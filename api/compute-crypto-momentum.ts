/**
 * Vercel Cron + admin-triggered crypto momentum anomaly scan.
 *
 * Scans crypto_prices.percentage for jump anomalies:
 *   - 1m: last 10 closed rows (candidate = 10th / newest closed)
 *   - 5m / 15m / 1h / 4h / 1D: last 5 closed rows (candidate = 5th / newest closed)
 *
 * Only fully closed candles are used (bucket_start + timeframe <= now). This
 * avoids snapshotting an in-progress higher-TF bar whose % later changes.
 *
 * When the candidate bar's percentage jump is anomalous vs the prior bars in
 * that window, the signed percentage is written to the matching mom_* column
 * on crypto_momentum (upsert refreshes % if the closed bar is scanned again).
 *
 * Default (cron / incremental): evaluate only the latest closed window per TF.
 * Backfill (?backfill=1): slide through history, treating each window's
 * 10th (1m) or 5th (other) closed bar as the candidate.
 *
 * Self-contained (no ./lib imports) so Vercel Node ESM can resolve the route.
 */

const TIMEFRAMES = [1, 5, 15, 60, 240, 1440] as const;
const LOOKBACK_1M = 10;
const LOOKBACK_OTHER = 5;
const DEFAULT_CONFIG_ID = "default_v1";
/** Minimum |percentage| on the candidate bar to count as a jump. */
const DEFAULT_MIN_ABS_PCT = 0.3;
/**
 * Candidate |pct| must be at least this multiple of the mean |pct| of the
 * prior bars in the window (when priors are available).
 */
const DEFAULT_ANOMALY_RATIO = 2;
const PAGE_SIZE = 1000;
const UPSERT_CHUNK = 500;

const MOM_COLUMN_BY_TF: Record<number, keyof MomentumMomFields> = {
  1: "mom_1m",
  5: "mom_5m",
  15: "mom_15m",
  60: "mom_1h",
  240: "mom_4h",
  1440: "mom_1d",
};

const TF_LABEL: Record<number, string> = {
  1: "1m",
  5: "5m",
  15: "15m",
  60: "1h",
  240: "4h",
  1440: "1d",
};

export type ComputeCryptoMomentumEnv = {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  CRON_SECRET?: string;
};

export type ComputeCryptoMomentumOptions = {
  backfill?: boolean;
  /** Limit to these timeframes (minutes). Default: all. */
  timeframes?: number[];
  configId?: string;
  minAbsPct?: number;
  anomalyRatio?: number;
};

type Candle = {
  bucket_start: string;
  close: number;
  percentage: number | null;
};

type MomentumMomFields = {
  mom_1m: number | null;
  mom_5m: number | null;
  mom_15m: number | null;
  mom_1h: number | null;
  mom_4h: number | null;
  mom_1d: number | null;
};

type MomentumRow = MomentumMomFields & {
  asset_symbol: string;
  timestamp: string;
  config_id: string;
  timeframe_confluence_score: number | null;
  dominant_timeframe: string | null;
  custom_params: Record<string, unknown>;
};

type AssetRow = { id: number; symbol: string };

type AnomalyHit = {
  timeframe: number;
  timestamp: string;
  percentage: number;
  lookback: number;
  windowPercentages: Array<number | null>;
};

type ComputeResult =
  | {
      success: true;
      mode: "incremental" | "backfill";
      assets: number;
      rowsUpserted: number;
      anomaliesDetected: number;
      rows: MomentumRow[];
    }
  | { success: false; message: string; status?: number };

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

