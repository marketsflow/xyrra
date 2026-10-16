/**
 * Vercel Cron + admin-triggered crypto_price inserts.
 *
 * Analysis timeframe on each row is always 4h (S/R + stored timeframe=240).
 * Source candle cadence (bucket_start / close) defaults to 4h crypto_prices;
 * pass sourceTimeframe=1 (or ?source=1) for 1m buckets.
 *
 * Incremental (cron, default): latest 4h crypto_prices candle → upsert that bar
 * (includes the open/forming bar so levels exist at Polymarket window open).
 * Backfill: walk source candles from crypto_prices (optional DAYS), including the
 * current open bar when present.
 *
 * price_1m / price_level always come from the 1m crypto_prices candle at (or
 * closest to) the analysis window start — never from the 4h bar's open, which
 * can drift from the live 1m series. Same value is stored as both price_1m and
 * price_level so they stay fixed for the window.

 *
 * EMA (0–50): +10 per bullish ema_9_20_factor among 5m/15m/1h/4h/1D,
 *   scored as-of bucket_start (not the live latest MA).
 * Momentum: crypto_momentum.mom_4h from the previous analysis bucket only
 *   (no other mom_* fallback). Signals fire at timeframe open, so mom generated
 *   for bucket T is stored on the following row T+4h (e.g. mom at 12:00 → 16:00).
 *
 * percentage_sum: sum of the previous 4 crypto_prices.percentage on TF 4h
 *   (excludes the current bar so the sum is fixed at bucket open).
 * After all other fields are set, first matching signal rule wins:
 *   1) 0 < mom < 1% and %sum < -0.50 → Above
 *   2) 0 < mom < 1% and %sum > 1.00 → Below
 *   3) mom > 1% and %sum >= 0.99 → Below
 *   4) mom > 1% and %sum < 0.99 → Above
 *   5) -1% < mom < 0 and %sum > 0.80 → Below
 *   6) mom < 1% and %sum <= -1.00 (fallback) → Above
 *   7) mom < 1% and %sum > -1.00 (fallback) → Below
 *  13) mom is null and %sum > 1.00 and Dist. to resistance < 2% and > -2% → Above
 *      (checked before 8 so near-resistance overrides the general Below)
 *   8) mom is null and %sum > 1.00 and EMA is not reducing → Below
 *   9) mom is null and %sum < 1.20 and EMA is reducing
 *      and Dist. to resistance > 1.5% and EMA < 20
 *      and Dist. from support > 1.5% → Above
 *  14) mom is null and %sum < 1.20 and EMA is reducing
 *      and Dist. to resistance < -2% → Below
 *  10) mom is null and %sum < 0.10 and EMA < 20 → Below
 *  11) mom is null and %sum < 0.10 and (last 3 EMA reducing
 *      OR last 3 Dist. to resistance rising) → Above
 *  12) mom is null and 0.10 <= %sum <= 1.00 and last 3 EMA reducing
 *      and price_level_pct < 0 and Dist. to resistance >= 1% → Below
 *      "reducing" = non-increasing with a net drop (e.g. 50→50→30 counts)
 *      "rising" = non-decreasing with a net rise (e.g. 3.46→3.60→3.73)
 * price_level is always price_1m (nearest 1m open at window start; no ± offset).
 * price_level_pct: (price_level - prev_price_level) / prev_price_level * 100 vs the
 *   prior crypto_price bar. Uses frozen 1m opens, so it does not tick every minute.
 * When no 1m candle is within ±15m of the window start, reuse an existing
 * crypto_price.price_1m for that bucket if present; otherwise skip the bar.
 *
 * BTC only — market_title + price_to_beat from Polymarket for the same 4h window
 *   (slug btc-updown-4h-{unix}). Prefer polymarket_events; fall back to ticks for
 *   price_to_beat. Cron re-upserts the open bar every minute so strike fills in
 *   once ingest has it.
 *
 * Self-contained (no ./lib imports) so Vercel Node ESM can resolve the route.
 */

/** Persisted crypto_price.timeframe + S/R cycle timeframe. */
const ANALYSIS_TIMEFRAME = 240;
/** Default source candles from crypto_prices (override with sourceTimeframe=1). */
const DEFAULT_SOURCE_TIMEFRAME = 240;
const SOURCE_TIMEFRAME_1M = 1;
const ALLOWED_SOURCE_TIMEFRAMES = new Set([SOURCE_TIMEFRAME_1M, ANALYSIS_TIMEFRAME]);
/** Timeframes scored into crypto_price.ema (1m excluded). */
const EMA_SCORE_TIMEFRAMES = [5, 15, 60, 240, 1440] as const;
const EMA_BULLISH_POINTS = 10;
const PAGE_SIZE = 1000;
const UPSERT_CHUNK = 500;
/** Default lookback when backfill=1 and days is omitted. */
const DEFAULT_BACKFILL_DAYS = 7;
const DEFAULT_MOMENTUM_CONFIG_ID = "default_v1";
/** Only this mom_* column is copied into crypto_price.momentum (ANALYSIS_TIMEFRAME). */
const MOMENTUM_COLUMN = "mom_4h" as const;
const SIGNAL_ABOVE = "Above";
const SIGNAL_BELOW = "Below";
/** Only BTC 4h rows get Polymarket market / price_to_beat. */
const BTC_SYMBOL = "BTC";
const WINDOW_SEC = ANALYSIS_TIMEFRAME * 60;
/** Max distance when picking the nearest 1m open for a 4h window start. */
const ONE_M_OPEN_MAX_DELTA_MS = 15 * 60_000;
/** Bars used for percentage_sum (last N × 4h close-%). */
const PCT_LOOKBACK = 4;
/** Momentum band edges in percent units (crypto_price.momentum). */
const MOMENTUM_STRONG_PCT = 1;
/** percentage_sum thresholds in percent units. */
const PCT_SUM_NEGATIVE = -0.5;
const PCT_SUM_FALLBACK = -1;
const PCT_SUM_STRONG = 0.8;
const PCT_SUM_MOM_HIGH = 0.99;
const PCT_SUM_VERY_STRONG = 1.0;
/** Cap for null-mom EMA-reducing rule 9. */
const PCT_SUM_EMA_REDUCING_CAP = 1.2;
/** Split for null-mom trend rules 11 (<) / 12 (>= lower bound). */
const PCT_SUM_TREND_SPLIT = 0.1;
/**
 * Dist. to resistance band for null-mom rules (%):
 *   13: -2 < dist < +2 → Above
 *   9:  dist to resistance > 1.5 and dist from support > 1.5
 *       (with EMA reducing and EMA < 20) → Above
 *  14:  dist < -2 (with EMA reducing) → Below
 *  12:  dist >= 1 (with EMA reducing, %sum in [0.10, 1.00], pl_pct < 0) → Below
 */
const DIST_RESISTANCE_NEAR_PCT = 2;
/** Dist. to resistance floor for null-mom rule 12 (%). */
const DIST_RESISTANCE_RULE12_MIN_PCT = 1;
/** Dist. to resistance / from support floors for null-mom rule 9 (%). */
const DIST_RESISTANCE_RULE9_MIN_PCT = 1.5;
const DIST_SUPPORT_RULE9_MIN_PCT = 1.5;
/** EMA score ceiling for null-mom rule 10 (ema is 0–50). */
const EMA_LOW_THRESHOLD = 20;
/** Bars needed (incl. current) for no-momentum EMA / Dist. resistance reducing rule. */
const SIGNAL_TREND_LOOKBACK = 3;

export type ComputeCryptoPriceEnv = {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  CRON_SECRET?: string;
};

export type ComputeCryptoPriceOptions = {
  /** Walk source-candle history instead of latest bar only. */
  backfill?: boolean;
  /** Backfill lookback in days (omit / 0 = all available source history). */
  days?: number;
  /**
   * crypto_prices timeframe used for bucket_start/open.
   * Default 240 (4h). Set to 1 for per-minute rows.
   */
  sourceTimeframe?: number;
};

