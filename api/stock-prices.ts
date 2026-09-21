/**
 * Vercel ships one compiled file for this route — keep all EODHD/Supabase logic here
 * (no ./lib/* imports) or Node ESM on /var/task cannot resolve sibling modules.
 *
 * Vercel: Web Standard `default { fetch }` (not legacy (req, res)).
 * Vite: imports named `fetchStockPrices` for the dev middleware.
 */

const EODHD_BASE_URI = "https://eodhd.com/api/";
const MAX_RANGE_DAYS = 366;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type StockPricesEnv = {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  EODHD_API_KEY?: string;
  EODHD_API_BASE_URI?: string;
};

type FetchResult =
  | {
      success: true;
      stocksProcessed: number;
      rowsUpserted: number;
      errors: Array<{ stock: string; message: string }>;
    }
  | { success: false; message: string; status?: number };

type StockRow = { stock: string };

type EodhdCandle = {
  date?: string;
  open?: number | string | null;
  high?: number | string | null;
  low?: number | string | null;
  close?: number | string | null;
  volume?: number | string | null;
};

type Payload = { from: string; to: string };

function jsonHeaders() {
  return { "Content-Type": "application/json; charset=utf-8" };
}

function bearerToken(authHeader: string | null | undefined) {
  if (!authHeader) return "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

function parsePayload(raw: unknown): { ok: true; data: Payload } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Invalid JSON body." };
  const o = raw as Record<string, unknown>;
  const from = String(o.from ?? "").trim();
  const to = String(o.to ?? "").trim();

  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return { ok: false, error: "From and to must be dates in YYYY-MM-DD format." };
  }

  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return { ok: false, error: "From and to must be valid dates." };
  }
  if (fromDate > toDate) {
    return { ok: false, error: "From date must be before or equal to the to date." };
  }
  const rangeDays = Math.round((toDate.getTime() - fromDate.getTime()) / 86_400_000);
  if (rangeDays > MAX_RANGE_DAYS) {
    return { ok: false, error: `Date range cannot exceed ${MAX_RANGE_DAYS} days.` };
  }

  return { ok: true, data: { from, to } };
}

async function parseJsonResponse(res: Response): Promise<unknown> {
  const rawText = await res.text();
  if (!rawText) return {};
  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    return rawText;
  }
}

function anonConfig(env: StockPricesEnv) {
  const url = env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const anonKey = env.SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

function serviceConfig(env: StockPricesEnv) {
  const url = env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) return null;
  return { url, serviceRoleKey };
}

async function anonFetch(
  config: { url: string; anonKey: string },
  token: string,
  path: string,
) {
  return fetch(`${config.url}${path}`, {
    headers: { apikey: config.anonKey, Authorization: `Bearer ${token}` },
  });
}

async function requireAdminUser(
  config: { url: string; anonKey: string },
  token: string,
): Promise<{ ok: true; userId: string } | { ok: false; message: string; status: number }> {
  const userRes = await anonFetch(config, token, "/auth/v1/user");
  const userJson = await parseJsonResponse(userRes);
  if (!userRes.ok) {
    return { ok: false, message: "Sign in required.", status: 401 };
  }

  const userId =
    userJson && typeof userJson === "object" && typeof (userJson as { id?: unknown }).id === "string"
      ? (userJson as { id: string }).id
      : "";
  if (!userId) {
    return { ok: false, message: "Sign in required.", status: 401 };
  }

  const profileRes = await anonFetch(
    config,
    token,
    `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=role`,
  );
  const profiles = (await parseJsonResponse(profileRes)) as Array<{ role?: string }> | unknown;
  const role =
    Array.isArray(profiles) && profiles[0] && typeof profiles[0].role === "string" ? profiles[0].role : "user";

  if (role !== "admin" && role !== "editor") {
    return { ok: false, message: "Not authorized for the admin console.", status: 403 };
  }

  return { ok: true, userId };
}

