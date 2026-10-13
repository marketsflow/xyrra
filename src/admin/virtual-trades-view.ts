import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";

const WINDOW_SEC = 4 * 60 * 60;
/** Stake used for displayed / settled P&L. */
const STAKE_USD = 10;
const BTC_SYMBOL = "BTC";
const TF_4H = 240;

type VirtualTradeRow = {
  id: number;
  timestamp: string;
  market_slug: string;
  market_title: string | null;
  direction: "LONG_UP" | "LONG_DOWN" | string;
  entry_poly_price: number | null;
  entry_spot_price: number | null;
  strike_price: number | null;
  price_to_beat: number | null;
  price_level: number | null;
  crypto_price_at: string | null;
  signal_state: string;
  status: string;
  exit_poly_price: number | null;
  pnl_usd: number | null;
  pnl_percent: number | null;
  closed_at: string | null;
  position_size_usd: number | null;
};

type Settlement = {
  status: "WIN" | "LOSS";
  exitSpot: number;
  exitPolyPrice: number;
  pnlUsd: number;
  pnlPercent: number;
  closedAt: string;
};

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function formatUsd(value: number | null) {
  if (value === null) return "—";
  return value.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function formatPnl(value: number | null) {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
  });
}

function windowStartSecFromSlug(slug: string): number | null {
  const match = /^btc-updown-4h-(\d+)$/.exec(slug);
  if (!match) return null;
  const sec = Number(match[1]);
  return Number.isFinite(sec) ? sec : null;
}

function isWindowClosed(slug: string, nowMs = Date.now()): boolean {
  const start = windowStartSecFromSlug(slug);
  if (start === null) return false;
  return (start + WINDOW_SEC) * 1000 <= nowMs;
}

/**
 * Binary Polymarket Up/Down: $STAKE buys STAKE/entry shares.
 * WIN pays $1/share → profit = STAKE/entry - STAKE; LOSS → -STAKE.
 */
