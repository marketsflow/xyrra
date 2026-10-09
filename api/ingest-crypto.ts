/**
 * Vercel Cron + admin-triggered Binance 1m crypto candle ingest.
 * Mirrors Marketsflow: Binance /api/v3/klines → upsert OHLCV.
 * Self-contained (no ./lib imports) so Vercel Node ESM can resolve the route.
 *
 * Vercel: Web Standard `default { fetch }` (GET/POST).
 * Vite: imports named `ingestCryptoPrices` for the dev middleware.
 */

/** Primary + fallbacks: api.binance.com is often geo-blocked from Vercel US (iad1). */
const BINANCE_KLINES_URLS = [
  "https://api.binance.com/api/v3/klines",
  "https://data-api.binance.vision/api/v3/klines",
] as const;
const COINBASE_CANDLES_URL = "https://api.exchange.coinbase.com/products";
const DEFAULT_SYMBOL = "BTC";
const DEFAULT_QUOTE = "USDT";
const TIMEFRAME_1M = 1;

export type IngestCryptoEnv = {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  CRON_SECRET?: string;
  CRYPTO_INGEST_SYMBOL?: string;
  CRYPTO_INGEST_QUOTE?: string;
};

export type CryptoPriceRow = {
  asset_id: number;
  timeframe: number;
  bucket_start: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  /** ((close - prev_close) / prev_close) * 100 vs previous 1m candle. */
  percentage: number | null;
};

type BinanceKline = [
  number, // open time ms
  string, // open
  string, // high
  string, // low
  string, // close
  string, // volume
  number, // close time ms
  string, // quote asset volume
  number, // number of trades
  string, // taker buy base
  string, // taker buy quote
  string, // ignore
];

type IngestResult =
  | { success: true; row: CryptoPriceRow; pair: string; created: boolean }
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

function minuteBoundsUtc(now = new Date()): { startMs: number; endMs: number } {
  // Same window Marketsflow uses: current UTC minute [start, end].
  const start = new Date(now);
  start.setUTCSeconds(0, 0);
  const end = new Date(start);
  end.setUTCMinutes(end.getUTCMinutes() + 1);
  end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

async function assertAdminAccess(
  env: IngestCryptoEnv,
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

async function authorizeIngest(
  env: IngestCryptoEnv,
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

function restHeaders(serviceKey: string, extra?: Record<string, string>) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function ensureAsset(
  supabaseUrl: string,
  serviceKey: string,
  symbol: string,
): Promise<number> {
  const base = supabaseUrl.replace(/\/$/, "");
  const selectRes = await fetch(
    `${base}/rest/v1/crypto_assets?select=id&symbol=eq.${encodeURIComponent(symbol)}&limit=1`,
    { headers: restHeaders(serviceKey) },
  );
  if (!selectRes.ok) {
    const text = await selectRes.text();
    throw new Error(`Failed to load crypto_assets: ${text.slice(0, 300)}`);
  }
  const existing = (await selectRes.json()) as Array<{ id: number }>;
  if (existing[0]?.id) return existing[0].id;

  const insertRes = await fetch(`${base}/rest/v1/crypto_assets`, {
    method: "POST",
    headers: restHeaders(serviceKey, { Prefer: "return=representation" }),
    body: JSON.stringify({
      symbol,
      name: symbol === "BTC" ? "Bitcoin" : symbol,
      exchange: "binance",
      base_asset: symbol,
      quote_asset: "USDT",
      enabled: true,
      is_active: true,
    }),
  });
  if (!insertRes.ok) {
    const text = await insertRes.text();
    // Retry without optional columns if remote schema is leaner.
    if (insertRes.status === 400 || insertRes.status === 415) {
      const leanRes = await fetch(`${base}/rest/v1/crypto_assets`, {
        method: "POST",
        headers: restHeaders(serviceKey, { Prefer: "return=representation" }),
        body: JSON.stringify({
          symbol,
          name: symbol === "BTC" ? "Bitcoin" : symbol,
          exchange: "binance",
          enabled: true,
        }),
      });
      if (!leanRes.ok) {
        const leanText = await leanRes.text();
        throw new Error(`Failed to create crypto_assets row: ${leanText.slice(0, 300)}`);
      }
      const leanCreated = (await leanRes.json()) as Array<{ id: number }>;
      if (!leanCreated[0]?.id) {
        throw new Error("crypto_assets insert returned no id.");
      }
      return leanCreated[0].id;
    }
    throw new Error(`Failed to create crypto_assets row: ${text.slice(0, 300)}`);
  }
  const created = (await insertRes.json()) as Array<{ id: number }>;
  if (!created[0]?.id) {
    throw new Error("crypto_assets insert returned no id.");
  }
  return created[0].id;
}

function isGeoBlocked(status: number, body: string): boolean {
  if (status === 451 || status === 403) return true;
  const lower = body.toLowerCase();
  return lower.includes("restricted location") || lower.includes("unavailable from a restricted");
}

async function fetchBinance1mKlineFrom(
  baseUrl: string,
  pair: string,
  startMs: number,
  endMs: number,
): Promise<{ kline: BinanceKline | null; error?: string }> {
  const url = new URL(baseUrl);
  url.searchParams.set("symbol", pair);
  url.searchParams.set("interval", "1m");
  url.searchParams.set("startTime", String(startMs));
  url.searchParams.set("endTime", String(endMs));
  url.searchParams.set("limit", "1");

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
    });
    const text = await res.text();
    if (res.status === 429 || res.status === 503) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
      continue;
    }
    if (!res.ok) {
      if (isGeoBlocked(res.status, text)) {
        return { kline: null, error: `geo-blocked (${res.status})` };
      }
      return { kline: null, error: `HTTP ${res.status}: ${text.slice(0, 160)}` };
    }
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      return { kline: null, error: `invalid JSON from ${baseUrl}` };
    }
    if (!Array.isArray(json) || json.length === 0) return { kline: null };
    return { kline: json[0] as BinanceKline };
  }
  return { kline: null, error: `rate-limited on ${baseUrl}` };
}