type AssetRow = { id: number; symbol: string };

type ActiveCycle = {
  support: number;
  resistance: number;
};

type SrCycleHist = ActiveCycle & {
  started_at: string;
  ended_at: string | null;
  cycle_seq: number;
};

type MaPoint = {
  timestamp: string;
  factor: number | null;
};

type PriceCandle = {
  bucket_start: string;
  /**
   * Price used for price_1m / price_level.
   * For 4h analysis this is the nearest 1m open at window start (not the 4h open).
   */
  open: number;
};

type PctPoint = {
  bucket_start: string;
  percentage: number | null;
};

type CryptoPriceRow = {
  asset_id: number;
  bucket_start: string;
  price_1m: number;
  timeframe: number;
  distance_from_support: number | null;
  distance_to_resistance: number | null;
  signal: string | null;
  /** First-matching rule number (1–14); null when signal is null. */
  signal_rule: number | null;
  price_level: number;
  /** % vs prior bar price_level; frozen (open-based), not live close. */
  price_level_pct: number | null;
  ema: number | null;
  momentum: number | null;
  percentage_sum: number | null;
  /** Polymarket market label (BTC 4h only). */
  market_title: string | null;
  /** Polymarket BTC price to beat / strike (BTC 4h only). */
  price_to_beat: number | null;
  updated_at: string;
};

type PolymarketWindow = {
  market_title: string | null;
  price_to_beat: number | null;
};

type ComputeResult =
  | {
      success: true;
      mode: "incremental" | "backfill";
      sourceTimeframe: number;
      analysisTimeframe: number;
      assets: number;
      rowsInserted: number;
      skippedNoPrice: number;
      skippedNoCycle: number;
      skippedNo1m: number;
      rows: CryptoPriceRow[];
    }
  | { success: false; message: string; status?: number };

/** Parse 1 / 1m / 240 / 4h → source timeframe minutes. */
export function parseSourceTimeframe(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (s === "1" || s === "1m" || s === "1min" || s === "minute") return SOURCE_TIMEFRAME_1M;
  if (s === "240" || s === "4h" || s === "4hr" || s === "4hour") return ANALYSIS_TIMEFRAME;
  const n = Number(s);
  if (Number.isFinite(n) && ALLOWED_SOURCE_TIMEFRAMES.has(n)) return n;
  return null;
}

function isCandleClosed(bucketStart: string, timeframeMinutes: number, nowMs = Date.now()): boolean {
  const startMs = Date.parse(bucketStart);
  if (!Number.isFinite(startMs)) return false;
  return startMs + timeframeMinutes * 60_000 <= nowMs;
}

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

function roundStrike(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function marketSlugForStart(startSec: number) {
  return `btc-updown-4h-${startSec}`;
}

function formatEtClock(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const period = (parts.find((p) => p.type === "dayPeriod")?.value ?? "").toUpperCase();
  return `${hour}:${minute}${period}`;
}

/** e.g. Bitcoin Up or Down - October 16, 12:00AM-4:00AM ET */
function formatPolymarketTitle(startSec: number, endSec: number) {
  const start = new Date(startSec * 1000);
  const end = new Date(endSec * 1000);
  const monthDay = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
  }).format(start);
  return `Bitcoin Up or Down - ${monthDay}, ${formatEtClock(start)}-${formatEtClock(end)} ET`;
}

