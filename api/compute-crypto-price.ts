/**
 * Vercel Cron + admin-triggered crypto_price inserts.
 *
 * Analysis timeframe on each row is always 4h (S/R + stored timeframe=240).
 * Source candle cadence (bucket_start / close) defaults to 4h crypto_prices;
 * pass sourceTimeframe=1 (or ?source=1) for 1m buckets.
 *
 * Incremental (cron, default): latest *closed* 4h candle → upsert that bar only
 * (does not invent per-minute rows).
 * Backfill: walk source candles from crypto_prices (optional DAYS).
 *
 * EMA (0–50): +10 per bullish ema_9_20_factor among 5m/15m/1h/4h/1D.
 * Momentum: crypto_momentum value at the same timestamp when present
 *   (prefers mom_4h for analysis TF 4h; else first non-null mom_*).
 *
 * percentage_sum: sum of last 4 crypto_prices.percentage on TF 4h (as of bar).
 * After all other fields are set, first matching signal rule wins:
 *   1) 0 < mom < 1% and %sum < 0.30 → Above, price_level = price_1m + 200
 *   2) 0 < mom < 1% and %sum > 0.80 → Above, price_level = price_1m - 200
 *   3) mom > 1% → Below, price_level = price_1m - 200
 *   4) -1% < mom < 0 and %sum > 0.80 → Below, price_level = price_1m - 200
 *   5) mom < 1% (fallback) → Below, price_level = price_1m - 200
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
/** Prefer this mom_* column for crypto_price.momentum (matches ANALYSIS_TIMEFRAME). */
const MOMENTUM_PREFERRED_COLUMN = "mom_4h" as const;
const MOMENTUM_FALLBACK_COLUMNS = [
  "mom_4h",
  "mom_1d",
  "mom_1h",
  "mom_15m",
  "mom_5m",
  "mom_1m",
] as const;
const SIGNAL_ABOVE = "Above";
const SIGNAL_BELOW = "Below";
/** Bars used for percentage_sum (last N × 4h close-%). */
const PCT_LOOKBACK = 4;
/** Momentum band edges in percent units (crypto_price.momentum). */
const MOMENTUM_STRONG_PCT = 1;
/** percentage_sum thresholds in percent units. */
const PCT_SUM_WEAK = 0.3;
const PCT_SUM_STRONG = 0.8;
const PRICE_LEVEL_OFFSET = 200;

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
   * crypto_prices timeframe used for bucket_start/close.
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
  close: number;
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
  price_level: number;
  ema: number | null;
  momentum: number | null;
  percentage_sum: number | null;
  updated_at: string;
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
 * Sum of the last `PCT_LOOKBACK` 4h crypto_prices.percentage values
 * with bucket_start <= asOfBucketStart. Null when fewer than 4 bars exist or
 * any of those percentages is missing.
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
    if (!Number.isFinite(tMs) || tMs > asOfMs) continue;
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
 * Persist percentage_sum, then apply signal rules (first match wins).
 * See file header for the five rules.
 */
