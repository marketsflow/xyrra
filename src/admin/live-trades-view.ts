import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";

const WINDOW_SEC = 4 * 60 * 60;
const BTC_SYMBOL = "BTC";
const TF_4H = 240;

type LiveTradeRow = {
  id: number;
  timestamp: string;
  market_slug: string;
  market_title: string | null;
  direction: string;
  entry_poly_price: number | null;
  signal_rule: number | null;
  strike_price: number | null;
  price_to_beat: number | null;
  signal_state: string;
  status: string;
  position_size_usd: number | null;
  order_id: string | null;
  exit_poly_price: number | null;
  pnl_usd: number | null;
  pnl_percent: number | null;
  closed_at: string | null;
  error_message: string | null;
};

type Settlement = {
  status: "WIN" | "LOSS";
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

function pnlForStake(entryPolyPrice: number, won: boolean, stakeUsd: number) {
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

function settleTrade(row: LiveTradeRow, exitSpot: number): Settlement | null {
  const strike = row.price_to_beat ?? row.strike_price;
  const entry = row.entry_poly_price;
  const stake = row.position_size_usd;
  if (strike === null || entry === null || stake === null || !(stake > 0)) return null;

  const upWon = didLongUpWin(exitSpot, strike);
  const won =
    row.direction === "LONG_UP" ? upWon : row.direction === "LONG_DOWN" ? !upWon : null;
  if (won === null) return null;

  const startSec = windowStartSecFromSlug(row.market_slug);
  const closedAt =
    startSec === null
      ? new Date().toISOString()
      : new Date((startSec + WINDOW_SEC) * 1000).toISOString();

  const { pnlUsd, pnlPercent, exitPolyPrice } = pnlForStake(entry, won, stake);
  return {
    status: won ? "WIN" : "LOSS",
    exitPolyPrice,
    pnlUsd,
    pnlPercent,
    closedAt,
  };
}

async function resolveOpenTrades(
  supabase: SupabaseClient,
  rows: LiveTradeRow[],
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
      .from("live_trades")
      .update({
        status: settlement.status,
        exit_poly_price: settlement.exitPolyPrice,
        pnl_usd: settlement.pnlUsd,
        pnl_percent: settlement.pnlPercent,
        closed_at: settlement.closedAt,
      })
      .eq("id", row.id)
      .eq("status", "OPEN");

    if (error) continue;

    row.status = settlement.status;
    row.exit_poly_price = settlement.exitPolyPrice;
    row.pnl_usd = settlement.pnlUsd;
    row.pnl_percent = settlement.pnlPercent;
    row.closed_at = settlement.closedAt;
    settled += 1;
  }

  return settled;
}

function mapRow(row: Record<string, unknown>): LiveTradeRow {
  return {
    id: asNumber(row.id) ?? 0,
    timestamp: asString(row.timestamp) || "",
    market_slug: asString(row.market_slug) || "",
    market_title: asString(row.market_title),
    direction: asString(row.direction) || "",
    entry_poly_price: asNumber(row.entry_poly_price),
    signal_rule: asNumber(row.signal_rule),
    strike_price: asNumber(row.strike_price),
    price_to_beat: asNumber(row.price_to_beat),
    signal_state: asString(row.signal_state) || "",
    status: asString(row.status) || "",
    position_size_usd: asNumber(row.position_size_usd),
    order_id: asString(row.order_id),
    exit_poly_price: asNumber(row.exit_poly_price),
    pnl_usd: asNumber(row.pnl_usd),
    pnl_percent: asNumber(row.pnl_percent),
    closed_at: asString(row.closed_at),
    error_message: asString(row.error_message),
  };
}

function sideLabel(direction: string) {
  return direction.replace("LONG_", "");
}

function resultLabel(status: string) {
  if (status === "WIN") return "Win";
  if (status === "LOSS") return "Loss";
  if (status === "OPEN") return "Open";
  if (status === "PENDING") return "Pending";
  if (status === "FAILED") return "Failed";
  return status;
}

function renderRows(bodyEl: HTMLElement, rows: LiveTradeRow[]) {
  bodyEl.innerHTML = rows
    .map((row) => {
      const title = row.market_title || row.market_slug;
      const orderCell = row.order_id
        ? `<code title="${escapeHtml(row.order_id)}">${escapeHtml(row.order_id.slice(0, 10))}…</code>`
        : row.error_message
          ? `<span class="xa-users__status--error" title="${escapeHtml(row.error_message)}">error</span>`
          : "—";
      return `
      <tr>
        <td>${row.id}</td>
        <td>${escapeHtml(formatDateTime(row.timestamp))}</td>
        <td>${escapeHtml(title)}</td>
        <td>${escapeHtml(row.signal_state || "—")}</td>
        <td>${escapeHtml(sideLabel(row.direction))}</td>
        <td>${row.signal_rule == null ? "—" : escapeHtml(String(row.signal_rule))}</td>
        <td>${escapeHtml(formatUsd(row.position_size_usd))}</td>
        <td>${row.entry_poly_price == null ? "—" : escapeHtml(String(row.entry_poly_price))}</td>
        <td>${orderCell}</td>
        <td>${escapeHtml(resultLabel(row.status))}</td>
        <td>${escapeHtml(formatPnl(row.pnl_usd))}</td>
        <td>${escapeHtml(formatDateTime(row.closed_at))}</td>
      </tr>`;
    })
    .join("");
}

async function init() {
  const session = await requireAdminSession();
  if (!session) return;

  initAdminShell(session, "live-trades-view");
  setAdminLoading(false);

  const statusEl = document.getElementById("xa-live-view-status");
  const emptyEl = document.getElementById("xa-live-view-empty");
  const tableWrap = document.getElementById("xa-live-view-table-wrap");
  const bodyEl = document.getElementById("xa-live-view-body");
  const runBotBtn = document.getElementById("xa-live-run-bot") as HTMLButtonElement | null;
  if (!statusEl || !emptyEl || !tableWrap || !bodyEl) return;

  const supabase = session.supabase;
  const emptyDetailEl = emptyEl.querySelector("p:not(.xa-sent__empty-title)");

  function formatBotStatus(action: string | undefined, message: string | undefined): string {
    const detail = (message || "").trim();
    switch (action) {
      case "placed":
        return detail || "Bot placed a live trade.";
      case "already_exists":
        return detail || "Bot checked — a live trade already exists for this 4h window.";
      case "no_signal":
        return detail || "Bot ran — no Price Levels signal on the current 4h window.";
      case "rule_blocked":
        return detail || "Bot ran — signal rule is not allowed in Settings.";
      case "risk_blocked":
        return detail || "Bot ran — blocked by risk limits (max open / daily loss / balance).";
      case "skipped":
        return detail || "Bot ran — skipped (automation off, or missing setup).";
      case "failed":
        return detail || "Bot ran — order failed.";
      default:
        return detail || `Bot finished (${action || "ok"}).`;
    }
  }

  async function loadTrades(options?: { statusMessage?: string; isError?: boolean }) {
    const keepMessage = options?.statusMessage;
    if (!keepMessage) {
      statusEl!.classList.remove("xa-users__status--error");
      statusEl!.textContent = "Loading live trades…";
    }

    const { data, error } = await supabase
      .from("live_trades")
      .select(
        "id, timestamp, market_slug, market_title, direction, entry_poly_price, signal_rule, strike_price, price_to_beat, signal_state, status, position_size_usd, order_id, exit_poly_price, pnl_usd, pnl_percent, closed_at, error_message",
      )
      .order("timestamp", { ascending: false })
      .limit(200);

    if (error) {
      statusEl!.textContent = error.message;
      statusEl!.classList.add("xa-users__status--error");
      return;
    }

    const rows = (data ?? []).map((row) => mapRow(row as Record<string, unknown>));

    if (rows.length === 0) {
      emptyEl!.hidden = false;
      tableWrap!.hidden = true;
      if (keepMessage) {
        statusEl!.textContent = keepMessage;
        statusEl!.classList.toggle("xa-users__status--error", Boolean(options?.isError));
        if (emptyDetailEl) {
          emptyDetailEl.textContent = keepMessage;
        }
      } else {
        statusEl!.textContent = "No live trades yet. Click Run bot now to check the current 4h window.";
        statusEl!.classList.remove("xa-users__status--error");
        if (emptyDetailEl) {
          emptyDetailEl.textContent =
            "Enable automation in Settings, allow at least one signal rule, then wait for a 4h Price Levels signal — or click Run bot now.";
        }
      }
      return;
    }

    emptyEl!.hidden = true;
    tableWrap!.hidden = false;

    let settled = 0;
    try {
      settled = await resolveOpenTrades(supabase, rows);
    } catch {
      // Still show rows.
    }

    renderRows(bodyEl!, rows);

    if (keepMessage) {
      statusEl!.textContent = keepMessage;
      statusEl!.classList.toggle("xa-users__status--error", Boolean(options?.isError));
    } else {
      statusEl!.classList.remove("xa-users__status--error");
      statusEl!.textContent =
        settled > 0
          ? `Loaded ${rows.length} live trade${rows.length === 1 ? "" : "s"} · settled ${settled}.`
          : `Loaded ${rows.length} live trade${rows.length === 1 ? "" : "s"}.`;
    }
  }

  await loadTrades();

  runBotBtn?.addEventListener("click", () => {
    void (async () => {
      if (!runBotBtn) return;
      runBotBtn.disabled = true;
      statusEl.classList.remove("xa-users__status--error");
      statusEl.textContent = "Running live bot…";

      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        if (!token) throw new Error("Not signed in.");

        const res = await fetch("/api/place-live-trades", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        });
        const raw = await res.text();
        let body: {
          success?: boolean;
          message?: string;
          action?: string;
        } = {};
        try {
          body = raw ? (JSON.parse(raw) as typeof body) : {};
        } catch {
          throw new Error(
            raw.trim().slice(0, 240) || `Bot returned non-JSON (${res.status})`,
          );
        }
        if (!res.ok || body.success === false) {
          throw new Error(body.message || `Bot returned ${res.status}`);
        }

        const botMessage = formatBotStatus(body.action, body.message);
        const isError = body.action === "failed";
        await loadTrades({ statusMessage: botMessage, isError });
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Bot run failed.";
        statusEl.textContent = msg;
        statusEl.classList.add("xa-users__status--error");
      } finally {
        runBotBtn.disabled = false;
      }
    })();
  });
}

void init();
