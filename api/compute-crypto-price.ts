/**
 * Vercel Cron + admin-triggered crypto_price upserts.
 *
 * Every minute: for each enabled asset and selected timeframe (default: 4h only),
 * read the latest 1m close + active support/resistance cycle, then upsert:
 *   - price_1m
 *   - distance_from_support  (% above support)
 *   - distance_to_resistance (% below resistance)
 *   - price_level            (reference price = price_1m for now)
 *   - signal                 (left null until signal logic is added)
 *
 * Self-contained (no ./lib imports) so Vercel Node ESM can resolve the route.
 */

/** Default: 4h only. Expand later via ?timeframes=5,15,60,240,1440 */
const DEFAULT_TIMEFRAMES = [240] as const;
const ALLOWED_TIMEFRAMES = new Set([5, 15, 60, 240, 1440]);
const TIMEFRAME_1M = 1;

export type ComputeCryptoPriceEnv = {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  CRON_SECRET?: string;
};

export type ComputeCryptoPriceOptions = {
  /** Limit to these timeframes (minutes). Default: [240]. */
  timeframes?: number[];
};

type AssetRow = { id: number; symbol: string };

type ActiveCycle = {
  support: number;
  resistance: number;
};

type CryptoPriceRow = {
  asset_id: number;
  price_1m: number;
  timeframe: number;
  distance_from_support: number | null;
  distance_to_resistance: number | null;
  signal: null;
  price_level: number;
  updated_at: string;
};

type ComputeResult =
  | {
      success: true;
      assets: number;
      rowsUpserted: number;
      skippedNoPrice: number;
      skippedNoCycle: number;
      rows: CryptoPriceRow[];
    }
  | { success: false; message: string; status?: number };

function jsonHeaders() {
  return { "Content-Type": "application/json" };
}

