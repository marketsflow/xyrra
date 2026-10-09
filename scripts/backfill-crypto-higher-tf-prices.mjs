/**
 * Step 1: Backfill higher-TF OHLCV from Binance (15m / 1h / 4h / 1D), last N days.
 * Does not touch 1m or 5m.
 *
 * Usage:
 *   npx tsx scripts/backfill-crypto-higher-tf-prices.mjs
 *   DAYS=30 npx tsx scripts/backfill-crypto-higher-tf-prices.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BINANCE_KLINES_URLS = [
  "https://api.binance.com/api/v3/klines",
  "https://data-api.binance.vision/api/v3/klines",
];

/** Only the TFs that need history for EMA 9/20. */
const TARGETS = [
  { minutes: 15, interval: "15m" },
  { minutes: 60, interval: "1h" },
  { minutes: 240, interval: "4h" },
  { minutes: 1440, interval: "1d" },
];

const PAGE_LIMIT = 1000;
const UPSERT_CHUNK = 500;
const DEFAULT_DAYS = 30;
const DEFAULT_QUOTE = "USDT";

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const i = trimmed.indexOf("=");
    env[trimmed.slice(0, i)] = trimmed.slice(i + 1);
  }
  return env;
}

function restHeaders(serviceKey, extra = {}) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

function parseNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

async function listEnabledAssets(base, serviceKey) {
  const res = await fetch(
    `${base}/rest/v1/crypto_assets?select=id,symbol&enabled=eq.true&order=symbol.asc`,
    { headers: restHeaders(serviceKey) },
  );
  if (!res.ok) throw new Error(`crypto_assets: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function fetchBinanceKlines(pair, interval, startMs, endMs) {
  const errors = [];
  for (const baseUrl of BINANCE_KLINES_URLS) {
    const url = new URL(baseUrl);
    url.searchParams.set("symbol", pair);
    url.searchParams.set("interval", interval);
    url.searchParams.set("startTime", String(startMs));
    url.searchParams.set("endTime", String(endMs));
    url.searchParams.set("limit", String(PAGE_LIMIT));
    try {
      const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
      const text = await res.text();
      if (!res.ok) {
        errors.push(`${baseUrl}: HTTP ${res.status} ${text.slice(0, 120)}`);
        continue;
      }
      const json = JSON.parse(text);
      if (!Array.isArray(json)) {
        errors.push(`${baseUrl}: not an array`);
        continue;
      }
      return json;
    } catch (e) {
      errors.push(`${baseUrl}: ${e instanceof Error ? e.message : "fetch failed"}`);
    }
  }
  throw new Error(`Binance klines failed for ${pair} ${interval}: ${errors.join(" | ")}`);
}

async function fetchAllKlines(pair, interval, startMs, endMs) {
  const all = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const page = await fetchBinanceKlines(pair, interval, cursor, endMs);
    if (page.length === 0) break;
    all.push(...page);
    const lastOpen = page[page.length - 1][0];
    const next = lastOpen + 1;
    if (next <= cursor) break;
    cursor = next;
    if (page.length < PAGE_LIMIT) break;
  }
  return all;
}

function klinesToCandles(raw) {
  const candles = [];
  for (const row of raw) {
    const open = parseNumber(row[1]);
    const high = parseNumber(row[2]);
    const low = parseNumber(row[3]);
    const close = parseNumber(row[4]);
    const volume = parseNumber(row[5]);
    if (open === null || high === null || low === null || close === null) continue;
    candles.push({
      bucket_start: new Date(row[0]).toISOString(),
      open,
      high,
      low,
      close,
      volume,
    });
  }
  return candles;
}

async function upsertCandles(base, serviceKey, assetId, timeframe, candles) {
  let upserted = 0;
  for (let i = 0; i < candles.length; i += UPSERT_CHUNK) {
    const chunk = candles.slice(i, i + UPSERT_CHUNK).map((c) => ({
      asset_id: assetId,
      timeframe,
      bucket_start: c.bucket_start,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
    const res = await fetch(
      `${base}/rest/v1/crypto_prices?on_conflict=asset_id,timeframe,bucket_start`,
      {
        method: "POST",
        headers: restHeaders(serviceKey, {
          Prefer: "resolution=merge-duplicates,return=minimal",
        }),
        body: JSON.stringify(chunk),
      },
    );
    if (!res.ok) {
      throw new Error(`upsert tf=${timeframe}: ${(await res.text()).slice(0, 300)}`);
    }
    upserted += chunk.length;
  }
  return upserted;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fileEnv = {
  ...loadEnvFile(resolve(root, ".env.local")),
  ...loadEnvFile(resolve(root, ".env")),
};

const supabaseUrl = (
  process.env.SUPABASE_URL ||
  fileEnv.SUPABASE_URL ||
  fileEnv.VITE_SUPABASE_URL ||
  ""
).replace(/\/$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || fileEnv.SUPABASE_SERVICE_ROLE_KEY;
const quote = (process.env.CRYPTO_INGEST_QUOTE || fileEnv.CRYPTO_INGEST_QUOTE || DEFAULT_QUOTE).toUpperCase();
const days = Math.min(30, Math.max(1, Number(process.env.DAYS || DEFAULT_DAYS) || DEFAULT_DAYS));

if (!supabaseUrl || !serviceKey) {
  console.error("Missing SUPABASE_URL / VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const endMs = Date.now();
const startMs = endMs - days * 24 * 60 * 60 * 1000;

console.log(
  `Step 1: backfill prices for 15m/1h/4h/1D · last ${days}d · ${supabaseUrl} · from ${new Date(startMs).toISOString()}`,
);

const assets = await listEnabledAssets(supabaseUrl, serviceKey);
const summary = [];

for (const asset of assets) {
  const pair = `${String(asset.symbol).toUpperCase()}${quote}`;
  for (const target of TARGETS) {
    console.log(`Fetching ${asset.symbol} ${target.interval}…`);
    const raw = await fetchAllKlines(pair, target.interval, startMs, endMs);
    const candles = klinesToCandles(raw);
    const upserted = await upsertCandles(
      supabaseUrl,
      serviceKey,
      asset.id,
      target.minutes,
      candles,
    );
    summary.push({
      symbol: asset.symbol,
      timeframe: target.interval,
      fetched: raw.length,
      upserted,
      first: candles[0]?.bucket_start ?? null,
      last: candles[candles.length - 1]?.bucket_start ?? null,
    });
    console.log(`  → ${upserted} rows`);
  }
}

console.log(JSON.stringify({ success: true, days, summary }, null, 2));
