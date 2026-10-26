import type { SupabaseClient } from "@supabase/supabase-js";

const WINDOW_SEC = 4 * 60 * 60;
/** Stake used for settled P&L. */
export const VIRTUAL_TRADE_STAKE_USD = 10;
const BTC_SYMBOL = "BTC";
const TF_4H = 240;

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

async function loadExitSpot(
  supabase: SupabaseClient,
  slug: string,
  assetId: number | null,
): Promise<number | null> {
  const startSec = windowStartSecFromSlug(slug);
  if (startSec === null) return null;
  const startIso = new Date(startSec * 1000).toISOString();
  const endIso = new Date((startSec + WINDOW_SEC) * 1000).toISOString();

  const tick = await supabase
    .from("polymarket_ticks")
    .select("spot_price, recorded_at")
    .eq("event_slug", slug)
    .not("spot_price", "is", null)
    .gte("recorded_at", startIso)
    .lte("recorded_at", endIso)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!tick.error) {
    const spot = asNumber(tick.data?.spot_price);
    if (spot !== null) return spot;
  }

  if (assetId !== null) {
    const candle = await supabase
      .from("crypto_prices")
      .select("close")
      .eq("asset_id", assetId)
      .eq("timeframe", TF_4H)
      .eq("bucket_start", startIso)
      .maybeSingle();
    if (!candle.error) {
      const close = asNumber(candle.data?.close);
      if (close !== null) return close;
    }
  }

  return null;
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
  let settled = 0;

  for (const row of open) {
    const exitSpot = await loadExitSpot(supabase, row.market_slug, assetId);
    if (exitSpot === null) continue;
    const settlement = settleVirtualTrade(row, exitSpot);
    if (!settlement) continue;

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

    if (error) continue;

    row.status = settlement.status;
    row.exit_poly_price = settlement.exitPolyPrice;
    row.pnl_usd = settlement.pnlUsd;
    row.pnl_percent = settlement.pnlPercent;
    row.closed_at = settlement.closedAt;
    row.position_size_usd = VIRTUAL_TRADE_STAKE_USD;
    settled += 1;
  }

  return settled;
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

  return resolveOpenVirtualTrades(supabase, rows);
}