export function applySignalRules(
  row: CryptoPriceRow,
  pctSum: number | null,
): CryptoPriceRow {
  const withSum: CryptoPriceRow = {
    ...row,
    percentage_sum: pctSum === null ? null : roundPct(pctSum),
  };
  const mom = withSum.momentum;
  if (mom === null) return withSum;

  const price = withSum.price_1m;
  const set = (signal: string, priceLevel: number): CryptoPriceRow => ({
    ...withSum,
    signal,
    price_level: roundPrice(priceLevel),
  });

  // 1) 0 < mom < 1% and %sum < 0.30 → Above, +200
  if (mom > 0 && mom < MOMENTUM_STRONG_PCT && pctSum !== null && pctSum < PCT_SUM_WEAK) {
    return set(SIGNAL_ABOVE, price + PRICE_LEVEL_OFFSET);
  }
  // 2) 0 < mom < 1% and %sum > 0.80 → Above, -200
  if (mom > 0 && mom < MOMENTUM_STRONG_PCT && pctSum !== null && pctSum > PCT_SUM_STRONG) {
    return set(SIGNAL_ABOVE, price - PRICE_LEVEL_OFFSET);
  }
  // 3) mom > 1% → Below, -200
  if (mom > MOMENTUM_STRONG_PCT) {
    return set(SIGNAL_BELOW, price - PRICE_LEVEL_OFFSET);
  }
  // 4) -1% < mom < 0 and %sum > 0.80 → Below, -200
  if (mom < 0 && mom > -MOMENTUM_STRONG_PCT && pctSum !== null && pctSum > PCT_SUM_STRONG) {
    return set(SIGNAL_BELOW, price - PRICE_LEVEL_OFFSET);
  }
  // 5) mom < 1% (fallback when no earlier rule matched) → Below, -200
  if (mom < MOMENTUM_STRONG_PCT) {
    return set(SIGNAL_BELOW, price - PRICE_LEVEL_OFFSET);
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
    `${base}/rest/v1/crypto_prices?select=bucket_start,close&asset_id=eq.${assetId}&timeframe=eq.${sourceTimeframe}&order=bucket_start.desc&limit=${limit}`,
    { headers: restHeaders(serviceKey) },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Failed to load latest crypto_prices tf=${sourceTimeframe}: ${text.slice(0, 300)}`,
    );
  }
  const rows = (await res.json()) as Array<{ bucket_start?: unknown; close?: unknown }>;
  for (const row of rows) {
    const close = parseNumber(row.close);
    const bucketStart =
      typeof row.bucket_start === "string" ? row.bucket_start : null;
    if (close === null || !bucketStart) continue;
    if (options.closedOnly && !isCandleClosed(bucketStart, sourceTimeframe)) continue;
    return { bucket_start: bucketStart, close };
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
 * Latest ema_9_20_factor per higher timeframe from crypto_moving_averages.
 * One newest-row query per TF (not a shared recent window) so slower TFs
 * like 4h/1D are not crowded out by frequent 5m/15m rows.
 */
async function fetchLatestEmaFactorsByTimeframe(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
): Promise<Map<number, number | null>> {
  const base = supabaseUrl.replace(/\/$/, "");
  const results = await Promise.all(
    EMA_SCORE_TIMEFRAMES.map(async (tf) => {
      const res = await fetch(
        `${base}/rest/v1/crypto_moving_averages?select=ema_9_20_factor&asset_id=eq.${assetId}&timeframe=eq.${tf}&order=timestamp.desc&limit=1`,
        { headers: restHeaders(serviceKey) },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Failed to load crypto_moving_averages tf=${tf}: ${text.slice(0, 300)}`,
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
      `${base}/rest/v1/crypto_prices?select=bucket_start,close&asset_id=eq.${assetId}&timeframe=eq.${sourceTimeframe}${fromFilter}&order=bucket_start.asc`,
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
    const page = (await res.json()) as Array<{ bucket_start?: unknown; close?: unknown }>;
    for (const row of page) {
      const close = parseNumber(row.close);
      const bucketStart =
        typeof row.bucket_start === "string" ? row.bucket_start : null;
      if (close === null || !bucketStart) continue;
      if (options.closedOnly && !isCandleClosed(bucketStart, sourceTimeframe)) continue;
      candles.push({ bucket_start: bucketStart, close });
    }
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return candles;
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

/** Pick mom_4h when set; otherwise first non-null mom_* on the row. */
export function pickMomentumValue(row: Record<string, unknown>): number | null {
  const preferred = parseNumber(row[MOMENTUM_PREFERRED_COLUMN]);
  if (preferred !== null) return preferred;
  for (const col of MOMENTUM_FALLBACK_COLUMNS) {
    const v = parseNumber(row[col]);
    if (v !== null) return v;
  }
  return null;
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
    `${base}/rest/v1/crypto_momentum?select=timestamp,mom_1m,mom_5m,mom_15m,mom_1h,mom_4h,mom_1d&asset_symbol=eq.${encodeURIComponent(assetSymbol)}&timestamp=lte.${encodeURIComponent(timestampIso)}&config_id=eq.${encodeURIComponent(DEFAULT_MOMENTUM_CONFIG_ID)}&order=timestamp.desc&limit=5`,
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
      `${base}/rest/v1/crypto_momentum?select=timestamp,mom_1m,mom_5m,mom_15m,mom_1h,mom_4h,mom_1d&asset_symbol=eq.${encodeURIComponent(assetSymbol)}&config_id=eq.${encodeURIComponent(DEFAULT_MOMENTUM_CONFIG_ID)}${fromFilter}&order=timestamp.asc`,
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

function buildRow(
  assetId: number,
  candle: PriceCandle,
  cycle: ActiveCycle,
  emaTotal: number,
  momentum: number | null,
  updatedAt: string,
): CryptoPriceRow {
  const price = roundPrice(candle.close);
  return {
    asset_id: assetId,
    bucket_start: candle.bucket_start,
    price_1m: price,
    timeframe: ANALYSIS_TIMEFRAME,
    distance_from_support: distanceFromSupportPct(price, cycle.support),
    distance_to_resistance: distanceToResistancePct(price, cycle.resistance),
    signal: null,
    price_level: price,
    ema: emaTotal,
    momentum,
    percentage_sum: null,
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
): Promise<{ rows: CryptoPriceRow[]; skippedNoCycle: number }> {
  const candles = await fetchSourceCandlesAsc(
    supabaseUrl,
    serviceKey,
    asset.id,
    sourceTimeframe,
    fromIso,
    { closedOnly: true },
  );
  if (candles.length === 0) {
    return { rows: [], skippedNoCycle: 0 };
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

  const momentumByTs = await fetchMomentumByTimestamp(
    supabaseUrl,
    serviceKey,
    asset.symbol,
    fromIso,
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
    const momentum = momentumByTs.get(tMs) ?? null;
    const row = buildRow(asset.id, candle, cycle, emaTotal, momentum, updatedAt);
    const pctSum = sumLast4hPercentages(percentages4h, candle.bucket_start);
    rows.push(applySignalRules(row, pctSum));
  }

  return { rows, skippedNoCycle };
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
        rows: sampleRows,
      };
    }

    const rows: CryptoPriceRow[] = [];

    for (const asset of assets) {
      // Default 4h: only the latest *closed* 4h bar (cron every minute won't
      // create 1m rows). Opt-in source=1 uses closed 1m bars.
      const latest = await fetchLatestSourceCandle(
        supabaseUrl,
        serviceKey,
        asset.id,
        sourceTimeframe,
        { closedOnly: true },
      );
      if (latest === null) {
        skippedNoPrice += 1;
        continue;
      }

      const emaFactors = await fetchLatestEmaFactorsByTimeframe(
        supabaseUrl,
        serviceKey,
        asset.id,
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
      const momentum = await fetchMomentumAtTimestamp(
        supabaseUrl,
        serviceKey,
        asset.symbol,
        latest.bucket_start,
      );
      const row = buildRow(asset.id, latest, cycle, emaTotal, momentum, updatedAt);
      const percentages4h = await fetch4hPercentagesAsc(
        supabaseUrl,
        serviceKey,
        asset.id,
        // Enough prior 4h bars for the 4-bar % sum (plus the current bar).
        new Date(
          Date.parse(latest.bucket_start) -
            PCT_LOOKBACK * ANALYSIS_TIMEFRAME * 60_000,
        ).toISOString(),
      );
      const pctSum = sumLast4hPercentages(percentages4h, latest.bucket_start);
      rows.push(applySignalRules(row, pctSum));
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