async function assertAdminAccess(
  env: ComputeCryptoMomentumEnv,
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
  env: ComputeCryptoMomentumEnv,
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

function lookbackForTimeframe(timeframe: number): number {
  return timeframe === 1 ? LOOKBACK_1M : LOOKBACK_OTHER;
}

function roundMom(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Candle is closed once wall-clock reaches bucket_start + timeframe. */
export function isCandleClosed(
  candle: Candle,
  timeframeMinutes: number,
  nowMs: number = Date.now(),
): boolean {
  const startMs = new Date(candle.bucket_start).getTime();
  if (!Number.isFinite(startMs)) return false;
  return startMs + timeframeMinutes * 60_000 <= nowMs;
}

/** Drop the currently forming bar (and any future-dated rows). */
export function onlyClosedCandles(
  candlesAsc: Candle[],
  timeframeMinutes: number,
  nowMs: number = Date.now(),
): Candle[] {
  return candlesAsc.filter((c) => isCandleClosed(c, timeframeMinutes, nowMs));
}

/**
 * Candidate = last bar in the window. Anomaly when its |percentage| clears the
 * absolute floor and is a clear jump vs the mean |percentage| of prior bars.
 */
export function detectPercentageAnomaly(
  windowAsc: Candle[],
  options: { minAbsPct: number; anomalyRatio: number },
): AnomalyHit | null {
  const lookback = windowAsc.length;
  if (lookback < 2) return null;

  const candidate = windowAsc[lookback - 1]!;
  const lastPct = candidate.percentage;
  if (lastPct === null) return null;

  const absLast = Math.abs(lastPct);
  if (absLast < options.minAbsPct) return null;

  const priorPcts = windowAsc.slice(0, -1).map((c) => c.percentage);
  const absPriors = priorPcts
    .filter((p): p is number => p !== null)
    .map((p) => Math.abs(p));

  if (absPriors.length > 0) {
    const meanAbs = absPriors.reduce((sum, v) => sum + v, 0) / absPriors.length;
    const baseline = Math.max(meanAbs, 1e-6);
    if (absLast < baseline * options.anomalyRatio) return null;
  }

  return {
    timeframe: 0, // filled by caller
    timestamp: candidate.bucket_start,
    percentage: roundMom(lastPct),
    lookback,
    windowPercentages: windowAsc.map((c) => c.percentage),
  };
}

function attachPercentages(candlesAsc: Candle[]): Candle[] {
  const out: Candle[] = new Array(candlesAsc.length);
  for (let i = 0; i < candlesAsc.length; i++) {
    const c = candlesAsc[i]!;
    let pct = c.percentage;
    if (pct === null && i > 0) {
      const prev = candlesAsc[i - 1]!.close;
      if (prev !== 0) {
        pct = ((c.close - prev) / prev) * 100;
      }
    }
    out[i] = { ...c, percentage: pct };
  }
  return out;
}

function emptyMomFields(): MomentumMomFields {
  return {
    mom_1m: null,
    mom_5m: null,
    mom_15m: null,
    mom_1h: null,
    mom_4h: null,
    mom_1d: null,
  };
}

function confluenceAndDominant(fields: MomentumMomFields): {
  timeframe_confluence_score: number | null;
  dominant_timeframe: string | null;
} {
  const entries: Array<{ label: string; value: number }> = [];
  for (const [tf, col] of Object.entries(MOM_COLUMN_BY_TF)) {
    const value = fields[col];
    if (value !== null && value !== undefined) {
      entries.push({ label: TF_LABEL[Number(tf)] ?? String(tf), value });
    }
  }
  if (entries.length === 0) {
    return { timeframe_confluence_score: null, dominant_timeframe: null };
  }

  const signSum = entries.reduce((sum, e) => sum + Math.sign(e.value), 0);
  const confluence = roundMom(signSum / entries.length);
  let dominant = entries[0]!;
  for (const e of entries) {
    if (Math.abs(e.value) > Math.abs(dominant.value)) dominant = e;
  }
  return {
    timeframe_confluence_score: confluence,
    dominant_timeframe: dominant.label,
  };
}

function mergeHitIntoRow(
  row: MomentumRow,
  hit: AnomalyHit,
  scanParams: Record<string, unknown>,
): void {
  const col = MOM_COLUMN_BY_TF[hit.timeframe];
  if (!col) return;
  row[col] = hit.percentage;

  const detected = (row.custom_params.detected as Record<string, unknown>) || {};
  detected[TF_LABEL[hit.timeframe] ?? String(hit.timeframe)] = {
    percentage: hit.percentage,
    lookback: hit.lookback,
    window_percentages: hit.windowPercentages,
  };
  row.custom_params = {
    ...scanParams,
    detected,
  };

  const meta = confluenceAndDominant(row);
  row.timeframe_confluence_score = meta.timeframe_confluence_score;
  row.dominant_timeframe = meta.dominant_timeframe;
}

function rowKey(symbol: string, timestamp: string, configId: string): string {
  return `${symbol}\0${timestamp}\0${configId}`;
}

function scanTimeframeAnomalies(
  candlesAsc: Candle[],
  timeframe: number,
  options: {
    backfill: boolean;
    minAbsPct: number;
    anomalyRatio: number;
  },
): AnomalyHit[] {
  const lookback = lookbackForTimeframe(timeframe);
  if (candlesAsc.length < lookback) return [];

  const hits: AnomalyHit[] = [];
  const start = options.backfill ? lookback - 1 : candlesAsc.length - 1;
  const end = candlesAsc.length - 1;

  for (let i = start; i <= end; i++) {
    // Backfill: candidate is the lookback-th row of each sliding window
    // (10th for 1m, 5th for others). Live: only the newest bar.
    const windowAsc = candlesAsc.slice(i - lookback + 1, i + 1);
    const hit = detectPercentageAnomaly(windowAsc, {
      minAbsPct: options.minAbsPct,
      anomalyRatio: options.anomalyRatio,
    });
    if (!hit) continue;
    hits.push({ ...hit, timeframe });
  }

  return hits;
}

function toCandle(row: Record<string, unknown>): Candle | null {
  const bucket = typeof row.bucket_start === "string" ? row.bucket_start : null;
  const close = parseNumber(row.close);
  if (!bucket || close === null) return null;
  return {
    bucket_start: bucket,
    close,
    percentage: parseNumber(row.percentage),
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

async function fetchCandlesAsc(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
  timeframe: number,
  options: { limit?: number } = {},
): Promise<Candle[]> {
  const base = supabaseUrl.replace(/\/$/, "");
  const candles: Candle[] = [];

  if (options.limit !== undefined) {
    const res = await fetch(
      `${base}/rest/v1/crypto_prices?select=bucket_start,close,percentage&asset_id=eq.${assetId}&timeframe=eq.${timeframe}&order=bucket_start.desc&limit=${options.limit}`,
      { headers: restHeaders(serviceKey) },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to load crypto_prices tf=${timeframe}: ${text.slice(0, 300)}`);
    }
    const newestFirst = ((await res.json()) as Record<string, unknown>[])
      .map(toCandle)
      .filter((c): c is Candle => c !== null);
    return attachPercentages(newestFirst.reverse());
  }

  let offset = 0;
  while (true) {
    const end = offset + PAGE_SIZE - 1;
    const res = await fetch(
      `${base}/rest/v1/crypto_prices?select=bucket_start,close,percentage&asset_id=eq.${assetId}&timeframe=eq.${timeframe}&order=bucket_start.asc`,
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
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return attachPercentages(candles);
}

/** PostgREST requires every object in a batch to share the same keys. */
function toUpsertPayload(row: MomentumRow): Record<string, unknown> {
  return {
    asset_symbol: row.asset_symbol,
    timestamp: row.timestamp,
    config_id: row.config_id,
    mom_1m: row.mom_1m,
    mom_5m: row.mom_5m,
    mom_15m: row.mom_15m,
    mom_1h: row.mom_1h,
    mom_4h: row.mom_4h,
    mom_1d: row.mom_1d,
    timeframe_confluence_score: row.timeframe_confluence_score,
    dominant_timeframe: row.dominant_timeframe,
    custom_params: row.custom_params,
  };
}

async function upsertMomentumRows(
  supabaseUrl: string,
  serviceKey: string,
  rows: MomentumRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const base = supabaseUrl.replace(/\/$/, "");
  let upserted = 0;

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK).map(toUpsertPayload);
    const res = await fetch(
      `${base}/rest/v1/crypto_momentum?on_conflict=asset_symbol,timestamp,config_id`,
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
      throw new Error(`Failed to upsert crypto_momentum: ${text.slice(0, 300)}`);
    }
    upserted += chunk.length;
  }

  return upserted;
}

function buildRowsFromHits(
  symbol: string,
  configId: string,
  hits: AnomalyHit[],
  scanParams: Record<string, unknown>,
): MomentumRow[] {
  const byKey = new Map<string, MomentumRow>();

  for (const hit of hits) {
    const key = rowKey(symbol, hit.timestamp, configId);
    let row = byKey.get(key);
    if (!row) {
      row = {
        asset_symbol: symbol,
        timestamp: hit.timestamp,
        config_id: configId,
        ...emptyMomFields(),
        timeframe_confluence_score: null,
        dominant_timeframe: null,
        custom_params: { ...scanParams, detected: {} },
      };
      byKey.set(key, row);
    }
    mergeHitIntoRow(row, hit, scanParams);
  }

  return [...byKey.values()].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}

async function computeForAsset(
  supabaseUrl: string,
  serviceKey: string,
  asset: AssetRow,
  options: {
    backfill: boolean;
    timeframes: number[];
    configId: string;
    minAbsPct: number;
    anomalyRatio: number;
  },
): Promise<{ rows: MomentumRow[]; anomaliesDetected: number }> {
  const nowMs = Date.now();
  const scanParams = {
    lookback_1m: LOOKBACK_1M,
    lookback_other: LOOKBACK_OTHER,
    min_abs_pct: options.minAbsPct,
    anomaly_ratio: options.anomalyRatio,
    closed_candles_only: true,
    mode: options.backfill ? "backfill" : "incremental",
  };

  const allHits: AnomalyHit[] = [];

  for (const timeframe of options.timeframes) {
    const lookback = lookbackForTimeframe(timeframe);
    // Fetch one extra so dropping the still-open bar still leaves a full window.
    const rawCandles = await fetchCandlesAsc(
      supabaseUrl,
      serviceKey,
      asset.id,
      timeframe,
      options.backfill ? {} : { limit: lookback + 1 },
    );
    const candles = onlyClosedCandles(rawCandles, timeframe, nowMs);
    allHits.push(
      ...scanTimeframeAnomalies(candles, timeframe, {
        backfill: options.backfill,
        minAbsPct: options.minAbsPct,
        anomalyRatio: options.anomalyRatio,
      }),
    );
  }

  const rows = buildRowsFromHits(asset.symbol, options.configId, allHits, scanParams);
  return { rows, anomaliesDetected: allHits.length };
}

/**
 * Pass `skipAuth: true` only from trusted local scripts that already hold the service role key.
 */
export async function computeCryptoMomentum(
  env: ComputeCryptoMomentumEnv,
  authHeader: string | null,
  options: ComputeCryptoMomentumOptions & { skipAuth?: boolean } = {},
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
  const configId = options.configId || DEFAULT_CONFIG_ID;
  const minAbsPct = options.minAbsPct ?? DEFAULT_MIN_ABS_PCT;
  const anomalyRatio = options.anomalyRatio ?? DEFAULT_ANOMALY_RATIO;
  const timeframes = (options.timeframes?.length ? options.timeframes : [...TIMEFRAMES]).filter(
    (tf) => tf in MOM_COLUMN_BY_TF,
  );

  try {
    const assets = await listEnabledAssets(supabaseUrl, serviceKey);
    const sampleRows: MomentumRow[] = [];
    let rowsUpserted = 0;
    let anomaliesDetected = 0;

    for (const asset of assets) {
      const result = await computeForAsset(supabaseUrl, serviceKey, asset, {
        backfill: Boolean(options.backfill),
        timeframes,
        configId,
        minAbsPct,
        anomalyRatio,
      });
      anomaliesDetected += result.anomaliesDetected;
      rowsUpserted += await upsertMomentumRows(supabaseUrl, serviceKey, result.rows);
      if (!options.backfill) {
        sampleRows.push(...result.rows);
      } else if (sampleRows.length < 20) {
        sampleRows.push(...result.rows.slice(-5));
      }
    }

    return {
      success: true,
      mode,
      assets: assets.length,
      rowsUpserted,
      anomaliesDetected,
      rows: sampleRows,
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

      const timeframesParam = url.searchParams.get("timeframes") || url.searchParams.get("tf");
      const timeframes = timeframesParam
        ? timeframesParam
            .split(",")
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isFinite(n) && n > 0)
        : undefined;

      const minAbsPctRaw = url.searchParams.get("min_abs_pct");
      const anomalyRatioRaw = url.searchParams.get("anomaly_ratio");
      const minAbsPct = minAbsPctRaw !== null ? Number(minAbsPctRaw) : undefined;
      const anomalyRatio = anomalyRatioRaw !== null ? Number(anomalyRatioRaw) : undefined;

      const env: ComputeCryptoMomentumEnv = {
        SUPABASE_URL: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
        SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        CRON_SECRET: process.env.CRON_SECRET,
      };

      const result = await computeCryptoMomentum(env, request.headers.get("authorization"), {
        backfill,
        timeframes,
        configId: url.searchParams.get("config_id") || undefined,
        minAbsPct: Number.isFinite(minAbsPct) ? minAbsPct : undefined,
        anomalyRatio: Number.isFinite(anomalyRatio) ? anomalyRatio : undefined,
      });

      if (result.success === true) {
        return Response.json(
          {
            success: true,
            mode: result.mode,
            assets: result.assets,
            rowsUpserted: result.rowsUpserted,
            anomaliesDetected: result.anomaliesDetected,
            rows: result.rows,
          },
          { status: 200, headers: jsonHeaders() },
        );
      }
      console.error("[compute-crypto-momentum] failed", result.status, result.message);
      return Response.json(
        { success: false, message: result.message },
        { status: result.status ?? 500, headers: jsonHeaders() },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Internal error";
      console.error("[compute-crypto-momentum] uncaught", msg);
      return Response.json({ success: false, message: msg }, { status: 500, headers: jsonHeaders() });
    }
  },
};
