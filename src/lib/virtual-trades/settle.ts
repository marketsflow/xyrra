import type { SupabaseClient } from "@supabase/supabase-js";

const WINDOW_SEC = 4 * 60 * 60;
/** Stake used for settled P&L. */
export const VIRTUAL_TRADE_STAKE_USD = 10;
const BTC_SYMBOL = "BTC";
const TF_4H = 240;
/** Max concurrent settle updates / tick fallbacks. */
const SETTLE_CONCURRENCY = 8;

export type SettledVirtualTradeFields = {
  id: number;
  market_slug: string;
  direction: string;
  entry_poly_price: number | null;
  strike_price: number | null;
  price_to_beat: number | null;
  status: string;
  /** Optional display fields updated in place when settled. */
  exit_poly_price?: number | null;
  pnl_usd?: number | null;
  pnl_percent?: number | null;
  closed_at?: string | null;
  position_size_usd?: number | null;
};

export type VirtualTradeSettlement = {
  status: "WIN" | "LOSS";
  exitSpot: number;
  exitPolyPrice: number;
  pnlUsd: number;
  pnlPercent: number;
  closedAt: string;
};

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function windowStartSecFromSlug(slug: string): number | null {
  const match = /^btc-updown-4h-(\d+)$/.exec(slug);
  if (!match) return null;
  const sec = Number(match[1]);
  return Number.isFinite(sec) ? sec : null;
}

export function isVirtualTradeWindowClosed(slug: string, nowMs = Date.now()): boolean {
  const start = windowStartSecFromSlug(slug);
  if (start === null) return false;
  return (start + WINDOW_SEC) * 1000 <= nowMs;
}

/**
 * Binary Polymarket Up/Down: $stake buys stake/entry shares.
 * WIN pays $1/share → profit = stake/entry - stake; LOSS → -stake.
 */
export function pnlForVirtualTradeStake(
  entryPolyPrice: number,
  won: boolean,
  stakeUsd = VIRTUAL_TRADE_STAKE_USD,
) {
  if (!(entryPolyPrice > 0) || entryPolyPrice > 1) {
    throw new Error(`Invalid entry poly price ${entryPolyPrice}`);
  }
  if (won) {
    const payout = stakeUsd / entryPolyPrice;
    const pnlUsd = Number((payout - stakeUsd).toFixed(2));
    const pnlPercent = Number((((payout - stakeUsd) / stakeUsd) * 100).toFixed(4));
    return { pnlUsd, pnlPercent, exitPolyPrice: 1 };
  }
  return {
    pnlUsd: Number((-stakeUsd).toFixed(2)),
    pnlPercent: -100,
    exitPolyPrice: 0,
  };
}

function didLongUpWin(exitSpot: number, strike: number): boolean {
  return exitSpot > strike;
}