function windowStartSecFromBucket(bucketStart: string): number | null {
  const ms = Date.parse(bucketStart);
  if (!Number.isFinite(ms)) return null;
  const startSec = Math.floor(ms / 1000);
  if (startSec % WINDOW_SEC !== 0) return null;
  return startSec;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** (current - previous) / previous * 100; null when previous is missing/zero. */
export function priceLevelChangePct(
  current: number,
  previous: number | null,
): number | null {
  if (previous === null || previous === 0) return null;
  return roundPct(((current - previous) / previous) * 100);
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

/** EMA 9/20 factor: 1 bullish, 0 neutral, -1 bearish (null → not bullish). */
export function isEmaBullish(ema920Factor: number | null): boolean {
  return ema920Factor === 1;
}

/**
 * Sum ema_9_20_factor score across the 5 higher TFs only:
 * +10 per bullish (factor = 1), +0 for neutral/bearish/missing.
 * Max 50 (5 × 10). Does not use ema_20_50_factor.
 */
export function computeEmaTotal(
  factorByTimeframe: Map<number, number | null>,
): number {
  let total = 0;
  for (const tf of EMA_SCORE_TIMEFRAMES) {
    if (isEmaBullish(factorByTimeframe.get(tf) ?? null)) {
      total += EMA_BULLISH_POINTS;
    }
  }
  return total;
}

/**
 * Sum of the previous `PCT_LOOKBACK` 4h crypto_prices.percentage values
 * with bucket_start < asOfBucketStart (excludes the current bar so the sum
 * does not change while the open 4h candle's % updates). Null when fewer
 * than 4 prior bars exist or any of those percentages is missing.
 */
export function sumLast4hPercentages(
  percentagesAsc: PctPoint[],
  asOfBucketStart: string,
): number | null {
  const asOfMs = Date.parse(asOfBucketStart);
  if (!Number.isFinite(asOfMs)) return null;

  const eligible: PctPoint[] = [];
  for (const point of percentagesAsc) {
    const tMs = Date.parse(point.bucket_start);
    if (!Number.isFinite(tMs) || tMs >= asOfMs) continue;
    eligible.push(point);
  }
  if (eligible.length < PCT_LOOKBACK) return null;

  const last = eligible.slice(-PCT_LOOKBACK);
  let sum = 0;
  for (const point of last) {
    if (point.percentage === null) return null;
    sum += point.percentage;
  }
  return sum;
}

/**
 * True when the last 3 numeric values are reducing: non-increasing with a net
 * drop (a >= b >= c and a > c). Allows plateaus then a drop (e.g. 50→50→30).
 */
export function isReducingSeries(values: Array<number | null | undefined>): boolean {
  if (values.length < SIGNAL_TREND_LOOKBACK) return false;
  const a = values[values.length - 3];
  const b = values[values.length - 2];
  const c = values[values.length - 1];
  if (a === null || a === undefined) return false;
  if (b === null || b === undefined) return false;
  if (c === null || c === undefined) return false;
  return a >= b && b >= c && a > c;
}

/**
 * True when the last 3 numeric values are rising: non-decreasing with a net
 * rise (a <= b <= c and a < c). Allows plateaus then a rise.
 */
export function isRisingSeries(values: Array<number | null | undefined>): boolean {
  if (values.length < SIGNAL_TREND_LOOKBACK) return false;
  const a = values[values.length - 3];
  const b = values[values.length - 2];
  const c = values[values.length - 1];
  if (a === null || a === undefined) return false;
  if (b === null || b === undefined) return false;
  if (c === null || c === undefined) return false;
  return a <= b && b <= c && a < c;
}

/** @deprecated Use isReducingSeries. */
export function isStrictlyReducing(values: Array<number | null | undefined>): boolean {
  return isReducingSeries(values);
}

export type SignalTrendPrior = {
  ema: number | null;
  distance_to_resistance: number | null;
};

/**
 * Persist percentage_sum, keep price_level = price_1m, then apply signal rules
 * (first match wins). See file header for the rules.
 * `priors` = prior crypto_price bars immediately before this one (oldest→newest),
 * used for the no-momentum EMA / Dist. resistance reducing rule.
 * `priceLevelPct` = change vs prior bar's price_level (needed for rule 12).
 */
export function applySignalRules(
  row: CryptoPriceRow,
  pctSum: number | null,
  priors: SignalTrendPrior[] = [],
  priceLevelPct: number | null = null,
): CryptoPriceRow {
  const price1m = roundPrice(row.price_1m);
  const withSum: CryptoPriceRow = {
    ...row,
    price_level: price1m,
    percentage_sum: pctSum === null ? null : roundPct(pctSum),
    price_level_pct: priceLevelPct,
    signal: null,
    signal_rule: null,
  };

  const set = (signal: string, rule: number): CryptoPriceRow => ({
    ...withSum,
    signal,
    signal_rule: rule,
    price_level: price1m,
  });

  const mom = withSum.momentum;

  // Rules 1–7 require a momentum value.
  if (mom !== null) {
    // 1) 0 < mom < 1% and %sum < -0.50 → Above
    if (mom > 0 && mom < MOMENTUM_STRONG_PCT && pctSum !== null && pctSum < PCT_SUM_NEGATIVE) {
      return set(SIGNAL_ABOVE, 1);
    }
    // 2) 0 < mom < 1% and %sum > 1.00 → Below
    if (mom > 0 && mom < MOMENTUM_STRONG_PCT && pctSum !== null && pctSum > PCT_SUM_VERY_STRONG) {
      return set(SIGNAL_BELOW, 2);
    }
    // 3) mom > 1% and %sum >= 0.99 → Below
    if (mom > MOMENTUM_STRONG_PCT && pctSum !== null && pctSum >= PCT_SUM_MOM_HIGH) {
      return set(SIGNAL_BELOW, 3);
    }
    // 4) mom > 1% and %sum < 0.99 → Above
    if (mom > MOMENTUM_STRONG_PCT && pctSum !== null && pctSum < PCT_SUM_MOM_HIGH) {
      return set(SIGNAL_ABOVE, 4);
    }
    // 5) -1% < mom < 0 and %sum > 0.80 → Below
    if (mom < 0 && mom > -MOMENTUM_STRONG_PCT && pctSum !== null && pctSum > PCT_SUM_STRONG) {
      return set(SIGNAL_BELOW, 5);
    }
    // 6) mom < 1% and %sum <= -1.00 (fallback) → Above
    if (mom < MOMENTUM_STRONG_PCT && pctSum !== null && pctSum <= PCT_SUM_FALLBACK) {
      return set(SIGNAL_ABOVE, 6);
    }
    // 7) mom < 1% and %sum > -1.00 (fallback) → Below
    if (mom < MOMENTUM_STRONG_PCT && pctSum !== null && pctSum > PCT_SUM_FALLBACK) {
      return set(SIGNAL_BELOW, 7);
    }
    return withSum;
  }

  const emaSeries = [...priors.map((p) => p.ema), withSum.ema];
  const distSeries = [
    ...priors.map((p) => p.distance_to_resistance),
    withSum.distance_to_resistance,
  ];
  const emaReducing = isReducingSeries(emaSeries);
  const trendSignal = emaReducing || isRisingSeries(distSeries);

  // 13) mom is null and %sum > 1.00 and Dist. to resistance < 2% and > -2% → Above
  // Checked before 8 so near-resistance Above wins over the general Below.
  if (
    pctSum !== null &&
    pctSum > PCT_SUM_VERY_STRONG &&
    withSum.distance_to_resistance !== null &&
    withSum.distance_to_resistance < DIST_RESISTANCE_NEAR_PCT &&
    withSum.distance_to_resistance > -DIST_RESISTANCE_NEAR_PCT
  ) {
    return set(SIGNAL_ABOVE, 13);
  }

  // 8) mom is null and %sum > 1.00 and EMA is not reducing → Below
  if (pctSum !== null && pctSum > PCT_SUM_VERY_STRONG && !emaReducing) {
    return set(SIGNAL_BELOW, 8);
  }

  // 9) mom is null and %sum < 1.20 and EMA reducing and Dist. to resistance > 1.5%
  //    and EMA < 20 and Dist. from support > 1.5% → Above
  if (
    pctSum !== null &&
    pctSum < PCT_SUM_EMA_REDUCING_CAP &&
    emaReducing &&
    withSum.distance_to_resistance !== null &&
    withSum.distance_to_resistance > DIST_RESISTANCE_RULE9_MIN_PCT &&
    withSum.ema !== null &&
    withSum.ema < EMA_LOW_THRESHOLD &&
    withSum.distance_from_support !== null &&
    withSum.distance_from_support > DIST_SUPPORT_RULE9_MIN_PCT
  ) {
    return set(SIGNAL_ABOVE, 9);
  }

  // 14) mom is null and %sum < 1.20 and EMA reducing and Dist. to resistance < -2% → Below
  if (
    pctSum !== null &&
    pctSum < PCT_SUM_EMA_REDUCING_CAP &&
    emaReducing &&
    withSum.distance_to_resistance !== null &&
    withSum.distance_to_resistance < -DIST_RESISTANCE_NEAR_PCT
  ) {
    return set(SIGNAL_BELOW, 14);
  }

  // 10) mom is null and %sum < 0.10 and EMA < 20 → Below
  if (
    pctSum !== null &&
    pctSum < PCT_SUM_TREND_SPLIT &&
    withSum.ema !== null &&
    withSum.ema < EMA_LOW_THRESHOLD
  ) {
    return set(SIGNAL_BELOW, 10);
  }

  // 11) mom is null and %sum < 0.10 and last 3 EMA reducing and/or Dist. rising → Above
  if (trendSignal && pctSum !== null && pctSum < PCT_SUM_TREND_SPLIT) {
    return set(SIGNAL_ABOVE, 11);
  }

  // 12) mom is null and 0.10 <= %sum <= 1.00 and EMA reducing
  //     and price_level_pct < 0 and Dist. to resistance >= 1% → Below
  if (
    emaReducing &&
    pctSum !== null &&
    pctSum >= PCT_SUM_TREND_SPLIT &&
    pctSum <= PCT_SUM_VERY_STRONG &&
    priceLevelPct !== null &&
    priceLevelPct < 0 &&
    withSum.distance_to_resistance !== null &&
    withSum.distance_to_resistance >= DIST_RESISTANCE_RULE12_MIN_PCT
  ) {
    return set(SIGNAL_BELOW, 12);
  }

  return withSum;
}

/** @deprecated Use applySignalRules. */
export function applyAboveSignalRule(
  row: CryptoPriceRow,
  pctSum: number | null,
): CryptoPriceRow {
  return applySignalRules(row, pctSum);
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

async function fetchLatestSourceCandle(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
  sourceTimeframe: number,
  options: { closedOnly?: boolean } = {},
): Promise<PriceCandle | null> {
  const base = supabaseUrl.replace(/\/$/, "");
  const limit = options.closedOnly ? 3 : 1;
  const res = await fetch(
    `${base}/rest/v1/crypto_prices?select=bucket_start,open&asset_id=eq.${assetId}&timeframe=eq.${sourceTimeframe}&order=bucket_start.desc&limit=${limit}`,
    { headers: restHeaders(serviceKey) },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Failed to load latest crypto_prices tf=${sourceTimeframe}: ${text.slice(0, 300)}`,
    );
  }
  const rows = (await res.json()) as Array<{ bucket_start?: unknown; open?: unknown }>;
  for (const row of rows) {
    const open = parseNumber(row.open);
    const bucketStart =
      typeof row.bucket_start === "string" ? row.bucket_start : null;
    if (open === null || !bucketStart) continue;
    if (options.closedOnly && !isCandleClosed(bucketStart, sourceTimeframe)) continue;
    return { bucket_start: bucketStart, open };
  }
  return null;
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

/**
 * ema_9_20_factor per higher timeframe as-of `asOfIso` (timestamp <= asOf).
 * One query per TF so slower TFs (4h/1D) are not crowded out by 5m/15m rows.
 * Keeps crypto_price.ema fixed for a bucket instead of tracking live MAs.
 */
async function fetchEmaFactorsAsOf(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
  asOfIso: string,
): Promise<Map<number, number | null>> {
  const base = supabaseUrl.replace(/\/$/, "");
  const results = await Promise.all(
    EMA_SCORE_TIMEFRAMES.map(async (tf) => {
      const res = await fetch(
        `${base}/rest/v1/crypto_moving_averages?select=ema_9_20_factor&asset_id=eq.${assetId}&timeframe=eq.${tf}&timestamp=lte.${encodeURIComponent(asOfIso)}&order=timestamp.desc&limit=1`,
        { headers: restHeaders(serviceKey) },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Failed to load crypto_moving_averages tf=${tf} as-of ${asOfIso}: ${text.slice(0, 300)}`,
        );
      }
      const rows = (await res.json()) as Array<{ ema_9_20_factor?: unknown }>;
      return [tf, parseNumber(rows[0]?.ema_9_20_factor)] as const;
    }),
  );
  return new Map(results);
}

