/**
 * Vercel Cron + admin-triggered crypto support / resistance cycles.
 *
 * Per asset + timeframe (5m, 15m, 1h, 4h, 1D), using close prices only:
 *   - support    = min(close) over the last 30 closed bars
 *   - resistance = max(close) over the last 30 closed bars
 *
 * Once a cycle is entered, closes within ±3% of either level are ignored for
 * rollover (recorded as hover). A close beyond that band on the outer side
 * breaches the cycle: the row is closed and a new cycle row is inserted with
 * a fresh id / cycle_seq and levels from the current 30-bar window.
 *
 * Default (cron): evaluate the latest closed bar per TF against the active cycle.
 * Backfill (?backfill=1): walk closed history chronologically.
 *
 * Self-contained (no ./lib imports) so Vercel Node ESM can resolve the route.
 */

const TIMEFRAMES = [5, 15, 60, 240, 1440] as const;
const LOOKBACK = 30;
/** Ignore closes within this percent of a level for cycle rollover. */
const DEFAULT_BAND_PCT = 3;
const PAGE_SIZE = 1000;
const UPSERT_CHUNK = 200;

export type ComputeCryptoSrEnv = {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  CRON_SECRET?: string;
};

export type ComputeCryptoSrOptions = {
  backfill?: boolean;
  /** Limit to these timeframes (minutes). Default: 5/15/60/240/1440. */
  timeframes?: number[];
  /** Hover / ignore band percent. Default: 3. */
  bandPct?: number;
};

type Candle = {
  bucket_start: string;
  close: number;
};

type AssetRow = { id: number; symbol: string };

type CycleStatus = "active" | "breached_support" | "breached_resistance";
type HoverSide = "support" | "resistance";

type SrCycleRow = {
  id: string;
  asset_id: number;
  timeframe: number;
  cycle_seq: number;
  support: number;
  resistance: number;
  started_at: string;
  ended_at: string | null;
  status: CycleStatus;
  breach_close: number | null;
  breach_at: string | null;
  hover_side: HoverSide | null;
  hover_at: string | null;
  last_close: number | null;
  last_checked_at: string | null;
};