async function loadBtcAssetId(supabase: SupabaseClient): Promise<number | null> {
  const { data, error } = await supabase
    .from("crypto_assets")
    .select("id")
    .eq("symbol", BTC_SYMBOL)
    .maybeSingle();
  if (error || !data) return null;
  return asNumber(data.id);
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Prefer 4h candle closes in one query (fast path). Fall back to last tick
 * spot only for windows missing a candle.
 */
async function loadExitSpotsBySlug(
  supabase: SupabaseClient,
  slugs: string[],
  assetId: number | null,
): Promise<Map<string, number>> {
  const unique = [...new Set(slugs.filter(Boolean))];
  const out = new Map<string, number>();
  if (unique.length === 0) return out;

  const startBySlug = new Map<string, number>();
  const bucketStarts: string[] = [];
  for (const slug of unique) {
    const startSec = windowStartSecFromSlug(slug);
    if (startSec === null) continue;
    startBySlug.set(slug, startSec);
    bucketStarts.push(new Date(startSec * 1000).toISOString());
  }

  if (assetId !== null && bucketStarts.length > 0) {
    const { data, error } = await supabase
      .from("crypto_prices")
      .select("bucket_start, close")
      .eq("asset_id", assetId)
      .eq("timeframe", TF_4H)
      .in("bucket_start", [...new Set(bucketStarts)]);

    if (!error && data) {
      const closeByBucket = new Map<string, number>();
      for (const row of data) {
        const bucket =
          typeof row.bucket_start === "string"
            ? row.bucket_start
            : row.bucket_start instanceof Date
              ? row.bucket_start.toISOString()
              : null;
        const close = asNumber(row.close);
        if (bucket && close !== null) closeByBucket.set(bucket, close);
      }
      for (const [slug, startSec] of startBySlug) {
        const bucket = new Date(startSec * 1000).toISOString();
        const close = closeByBucket.get(bucket);
        if (close !== null && close !== undefined) out.set(slug, close);
      }
    }
  }

  const missing = unique.filter((slug) => !out.has(slug) && startBySlug.has(slug));
  if (missing.length === 0) return out;

  await mapPool(missing, SETTLE_CONCURRENCY, async (slug) => {
    const startSec = startBySlug.get(slug);
    if (startSec === undefined) return;
    const startIso = new Date(startSec * 1000).toISOString();
    const endIso = new Date((startSec + WINDOW_SEC) * 1000).toISOString();
    const tick = await supabase
      .from("polymarket_ticks")
      .select("spot_price")
      .eq("event_slug", slug)
      .not("spot_price", "is", null)
      .gte("recorded_at", startIso)
      .lte("recorded_at", endIso)
      .order("recorded_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (tick.error) return;
    const spot = asNumber(tick.data?.spot_price);
    if (spot !== null) out.set(slug, spot);
  });

  return out;
}

export function settleVirtualTrade(
  row: SettledVirtualTradeFields,
  exitSpot: number,
): VirtualTradeSettlement | null {
  const strike = row.price_to_beat ?? row.strike_price;
  const entry = row.entry_poly_price;
  if (strike === null || entry === null) return null;

  const upWon = didLongUpWin(exitSpot, strike);
  const won =
    row.direction === "LONG_UP" ? upWon : row.direction === "LONG_DOWN" ? !upWon : null;
  if (won === null) return null;

  const startSec = windowStartSecFromSlug(row.market_slug);
  const closedAt =
    startSec === null
      ? new Date().toISOString()
      : new Date((startSec + WINDOW_SEC) * 1000).toISOString();

  const { pnlUsd, pnlPercent, exitPolyPrice } = pnlForVirtualTradeStake(entry, won);
  return {
    status: won ? "WIN" : "LOSS",
    exitSpot,
    exitPolyPrice,
    pnlUsd,
    pnlPercent,
    closedAt,
  };
}

/**
 * Settle OPEN virtual trades whose 4h window has ended.
 * Updates rows in place and returns how many were settled.
 * DB trigger books P&L onto the paper account when status → WIN/LOSS.
 */
export async function resolveOpenVirtualTrades(
  supabase: SupabaseClient,
  rows: SettledVirtualTradeFields[],
): Promise<number> {
  const open = rows.filter(
    (row) => row.status === "OPEN" && isVirtualTradeWindowClosed(row.market_slug),
  );
  if (open.length === 0) return 0;

  const assetId = await loadBtcAssetId(supabase);
  const exitBySlug = await loadExitSpotsBySlug(
    supabase,
    open.map((row) => row.market_slug),
    assetId,
  );

  const ready: Array<{ row: SettledVirtualTradeFields; settlement: VirtualTradeSettlement }> = [];
  for (const row of open) {
    const exitSpot = exitBySlug.get(row.market_slug);
    if (exitSpot === undefined) continue;
    const settlement = settleVirtualTrade(row, exitSpot);
    if (!settlement) continue;
    ready.push({ row, settlement });
  }
  if (ready.length === 0) return 0;

  const outcomes = await mapPool(ready, SETTLE_CONCURRENCY, async ({ row, settlement }) => {
    const { error } = await supabase
      .from("virtual_trades")
      .update({
        status: settlement.status,
        exit_poly_price: settlement.exitPolyPrice,
        pnl_usd: settlement.pnlUsd,
        pnl_percent: settlement.pnlPercent,
        closed_at: settlement.closedAt,
        position_size_usd: VIRTUAL_TRADE_STAKE_USD,
      })
      .eq("id", row.id)
      .eq("status", "OPEN");

    if (error) return false;

    row.status = settlement.status;
    row.exit_poly_price = settlement.exitPolyPrice;
    row.pnl_usd = settlement.pnlUsd;
    row.pnl_percent = settlement.pnlPercent;
    row.closed_at = settlement.closedAt;
    row.position_size_usd = VIRTUAL_TRADE_STAKE_USD;
    return true;
  });

  return outcomes.filter(Boolean).length;
}

/**
 * Load OPEN trades with closed windows and settle them (for pages that don't
 * already have the trade list, e.g. Accounts).
 */
export async function settleOpenVirtualTrades(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase
    .from("virtual_trades")
    .select("id, market_slug, direction, entry_poly_price, strike_price, price_to_beat, status")
    .eq("status", "OPEN")
    .order("timestamp", { ascending: true })
    .limit(500);

  if (error || !data?.length) return 0;

  const rows: SettledVirtualTradeFields[] = data.map((row) => ({
    id: asNumber(row.id) ?? 0,
    market_slug: typeof row.market_slug === "string" ? row.market_slug : "",
    direction: typeof row.direction === "string" ? row.direction : "",
    entry_poly_price: asNumber(row.entry_poly_price),
    strike_price: asNumber(row.strike_price),
    price_to_beat: asNumber(row.price_to_beat),
    status: typeof row.status === "string" ? row.status : "OPEN",
  }));

  // Cheap client filter: skip network work when nothing is ready to settle.
  if (!rows.some((row) => isVirtualTradeWindowClosed(row.market_slug))) return 0;

  return resolveOpenVirtualTrades(supabase, rows);
}
