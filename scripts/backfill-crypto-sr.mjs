/**
 * One-shot backfill: crypto_support_resistance cycles.
 *
 * For each asset + timeframe (5m, 15m, 1h, 4h, 1D), walks all closed candles
 * chronologically. Initial levels = min/max close over a 30-bar window. For the
 * first 3 days after cycle start, a higher close raises resistance on the same
 * row. A close beyond ±3% of a level ends the cycle and opens a new row with
 * role reversal (breached resistance → new support; breached support → new
 * resistance, support pushed to the window low).
 *
 * Clears existing cycles for each asset/TF before rebuilding.
 *
 * Usage:
 *   node --import tsx scripts/backfill-crypto-sr.mjs
 *   # or: npx tsx scripts/backfill-crypto-sr.mjs
 *
 * Optional:
 *   TIMEFRAMES=5,15,60 node --import tsx scripts/backfill-crypto-sr.mjs
 *   BAND_PCT=3 node --import tsx scripts/backfill-crypto-sr.mjs
 *
 * Point SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY at production to backfill prod.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeCryptoSupportResistance } from "../api/compute-crypto-sr.ts";

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

const bandPct = process.env.BAND_PCT !== undefined ? Number(process.env.BAND_PCT) : undefined;

console.log(
  `Backfilling crypto_support_resistance` +
    (timeframes.length ? ` (tf=${timeframes.join(",")})` : " (5/15/60/240/1440)") +
    ` lookback=30` +
    ` @ ${env.SUPABASE_URL}`,
);

const result = await computeCryptoSupportResistance(env, null, {
  backfill: true,
  skipAuth: true,
  ...(timeframes.length ? { timeframes } : {}),
  ...(Number.isFinite(bandPct) ? { bandPct } : {}),
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
      cyclesOpened: result.cyclesOpened,
      cyclesBreached: result.cyclesBreached,
      hoversRecorded: result.hoversRecorded,
      sampleRows: result.rows,
    },
    null,
    2,
  ),
);
