/**
 * One-shot backfill: crypto_momentum percentage-jump anomalies.
 *
 * Walks each timeframe with a sliding window:
 *   - 1m: 10-row window, candidate = 10th bar
 *   - other TFs: 5-row window, candidate = 5th bar
 *
 * Usage:
 *   node --import tsx scripts/backfill-crypto-momentum.mjs
 *   # or: npx tsx scripts/backfill-crypto-momentum.mjs
 *
 * Optional:
 *   TIMEFRAMES=1,5,15 node --import tsx scripts/backfill-crypto-momentum.mjs
 *   MIN_ABS_PCT=0.5 ANOMALY_RATIO=2.5 node --import tsx scripts/backfill-crypto-momentum.mjs
 *   CONFIG_ID=default_v1 node --import tsx scripts/backfill-crypto-momentum.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeCryptoMomentum } from "../api/compute-crypto-momentum.ts";

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

const timeframes = (process.env.TIMEFRAMES || "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

const minAbsPct = process.env.MIN_ABS_PCT !== undefined ? Number(process.env.MIN_ABS_PCT) : undefined;
const anomalyRatio =
  process.env.ANOMALY_RATIO !== undefined ? Number(process.env.ANOMALY_RATIO) : undefined;
const configId = process.env.CONFIG_ID || undefined;

console.log(
  `Backfilling crypto_momentum` +
    (timeframes.length ? ` (tf=${timeframes.join(",")})` : " (all timeframes)") +
    ` @ ${env.SUPABASE_URL}`,
);

const result = await computeCryptoMomentum(env, null, {
  backfill: true,
  skipAuth: true,
  ...(timeframes.length ? { timeframes } : {}),
  ...(configId ? { configId } : {}),
  ...(Number.isFinite(minAbsPct) ? { minAbsPct } : {}),
  ...(Number.isFinite(anomalyRatio) ? { anomalyRatio } : {}),
});

if (!result.success) {
  console.error("Backfill failed:", result.message);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      mode: result.mode,
      assets: result.assets,
      rowsUpserted: result.rowsUpserted,
      anomaliesDetected: result.anomaliesDetected,
      sampleRows: result.rows,
    },
    null,
    2,
  ),
);