/**
 * Ascending 4h percentage series from crypto_prices (for Above signal rule).
 * When fromIso is set, loads a few extra prior bars so early rows still have
 * a full 4-bar lookback.
 */
async function fetch4hPercentagesAsc(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
  fromIso: string | null,
): Promise<PctPoint[]> {
  const base = supabaseUrl.replace(/\/$/, "");
  const points: PctPoint[] = [];
  let offset = 0;
  const lookbackMs = PCT_LOOKBACK * ANALYSIS_TIMEFRAME * 60_000;
  const fromFilter = fromIso
    ? `&bucket_start=gte.${encodeURIComponent(
        new Date(Date.parse(fromIso) - lookbackMs).toISOString(),
      )}`
    : "";

  while (true) {
    const end = offset + PAGE_SIZE - 1;
    const res = await fetch(
      `${base}/rest/v1/crypto_prices?select=bucket_start,percentage&asset_id=eq.${assetId}&timeframe=eq.${ANALYSIS_TIMEFRAME}${fromFilter}&order=bucket_start.asc`,
      {
        headers: restHeaders(serviceKey, {
          Prefer: "count=exact",
          Range: `${offset}-${end}`,
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Failed to load 4h crypto_prices percentages: ${text.slice(0, 300)}`,
      );
    }
    const page = (await res.json()) as Array<{
      bucket_start?: unknown;
      percentage?: unknown;
    }>;
    for (const row of page) {
      const bucketStart =
        typeof row.bucket_start === "string" ? row.bucket_start : null;
      if (!bucketStart) continue;
      points.push({
        bucket_start: bucketStart,
        percentage: parseNumber(row.percentage),
      });
    }
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return points;
}

/** Ascending source candles from crypto_prices. */
async function fetchSourceCandlesAsc(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
  sourceTimeframe: number,
  fromIso: string | null,
  options: { closedOnly?: boolean } = {},
): Promise<PriceCandle[]> {
  const base = supabaseUrl.replace(/\/$/, "");
  const candles: PriceCandle[] = [];
  let offset = 0;
  const fromFilter = fromIso
    ? `&bucket_start=gte.${encodeURIComponent(fromIso)}`
    : "";

  while (true) {
    const end = offset + PAGE_SIZE - 1;
    const res = await fetch(
      `${base}/rest/v1/crypto_prices?select=bucket_start,open&asset_id=eq.${assetId}&timeframe=eq.${sourceTimeframe}${fromFilter}&order=bucket_start.asc`,
      {
        headers: restHeaders(serviceKey, {
          Prefer: "count=exact",
          Range: `${offset}-${end}`,
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Failed to load crypto_prices tf=${sourceTimeframe}: ${text.slice(0, 300)}`,
      );
    }
    const page = (await res.json()) as Array<{ bucket_start?: unknown; open?: unknown }>;
    for (const row of page) {
      const open = parseNumber(row.open);
      const bucketStart =
        typeof row.bucket_start === "string" ? row.bucket_start : null;
      if (open === null || !bucketStart) continue;
      if (options.closedOnly && !isCandleClosed(bucketStart, sourceTimeframe)) continue;
      candles.push({ bucket_start: bucketStart, open });
    }
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return candles;
}

function bucketStartMs(bucketStart: string): number | null {
  const ms = Date.parse(bucketStart);
  return Number.isFinite(ms) ? ms : null;
}

/** Canonical UTC ISO (…Z) so query strings never turn `+00:00` into a space. */
function toUtcIso(bucketStart: string): string | null {
  const ms = bucketStartMs(bucketStart);
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Exact 1m opens keyed by bucket_start ms for the given timestamps.
 */
async function fetchOneMinuteOpensExact(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
  bucketStarts: string[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (bucketStarts.length === 0) return out;
  const base = supabaseUrl.replace(/\/$/, "");
  const unique = [
    ...new Set(
      bucketStarts
        .map((s) => toUtcIso(s))
        .filter((s): s is string => Boolean(s)),
    ),
  ];
  const chunkSize = 80;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    // Quote each ISO; use Z form so `+` is never decoded as a space in the query.
    const inList = chunk.map((s) => `"${s}"`).join(",");
    const res = await fetch(
      `${base}/rest/v1/crypto_prices?select=bucket_start,open&asset_id=eq.${assetId}&timeframe=eq.${SOURCE_TIMEFRAME_1M}&bucket_start=in.(${inList})`,
      { headers: restHeaders(serviceKey) },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to load 1m crypto_prices opens: ${text.slice(0, 300)}`);
    }
    const rows = (await res.json()) as Array<{ bucket_start?: unknown; open?: unknown }>;
    for (const row of rows) {
      const bucketStart =
        typeof row.bucket_start === "string" ? row.bucket_start : null;
      const open = parseNumber(row.open);
      const ms = bucketStart ? bucketStartMs(bucketStart) : null;
      if (ms === null || open === null) continue;
      out.set(ms, open);
    }
  }
  return out;
}

/**
 * Nearest 1m open to targetIso within ±ONE_M_OPEN_MAX_DELTA_MS.
 * Prefers exact bucket_start match when present.
 */
async function fetchClosestOneMinuteOpen(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
  targetIso: string,
): Promise<number | null> {
  const targetMs = bucketStartMs(targetIso);
  if (targetMs === null) return null;
  const base = supabaseUrl.replace(/\/$/, "");
  const fromIso = new Date(targetMs - ONE_M_OPEN_MAX_DELTA_MS).toISOString();
  const toIso = new Date(targetMs + ONE_M_OPEN_MAX_DELTA_MS).toISOString();

  const [beforeRes, afterRes] = await Promise.all([
    fetch(
      `${base}/rest/v1/crypto_prices?select=bucket_start,open&asset_id=eq.${assetId}&timeframe=eq.${SOURCE_TIMEFRAME_1M}&bucket_start=gte.${encodeURIComponent(fromIso)}&bucket_start=lte.${encodeURIComponent(targetIso)}&order=bucket_start.desc&limit=1`,
      { headers: restHeaders(serviceKey) },
    ),
    fetch(
      `${base}/rest/v1/crypto_prices?select=bucket_start,open&asset_id=eq.${assetId}&timeframe=eq.${SOURCE_TIMEFRAME_1M}&bucket_start=gte.${encodeURIComponent(targetIso)}&bucket_start=lte.${encodeURIComponent(toIso)}&order=bucket_start.asc&limit=1`,
      { headers: restHeaders(serviceKey) },
    ),
  ]);

  if (!beforeRes.ok) {
    const text = await beforeRes.text();
    throw new Error(`Failed to load nearest 1m open (before): ${text.slice(0, 300)}`);
  }
  if (!afterRes.ok) {
    const text = await afterRes.text();
    throw new Error(`Failed to load nearest 1m open (after): ${text.slice(0, 300)}`);
  }

  type Row = { bucket_start?: unknown; open?: unknown };
  const beforeRows = (await beforeRes.json()) as Row[];
  const afterRows = (await afterRes.json()) as Row[];

  const candidates: Array<{ ms: number; open: number }> = [];
  for (const row of [...beforeRows, ...afterRows]) {
    const bucketStart =
      typeof row.bucket_start === "string" ? row.bucket_start : null;
    const open = parseNumber(row.open);
    const ms = bucketStart ? bucketStartMs(bucketStart) : null;
    if (ms === null || open === null) continue;
    if (Math.abs(ms - targetMs) > ONE_M_OPEN_MAX_DELTA_MS) continue;
    candidates.push({ ms, open });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const da = Math.abs(a.ms - targetMs);
    const db = Math.abs(b.ms - targetMs);
    if (da !== db) return da - db;
    // Tie-break: prefer at-or-before the window start.
    return b.ms - a.ms;
  });
  return candidates[0].open;
}

/**
 * Existing crypto_price.price_1m keyed by bucket_start ms (analysis TF).
 * Used when a live 1m open is missing so rule backfills can still refresh
 * historical rows that already have a stored price level.
 */
async function fetchExistingPrice1mByBucket(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
  bucketStarts: string[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (bucketStarts.length === 0) return out;
  const base = supabaseUrl.replace(/\/$/, "");
  const unique = [
    ...new Set(
      bucketStarts
        .map((s) => toUtcIso(s))
        .filter((s): s is string => Boolean(s)),
    ),
  ];
  const chunkSize = 80;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const inList = chunk.map((s) => `"${s}"`).join(",");
    const res = await fetch(
      `${base}/rest/v1/crypto_price?select=bucket_start,price_1m&asset_id=eq.${assetId}&timeframe=eq.${ANALYSIS_TIMEFRAME}&bucket_start=in.(${inList})`,
      { headers: restHeaders(serviceKey) },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to load existing crypto_price.price_1m: ${text.slice(0, 300)}`);
    }
    const rows = (await res.json()) as Array<{
      bucket_start?: unknown;
      price_1m?: unknown;
    }>;
    for (const row of rows) {
      const bucketStart =
        typeof row.bucket_start === "string" ? row.bucket_start : null;
      const price1m = parseNumber(row.price_1m);
      const ms = bucketStart ? bucketStartMs(bucketStart) : null;
      if (ms === null || price1m === null) continue;
      out.set(ms, price1m);
    }
  }
  return out;
}

/**
 * Replace each candle.open with the nearest 1m open at that window start.
 * When source is already 1m, candles are returned unchanged.
 * If no 1m open is found, fall back to an existing crypto_price.price_1m.
 */
async function resolveCandlesWithOneMinuteOpen(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
  sourceTimeframe: number,
  candles: PriceCandle[],
): Promise<{ candles: PriceCandle[]; skippedNo1m: number }> {
  if (candles.length === 0) return { candles, skippedNo1m: 0 };
  if (sourceTimeframe === SOURCE_TIMEFRAME_1M) {
    return { candles, skippedNo1m: 0 };
  }

  const exact = await fetchOneMinuteOpensExact(
    supabaseUrl,
    serviceKey,
    assetId,
    candles.map((c) => c.bucket_start),
  );

  const resolved: PriceCandle[] = [];
  let skippedNo1m = 0;
  const needClosest: PriceCandle[] = [];

  for (const candle of candles) {
    const ms = bucketStartMs(candle.bucket_start);
    const open = ms === null ? null : (exact.get(ms) ?? null);
    if (open !== null) {
      resolved.push({ bucket_start: candle.bucket_start, open });
    } else {
      needClosest.push(candle);
    }
  }

  const stillMissing: PriceCandle[] = [];
  const closestConcurrency = 8;
  for (let i = 0; i < needClosest.length; i += closestConcurrency) {
    const chunk = needClosest.slice(i, i + closestConcurrency);
    const opens = await Promise.all(
      chunk.map((c) =>
        fetchClosestOneMinuteOpen(supabaseUrl, serviceKey, assetId, c.bucket_start),
      ),
    );
    for (let j = 0; j < chunk.length; j++) {
      const open = opens[j];
      if (open === null) {
        stillMissing.push(chunk[j]);
        continue;
      }
      resolved.push({ bucket_start: chunk[j].bucket_start, open });
    }
  }

  if (stillMissing.length > 0) {
    const existing = await fetchExistingPrice1mByBucket(
      supabaseUrl,
      serviceKey,
      assetId,
      stillMissing.map((c) => c.bucket_start),
    );
    for (const candle of stillMissing) {
      const ms = bucketStartMs(candle.bucket_start);
      const price1m = ms === null ? null : (existing.get(ms) ?? null);
      if (price1m === null) {
        skippedNo1m += 1;
        continue;
      }
      resolved.push({ bucket_start: candle.bucket_start, open: price1m });
    }
  }

  // Keep original source order (closest pass may append out of order).
  const byMs = new Map(
    resolved.map((c) => [bucketStartMs(c.bucket_start) ?? -1, c] as const),
  );
  const ordered: PriceCandle[] = [];
  for (const candle of candles) {
    const ms = bucketStartMs(candle.bucket_start);
    if (ms === null) continue;
    const hit = byMs.get(ms);
    if (hit) ordered.push(hit);
  }
  return { candles: ordered, skippedNo1m };
}

async function fetchSrCyclesAsc(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
  timeframe: number,
): Promise<SrCycleHist[]> {
  const base = supabaseUrl.replace(/\/$/, "");
  const cycles: SrCycleHist[] = [];
  let offset = 0;

  while (true) {
    const end = offset + PAGE_SIZE - 1;
    const res = await fetch(
      `${base}/rest/v1/crypto_support_resistance?select=support,resistance,started_at,ended_at,cycle_seq&asset_id=eq.${assetId}&timeframe=eq.${timeframe}&order=cycle_seq.asc`,
      {
        headers: restHeaders(serviceKey, {
          Prefer: "count=exact",
          Range: `${offset}-${end}`,
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Failed to load crypto_support_resistance tf=${timeframe}: ${text.slice(0, 300)}`,
      );
    }
    const page = (await res.json()) as Array<{
      support?: unknown;
      resistance?: unknown;
      started_at?: unknown;
      ended_at?: unknown;
      cycle_seq?: unknown;
    }>;
    for (const row of page) {
      const support = parseNumber(row.support);
      const resistance = parseNumber(row.resistance);
      const cycleSeq = parseNumber(row.cycle_seq);
      const startedAt =
        typeof row.started_at === "string" ? row.started_at : null;
      if (support === null || resistance === null || cycleSeq === null || !startedAt) {
        continue;
      }
      cycles.push({
        support,
        resistance,
        started_at: startedAt,
        ended_at: typeof row.ended_at === "string" ? row.ended_at : null,
        cycle_seq: cycleSeq,
      });
    }
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return cycles;
}

async function fetchMaSeriesAsc(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
  timeframe: number,
  fromIso: string | null,
): Promise<MaPoint[]> {
  const base = supabaseUrl.replace(/\/$/, "");
  const points: MaPoint[] = [];

  // Seed with the last factor before the window so early bars aren't scored as 0.
  if (fromIso) {
    const seedRes = await fetch(
      `${base}/rest/v1/crypto_moving_averages?select=timestamp,ema_9_20_factor&asset_id=eq.${assetId}&timeframe=eq.${timeframe}&timestamp=lt.${encodeURIComponent(fromIso)}&order=timestamp.desc&limit=1`,
      { headers: restHeaders(serviceKey) },
    );
    if (!seedRes.ok) {
      const text = await seedRes.text();
      throw new Error(
        `Failed to seed crypto_moving_averages tf=${timeframe}: ${text.slice(0, 300)}`,
      );
    }
    const seedRows = (await seedRes.json()) as Array<{
      timestamp?: unknown;
      ema_9_20_factor?: unknown;
    }>;
    const seedTs =
      typeof seedRows[0]?.timestamp === "string" ? seedRows[0].timestamp : null;
    if (seedTs) {
      points.push({
        timestamp: seedTs,
        factor: parseNumber(seedRows[0]?.ema_9_20_factor),
      });
    }
  }

  let offset = 0;
  const fromFilter = fromIso
    ? `&timestamp=gte.${encodeURIComponent(fromIso)}`
    : "";

  while (true) {
    const end = offset + PAGE_SIZE - 1;
    const res = await fetch(
      `${base}/rest/v1/crypto_moving_averages?select=timestamp,ema_9_20_factor&asset_id=eq.${assetId}&timeframe=eq.${timeframe}${fromFilter}&order=timestamp.asc`,
      {
        headers: restHeaders(serviceKey, {
          Prefer: "count=exact",
          Range: `${offset}-${end}`,
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Failed to load crypto_moving_averages tf=${timeframe}: ${text.slice(0, 300)}`,
      );
    }
    const page = (await res.json()) as Array<{
      timestamp?: unknown;
      ema_9_20_factor?: unknown;
    }>;
    for (const row of page) {
      const ts = typeof row.timestamp === "string" ? row.timestamp : null;
      if (!ts) continue;
      points.push({ timestamp: ts, factor: parseNumber(row.ema_9_20_factor) });
    }
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return points;
}

/** Cycle open at minute T (includes the breach bar; prefers breached over brand-new). */
export function cycleAtTime(cycles: SrCycleHist[], bucketStart: string): SrCycleHist | null {
  const tMs = Date.parse(bucketStart);
  if (!Number.isFinite(tMs)) return null;
  let chosen: SrCycleHist | null = null;
  for (const c of cycles) {
    const startMs = Date.parse(c.started_at);
    if (!Number.isFinite(startMs) || startMs > tMs) break;
    const endMs = c.ended_at ? Date.parse(c.ended_at) : null;
    if (endMs !== null && Number.isFinite(endMs) && endMs < tMs) continue;
    if (
      chosen &&
      chosen.ended_at === bucketStart &&
      c.started_at === bucketStart &&
      c.ended_at !== bucketStart
    ) {
      continue;
    }
    chosen = c;
  }
  return chosen;
}

/** Advance pointer through ascending MA series; return factor as-of tMs. */
function factorAsOf(
  series: MaPoint[],
  tMs: number,
  state: { i: number },
): number | null {
  while (
    state.i + 1 < series.length &&
    Date.parse(series[state.i + 1]!.timestamp) <= tMs
  ) {
    state.i += 1;
  }
  if (state.i < 0 || state.i >= series.length) return null;
  const point = series[state.i]!;
  if (Date.parse(point.timestamp) > tMs) return null;
  return point.factor;
}

function momentumTsKey(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Prior analysis-TF bucket start (ms) — source of mom for the current open. */
function previousMomentumBucketMs(bucketStartMs: number): number {
  return bucketStartMs - ANALYSIS_TIMEFRAME * 60_000;
}

function previousMomentumBucketIso(bucketStartIso: string): string | null {
  const ms = Date.parse(bucketStartIso);
  if (!Number.isFinite(ms)) return null;
  return new Date(previousMomentumBucketMs(ms)).toISOString();
}

/** Copy mom_4h only — null when that column is missing (no other-TF fallback). */
export function pickMomentumValue(row: Record<string, unknown>): number | null {
  return parseNumber(row[MOMENTUM_COLUMN]);
}

async function fetchMomentumAtTimestamp(
  supabaseUrl: string,
  serviceKey: string,
  assetSymbol: string,
  timestampIso: string,
): Promise<number | null> {
  const targetMs = momentumTsKey(timestampIso);
  if (targetMs === null) return null;
  const base = supabaseUrl.replace(/\/$/, "");
  // Fetch a few rows at/before target so ISO format variants still match by ms.
  const res = await fetch(
    `${base}/rest/v1/crypto_momentum?select=timestamp,${MOMENTUM_COLUMN}&asset_symbol=eq.${encodeURIComponent(assetSymbol)}&timestamp=lte.${encodeURIComponent(timestampIso)}&config_id=eq.${encodeURIComponent(DEFAULT_MOMENTUM_CONFIG_ID)}&order=timestamp.desc&limit=5`,
    { headers: restHeaders(serviceKey) },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to load crypto_momentum: ${text.slice(0, 300)}`);
  }
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const ts = typeof row.timestamp === "string" ? momentumTsKey(row.timestamp) : null;
    if (ts !== targetMs) continue;
    return pickMomentumValue(row);
  }
  return null;
}

/**
 * Load crypto_momentum rows for an asset (optional fromIso window) keyed by
 * timestamp ms for exact bucket matches during backfill.
 */
async function fetchMomentumByTimestamp(
  supabaseUrl: string,
  serviceKey: string,
  assetSymbol: string,
  fromIso: string | null,
): Promise<Map<number, number>> {
  const base = supabaseUrl.replace(/\/$/, "");
  const byTs = new Map<number, number>();
  let offset = 0;
  const fromFilter = fromIso
    ? `&timestamp=gte.${encodeURIComponent(fromIso)}`
    : "";

  while (true) {
    const end = offset + PAGE_SIZE - 1;
    const res = await fetch(
      `${base}/rest/v1/crypto_momentum?select=timestamp,${MOMENTUM_COLUMN}&asset_symbol=eq.${encodeURIComponent(assetSymbol)}&config_id=eq.${encodeURIComponent(DEFAULT_MOMENTUM_CONFIG_ID)}${fromFilter}&order=timestamp.asc`,
      {
        headers: restHeaders(serviceKey, {
          Prefer: "count=exact",
          Range: `${offset}-${end}`,
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to load crypto_momentum: ${text.slice(0, 300)}`);
    }
    const page = (await res.json()) as Array<Record<string, unknown>>;
    for (const row of page) {
      const ts =
        typeof row.timestamp === "string" ? momentumTsKey(row.timestamp) : null;
      const value = pickMomentumValue(row);
      if (ts === null || value === null) continue;
      byTs.set(ts, value);
    }
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return byTs;
}

/**
 * Prior crypto_price bars immediately before `beforeBucketStart` (oldest→newest),
 * for the no-momentum EMA / Dist. resistance reducing signal rule.
 */
async function fetchPreviousPriceLevel(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
  beforeBucketStart: string,
): Promise<number | null> {
  const base = supabaseUrl.replace(/\/$/, "");
  const res = await fetch(
    `${base}/rest/v1/crypto_price?select=price_level&asset_id=eq.${assetId}&timeframe=eq.${ANALYSIS_TIMEFRAME}&bucket_start=lt.${encodeURIComponent(beforeBucketStart)}&order=bucket_start.desc&limit=1`,
    { headers: restHeaders(serviceKey) },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to load previous crypto_price level: ${text.slice(0, 300)}`);
  }
  const rows = (await res.json()) as Array<{ price_level?: unknown }>;
  return parseNumber(rows[0]?.price_level);
}

async function fetchPriorSignalTrend(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
  beforeBucketStart: string,
): Promise<SignalTrendPrior[]> {
  const base = supabaseUrl.replace(/\/$/, "");
  const limit = SIGNAL_TREND_LOOKBACK - 1;
  const res = await fetch(
    `${base}/rest/v1/crypto_price?select=ema,distance_to_resistance&asset_id=eq.${assetId}&timeframe=eq.${ANALYSIS_TIMEFRAME}&bucket_start=lt.${encodeURIComponent(beforeBucketStart)}&order=bucket_start.desc&limit=${limit}`,
    { headers: restHeaders(serviceKey) },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to load prior crypto_price trend: ${text.slice(0, 300)}`);
  }
  const rows = (await res.json()) as Array<{
    ema?: unknown;
    distance_to_resistance?: unknown;
  }>;
  // Queried newest-first; reverse to oldest→newest for the reducing check.
  return rows
    .slice()
    .reverse()
    .map((row) => ({
      ema: parseNumber(row.ema),
      distance_to_resistance: parseNumber(row.distance_to_resistance),
    }));
}

async function insertCryptoPriceRows(
  supabaseUrl: string,
  serviceKey: string,
  rows: CryptoPriceRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const base = supabaseUrl.replace(/\/$/, "");
  let inserted = 0;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const res = await fetch(
      `${base}/rest/v1/crypto_price?on_conflict=asset_id,timeframe,bucket_start`,
      {
        method: "POST",
        headers: restHeaders(serviceKey, {
          Prefer: "resolution=merge-duplicates,return=minimal",
        }),
        body: JSON.stringify(chunk),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to insert crypto_price: ${text.slice(0, 300)}`);
    }
    inserted += chunk.length;
  }
  return inserted;
}

async function fetchPolymarketEventsBySlugs(
  supabaseUrl: string,
  serviceKey: string,
  slugs: string[],
): Promise<Map<string, PolymarketWindow>> {
  const out = new Map<string, PolymarketWindow>();
  if (slugs.length === 0) return out;
  const base = supabaseUrl.replace(/\/$/, "");
  const unique = [...new Set(slugs)];
  const chunkSize = 80;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const inList = chunk.map((s) => `"${s.replaceAll('"', '\\"')}"`).join(",");
    const res = await fetch(
      `${base}/rest/v1/polymarket_events?select=slug,title,price_to_beat&slug=in.(${inList})`,
      { headers: restHeaders(serviceKey) },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to load polymarket_events: ${text.slice(0, 300)}`);
    }
    const rows = (await res.json()) as Array<{
      slug?: unknown;
      title?: unknown;
      price_to_beat?: unknown;
    }>;
    for (const row of rows) {
      const slug = asTrimmedString(row.slug);
      if (!slug) continue;
      out.set(slug, {
        market_title: asTrimmedString(row.title),
        price_to_beat: parseNumber(row.price_to_beat),
      });
    }
  }
  return out;
}

async function fetchPriceToBeatFromTicks(
  supabaseUrl: string,
  serviceKey: string,
  slug: string,
): Promise<number | null> {
  const base = supabaseUrl.replace(/\/$/, "");
  const res = await fetch(
    `${base}/rest/v1/polymarket_ticks?select=price_to_beat&event_slug=eq.${encodeURIComponent(slug)}&price_to_beat=not.is.null&order=recorded_at.asc&limit=1`,
    { headers: restHeaders(serviceKey) },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to load polymarket_ticks price_to_beat: ${text.slice(0, 300)}`);
  }
  const rows = (await res.json()) as Array<{ price_to_beat?: unknown }>;
  return parseNumber(rows[0]?.price_to_beat);
}

async function attachPolymarketFields(
  supabaseUrl: string,
  serviceKey: string,
  asset: AssetRow,
  rows: CryptoPriceRow[],
): Promise<void> {
  if (asset.symbol.toUpperCase() !== BTC_SYMBOL || rows.length === 0) return;

  const slugs: string[] = [];
  for (const row of rows) {
    const startSec = windowStartSecFromBucket(row.bucket_start);
    if (startSec === null) continue;
    slugs.push(marketSlugForStart(startSec));
  }
  const eventsBySlug = await fetchPolymarketEventsBySlugs(supabaseUrl, serviceKey, slugs);

  // First pass: title + event strike (no tick round-trips).
  const needTick: Array<{ row: CryptoPriceRow; slug: string }> = [];
  for (const row of rows) {
    const startSec = windowStartSecFromBucket(row.bucket_start);
    if (startSec === null) {
      row.market_title = null;
      row.price_to_beat = null;
      continue;
    }
    const endSec = startSec + WINDOW_SEC;
    const slug = marketSlugForStart(startSec);
    const event = eventsBySlug.get(slug);
    row.market_title = event?.market_title ?? formatPolymarketTitle(startSec, endSec);
    if (event?.price_to_beat !== null && event?.price_to_beat !== undefined) {
      row.price_to_beat = roundStrike(event.price_to_beat);
    } else {
      row.price_to_beat = null;
      needTick.push({ row, slug });
    }
  }

  // Second pass: tick fallback for missing strikes (batched concurrency).
  const tickConcurrency = 8;
  for (let i = 0; i < needTick.length; i += tickConcurrency) {
    const chunk = needTick.slice(i, i + tickConcurrency);
    const strikes = await Promise.all(
      chunk.map((item) => fetchPriceToBeatFromTicks(supabaseUrl, serviceKey, item.slug)),
    );
    for (let j = 0; j < chunk.length; j++) {
      const strike = strikes[j];
      chunk[j].row.price_to_beat = strike === null ? null : roundStrike(strike);
    }
  }
}

function buildRow(
  assetId: number,
  candle: PriceCandle,
  cycle: ActiveCycle,
  emaTotal: number,
  momentum: number | null,
  updatedAt: string,
): CryptoPriceRow {
  const price = roundPrice(candle.open);
  return {
    asset_id: assetId,
    bucket_start: candle.bucket_start,
    price_1m: price,
    timeframe: ANALYSIS_TIMEFRAME,
    distance_from_support: distanceFromSupportPct(price, cycle.support),
    distance_to_resistance: distanceToResistancePct(price, cycle.resistance),
    signal: null,
    signal_rule: null,
    price_level: price,
    price_level_pct: null,
    ema: emaTotal,
    momentum,
    percentage_sum: null,
    market_title: null,
    price_to_beat: null,
    updated_at: updatedAt,
  };
}

async function backfillAsset(
  supabaseUrl: string,
  serviceKey: string,
  asset: AssetRow,
  sourceTimeframe: number,
  fromIso: string | null,
  updatedAt: string,
): Promise<{ rows: CryptoPriceRow[]; skippedNoCycle: number; skippedNo1m: number }> {
  const sourceCandles = await fetchSourceCandlesAsc(
    supabaseUrl,
    serviceKey,
    asset.id,
    sourceTimeframe,
    fromIso,
    { closedOnly: false },
  );
  if (sourceCandles.length === 0) {
    return { rows: [], skippedNoCycle: 0, skippedNo1m: 0 };
  }

  const { candles, skippedNo1m } = await resolveCandlesWithOneMinuteOpen(
    supabaseUrl,
    serviceKey,
    asset.id,
    sourceTimeframe,
    sourceCandles,
  );
  if (candles.length === 0) {
    return { rows: [], skippedNoCycle: 0, skippedNo1m };
  }

  const maSeries = new Map<number, MaPoint[]>();
  for (const tf of EMA_SCORE_TIMEFRAMES) {
    maSeries.set(
      tf,
      await fetchMaSeriesAsc(supabaseUrl, serviceKey, asset.id, tf, fromIso),
    );
  }

  const cycles = await fetchSrCyclesAsc(
    supabaseUrl,
    serviceKey,
    asset.id,
    ANALYSIS_TIMEFRAME,
  );

  // Include one prior TF so mom for the first candle can shift forward.
  const momentumFromIso =
    fromIso === null
      ? null
      : new Date(
          Date.parse(fromIso) - ANALYSIS_TIMEFRAME * 60_000,
        ).toISOString();
  const momentumByTs = await fetchMomentumByTimestamp(
    supabaseUrl,
    serviceKey,
    asset.symbol,
    momentumFromIso,
  );

  const percentages4h = await fetch4hPercentagesAsc(
    supabaseUrl,
    serviceKey,
    asset.id,
    fromIso,
  );

  const maState = new Map<number, { i: number }>();
  for (const tf of EMA_SCORE_TIMEFRAMES) {
    maState.set(tf, { i: -1 });
  }

  const rows: CryptoPriceRow[] = [];
  let skippedNoCycle = 0;

  for (const candle of candles) {
    const tMs = Date.parse(candle.bucket_start);
    const factors = new Map<number, number | null>();
    for (const tf of EMA_SCORE_TIMEFRAMES) {
      factors.set(
        tf,
        factorAsOf(maSeries.get(tf) ?? [], tMs, maState.get(tf)!),
      );
    }
    const emaTotal = computeEmaTotal(factors);
    const cycle = cycleAtTime(cycles, candle.bucket_start);
    if (!cycle) {
      skippedNoCycle += 1;
      continue;
    }
    // Mom for prior bucket lands on this open (signal at timeframe start).
    const momentum = momentumByTs.get(previousMomentumBucketMs(tMs)) ?? null;
    const row = buildRow(asset.id, candle, cycle, emaTotal, momentum, updatedAt);
    const pctSum = sumLast4hPercentages(percentages4h, candle.bucket_start);
    const priors = rows.slice(-(SIGNAL_TREND_LOOKBACK - 1)).map((r) => ({
      ema: r.ema,
      distance_to_resistance: r.distance_to_resistance,
    }));
    const prevLevel = rows.at(-1)?.price_level ?? null;
    const priceLevelPct = priceLevelChangePct(roundPrice(row.price_1m), prevLevel);
    const withSignal = applySignalRules(row, pctSum, priors, priceLevelPct);
    rows.push(withSignal);
  }

  await attachPolymarketFields(supabaseUrl, serviceKey, asset, rows);

  return { rows, skippedNoCycle, skippedNo1m };
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

  const sourceTimeframe = ALLOWED_SOURCE_TIMEFRAMES.has(options.sourceTimeframe ?? -1)
    ? (options.sourceTimeframe as number)
    : DEFAULT_SOURCE_TIMEFRAME;
  const mode = options.backfill ? "backfill" : "incremental";

  try {
    const assets = await listEnabledAssets(supabaseUrl, serviceKey);
    const sampleRows: CryptoPriceRow[] = [];
    let rowsInserted = 0;
    let skippedNoPrice = 0;
    let skippedNoCycle = 0;
    let skippedNo1m = 0;
    const updatedAt = new Date().toISOString();

    if (mode === "backfill") {
      const days =
        options.days !== undefined && Number.isFinite(options.days)
          ? options.days
          : DEFAULT_BACKFILL_DAYS;
      const fromIso =
        days > 0
          ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
          : null;

      for (const asset of assets) {
        const result = await backfillAsset(
          supabaseUrl,
          serviceKey,
          asset,
          sourceTimeframe,
          fromIso,
          updatedAt,
        );
        skippedNo1m += result.skippedNo1m;
        if (result.rows.length === 0) {
          skippedNoPrice += 1;
          continue;
        }
        skippedNoCycle += result.skippedNoCycle;
        rowsInserted += await insertCryptoPriceRows(
          supabaseUrl,
          serviceKey,
          result.rows,
        );
        if (sampleRows.length < 20) {
          sampleRows.push(...result.rows.slice(-5));
        }
      }

      return {
        success: true,
        mode,
        sourceTimeframe,
        analysisTimeframe: ANALYSIS_TIMEFRAME,
        assets: assets.length,
        rowsInserted,
        skippedNoPrice,
        skippedNoCycle,
        skippedNo1m,
        rows: sampleRows,
      };
    }

    const rows: CryptoPriceRow[] = [];

    for (const asset of assets) {
      // Default 4h: latest crypto_prices bar including the open/forming candle
      // (same bucket as Prices / Polymarket 4h window start). Price comes from
      // the nearest 1m open at that start. Opt-in source=1 uses 1m buckets.
      const latestSource = await fetchLatestSourceCandle(
        supabaseUrl,
        serviceKey,
        asset.id,
        sourceTimeframe,
        { closedOnly: false },
      );
      if (latestSource === null) {
        skippedNoPrice += 1;
        continue;
      }

      const { candles: resolved, skippedNo1m: no1m } =
        await resolveCandlesWithOneMinuteOpen(
          supabaseUrl,
          serviceKey,
          asset.id,
          sourceTimeframe,
          [latestSource],
        );
      skippedNo1m += no1m;
      const latest = resolved[0];
      if (!latest) {
        skippedNoPrice += 1;
        continue;
      }

      const emaFactors = await fetchEmaFactorsAsOf(
        supabaseUrl,
        serviceKey,
        asset.id,
        latest.bucket_start,
      );
      const emaTotal = computeEmaTotal(emaFactors);

      const cycle = await fetchActiveCycle(
        supabaseUrl,
        serviceKey,
        asset.id,
        ANALYSIS_TIMEFRAME,
      );
      if (!cycle) {
        skippedNoCycle += 1;
        continue;
      }
      const momSourceIso = previousMomentumBucketIso(latest.bucket_start);
      const momentum =
        momSourceIso === null
          ? null
          : await fetchMomentumAtTimestamp(
              supabaseUrl,
              serviceKey,
              asset.symbol,
              momSourceIso,
            );
      const row = buildRow(asset.id, latest, cycle, emaTotal, momentum, updatedAt);
      const percentages4h = await fetch4hPercentagesAsc(
        supabaseUrl,
        serviceKey,
        asset.id,
        // Enough prior 4h bars for the previous-4 % sum (excludes current bar).
        new Date(
          Date.parse(latest.bucket_start) -
            PCT_LOOKBACK * ANALYSIS_TIMEFRAME * 60_000,
        ).toISOString(),
      );
      const pctSum = sumLast4hPercentages(percentages4h, latest.bucket_start);
      const priors = await fetchPriorSignalTrend(
        supabaseUrl,
        serviceKey,
        asset.id,
        latest.bucket_start,
      );
      const prevLevel = await fetchPreviousPriceLevel(
        supabaseUrl,
        serviceKey,
        asset.id,
        latest.bucket_start,
      );
      const priceLevelPct = priceLevelChangePct(roundPrice(row.price_1m), prevLevel);
      const withSignal = applySignalRules(row, pctSum, priors, priceLevelPct);
      await attachPolymarketFields(supabaseUrl, serviceKey, asset, [withSignal]);
      rows.push(withSignal);
    }

    rowsInserted = await insertCryptoPriceRows(supabaseUrl, serviceKey, rows);

    return {
      success: true,
      mode,
      sourceTimeframe,
      analysisTimeframe: ANALYSIS_TIMEFRAME,
      assets: assets.length,
      rowsInserted,
      skippedNoPrice,
      skippedNoCycle,
      skippedNo1m,
      rows,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Compute failed";
    return { success: false, message, status: 500 };
  }
}

export const config = {
  maxDuration: 300,
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
      const backfill =
        url.searchParams.get("backfill") === "1" ||
        url.searchParams.get("backfill") === "true" ||
        url.searchParams.get("mode") === "backfill";
      const daysParam = url.searchParams.get("days");
      const days =
        daysParam !== null && daysParam !== ""
          ? Number(daysParam)
          : undefined;
      const sourceTimeframe = parseSourceTimeframe(
        url.searchParams.get("source") ||
          url.searchParams.get("source_tf") ||
          url.searchParams.get("cadence"),
      );

      const env: ComputeCryptoPriceEnv = {
        SUPABASE_URL: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
        SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        CRON_SECRET: process.env.CRON_SECRET,
      };

      const result = await computeCryptoPrice(env, request.headers.get("authorization"), {
        backfill,
        ...(Number.isFinite(days) ? { days } : {}),
        ...(sourceTimeframe !== null ? { sourceTimeframe } : {}),
      });

      if (result.success === true) {
        return Response.json(
          {
            success: true,
            mode: result.mode,
            sourceTimeframe: result.sourceTimeframe,
            analysisTimeframe: result.analysisTimeframe,
            assets: result.assets,
            rowsInserted: result.rowsInserted,
            skippedNoPrice: result.skippedNoPrice,
            skippedNoCycle: result.skippedNoCycle,
            skippedNo1m: result.skippedNo1m,
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
