/**
 * One-shot backfill: crypto_price_action (plus MA + bar characteristics) for
 * every timeframe (1m / 5m / 15m / 1h / 4h / 1D).
 *
 * Uses the same compute path as the minute cron so classifications stay in sync.
 * MA and bar-characteristic upserts are idempotent merge-duplicates.
 *
 * Usage:
 *   node --import tsx scripts/backfill-crypto-price-action.mjs
 *   # or: npx tsx scripts/backfill-crypto-price-action.mjs
 *
 * Optional timeframe filter (minutes):
 *   TIMEFRAMES=15,60 node --import tsx scripts/backfill-crypto-price-action.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeCryptoMovingAverages } from "../api/compute-crypto-ma.ts";

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

console.log(
  `Backfilling crypto_price_action` +
    (timeframes.length ? ` (tf=${timeframes.join(",")})` : " (all timeframes)") +
    ` @ ${env.SUPABASE_URL}`,
);

const result = await computeCryptoMovingAverages(env, null, {
  backfill: true,
  skipAuth: true,
  preferStoredHigherTf: true,
  ...(timeframes.length ? { timeframes } : {}),
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
      priceRowsUpserted: result.priceRowsUpserted,
      characteristicRowsUpserted: result.characteristicRowsUpserted,
      priceActionRowsUpserted: result.priceActionRowsUpserted,
    },
    null,
    2,
  ),
);