function bearerToken(authHeader: string | null): string {
  if (!authHeader) return "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function restHeaders(serviceKey: string, extra?: Record<string, string>) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

function roundPrice(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

function roundPct(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Signed %: how far price is above support. */
export function distanceFromSupportPct(price: number, support: number): number | null {
  if (support === 0) return null;
  return roundPct(((price - support) / support) * 100);
}

/** Signed %: how far resistance is above price. */
export function distanceToResistancePct(price: number, resistance: number): number | null {
  if (resistance === 0) return null;
  return roundPct(((resistance - price) / resistance) * 100);
}

async function assertAdminAccess(
  env: ComputeCryptoPriceEnv,
  accessToken: string,
): Promise<{ ok: true } | { ok: false; message: string; status: number }> {
  const supabaseUrl = (env.SUPABASE_URL || "").replace(/\/$/, "");
  const anonKey = env.SUPABASE_ANON_KEY || "";
  if (!supabaseUrl || !anonKey) {
    return { ok: false, message: "Supabase env is not configured.", status: 500 };
  }

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!userRes.ok) {
    return { ok: false, message: "Unauthorized", status: 401 };
  }
  const user = (await userRes.json()) as { id?: string };
  if (!user.id) {
    return { ok: false, message: "Unauthorized", status: 401 };
  }

  const profileRes = await fetch(
    `${supabaseUrl}/rest/v1/profiles?select=role&id=eq.${encodeURIComponent(user.id)}&limit=1`,
    {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
  if (!profileRes.ok) {
    return { ok: false, message: "Unable to verify admin role.", status: 500 };
  }
  const profiles = (await profileRes.json()) as Array<{ role?: string }>;
  const role = profiles[0]?.role;
  if (role !== "admin" && role !== "editor") {
    return { ok: false, message: "Forbidden", status: 403 };
  }
  return { ok: true };
}

async function authorize(
  env: ComputeCryptoPriceEnv,
  authHeader: string | null,
): Promise<{ ok: true } | { ok: false; message: string; status: number }> {
  const token = bearerToken(authHeader);
  if (!token) {
    return { ok: false, message: "Unauthorized", status: 401 };
  }
  if (env.CRON_SECRET && token === env.CRON_SECRET) {
    return { ok: true };
  }
  return assertAdminAccess(env, token);
}

async function listEnabledAssets(
  supabaseUrl: string,
  serviceKey: string,
): Promise<AssetRow[]> {
  const base = supabaseUrl.replace(/\/$/, "");
  const res = await fetch(
    `${base}/rest/v1/crypto_assets?select=id,symbol&enabled=eq.true&order=symbol.asc`,
    { headers: restHeaders(serviceKey) },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to load crypto_assets: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as AssetRow[];
}

async function fetchLatest1mClose(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
): Promise<number | null> {
  const base = supabaseUrl.replace(/\/$/, "");
  const res = await fetch(
    `${base}/rest/v1/crypto_prices?select=close&asset_id=eq.${assetId}&timeframe=eq.${TIMEFRAME_1M}&order=bucket_start.desc&limit=1`,
    { headers: restHeaders(serviceKey) },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to load latest 1m close: ${text.slice(0, 300)}`);
  }
  const rows = (await res.json()) as Array<{ close?: unknown }>;
  return parseNumber(rows[0]?.close);
}

async function fetchActiveCycle(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
  timeframe: number,
): Promise<ActiveCycle | null> {
  const base = supabaseUrl.replace(/\/$/, "");
  const res = await fetch(
    `${base}/rest/v1/crypto_support_resistance?select=support,resistance&asset_id=eq.${assetId}&timeframe=eq.${timeframe}&status=eq.active&limit=1`,
    { headers: restHeaders(serviceKey) },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to load active S/R cycle tf=${timeframe}: ${text.slice(0, 300)}`);
  }
  const rows = (await res.json()) as Array<{ support?: unknown; resistance?: unknown }>;
  const support = parseNumber(rows[0]?.support);
  const resistance = parseNumber(rows[0]?.resistance);
  if (support === null || resistance === null) return null;
  return { support, resistance };
}

async function upsertCryptoPriceRows(
  supabaseUrl: string,
  serviceKey: string,
  rows: CryptoPriceRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const base = supabaseUrl.replace(/\/$/, "");
  const res = await fetch(
    `${base}/rest/v1/crypto_price?on_conflict=asset_id,timeframe`,
    {
      method: "POST",
      headers: restHeaders(serviceKey, {
        Prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify(rows),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to upsert crypto_price: ${text.slice(0, 300)}`);
  }
  return rows.length;
}

function buildRow(
  assetId: number,
  timeframe: number,
  price1m: number,
  cycle: ActiveCycle,
  updatedAt: string,
): CryptoPriceRow {
  const price = roundPrice(price1m);
  return {
    asset_id: assetId,
    price_1m: price,
    timeframe,
    distance_from_support: distanceFromSupportPct(price, cycle.support),
    distance_to_resistance: distanceToResistancePct(price, cycle.resistance),
    signal: null,
    price_level: price,
    updated_at: updatedAt,
  };
}

/**
 * Pass `skipAuth: true` only from trusted local scripts that already hold the service role key.
 */
export async function computeCryptoPrice(
  env: ComputeCryptoPriceEnv,
  authHeader: string | null,
  options: ComputeCryptoPriceOptions & { skipAuth?: boolean } = {},
): Promise<ComputeResult> {
  if (!options.skipAuth) {
    const auth = await authorize(env, authHeader);
    if (auth.ok === false) {
      return { success: false, message: auth.message, status: auth.status };
    }
  }

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return {
      success: false,
      message: "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.",
      status: 500,
    };
  }

  const timeframes = (options.timeframes?.length
    ? options.timeframes
    : [...DEFAULT_TIMEFRAMES]
  ).filter((tf) => ALLOWED_TIMEFRAMES.has(tf));

  if (timeframes.length === 0) {
    return { success: false, message: "No valid timeframes selected.", status: 400 };
  }

  try {
    const assets = await listEnabledAssets(supabaseUrl, serviceKey);
    const rows: CryptoPriceRow[] = [];
    let skippedNoPrice = 0;
    let skippedNoCycle = 0;
    const updatedAt = new Date().toISOString();

    for (const asset of assets) {
      const price1m = await fetchLatest1mClose(supabaseUrl, serviceKey, asset.id);
      if (price1m === null) {
        skippedNoPrice += timeframes.length;
        continue;
      }

      for (const timeframe of timeframes) {
        const cycle = await fetchActiveCycle(
          supabaseUrl,
          serviceKey,
          asset.id,
          timeframe,
        );
        if (!cycle) {
          skippedNoCycle += 1;
          continue;
        }
        rows.push(buildRow(asset.id, timeframe, price1m, cycle, updatedAt));
      }
    }

    const rowsUpserted = await upsertCryptoPriceRows(supabaseUrl, serviceKey, rows);

    return {
      success: true,
      assets: assets.length,
      rowsUpserted,
      skippedNoPrice,
      skippedNoCycle,
      rows,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Compute failed";
    return { success: false, message, status: 500 };
  }
}

export const config = {
  maxDuration: 60,
};

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== "GET" && request.method !== "POST") {
        return Response.json(
          { success: false, message: "Method not allowed" },
          { status: 405, headers: jsonHeaders() },
        );
      }

      const url = new URL(request.url);
      const timeframesParam = url.searchParams.get("timeframes") || url.searchParams.get("tf");
      const timeframes = timeframesParam
        ? timeframesParam
            .split(",")
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isFinite(n) && n > 0)
        : undefined;

      const env: ComputeCryptoPriceEnv = {
        SUPABASE_URL: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
        SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        CRON_SECRET: process.env.CRON_SECRET,
      };

      const result = await computeCryptoPrice(env, request.headers.get("authorization"), {
        timeframes,
      });

      if (result.success === true) {
        return Response.json(
          {
            success: true,
            assets: result.assets,
            rowsUpserted: result.rowsUpserted,
            skippedNoPrice: result.skippedNoPrice,
            skippedNoCycle: result.skippedNoCycle,
            rows: result.rows,
          },
          { status: 200, headers: jsonHeaders() },
        );
      }
      console.error("[compute-crypto-price] failed", result.status, result.message);
      return Response.json(
        { success: false, message: result.message },
        { status: result.status ?? 500, headers: jsonHeaders() },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Internal error";
      console.error("[compute-crypto-price] uncaught", msg);
      return Response.json({ success: false, message: msg }, { status: 500, headers: jsonHeaders() });
    }
  },
};
