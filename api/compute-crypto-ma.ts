/**
 * Vercel Cron + admin-triggered crypto SMA/EMA + bar-characteristics compute.
 *
 * Default (cron): upsert the latest MA row and bar characteristics per timeframe
 * for each enabled asset.
 * Backfill (?backfill=1): walk all 1m candles from the first price and write MA
 * + bar-characteristic rows for every candle on 1m / 5m / 15m / 1h / 4h / 1D.
 *
 * Self-contained (no ./lib imports) so Vercel Node ESM can resolve the route.
 */

const TIMEFRAMES = [1, 5, 15, 60, 240, 1440] as const;
const MAX_PERIOD = 50;
/** Enough 1m bars to build the current 1D bucket + a small buffer. */
const ONE_M_LOOKBACK = 1500;
const ONE_M_PAGE = 1000;
/** Closes needed from each TF to seed SMA50 / EMA50 (incremental cron). */
const CLOSE_LOOKBACK = MAX_PERIOD + 5;
const UPSERT_CHUNK = 500;

export type ComputeCryptoMaEnv = {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  CRON_SECRET?: string;
};

export type ComputeCryptoMaOptions = {
  /** When true, recompute MA history from stored candles (and 1m fallback). */
  backfill?: boolean;
  /** Limit backfill to these timeframes (minutes). Default: all. */
  timeframes?: number[];
  /**
   * When true (default for backfill), prefer stored higher-TF candles in crypto_prices
   * instead of re-aggregating from 1m (preserves Binance historical higher-TF backfills).
   */
  preferStoredHigherTf?: boolean;
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
  /** 1 if short > long, -1 if short < long, 0 if equal, null if either missing. */
  sma_20_50_factor: number | null;
  ema_9_20_factor: number | null;
  ema_20_50_factor: number | null;
};

type BarCharacteristicRow = {
  asset_id: number;
  timeframe: number;
  timestamp: string;
  price_change_pct: number | null;
  direction: number;
  body: number;
  body_pct: number | null;
  range: number;
  range_pct: number | null;
  upper_wick: number;
  lower_wick: number;
  body_to_range: number | null;
  close_position: number | null;
};

type AssetRow = { id: number; symbol: string };

