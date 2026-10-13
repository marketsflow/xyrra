import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";

type VirtualTradeRow = {
  id: number;
  timestamp: string;
  market_slug: string;
  market_title: string | null;
  direction: string;
  entry_poly_price: number | null;
  entry_spot_price: number | null;
  strike_price: number | null;
  price_to_beat: number | null;
  price_level: number | null;
  crypto_price_at: string | null;
  signal_state: string;
  status: string;
  pnl_usd: number | null;
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

function formatCryptoPriceAt(value: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const datePart = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(d);
  const timePart = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
  return `${datePart}, ${timePart}`;
}

async function init() {
  const session = await requireAdminSession();
  if (!session) return;

  initAdminShell(session, "virtual-trades");
  setAdminLoading(false);

  const statusEl = document.getElementById("xa-vt-view-status");
  const emptyEl = document.getElementById("xa-vt-view-empty");
  const tableWrap = document.getElementById("xa-vt-view-table-wrap");
  const bodyEl = document.getElementById("xa-vt-view-body");
  if (!statusEl || !emptyEl || !tableWrap || !bodyEl) return;

  statusEl.textContent = "Loading virtual trades…";

  const { data, error } = await session.supabase
    .from("virtual_trades")
    .select(
      "id, timestamp, market_slug, market_title, direction, entry_poly_price, entry_spot_price, strike_price, price_to_beat, price_level, crypto_price_at, signal_state, status, pnl_usd",
    )
    .order("timestamp", { ascending: false })
    .limit(200);

  if (error) {
    statusEl.textContent = error.message;
    statusEl.classList.add("xa-users__status--error");
    return;
  }

  const rows: VirtualTradeRow[] = (data ?? []).map((row) => ({
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
    pnl_usd: asNumber(row.pnl_usd),
  }));

  if (rows.length === 0) {
    statusEl.textContent = "";
    emptyEl.hidden = false;
    tableWrap.hidden = true;
    return;
  }

  emptyEl.hidden = true;
  tableWrap.hidden = false;
  statusEl.textContent = `${rows.length} virtual trade${rows.length === 1 ? "" : "s"}.`;

  bodyEl.innerHTML = rows
    .map(
      (row) => `
      <tr>
        <td>${escapeHtml(String(row.id))}</td>
        <td>${escapeHtml(formatDateTime(row.timestamp))}</td>
        <td>${escapeHtml(row.market_title || row.market_slug)}</td>
        <td>${escapeHtml(formatCryptoPriceAt(row.crypto_price_at))}</td>
        <td>${escapeHtml(formatUsd(row.price_to_beat ?? row.strike_price))}</td>
        <td>${escapeHtml(formatUsd(row.price_level))}</td>
        <td>${escapeHtml(row.signal_state)}</td>
        <td>${escapeHtml(formatUsd(row.entry_spot_price))}</td>
        <td>${row.entry_poly_price == null ? "—" : escapeHtml(row.entry_poly_price.toFixed(3))}</td>
        <td>${escapeHtml(row.direction)}</td>
        <td>${escapeHtml(row.status)}</td>
      </tr>`,
    )
    .join("");
}

void init();