/** Coinbase candle: [timeSec, low, high, open, close, volume] */
async function fetchCoinbase1mKline(
  symbol: string,
  quote: string,
  startMs: number,
  endMs: number,
): Promise<BinanceKline | null> {
  const product = `${symbol}-${quote}`;
  const url = new URL(`${COINBASE_CANDLES_URL}/${encodeURIComponent(product)}/candles`);
  url.searchParams.set("granularity", "60");
  url.searchParams.set("start", new Date(startMs).toISOString());
  url.searchParams.set("end", new Date(endMs).toISOString());

  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as unknown;
  if (!Array.isArray(json) || json.length === 0) return null;

  // Coinbase returns newest-first; pick the bucket matching startMs when possible.
  const rows = json as Array<[number, number, number, number, number, number]>;
  const startSec = Math.floor(startMs / 1000);
  const match = rows.find((r) => r[0] === startSec) ?? rows[0];
  if (!match) return null;
  const [timeSec, low, high, open, close, volume] = match;
  return [
    timeSec * 1000,
    String(open),
    String(high),
    String(low),
    String(close),
    String(volume),
    timeSec * 1000 + 59_999,
    "0",
    0,
    "0",
    "0",
    "0",
  ];
}

async function fetch1mKline(
  symbol: string,
  quote: string,
  startMs: number,
  endMs: number,
): Promise<BinanceKline> {
  const pair = `${symbol}${quote}`;
  const errors: string[] = [];

  for (const baseUrl of BINANCE_KLINES_URLS) {
    try {
      const result = await fetchBinance1mKlineFrom(baseUrl, pair, startMs, endMs);
      if (result.kline) return result.kline;
      if (result.error) errors.push(`${baseUrl}: ${result.error}`);
    } catch (e) {
      errors.push(`${baseUrl}: ${e instanceof Error ? e.message : "fetch failed"}`);
    }
  }

  try {
    const coinbase = await fetchCoinbase1mKline(symbol, quote, startMs, endMs);
    if (coinbase) return coinbase;
    errors.push("coinbase: no candle");
  } catch (e) {
    errors.push(`coinbase: ${e instanceof Error ? e.message : "fetch failed"}`);
  }

  // Last resort: previous closed minute (cron at :00 often races an empty current bucket).
  const prevStart = startMs - 60_000;
  const prevEnd = startMs - 1;
  for (const baseUrl of BINANCE_KLINES_URLS) {
    try {
      const result = await fetchBinance1mKlineFrom(baseUrl, pair, prevStart, prevEnd);
      if (result.kline) return result.kline;
    } catch {
      // continue
    }
  }
  const prevCoinbase = await fetchCoinbase1mKline(symbol, quote, prevStart, prevEnd);
  if (prevCoinbase) return prevCoinbase;

  throw new Error(`No 1m kline for ${pair}. ${errors.join(" | ").slice(0, 400)}`);
}