type ComputeResult =
  | {
      success: true;
      mode: "incremental" | "backfill";
      assets: number;
      rowsUpserted: number;
      priceRowsUpserted: number;
      characteristicRowsUpserted: number;
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

/** Compare short vs long MA → 1 / -1 / 0 / null. */
function maFactor(shortMa: number | null, longMa: number | null): number | null {
  if (shortMa === null || longMa === null) return null;
  if (shortMa > longMa) return 1;
  if (shortMa < longMa) return -1;
  return 0;
}

function withFactors(
  row: Omit<MaRow, "sma_20_50_factor" | "ema_9_20_factor" | "ema_20_50_factor">,
): MaRow {
  return {
    ...row,
    sma_20_50_factor: maFactor(row.sma_20, row.sma_50),
    ema_9_20_factor: maFactor(row.ema_9, row.ema_20),
    ema_20_50_factor: maFactor(row.ema_20, row.ema_50),
  };
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

/** O(n) SMA/EMA series for every candle from the start of history. */
function computeMaSeries(assetId: number, timeframe: number, candlesAsc: Candle[]): MaRow[] {
  if (candlesAsc.length === 0) return [];

  const closes = candlesAsc.map((c) => c.close);
  const rows: MaRow[] = [];
  let sum20 = 0;
  let sum50 = 0;
  let ema9: number | null = null;
  let ema20: number | null = null;
  let ema50: number | null = null;
  const k9 = 2 / (9 + 1);
  const k20 = 2 / (20 + 1);
  const k50 = 2 / (50 + 1);

  for (let i = 0; i < closes.length; i++) {
    const close = closes[i]!;
    sum20 += close;
    sum50 += close;
    if (i >= 20) sum20 -= closes[i - 20]!;
    if (i >= 50) sum50 -= closes[i - 50]!;

    if (i === 8) {
      ema9 = closes.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
    } else if (i > 8 && ema9 !== null) {
      ema9 = close * k9 + ema9 * (1 - k9);
    }

    if (i === 19) {
      ema20 = closes.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
    } else if (i > 19 && ema20 !== null) {
      ema20 = close * k20 + ema20 * (1 - k20);
    }

    if (i === 49) {
      ema50 = closes.slice(0, 50).reduce((a, b) => a + b, 0) / 50;
    } else if (i > 49 && ema50 !== null) {
      ema50 = close * k50 + ema50 * (1 - k50);
    }

    const sma20 = i >= 19 ? sum20 / 20 : null;
    const sma50 = i >= 49 ? sum50 / 50 : null;
    rows.push(
      withFactors({
        asset_id: assetId,
        timeframe,
        timestamp: candlesAsc[i]!.bucket_start,
        sma_20: sma20,
        sma_50: sma50,
        ema_9: ema9,
        ema_20: ema20,
        ema_50: ema50,
      }),
    );
  }

  return rows;
}

function computeMaRow(assetId: number, timeframe: number, candlesAsc: Candle[]): MaRow | null {
  if (candlesAsc.length === 0) return null;
  const latest = candlesAsc[candlesAsc.length - 1]!;
  const closes = candlesAsc.map((c) => c.close);
  return withFactors({
    asset_id: assetId,
    timeframe,
    timestamp: latest.bucket_start,
    sma_20: sma(closes, 20),
    sma_50: sma(closes, 50),
    ema_9: ema(closes, 9),
    ema_20: ema(closes, 20),
    ema_50: ema(closes, 50),
  });
}

function pctOf(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return (numerator / denominator) * 100;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
}

function computeBarCharacteristic(
  assetId: number,
  timeframe: number,
  candle: Candle,
  previousClose: number | null,
): BarCharacteristicRow {
  const body = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;
  const upper = Math.max(candle.open, candle.close);
  const lower = Math.min(candle.open, candle.close);
  let direction = 0;
  if (candle.close > candle.open) direction = 1;
  else if (candle.close < candle.open) direction = -1;

  return {
    asset_id: assetId,
    timeframe,
    timestamp: candle.bucket_start,
    price_change_pct:
      previousClose === null ? null : pctOf(candle.close - previousClose, previousClose),
    direction,
    body,
    body_pct: pctOf(body, candle.open),
    range,
    range_pct: pctOf(range, candle.open),
    upper_wick: candle.high - upper,
    lower_wick: lower - candle.low,
    body_to_range: ratio(body, range),
    close_position: ratio(candle.close - candle.low, range),
  };
}

function computeBarCharacteristicSeries(
  assetId: number,
  timeframe: number,
  candlesAsc: Candle[],
): BarCharacteristicRow[] {
  const rows: BarCharacteristicRow[] = [];
  for (let i = 0; i < candlesAsc.length; i++) {
    const candle = candlesAsc[i]!;
    const previousClose = i > 0 ? candlesAsc[i - 1]!.close : null;
    rows.push(computeBarCharacteristic(assetId, timeframe, candle, previousClose));
  }
  return rows;
}

function computeBarCharacteristicRow(
  assetId: number,
  timeframe: number,
  candlesAsc: Candle[],
): BarCharacteristicRow | null {
  if (candlesAsc.length === 0) return null;
  const latest = candlesAsc[candlesAsc.length - 1]!;
  const previousClose =
    candlesAsc.length > 1 ? candlesAsc[candlesAsc.length - 2]!.close : null;
  return computeBarCharacteristic(assetId, timeframe, latest, previousClose);
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
  options: { limit?: number; ascending?: boolean } = {},
): Promise<Candle[]> {
  const base = supabaseUrl.replace(/\/$/, "");
  const candles: Candle[] = [];
  let offset = 0;
  const order = options.ascending ? "asc" : "desc";
  const hardLimit = options.limit ?? Number.POSITIVE_INFINITY;

  while (candles.length < hardLimit) {
    const end = offset + ONE_M_PAGE - 1;
    const res = await fetch(
      `${base}/rest/v1/crypto_prices?select=bucket_start,open,high,low,close,volume&asset_id=eq.${assetId}&timeframe=eq.1&order=bucket_start.${order}`,
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

  if (Number.isFinite(hardLimit)) {
    return candles.slice(0, hardLimit);
  }
  return candles;
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

async function fetchAllTimeframeCandlesAsc(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
  timeframe: number,
): Promise<Candle[]> {
  const base = supabaseUrl.replace(/\/$/, "");
  const candles: Candle[] = [];
  let offset = 0;

  while (true) {
    const end = offset + ONE_M_PAGE - 1;
    const res = await fetch(
      `${base}/rest/v1/crypto_prices?select=bucket_start,open,high,low,close,volume&asset_id=eq.${assetId}&timeframe=eq.${timeframe}&order=bucket_start.asc`,
      {
        headers: restHeaders(serviceKey, {
          Prefer: "count=exact",
          Range: `${offset}-${end}`,
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to load crypto_prices tf=${timeframe}: ${text.slice(0, 300)}`);
    }
    const page = ((await res.json()) as Record<string, unknown>[])
      .map(toCandle)
      .filter((c): c is Candle => c !== null);
    if (page.length === 0) break;
    candles.push(...page);
    if (page.length < ONE_M_PAGE) break;
    offset += ONE_M_PAGE;
  }

  return candles;
}

async function upsertCryptoPrices(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
  timeframe: number,
  candles: Candle[],
): Promise<number> {
  if (candles.length === 0) return 0;
  const base = supabaseUrl.replace(/\/$/, "");
  let upserted = 0;

  for (let i = 0; i < candles.length; i += UPSERT_CHUNK) {
    const chunk = candles.slice(i, i + UPSERT_CHUNK);
    const payload = chunk.map((candle) => ({
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
    upserted += chunk.length;
  }

  return upserted;
}

async function upsertMovingAverages(
  supabaseUrl: string,
  serviceKey: string,
  rows: MaRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const base = supabaseUrl.replace(/\/$/, "");
  let upserted = 0;

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const res = await fetch(
      `${base}/rest/v1/crypto_moving_averages?on_conflict=asset_id,timeframe,timestamp`,
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
      throw new Error(`Failed to upsert crypto_moving_averages: ${text.slice(0, 300)}`);
    }
    upserted += chunk.length;
  }

  return upserted;
}

async function upsertBarCharacteristics(
  supabaseUrl: string,
  serviceKey: string,
  rows: BarCharacteristicRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const base = supabaseUrl.replace(/\/$/, "");
  let upserted = 0;

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const res = await fetch(
      `${base}/rest/v1/crypto_bar_characteristics?on_conflict=asset_id,timeframe,timestamp`,
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
      throw new Error(`Failed to upsert crypto_bar_characteristics: ${text.slice(0, 300)}`);
    }
    upserted += chunk.length;
  }

  return upserted;
}

async function computeForAssetIncremental(
  supabaseUrl: string,
  serviceKey: string,
  asset: AssetRow,
): Promise<{
  maRows: MaRow[];
  priceRowsUpserted: number;
  characteristicRowsUpserted: number;
}> {
  const oneMinuteNewestFirst = await fetchOneMinuteCandles(supabaseUrl, serviceKey, asset.id, {
    limit: ONE_M_LOOKBACK,
  });
  if (oneMinuteNewestFirst.length === 0) {
    return { maRows: [], priceRowsUpserted: 0, characteristicRowsUpserted: 0 };
  }

  const maRows: MaRow[] = [];
  let priceRowsUpserted = 0;
  let characteristicRowsUpserted = 0;

  for (const timeframe of TIMEFRAMES) {
    if (timeframe > 1) {
      const aggregated = aggregateCandles(oneMinuteNewestFirst, timeframe);
      priceRowsUpserted += await upsertCryptoPrices(
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
    await upsertMovingAverages(supabaseUrl, serviceKey, [ma]);
    maRows.push(ma);

    const bar = computeBarCharacteristicRow(asset.id, timeframe, closesAsc);
    if (bar) {
      characteristicRowsUpserted += await upsertBarCharacteristics(
        supabaseUrl,
        serviceKey,
        [bar],
      );
    }
  }

  return { maRows, priceRowsUpserted, characteristicRowsUpserted };
}

async function computeForAssetBackfill(
  supabaseUrl: string,
  serviceKey: string,
  asset: AssetRow,
  options: {
    timeframes?: number[];
    preferStoredHigherTf?: boolean;
  } = {},
): Promise<{
  maRows: MaRow[];
  priceRowsUpserted: number;
  rowsUpserted: number;
  characteristicRowsUpserted: number;
}> {
  const preferStored = options.preferStoredHigherTf !== false;
  const timeframes = (options.timeframes?.length ? options.timeframes : [...TIMEFRAMES]).filter(
    (tf): tf is (typeof TIMEFRAMES)[number] =>
      (TIMEFRAMES as readonly number[]).includes(tf),
  );

  let oneMinuteAsc: Candle[] | null = null;
  async function loadOneMinute() {
    if (oneMinuteAsc) return oneMinuteAsc;
    oneMinuteAsc = await fetchOneMinuteCandles(supabaseUrl, serviceKey, asset.id, {
      ascending: true,
    });
    return oneMinuteAsc;
  }

  if (timeframes.includes(1)) {
    const ones = await loadOneMinute();
    if (ones.length === 0) {
      return {
        maRows: [],
        priceRowsUpserted: 0,
        rowsUpserted: 0,
        characteristicRowsUpserted: 0,
      };
    }
  }

  let priceRowsUpserted = 0;
  let rowsUpserted = 0;
  let characteristicRowsUpserted = 0;
  const latestRows: MaRow[] = [];

  for (const timeframe of timeframes) {
    let candlesAsc: Candle[] = [];

    if (timeframe === 1) {
      candlesAsc = await loadOneMinute();
    } else if (preferStored) {
      candlesAsc = await fetchAllTimeframeCandlesAsc(
        supabaseUrl,
        serviceKey,
        asset.id,
        timeframe,
      );
      // Fallback only when this TF has never been stored.
      if (candlesAsc.length === 0) {
        const ones = await loadOneMinute();
        if (ones.length > 0) {
          candlesAsc = aggregateCandles(ones, timeframe);
          priceRowsUpserted += await upsertCryptoPrices(
            supabaseUrl,
            serviceKey,
            asset.id,
            timeframe,
            candlesAsc,
          );
        }
      }
    } else {
      const ones = await loadOneMinute();
      candlesAsc = aggregateCandles(ones, timeframe);
      priceRowsUpserted += await upsertCryptoPrices(
        supabaseUrl,
        serviceKey,
        asset.id,
        timeframe,
        candlesAsc,
      );
    }

    if (candlesAsc.length === 0) continue;

    const series = computeMaSeries(asset.id, timeframe, candlesAsc);
    rowsUpserted += await upsertMovingAverages(supabaseUrl, serviceKey, series);
    if (series.length > 0) {
      latestRows.push(series[series.length - 1]!);
    }

    const barSeries = computeBarCharacteristicSeries(asset.id, timeframe, candlesAsc);
    characteristicRowsUpserted += await upsertBarCharacteristics(
      supabaseUrl,
      serviceKey,
      barSeries,
    );
  }

  return { maRows: latestRows, priceRowsUpserted, rowsUpserted, characteristicRowsUpserted };
}

/**
 * Core runner used by HTTP handler and local backfill script.
 * Pass `skipAuth: true` only from trusted local scripts that already hold the service role key.
 */
export async function computeCryptoMovingAverages(
  env: ComputeCryptoMaEnv,
  authHeader: string | null,
  options: ComputeCryptoMaOptions & { skipAuth?: boolean } = {},
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

  const mode = options.backfill ? "backfill" : "incremental";

  try {
    const assets = await listEnabledAssets(supabaseUrl, serviceKey);
    const allLatestRows: MaRow[] = [];
    let rowsUpserted = 0;
    let priceRowsUpserted = 0;
    let characteristicRowsUpserted = 0;

    for (const asset of assets) {
      if (options.backfill) {
        const result = await computeForAssetBackfill(supabaseUrl, serviceKey, asset, {
          timeframes: options.timeframes,
          preferStoredHigherTf: options.preferStoredHigherTf,
        });
        allLatestRows.push(...result.maRows);
        rowsUpserted += result.rowsUpserted;
        priceRowsUpserted += result.priceRowsUpserted;
        characteristicRowsUpserted += result.characteristicRowsUpserted;
      } else {
        const result = await computeForAssetIncremental(supabaseUrl, serviceKey, asset);
        allLatestRows.push(...result.maRows);
        rowsUpserted += result.maRows.length;
        priceRowsUpserted += result.priceRowsUpserted;
        characteristicRowsUpserted += result.characteristicRowsUpserted;
      }
    }

    return {
      success: true,
      mode,
      assets: assets.length,
      rowsUpserted,
      priceRowsUpserted,
      characteristicRowsUpserted,
      rows: allLatestRows,
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

      const env: ComputeCryptoMaEnv = {
        SUPABASE_URL: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
        SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        CRON_SECRET: process.env.CRON_SECRET,
      };

      const result = await computeCryptoMovingAverages(
        env,
        request.headers.get("authorization"),
        { backfill },
      );
      if (result.success === true) {
        return Response.json(
          {
            success: true,
            mode: result.mode,
            assets: result.assets,
            rowsUpserted: result.rowsUpserted,
            priceRowsUpserted: result.priceRowsUpserted,
            characteristicRowsUpserted: result.characteristicRowsUpserted,
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