async function serviceFetch(
  config: { url: string; serviceRoleKey: string },
  path: string,
  init?: RequestInit,
) {
  const headers = new Headers(init?.headers);
  headers.set("apikey", config.serviceRoleKey);
  headers.set("Authorization", `Bearer ${config.serviceRoleKey}`);
  if (!headers.has("Content-Type") && init?.body) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${config.url}${path}`, { ...init, headers });
}

async function fetchStocksToFetch(config: { url: string; serviceRoleKey: string }): Promise<StockRow[]> {
  // Fetches every stock (not just enable_for_trading = true) — crypto symbols use a separate EODHD endpoint.
  const res = await serviceFetch(
    config,
    "/rest/v1/stocks?stock=not.like.C:*&select=stock&order=stock.asc",
  );
  if (!res.ok) {
    throw new Error("Unable to load stocks.");
  }
  const rows = (await parseJsonResponse(res)) as StockRow[] | unknown;
  return Array.isArray(rows) ? rows : [];
}

function toNumberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

async function getEodForStockFromTo(
  eodhd: { baseUri: string; apiKey: string },
  symbol: string,
  from: string,
  to: string,
): Promise<EodhdCandle[]> {
  const url = new URL(`eod/${encodeURIComponent(symbol)}`, eodhd.baseUri);
  url.searchParams.set("api_token", eodhd.apiKey);
  url.searchParams.set("fmt", "json");
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`EODHD request failed (HTTP ${res.status}).`);
  }
  const json = await parseJsonResponse(res);
  return Array.isArray(json) ? (json as EodhdCandle[]) : [];
}

async function upsertStockPrices(
  config: { url: string; serviceRoleKey: string },
  stock: string,
  candles: EodhdCandle[],
): Promise<number> {
  const rows = candles
    .filter((candle) => typeof candle.date === "string" && DATE_RE.test(candle.date))
    .map((candle) => ({
      stock,
      date: candle.date,
      open: toNumberOrNull(candle.open),
      high: toNumberOrNull(candle.high),
      low: toNumberOrNull(candle.low),
      close: toNumberOrNull(candle.close) ?? 0,
      volume: toNumberOrNull(candle.volume),
    }));

  if (rows.length === 0) return 0;

  const res = await serviceFetch(config, "/rest/v1/stock_prices?on_conflict=stock,date", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const json = await parseJsonResponse(res);
    const message =
      json && typeof json === "object" && typeof (json as { message?: unknown }).message === "string"
        ? (json as { message: string }).message
        : `Unable to save prices for ${stock}.`;
    throw new Error(message);
  }

  return rows.length;
}

export async function fetchStockPrices(
  payload: unknown,
  env: StockPricesEnv,
  authHeader: string | null | undefined,
): Promise<FetchResult> {
  const token = bearerToken(authHeader);
  if (!token) {
    return { success: false, message: "Sign in required.", status: 401 };
  }

  const parsed = parsePayload(payload);
  if (!parsed.ok) {
    return { success: false, message: parsed.error, status: 400 };
  }

  const anon = anonConfig(env);
  if (!anon) {
    return { success: false, message: "Supabase is not configured on the server.", status: 500 };
  }

  const service = serviceConfig(env);
  if (!service) {
    return { success: false, message: "Supabase service role is not configured on the server.", status: 500 };
  }

  const apiKey = env.EODHD_API_KEY?.trim();
  if (!apiKey) {
    return { success: false, message: "EOD data is not configured (EODHD_API_KEY).", status: 500 };
  }
  const baseUri = (env.EODHD_API_BASE_URI?.trim() || EODHD_BASE_URI).replace(/\/*$/, "/");

  const admin = await requireAdminUser(anon, token);
  if (!admin.ok) {
    return { success: false, message: admin.message, status: admin.status };
  }

  let stocks: StockRow[];
  try {
    stocks = await fetchStocksToFetch(service);
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unable to load stocks.",
      status: 500,
    };
  }

  if (stocks.length === 0) {
    return { success: false, message: "No stocks were found.", status: 400 };
  }

  const errors: Array<{ stock: string; message: string }> = [];
  let rowsUpserted = 0;

  // Fetch several symbols concurrently — sequential requests would blow past the serverless timeout for large stock lists.
  const CONCURRENCY = 10;
  const { from, to } = parsed.data;
  const svc = service;
  const eodhdApiKey = apiKey;
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < stocks.length) {
      const { stock } = stocks[nextIndex++];
      try {
        const candles = await getEodForStockFromTo({ baseUri, apiKey: eodhdApiKey }, stock, from, to);
        rowsUpserted += await upsertStockPrices(svc, stock, candles);
      } catch (error) {
        errors.push({ stock, message: error instanceof Error ? error.message : "Unknown error." });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, stocks.length) }, () => worker()));

  return { success: true, stocksProcessed: stocks.length, rowsUpserted, errors };
}

export const config = {
  maxDuration: 60,
};

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== "POST") {
        return Response.json(
          { success: false, message: "Method not allowed" },
          { status: 405, headers: jsonHeaders() },
        );
      }

      const ct = (request.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("application/json")) {
        return Response.json(
          { success: false, message: "Content-Type must be application/json." },
          { status: 400, headers: jsonHeaders() },
        );
      }

      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return Response.json(
          { success: false, message: "Invalid JSON body." },
          { status: 400, headers: jsonHeaders() },
        );
      }

      const env: StockPricesEnv = {
        SUPABASE_URL: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
        SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        EODHD_API_KEY: process.env.EODHD_API_KEY,
        EODHD_API_BASE_URI: process.env.EODHD_API_BASE_URI,
      };

      const result = await fetchStockPrices(payload, env, request.headers.get("authorization"));
      if (result.success) {
        return Response.json(
          {
            success: true,
            stocksProcessed: result.stocksProcessed,
            rowsUpserted: result.rowsUpserted,
            errors: result.errors,
          },
          { status: 200, headers: jsonHeaders() },
        );
      }
      return Response.json(
        { success: false, message: result.message },
        { status: result.status ?? 500, headers: jsonHeaders() },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Internal error";
      return Response.json({ success: false, message: msg }, { status: 500, headers: jsonHeaders() });
    }
  },
};
