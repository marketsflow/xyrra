/**
 * One-shot backfill: crypto_price from crypto_prices source candles.
 *
 * Default source = 4h (timeframe=240): one row per closed 4h candle.
 * Opt-in 1m source: SOURCE_TF=1 (or CADENCE=1m) for per-minute buckets.
 * Stored analysis timeframe is always 4h (S/R + crypto_price.timeframe=240).
 * EMA score: Σ +10 for each bullish ema_9_20_factor among 5m/15m/1h/4h/1D.
 * Momentum: crypto_momentum at the same timestamp when present (mom_4h preferred).
 * Signal price_level = previous source-candle close (Polymarket-open aligned; no ±200).
 *
 * Usage:
 *   npx tsx scripts/backfill-crypto-price.mjs
 *   SOURCE_TF=1 DAYS=1 npx tsx scripts/backfill-crypto-price.mjs
 *   SUPABASE_URL=https://….supabase.co DAYS=14 npx tsx scripts/backfill-crypto-price.mjs
 *
 * Optional:
 *   DAYS=7 / DAYS=0 (all history)
 *   SOURCE_TF=1|240   (alias: CADENCE=1m|4h)
 *
 * Point SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY at production to backfill prod.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeCryptoPrice, parseSourceTimeframe } from "../api/compute-crypto-price.ts";

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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fileEnv = {
  ...loadEnvFile(resolve(root, ".env.production.local")),
  ...loadEnvFile(resolve(root, ".env.local")),
  ...loadEnvFile(resolve(root, ".env")),
};

const env = {
  SUPABASE_URL: process.env.SUPABASE_URL || fileEnv.SUPABASE_URL || fileEnv.VITE_SUPABASE_URL,
  SUPABASE_ANON_KEY:
    process.env.SUPABASE_ANON_KEY || fileEnv.SUPABASE_ANON_KEY || fileEnv.VITE_SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY:
    process.env.SUPABASE_SERVICE_ROLE_KEY || fileEnv.SUPABASE_SERVICE_ROLE_KEY,
  CRON_SECRET: process.env.CRON_SECRET || fileEnv.CRON_SECRET,
};

if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL / VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const days =
  process.env.DAYS !== undefined && process.env.DAYS !== ""
    ? Number(process.env.DAYS)
    : undefined;

const sourceTimeframe = parseSourceTimeframe(
  process.env.SOURCE_TF || process.env.CADENCE || process.env.SOURCE,
);

console.log(
  `Backfilling crypto_price` +
    ` (source=${sourceTimeframe ?? 240}${sourceTimeframe === 1 ? " / 1m" : " / 4h"}` +
    `; analysis=240; EMA scores 5m/15m/1h/4h/1D)` +
    (days === undefined
      ? " days=7"
      : days > 0
        ? ` days=${days}`
        : " days=all") +
    ` @ ${env.SUPABASE_URL}`,
);

const result = await computeCryptoPrice(env, null, {
  backfill: true,
  skipAuth: true,
  ...(Number.isFinite(days) ? { days } : {}),
  ...(sourceTimeframe !== null ? { sourceTimeframe } : {}),
});

if (!result.success) {
  console.error("Backfill failed:", result.message);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      mode: result.mode,
      sourceTimeframe: result.sourceTimeframe,
      analysisTimeframe: result.analysisTimeframe,
      assets: result.assets,
      rowsInserted: result.rowsInserted,
      skippedNoPrice: result.skippedNoPrice,
      skippedNoCycle: result.skippedNoCycle,
      sampleRows: result.rows,
    },
    null,
    2,
  ),
);