function closeChangePct(close: number, previousClose: number | null): number | null {
  if (previousClose === null || previousClose === 0) return null;
  return ((close - previousClose) / previousClose) * 100;
}

function klineToRow(
  assetId: number,
  kline: BinanceKline,
  previousClose: number | null = null,
): CryptoPriceRow {
  const open = parseNumber(kline[1]);
  const high = parseNumber(kline[2]);
  const low = parseNumber(kline[3]);
  const close = parseNumber(kline[4]);
  const volume = parseNumber(kline[5]);
  if (open === null || high === null || low === null || close === null) {
    throw new Error("Binance kline missing OHLC values.");
  }
  return {
    asset_id: assetId,
    timeframe: TIMEFRAME_1M,
    bucket_start: new Date(kline[0]).toISOString(),
    open,
    high,
    low,
    close,
    volume,
    percentage: closeChangePct(close, previousClose),
  };
}

async function fetchPreviousClose(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
  bucketStartIso: string,
): Promise<number | null> {
  const base = supabaseUrl.replace(/\/$/, "");
  const res = await fetch(
    `${base}/rest/v1/crypto_prices?select=close&asset_id=eq.${assetId}&timeframe=eq.${TIMEFRAME_1M}&bucket_start=lt.${encodeURIComponent(bucketStartIso)}&order=bucket_start.desc&limit=1`,
    { headers: restHeaders(serviceKey) },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to load previous crypto_prices close: ${text.slice(0, 300)}`);
  }
  const rows = (await res.json()) as Array<{ close?: unknown }>;
  return parseNumber(rows[0]?.close);
}

async function upsertCryptoPrice(
  supabaseUrl: string,
  serviceKey: string,
  row: CryptoPriceRow,
): Promise<boolean> {
  const base = supabaseUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/rest/v1/crypto_prices?on_conflict=asset_id,timeframe,bucket_start`, {
    method: "POST",
    headers: restHeaders(serviceKey, {
      Prefer: "resolution=merge-duplicates,return=minimal",
    }),
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to upsert crypto_prices: ${text.slice(0, 300)}`);
  }
  // PostgREST merge-duplicates does not distinguish insert vs update; treat as upserted.
  return true;
}

export async function ingestCryptoPrices(
  env: IngestCryptoEnv,
  authHeader: string | null,
): Promise<IngestResult> {
  const auth = await authorizeIngest(env, authHeader);
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

  const symbol = (env.CRYPTO_INGEST_SYMBOL || DEFAULT_SYMBOL).toUpperCase();
  const quote = (env.CRYPTO_INGEST_QUOTE || DEFAULT_QUOTE).toUpperCase();
  const pair = `${symbol}${quote}`;
  const { startMs, endMs } = minuteBoundsUtc();

  try {
    const assetId = await ensureAsset(supabaseUrl, serviceKey, symbol);
    const kline = await fetch1mKline(symbol, quote, startMs, endMs);
    const bucketStart = new Date(kline[0]).toISOString();
    const previousClose = await fetchPreviousClose(supabaseUrl, serviceKey, assetId, bucketStart);
    const row = klineToRow(assetId, kline, previousClose);
    await upsertCryptoPrice(supabaseUrl, serviceKey, row);
    return { success: true, row, pair, created: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ingest failed";
    return { success: false, message, status: 500 };
  }
}

export const config = {
  maxDuration: 10,
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

      const env: IngestCryptoEnv = {
        SUPABASE_URL: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
        SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        CRON_SECRET: process.env.CRON_SECRET,
        CRYPTO_INGEST_SYMBOL: process.env.CRYPTO_INGEST_SYMBOL,
        CRYPTO_INGEST_QUOTE: process.env.CRYPTO_INGEST_QUOTE,
      };

      const result = await ingestCryptoPrices(env, request.headers.get("authorization"));
      if (result.success === true) {
        return Response.json(
          { success: true, pair: result.pair, row: result.row },
          { status: 200, headers: jsonHeaders() },
        );
      }
      console.error("[ingest-crypto] failed", result.status, result.message);
      return Response.json(
        { success: false, message: result.message },
        { status: result.status ?? 500, headers: jsonHeaders() },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Internal error";
      console.error("[ingest-crypto] uncaught", msg);
      return Response.json({ success: false, message: msg }, { status: 500, headers: jsonHeaders() });
    }
  },
};