type ComputeResult =
  | {
      success: true;
      mode: "incremental" | "backfill";
      assets: number;
      cyclesOpened: number;
      cyclesBreached: number;
      hoversRecorded: number;
      rows: SrCycleRow[];
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

function roundPrice(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

function pctDistance(price: number, level: number): number {
  if (level === 0) return Number.POSITIVE_INFINITY;
  return (Math.abs(price - level) / level) * 100;
}

function withinBand(price: number, level: number, bandPct: number): boolean {
  return pctDistance(price, level) <= bandPct;
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

export function onlyClosedCandles(
  candlesAsc: Candle[],
  timeframeMinutes: number,
  nowMs: number = Date.now(),
): Candle[] {
  return candlesAsc.filter((c) => isCandleClosed(c, timeframeMinutes, nowMs));
}

export function levelsFromWindow(windowAsc: Candle[]): {
  support: number;
  resistance: number;
} | null {
  if (windowAsc.length === 0) return null;
  let support = Infinity;
  let resistance = -Infinity;
  for (const c of windowAsc) {
    if (c.close < support) support = c.close;
    if (c.close > resistance) resistance = c.close;
  }
  if (!Number.isFinite(support) || !Number.isFinite(resistance)) return null;
  return { support: roundPrice(support), resistance: roundPrice(resistance) };
}

export type LevelEvent =
  | { kind: "hold" }
  | { kind: "hover"; side: HoverSide }
  | { kind: "breach"; side: HoverSide };

/**
 * ±bandPct around each level is ignored for rollover (hover).
 * Outer side beyond the band = breach. Between the inner bands = hold.
 */
export function classifyCloseAgainstLevels(
  close: number,
  support: number,
  resistance: number,
  bandPct: number,
): LevelEvent {
  const supportFloor = support * (1 - bandPct / 100);
  const resistanceCeil = resistance * (1 + bandPct / 100);

  if (close < supportFloor) {
    return { kind: "breach", side: "support" };
  }
  if (close > resistanceCeil) {
    return { kind: "breach", side: "resistance" };
  }

  const nearSupport = withinBand(close, support, bandPct);
  const nearResistance = withinBand(close, resistance, bandPct);
  if (nearSupport && nearResistance) {
    return pctDistance(close, support) <= pctDistance(close, resistance)
      ? { kind: "hover", side: "support" }
      : { kind: "hover", side: "resistance" };
  }
  if (nearSupport) return { kind: "hover", side: "support" };
  if (nearResistance) return { kind: "hover", side: "resistance" };
  return { kind: "hold" };
}

function newCycleId(): string {
  return crypto.randomUUID();
}

function openCycle(params: {
  assetId: number;
  timeframe: number;
  cycleSeq: number;
  support: number;
  resistance: number;
  startedAt: string;
  lastClose: number;
}): SrCycleRow {
  return {
    id: newCycleId(),
    asset_id: params.assetId,
    timeframe: params.timeframe,
    cycle_seq: params.cycleSeq,
    support: params.support,
    resistance: params.resistance,
    started_at: params.startedAt,
    ended_at: null,
    status: "active",
    breach_close: null,
    breach_at: null,
    hover_side: null,
    hover_at: null,
    last_close: params.lastClose,
    last_checked_at: params.startedAt,
  };
}

async function assertAdminAccess(
  env: ComputeCryptoSrEnv,
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
  env: ComputeCryptoSrEnv,
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

function toCandle(row: Record<string, unknown>): Candle | null {
  const bucket = typeof row.bucket_start === "string" ? row.bucket_start : null;
  const close = parseNumber(row.close);
  if (!bucket || close === null) return null;
  return { bucket_start: bucket, close };
}

function toCycleRow(row: Record<string, unknown>): SrCycleRow | null {
  const id = typeof row.id === "string" ? row.id : null;
  const assetId = parseNumber(row.asset_id);
  const timeframe = parseNumber(row.timeframe);
  const cycleSeq = parseNumber(row.cycle_seq);
  const support = parseNumber(row.support);
  const resistance = parseNumber(row.resistance);
  const startedAt = typeof row.started_at === "string" ? row.started_at : null;
  const status = row.status;
  if (
    !id ||
    assetId === null ||
    timeframe === null ||
    cycleSeq === null ||
    support === null ||
    resistance === null ||
    !startedAt ||
    (status !== "active" &&
      status !== "breached_support" &&
      status !== "breached_resistance")
  ) {
    return null;
  }
  const hoverSide = row.hover_side;
  return {
    id,
    asset_id: assetId,
    timeframe,
    cycle_seq: cycleSeq,
    support,
    resistance,
    started_at: startedAt,
    ended_at: typeof row.ended_at === "string" ? row.ended_at : null,
    status,
    breach_close: parseNumber(row.breach_close),
    breach_at: typeof row.breach_at === "string" ? row.breach_at : null,
    hover_side:
      hoverSide === "support" || hoverSide === "resistance" ? hoverSide : null,
    hover_at: typeof row.hover_at === "string" ? row.hover_at : null,
    last_close: parseNumber(row.last_close),
    last_checked_at:
      typeof row.last_checked_at === "string" ? row.last_checked_at : null,
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
      `${base}/rest/v1/crypto_prices?select=bucket_start,close&asset_id=eq.${assetId}&timeframe=eq.${timeframe}&order=bucket_start.desc&limit=${options.limit}`,
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

  let offset = 0;
  while (true) {
    const end = offset + PAGE_SIZE - 1;
    const res = await fetch(
      `${base}/rest/v1/crypto_prices?select=bucket_start,close&asset_id=eq.${assetId}&timeframe=eq.${timeframe}&order=bucket_start.asc`,
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

  return candles;
}

async function fetchActiveCycle(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
  timeframe: number,
): Promise<SrCycleRow | null> {
  const base = supabaseUrl.replace(/\/$/, "");
  const res = await fetch(
    `${base}/rest/v1/crypto_support_resistance?select=*&asset_id=eq.${assetId}&timeframe=eq.${timeframe}&status=eq.active&limit=1`,
    { headers: restHeaders(serviceKey) },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to load active S/R cycle: ${text.slice(0, 300)}`);
  }
  const rows = ((await res.json()) as Record<string, unknown>[])
    .map(toCycleRow)
    .filter((r): r is SrCycleRow => r !== null);
  return rows[0] ?? null;
}

async function fetchMaxCycleSeq(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
  timeframe: number,
): Promise<number> {
  const base = supabaseUrl.replace(/\/$/, "");
  const res = await fetch(
    `${base}/rest/v1/crypto_support_resistance?select=cycle_seq&asset_id=eq.${assetId}&timeframe=eq.${timeframe}&order=cycle_seq.desc&limit=1`,
    { headers: restHeaders(serviceKey) },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to load max cycle_seq: ${text.slice(0, 300)}`);
  }
  const rows = (await res.json()) as Array<{ cycle_seq?: number }>;
  const seq = parseNumber(rows[0]?.cycle_seq);
  return seq ?? 0;
}

function toUpsertPayload(row: SrCycleRow): Record<string, unknown> {
  return {
    id: row.id,
    asset_id: row.asset_id,
    timeframe: row.timeframe,
    cycle_seq: row.cycle_seq,
    support: row.support,
    resistance: row.resistance,
    started_at: row.started_at,
    ended_at: row.ended_at,
    status: row.status,
    breach_close: row.breach_close,
    breach_at: row.breach_at,
    hover_side: row.hover_side,
    hover_at: row.hover_at,
    last_close: row.last_close,
    last_checked_at: row.last_checked_at,
  };
}

async function upsertCycles(
  supabaseUrl: string,
  serviceKey: string,
  rows: SrCycleRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const base = supabaseUrl.replace(/\/$/, "");
  let upserted = 0;

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK).map(toUpsertPayload);
    const res = await fetch(
      `${base}/rest/v1/crypto_support_resistance?on_conflict=id`,
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
      throw new Error(`Failed to upsert crypto_support_resistance: ${text.slice(0, 300)}`);
    }
    upserted += chunk.length;
  }

  return upserted;
}

type ProcessStats = {
  cyclesOpened: number;
  cyclesBreached: number;
  hoversRecorded: number;
  dirty: SrCycleRow[];
};

/**
 * Walk closed candles from `startIndex` (inclusive). Requires candlesAsc length >= LOOKBACK
 * and startIndex >= LOOKBACK - 1.
 */
export function processCandleSeries(
  assetId: number,
  timeframe: number,
  candlesAsc: Candle[],
  startIndex: number,
  initial: { active: SrCycleRow | null; nextSeq: number },
  bandPct: number,
): ProcessStats {
  let active = initial.active;
  let nextSeq = initial.nextSeq;
  const dirty = new Map<string, SrCycleRow>();
  let cyclesOpened = 0;
  let cyclesBreached = 0;
  let hoversRecorded = 0;

  const mark = (row: SrCycleRow) => {
    dirty.set(row.id, row);
  };

  for (let i = startIndex; i < candlesAsc.length; i++) {
    const candle = candlesAsc[i]!;
    const window = candlesAsc.slice(i - LOOKBACK + 1, i + 1);
    const levels = levelsFromWindow(window);
    if (!levels) continue;

    if (!active) {
      active = openCycle({
        assetId,
        timeframe,
        cycleSeq: nextSeq,
        support: levels.support,
        resistance: levels.resistance,
        startedAt: candle.bucket_start,
        lastClose: candle.close,
      });
      nextSeq += 1;
      cyclesOpened += 1;
      mark(active);
      continue;
    }

    const event = classifyCloseAgainstLevels(
      candle.close,
      active.support,
      active.resistance,
      bandPct,
    );

    active.last_close = candle.close;
    active.last_checked_at = candle.bucket_start;

    if (event.kind === "hover") {
      active.hover_side = event.side;
      active.hover_at = candle.bucket_start;
      hoversRecorded += 1;
      mark(active);
      continue;
    }

    if (event.kind === "hold") {
      mark(active);
      continue;
    }

    // Breach → close current cycle, open a new one from this window.
    active.status =
      event.side === "support" ? "breached_support" : "breached_resistance";
    active.ended_at = candle.bucket_start;
    active.breach_close = candle.close;
    active.breach_at = candle.bucket_start;
    active.hover_side = event.side;
    active.hover_at = candle.bucket_start;
    mark(active);
    cyclesBreached += 1;

    active = openCycle({
      assetId,
      timeframe,
      cycleSeq: nextSeq,
      support: levels.support,
      resistance: levels.resistance,
      startedAt: candle.bucket_start,
      lastClose: candle.close,
    });
    nextSeq += 1;
    cyclesOpened += 1;
    mark(active);
  }

  return {
    cyclesOpened,
    cyclesBreached,
    hoversRecorded,
    dirty: [...dirty.values()],
  };
}

async function computeForAssetTimeframe(
  supabaseUrl: string,
  serviceKey: string,
  asset: AssetRow,
  timeframe: number,
  options: { backfill: boolean; bandPct: number },
): Promise<ProcessStats> {
  const nowMs = Date.now();

  if (options.backfill) {
    const raw = await fetchCandlesAsc(supabaseUrl, serviceKey, asset.id, timeframe);
    const candles = onlyClosedCandles(raw, timeframe, nowMs);
    if (candles.length < LOOKBACK) {
      return { cyclesOpened: 0, cyclesBreached: 0, hoversRecorded: 0, dirty: [] };
    }
    // Fresh historical rebuild for this asset/TF: ignore any prior active cycle.
    return processCandleSeries(
      asset.id,
      timeframe,
      candles,
      LOOKBACK - 1,
      { active: null, nextSeq: 1 },
      options.bandPct,
    );
  }

  // Incremental: need LOOKBACK closed bars (+1 fetch slack for an open bar).
  const raw = await fetchCandlesAsc(supabaseUrl, serviceKey, asset.id, timeframe, {
    limit: LOOKBACK + 1,
  });
  const candles = onlyClosedCandles(raw, timeframe, nowMs);
  if (candles.length < LOOKBACK) {
    return { cyclesOpened: 0, cyclesBreached: 0, hoversRecorded: 0, dirty: [] };
  }

  const active = await fetchActiveCycle(supabaseUrl, serviceKey, asset.id, timeframe);
  const maxSeq = active
    ? active.cycle_seq
    : await fetchMaxCycleSeq(supabaseUrl, serviceKey, asset.id, timeframe);

  // Only evaluate the newest closed bar against the active cycle.
  const startIndex = candles.length - 1;
  const latest = candles[startIndex]!;
  if (active?.last_checked_at === latest.bucket_start) {
    return { cyclesOpened: 0, cyclesBreached: 0, hoversRecorded: 0, dirty: [] };
  }

  return processCandleSeries(
    asset.id,
    timeframe,
    candles,
    startIndex,
    {
      active,
      nextSeq: active ? active.cycle_seq + 1 : maxSeq + 1,
    },
    options.bandPct,
  );
}

/**
 * Pass `skipAuth: true` only from trusted local scripts that already hold the service role key.
 */
export async function computeCryptoSupportResistance(
  env: ComputeCryptoSrEnv,
  authHeader: string | null,
  options: ComputeCryptoSrOptions & { skipAuth?: boolean } = {},
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
  const bandPct = options.bandPct ?? DEFAULT_BAND_PCT;
  const allowed = new Set<number>(TIMEFRAMES);
  const timeframes = (options.timeframes?.length ? options.timeframes : [...TIMEFRAMES]).filter(
    (tf) => allowed.has(tf),
  );

  if (timeframes.length === 0) {
    return { success: false, message: "No valid timeframes selected.", status: 400 };
  }

  try {
    const assets = await listEnabledAssets(supabaseUrl, serviceKey);
    const sampleRows: SrCycleRow[] = [];
    let cyclesOpened = 0;
    let cyclesBreached = 0;
    let hoversRecorded = 0;

    for (const asset of assets) {
      for (const timeframe of timeframes) {
        // Backfill replaces history for this asset/TF: delete prior rows first.
        if (options.backfill) {
          await deleteCyclesForAssetTf(supabaseUrl, serviceKey, asset.id, timeframe);
        }

        const result = await computeForAssetTimeframe(
          supabaseUrl,
          serviceKey,
          asset,
          timeframe,
          { backfill: Boolean(options.backfill), bandPct },
        );
        cyclesOpened += result.cyclesOpened;
        cyclesBreached += result.cyclesBreached;
        hoversRecorded += result.hoversRecorded;
        await upsertCycles(supabaseUrl, serviceKey, result.dirty);

        if (!options.backfill) {
          sampleRows.push(...result.dirty);
        } else if (sampleRows.length < 20) {
          const active = result.dirty.find((r) => r.status === "active");
          if (active) sampleRows.push(active);
        }
      }
    }

    return {
      success: true,
      mode,
      assets: assets.length,
      cyclesOpened,
      cyclesBreached,
      hoversRecorded,
      rows: sampleRows,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Compute failed";
    return { success: false, message, status: 500 };
  }
}

async function deleteCyclesForAssetTf(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
  timeframe: number,
): Promise<void> {
  const base = supabaseUrl.replace(/\/$/, "");
  const res = await fetch(
    `${base}/rest/v1/crypto_support_resistance?asset_id=eq.${assetId}&timeframe=eq.${timeframe}`,
    {
      method: "DELETE",
      headers: restHeaders(serviceKey, { Prefer: "return=minimal" }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Failed to clear crypto_support_resistance tf=${timeframe}: ${text.slice(0, 300)}`,
    );
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

      const bandPctRaw = url.searchParams.get("band_pct");
      const bandPct = bandPctRaw !== null ? Number(bandPctRaw) : undefined;

      const env: ComputeCryptoSrEnv = {
        SUPABASE_URL: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
        SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        CRON_SECRET: process.env.CRON_SECRET,
      };

      const result = await computeCryptoSupportResistance(
        env,
        request.headers.get("authorization"),
        {
          backfill,
          timeframes,
          bandPct: Number.isFinite(bandPct) ? bandPct : undefined,
        },
      );

      if (result.success === true) {
        return Response.json(
          {
            success: true,
            mode: result.mode,
            assets: result.assets,
            cyclesOpened: result.cyclesOpened,
            cyclesBreached: result.cyclesBreached,
            hoversRecorded: result.hoversRecorded,
            rows: result.rows,
          },
          { status: 200, headers: jsonHeaders() },
        );
      }
      console.error("[compute-crypto-sr] failed", result.status, result.message);
      return Response.json(
        { success: false, message: result.message },
        { status: result.status ?? 500, headers: jsonHeaders() },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Internal error";
      console.error("[compute-crypto-sr] uncaught", msg);
      return Response.json({ success: false, message: msg }, { status: 500, headers: jsonHeaders() });
    }
  },
};
