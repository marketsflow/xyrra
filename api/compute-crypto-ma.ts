/**
 * Vercel Cron + admin-triggered crypto SMA/EMA compute.
 * Reads crypto_prices (1m source of truth), materializes the latest higher-TF
 * candle into crypto_prices, then upserts one MA row per timeframe.
 *
 * Self-contained (no ./lib imports) so Vercel Node ESM can resolve the route.
 */

const TIMEFRAMES = [1, 5, 15, 60, 240, 1440] as const;
const MAX_PERIOD = 50;
/** Enough 1m bars to build the current 1D bucket + a small buffer. */
const ONE_M_LOOKBACK = 1500;
const ONE_M_PAGE = 1000;
/** Closes needed from each TF to seed SMA50 / EMA50. */
const CLOSE_LOOKBACK = MAX_PERIOD + 5;

export type ComputeCryptoMaEnv = {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  CRON_SECRET?: string;
};

type Candle = {
  bucket_start: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

type MaRow = {
  asset_id: number;
  timeframe: number;
  timestamp: string;
  sma_20: number | null;
  sma_50: number | null;
  ema_9: number | null;
  ema_20: number | null;
  ema_50: number | null;
};

type AssetRow = { id: number; symbol: string };

type ComputeResult =
  | {
      success: true;
      assets: number;
      rowsUpserted: number;
      rows: MaRow[];
    }
  | { success: false; message: string; status?: number };

function jsonHeaders() {
  return { "Content-Type": "application/json; charset=utf-8" };
}

function bearerToken(authHeader: string | null | undefined) {
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

async function assertAdminAccess(
  env: ComputeCryptoMaEnv,
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
  env: ComputeCryptoMaEnv,
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

function floorToTimeframeMs(ms: number, timeframeMinutes: number) {
  const size = timeframeMinutes * 60_000;
  return Math.floor(ms / size) * size;
}

function aggregateCandles(oneMinute: Candle[], timeframeMinutes: number): Candle[] {
  if (timeframeMinutes <= 1) {
    return [...oneMinute].sort(
      (a, b) => new Date(a.bucket_start).getTime() - new Date(b.bucket_start).getTime(),
    );
  }

  const buckets = new Map<number, Candle>();
  const chronological = [...oneMinute].sort(
    (a, b) => new Date(a.bucket_start).getTime() - new Date(b.bucket_start).getTime(),
  );

  for (const bar of chronological) {
    const startMs = floorToTimeframeMs(new Date(bar.bucket_start).getTime(), timeframeMinutes);
    const existing = buckets.get(startMs);
    if (!existing) {
      buckets.set(startMs, {
        bucket_start: new Date(startMs).toISOString(),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      });
      continue;
    }
    existing.high = Math.max(existing.high, bar.high);
    existing.low = Math.min(existing.low, bar.low);
    existing.close = bar.close;
    if (existing.volume === null && bar.volume === null) {
      existing.volume = null;
    } else {
      existing.volume = (existing.volume ?? 0) + (bar.volume ?? 0);
    }
  }

  return [...buckets.values()].sort(
    (a, b) => new Date(a.bucket_start).getTime() - new Date(b.bucket_start).getTime(),
  );
}

function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  let sum = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    sum += closes[i]!;
  }
  return sum / period;
}

function ema(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let value = 0;
  for (let i = 0; i < period; i++) {
    value += closes[i]!;
  }
  value /= period;
  for (let i = period; i < closes.length; i++) {
    value = closes[i]! * k + value * (1 - k);
  }
  return value;
}

function computeMaRow(assetId: number, timeframe: number, candlesAsc: Candle[]): MaRow | null {
  if (candlesAsc.length === 0) return null;
  const latest = candlesAsc[candlesAsc.length - 1]!;
  const closes = candlesAsc.map((c) => c.close);
  return {
    asset_id: assetId,
    timeframe,
    timestamp: latest.bucket_start,
    sma_20: sma(closes, 20),
    sma_50: sma(closes, 50),
    ema_9: ema(closes, 9),
    ema_20: ema(closes, 20),
    ema_50: ema(closes, 50),
  };
}

function toCandle(row: Record<string, unknown>): Candle | null {
  const bucket = typeof row.bucket_start === "string" ? row.bucket_start : null;
  const open = parseNumber(row.open);
  const high = parseNumber(row.high);
  const low = parseNumber(row.low);
  const close = parseNumber(row.close);
  if (!bucket || open === null || high === null || low === null || close === null) return null;
  return {
    bucket_start: bucket,
    open,
    high,
    low,
    close,
    volume: parseNumber(row.volume),
  };
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

async function fetchOneMinuteCandles(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
  limit: number,
): Promise<Candle[]> {
  const base = supabaseUrl.replace(/\/$/, "");
  const candles: Candle[] = [];
  let offset = 0;

  while (candles.length < limit) {
    const end = offset + ONE_M_PAGE - 1;
    const res = await fetch(
      `${base}/rest/v1/crypto_prices?select=bucket_start,open,high,low,close,volume&asset_id=eq.${assetId}&timeframe=eq.1&order=bucket_start.desc`,
      {
        headers: restHeaders(serviceKey, {
          Prefer: "count=exact",
          Range: `${offset}-${end}`,
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to load 1m crypto_prices: ${text.slice(0, 300)}`);
    }
    const page = ((await res.json()) as Record<string, unknown>[])
      .map(toCandle)
      .filter((c): c is Candle => c !== null);
    if (page.length === 0) break;
    candles.push(...page);
    if (page.length < ONE_M_PAGE) break;
    offset += ONE_M_PAGE;
  }

  return candles.slice(0, limit);
}

async function fetchTimeframeCandlesAsc(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
  timeframe: number,
  limit: number,
): Promise<Candle[]> {
  const base = supabaseUrl.replace(/\/$/, "");
  const res = await fetch(
    `${base}/rest/v1/crypto_prices?select=bucket_start,open,high,low,close,volume&asset_id=eq.${assetId}&timeframe=eq.${timeframe}&order=bucket_start.desc&limit=${limit}`,
    { headers: restHeaders(serviceKey) },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to load crypto_prices tf=${timeframe}: ${text.slice(0, 300)}`);
  }
  const newestFirst = ((await res.json()) as Record<string, unknown>[])
    .map(toCandle)
    .filter((c): c is Candle => c !== null);
  return newestFirst.reverse();
}

async function upsertCryptoPrices(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
  timeframe: number,
  candles: Candle[],
): Promise<void> {
  if (candles.length === 0) return;
  const base = supabaseUrl.replace(/\/$/, "");
  const payload = candles.map((candle) => ({
    asset_id: assetId,
    timeframe,
    bucket_start: candle.bucket_start,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  }));
  const res = await fetch(
    `${base}/rest/v1/crypto_prices?on_conflict=asset_id,timeframe,bucket_start`,
    {
      method: "POST",
      headers: restHeaders(serviceKey, {
        Prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to upsert crypto_prices tf=${timeframe}: ${text.slice(0, 300)}`);
  }
}

async function upsertMovingAverage(
  supabaseUrl: string,
  serviceKey: string,
  row: MaRow,
): Promise<void> {
  const base = supabaseUrl.replace(/\/$/, "");
  const res = await fetch(
    `${base}/rest/v1/crypto_moving_averages?on_conflict=asset_id,timeframe,timestamp`,
    {
      method: "POST",
      headers: restHeaders(serviceKey, {
        Prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify(row),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to upsert crypto_moving_averages: ${text.slice(0, 300)}`);
  }
}

async function computeForAsset(
  supabaseUrl: string,
  serviceKey: string,
  asset: AssetRow,
): Promise<MaRow[]> {
  const oneMinuteNewestFirst = await fetchOneMinuteCandles(
    supabaseUrl,
    serviceKey,
    asset.id,
    ONE_M_LOOKBACK,
  );
  if (oneMinuteNewestFirst.length === 0) return [];

  const rows: MaRow[] = [];

  for (const timeframe of TIMEFRAMES) {
    // Materialize recent higher-TF candles from 1m so MA history can seed without a separate backfill.
    if (timeframe > 1) {
      const aggregated = aggregateCandles(oneMinuteNewestFirst, timeframe);
      await upsertCryptoPrices(
        supabaseUrl,
        serviceKey,
        asset.id,
        timeframe,
        aggregated.slice(-CLOSE_LOOKBACK),
      );
    }

    const closesAsc = await fetchTimeframeCandlesAsc(
      supabaseUrl,
      serviceKey,
      asset.id,
      timeframe,
      CLOSE_LOOKBACK,
    );
    const ma = computeMaRow(asset.id, timeframe, closesAsc);
    if (!ma) continue;
    await upsertMovingAverage(supabaseUrl, serviceKey, ma);
    rows.push(ma);
  }

  return rows;
}

export async function computeCryptoMovingAverages(
  env: ComputeCryptoMaEnv,
  authHeader: string | null,
): Promise<ComputeResult> {
  const auth = await authorize(env, authHeader);
  if (auth.ok === false) {
    return { success: false, message: auth.message, status: auth.status };
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

  try {
    const assets = await listEnabledAssets(supabaseUrl, serviceKey);
    const allRows: MaRow[] = [];

    for (const asset of assets) {
      const rows = await computeForAsset(supabaseUrl, serviceKey, asset);
      allRows.push(...rows);
    }

    return {
      success: true,
      assets: assets.length,
      rowsUpserted: allRows.length,
      rows: allRows,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Compute failed";
    return { success: false, message, status: 500 };
  }
}

export const config = {
  maxDuration: 30,
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

      const env: ComputeCryptoMaEnv = {
        SUPABASE_URL: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
        SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        CRON_SECRET: process.env.CRON_SECRET,
      };

      const result = await computeCryptoMovingAverages(env, request.headers.get("authorization"));
      if (result.success === true) {
        return Response.json(
          {
            success: true,
            assets: result.assets,
            rowsUpserted: result.rowsUpserted,
            rows: result.rows,
          },
          { status: 200, headers: jsonHeaders() },
        );
      }
      console.error("[compute-crypto-ma] failed", result.status, result.message);
      return Response.json(
        { success: false, message: result.message },
        { status: result.status ?? 500, headers: jsonHeaders() },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Internal error";
      console.error("[compute-crypto-ma] uncaught", msg);
      return Response.json({ success: false, message: msg }, { status: 500, headers: jsonHeaders() });
    }
  },
};