function pnlForStake(entryPolyPrice: number, won: boolean, stakeUsd = STAKE_USD) {
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

  // Prefer last Polymarket tick spot in the window.
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

  // Fallback: 4h candle close for this window (bucket_start = window start).
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

function settleTrade(row: VirtualTradeRow, exitSpot: number): Settlement | null {
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

  const { pnlUsd, pnlPercent, exitPolyPrice } = pnlForStake(entry, won);
  return {
    status: won ? "WIN" : "LOSS",
    exitSpot,
    exitPolyPrice,
    pnlUsd,
    pnlPercent,
    closedAt,
  };
}

async function resolveOpenTrades(
  supabase: SupabaseClient,
  rows: VirtualTradeRow[],
): Promise<number> {
  const open = rows.filter((row) => row.status === "OPEN" && isWindowClosed(row.market_slug));
  if (open.length === 0) return 0;

  const assetId = await loadBtcAssetId(supabase);
  let settled = 0;

  for (const row of open) {
    const exitSpot = await loadExitSpot(supabase, row.market_slug, assetId);
    if (exitSpot === null) continue;
    const settlement = settleTrade(row, exitSpot);
    if (!settlement) continue;

    const { error } = await supabase
      .from("virtual_trades")
      .update({
        status: settlement.status,
        exit_poly_price: settlement.exitPolyPrice,
        pnl_usd: settlement.pnlUsd,
        pnl_percent: settlement.pnlPercent,
        closed_at: settlement.closedAt,
        position_size_usd: STAKE_USD,
      })
      .eq("id", row.id)
      .eq("status", "OPEN");

    if (error) continue;

    row.status = settlement.status;
    row.exit_poly_price = settlement.exitPolyPrice;
    row.pnl_usd = settlement.pnlUsd;
    row.pnl_percent = settlement.pnlPercent;
    row.closed_at = settlement.closedAt;
    row.position_size_usd = STAKE_USD;
    settled += 1;
  }

  return settled;
}

/** Recompute display P&L at $10 when entry price is known (for already-settled rows). */
function displayPnl(row: VirtualTradeRow): number | null {
  if (row.status !== "WIN" && row.status !== "LOSS") return null;
  if (row.entry_poly_price === null || row.entry_poly_price <= 0) return row.pnl_usd;
  try {
    return pnlForStake(row.entry_poly_price, row.status === "WIN", STAKE_USD).pnlUsd;
  } catch {
    return row.pnl_usd;
  }
}

function resultLabel(status: string) {
  if (status === "WIN") return "Win";
  if (status === "LOSS") return "Loss";
  if (status === "OPEN") return "Open";
  return status;
}

function mapRow(row: Record<string, unknown>): VirtualTradeRow {
  return {
    id: asNumber(row.id) ?? 0,
    timestamp: asString(row.timestamp) || "",
    market_slug: asString(row.market_slug) || "",
    market_title: asString(row.market_title),
    direction: asString(row.direction) || "",
    entry_poly_price: asNumber(row.entry_poly_price),
    entry_spot_price: asNumber(row.entry_spot_price),
    strike_price: asNumber(row.strike_price),
    price_to_beat: asNumber(row.price_to_beat),
    price_level: asNumber(row.price_level),
    crypto_price_at: asString(row.crypto_price_at),
    signal_state: asString(row.signal_state) || "",
    status: asString(row.status) || "",
    exit_poly_price: asNumber(row.exit_poly_price),
    pnl_usd: asNumber(row.pnl_usd),
    pnl_percent: asNumber(row.pnl_percent),
    closed_at: asString(row.closed_at),
    position_size_usd: asNumber(row.position_size_usd),
  };
}

async function init() {
  const session = await requireAdminSession();
  if (!session) return;

  initAdminShell(session, "virtual-trades");
  setAdminLoading(false);

  const statusNode = document.getElementById("xa-vt-view-status");
  const emptyNode = document.getElementById("xa-vt-view-empty");
  const tableWrapNode = document.getElementById("xa-vt-view-table-wrap");
  const bodyNode = document.getElementById("xa-vt-view-body");
  if (!statusNode || !emptyNode || !tableWrapNode || !bodyNode) return;

  // Locals after the null guard so nested helpers keep non-null types under tsc.
  const statusEl = statusNode;
  const emptyEl = emptyNode;
  const tableWrap = tableWrapNode;
  const bodyEl = bodyNode;

  statusEl.textContent = "Loading virtual trades…";

  const { data, error } = await session.supabase
    .from("virtual_trades")
    .select(
      "id, timestamp, market_slug, market_title, direction, entry_poly_price, entry_spot_price, strike_price, price_to_beat, price_level, crypto_price_at, signal_state, status, exit_poly_price, pnl_usd, pnl_percent, closed_at, position_size_usd",
    )
    .order("timestamp", { ascending: false })
    .limit(200);

  if (error) {
    statusEl.textContent = error.message;
    statusEl.classList.add("xa-users__status--error");
    return;
  }

  const rows = (data ?? []).map((row) => mapRow(row as Record<string, unknown>));

  if (rows.length === 0) {
    statusEl.textContent = "";
    emptyEl.hidden = false;
    tableWrap.hidden = true;
    return;
  }

  let settled = 0;
  try {
    settled = await resolveOpenTrades(session.supabase, rows);
  } catch {
    // Still show rows even if settlement fails.
  }

  function renderStatus() {
    const wins = rows.filter((r) => r.status === "WIN").length;
    const losses = rows.filter((r) => r.status === "LOSS").length;
    const open = rows.filter((r) => r.status === "OPEN").length;
    const totalPnl = rows
      .map((r) => displayPnl(r))
      .filter((n): n is number => n !== null)
      .reduce((sum, n) => sum + n, 0);

    statusEl.textContent =
      `${rows.length} trade${rows.length === 1 ? "" : "s"}` +
      ` · ${wins} win / ${losses} loss / ${open} open` +
      ` · P&L on $${STAKE_USD}/trade: ${formatPnl(totalPnl)}` +
      (settled > 0 ? ` · settled ${settled} just now` : "");
  }

  function renderRows() {
    if (rows.length === 0) {
      emptyEl.hidden = false;
      tableWrap.hidden = true;
      bodyEl.innerHTML = "";
      statusEl.textContent = "";
      return;
    }

    emptyEl.hidden = true;
    tableWrap.hidden = false;
    renderStatus();

    bodyEl.innerHTML = rows
      .map((row) => {
        const pnl = displayPnl(row);
        const pnlClass =
          pnl === null ? "" : pnl > 0 ? "xa-vt__pnl--win" : pnl < 0 ? "xa-vt__pnl--loss" : "";
        const resultClass =
          row.status === "WIN"
            ? "xa-vt__result--win"
            : row.status === "LOSS"
              ? "xa-vt__result--loss"
              : "xa-vt__result--open";

        return `
      <tr data-trade-id="${row.id}">
        <td>${escapeHtml(String(row.id))}</td>
        <td>${escapeHtml(formatDateTime(row.timestamp))}</td>
        <td>${escapeHtml(row.market_title || row.market_slug)}</td>
        <td>${escapeHtml(formatUsd(row.price_to_beat ?? row.strike_price))}</td>
        <td>${escapeHtml(row.signal_state)}</td>
        <td>${escapeHtml(row.direction.replace("LONG_", ""))}</td>
        <td>${row.entry_poly_price == null ? "—" : escapeHtml(row.entry_poly_price.toFixed(3))}</td>
        <td>${escapeHtml(formatUsd(row.entry_spot_price))}</td>
        <td><span class="xa-vt__result ${resultClass}">${escapeHtml(resultLabel(row.status))}</span></td>
        <td class="${pnlClass}">${escapeHtml(row.status === "OPEN" ? "—" : formatPnl(pnl))}</td>
        <td>${escapeHtml(formatDateTime(row.closed_at))}</td>
        <td>
          <button
            type="button"
            class="xa-vt__delete"
            data-delete-id="${row.id}"
            data-delete-label="${escapeHtml(row.market_title || row.market_slug)}"
          >Delete</button>
        </td>
      </tr>`;
      })
      .join("");
  }

  renderRows();

  bodyEl.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || !target.classList.contains("xa-vt__delete")) {
      return;
    }
    const id = Number(target.dataset.deleteId);
    if (!Number.isFinite(id)) return;
    const label = target.dataset.deleteLabel || `trade #${id}`;
    if (!window.confirm(`Delete virtual trade #${id} (${label})? You can re-place it from Create.`)) {
      return;
    }

    void (async () => {
      target.disabled = true;
      statusEl.classList.remove("xa-users__status--error");
      statusEl.textContent = `Deleting trade #${id}…`;
      const { error: deleteError } = await session.supabase
        .from("virtual_trades")
        .delete()
        .eq("id", id);
      if (deleteError) {
        target.disabled = false;
        statusEl.textContent = deleteError.message;
        statusEl.classList.add("xa-users__status--error");
        return;
      }
      const idx = rows.findIndex((row) => row.id === id);
      if (idx >= 0) rows.splice(idx, 1);
      settled = 0;
      renderRows();
      statusEl.textContent =
        rows.length === 0
          ? `Deleted trade #${id}.`
          : `Deleted trade #${id}. ${rows.length} remaining.`;
    })();
  });
}

void init();
