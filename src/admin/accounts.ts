import { settleOpenVirtualTrades } from "../lib/virtual-trades/settle";
import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";
import type { SupabaseClient } from "@supabase/supabase-js";

const PAGE_SIZE = 200;

type AccountRow = {
  id: number;
  name: string;
  starting_balance_usd: number;
  balance_usd: number;
  updated_at: string | null;
};

type TxRow = {
  id: number;
  kind: string;
  amount_usd: number;
  balance_after_usd: number;
  description: string | null;
  virtual_trade_id: number | null;
  created_at: string;
};

type AccountsUi = {
  statusEl: HTMLElement;
  balanceEl: HTMLElement;
  startingEl: HTMLElement;
  updatedEl: HTMLElement;
  nameEl: HTMLElement;
  emptyEl: HTMLElement;
  tableWrap: HTMLElement;
  bodyEl: HTMLElement;
  moreWrap: HTMLElement;
  moreLabel: HTMLElement;
  showMoreBtn: HTMLButtonElement;
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
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatSignedUsd(value: number | null) {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatUsd(value)}`;
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

function kindLabel(kind: string) {
  if (kind === "opening") return "Opening";
  if (kind === "trade_pnl") return "Trade P&L";
  if (kind === "trade_pnl_reversal") return "Reversal";
  if (kind === "adjustment") return "Adjustment";
  return kind;
}

function mapTxRows(data: Array<Record<string, unknown>> | null): TxRow[] {
  return (data ?? []).map((row) => ({
    id: asNumber(row.id) ?? 0,
    kind: asString(row.kind) || "",
    amount_usd: asNumber(row.amount_usd) ?? 0,
    balance_after_usd: asNumber(row.balance_after_usd) ?? 0,
    description: asString(row.description),
    virtual_trade_id: asNumber(row.virtual_trade_id),
    created_at: asString(row.created_at) || "",
  }));
}

function renderRowsHtml(rows: TxRow[]) {
  return rows
    .map((row) => {
      const amountClass =
        row.amount_usd > 0
          ? "xa-vt__pnl--win"
          : row.amount_usd < 0
            ? "xa-vt__pnl--loss"
            : "";
      return `
      <tr>
        <td>${escapeHtml(formatDateTime(row.created_at))}</td>
        <td>${escapeHtml(kindLabel(row.kind))}</td>
        <td>${escapeHtml(row.description || "—")}</td>
        <td>${row.virtual_trade_id == null ? "—" : escapeHtml(`#${row.virtual_trade_id}`)}</td>
        <td class="${amountClass}">${escapeHtml(formatSignedUsd(row.amount_usd))}</td>
        <td>${escapeHtml(formatUsd(row.balance_after_usd))}</td>
      </tr>`;
    })
    .join("");
}

function updateMoreControls(ui: AccountsUi, shown: number, total: number, loading = false) {
  const hasMore = shown < total;
  ui.moreWrap.hidden = total === 0 || (!hasMore && shown <= PAGE_SIZE);
  if (total === 0) {
    ui.moreLabel.textContent = "";
    ui.showMoreBtn.hidden = true;
    return;
  }

  ui.moreLabel.textContent =
    shown >= total
      ? `Showing all ${total.toLocaleString()} transaction${total === 1 ? "" : "s"}`
      : `Showing ${shown.toLocaleString()} of ${total.toLocaleString()}`;
  ui.showMoreBtn.hidden = !hasMore;
  ui.showMoreBtn.disabled = loading;
  ui.showMoreBtn.textContent = loading ? "Loading…" : "Show more";
}

function renderLedger(
  ui: AccountsUi,
  account: AccountRow,
  rows: TxRow[],
  totalCount: number,
  settledJustNow = 0,
) {
  const { statusEl, balanceEl, startingEl, updatedEl, nameEl, emptyEl, tableWrap, bodyEl } = ui;

  nameEl.textContent = account.name;
  startingEl.textContent = formatUsd(account.starting_balance_usd);
  balanceEl.textContent = formatUsd(account.balance_usd);
  balanceEl.classList.toggle("xa-vt__pnl--win", account.balance_usd > account.starting_balance_usd);
  balanceEl.classList.toggle("xa-vt__pnl--loss", account.balance_usd < account.starting_balance_usd);
  updatedEl.textContent = formatDateTime(account.updated_at);

  const pnlTotal = account.balance_usd - account.starting_balance_usd;
  const shownNote =
    totalCount > rows.length
      ? `Showing ${rows.length.toLocaleString()} of ${totalCount.toLocaleString()} transactions`
      : `${totalCount.toLocaleString()} transaction${totalCount === 1 ? "" : "s"}`;
  statusEl.classList.remove("xa-users__status--error");
  statusEl.textContent =
    `${shownNote} · net P&L ${formatSignedUsd(pnlTotal)}` +
    (settledJustNow > 0
      ? ` · settled ${settledJustNow} trade${settledJustNow === 1 ? "" : "s"}`
      : "");

  if (rows.length === 0) {
    emptyEl.hidden = false;
    tableWrap.hidden = true;
    bodyEl.innerHTML = "";
    updateMoreControls(ui, 0, 0);
    return;
  }

  emptyEl.hidden = true;
  tableWrap.hidden = false;
  bodyEl.innerHTML = renderRowsHtml(rows);
  updateMoreControls(ui, rows.length, totalCount);
}

async function loadAccount(
  supabase: SupabaseClient,
): Promise<AccountRow | { error: string }> {
  const { data: accountData, error: accountError } = await supabase
    .from("accounts")
    .select("id, name, starting_balance_usd, balance_usd, updated_at")
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (accountError) return { error: accountError.message };
  if (!accountData) return { error: "No account found. Run the accounts migration first." };

  return {
    id: asNumber(accountData.id) ?? 0,
    name: asString(accountData.name) || "Account",
    starting_balance_usd: asNumber(accountData.starting_balance_usd) ?? 10,
    balance_usd: asNumber(accountData.balance_usd) ?? 10,
    updated_at: asString(accountData.updated_at),
  };
}

async function loadTransactions(
  supabase: SupabaseClient,
  accountId: number,
  offset: number,
  limit: number,
): Promise<{ rows: TxRow[]; totalCount: number } | { error: string }> {
  const { data, error, count } = await supabase
    .from("account_transactions")
    .select("id, kind, amount_usd, balance_after_usd, description, virtual_trade_id, created_at", {
      count: "exact",
    })
    .eq("account_id", accountId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return { error: error.message };

  const rows = mapTxRows((data ?? []) as Array<Record<string, unknown>>);
  const totalCount = typeof count === "number" ? count : offset + rows.length;
  return { rows, totalCount };
}

async function init() {
  const session = await requireAdminSession();
  if (!session) return;

  initAdminShell(session, "accounts");
  setAdminLoading(false);

  const statusEl = document.getElementById("xa-accounts-status");
  const balanceEl = document.getElementById("xa-accounts-balance");
  const startingEl = document.getElementById("xa-accounts-starting");
  const updatedEl = document.getElementById("xa-accounts-updated");
  const nameEl = document.getElementById("xa-accounts-name");
  const emptyEl = document.getElementById("xa-accounts-empty");
  const tableWrap = document.getElementById("xa-accounts-table-wrap");
  const bodyEl = document.getElementById("xa-accounts-body");
  const moreWrap = document.getElementById("xa-accounts-more-wrap");
  const moreLabel = document.getElementById("xa-accounts-more-label");
  const showMoreBtn = document.getElementById(
    "xa-accounts-show-more",
  ) as HTMLButtonElement | null;
  if (
    !statusEl ||
    !balanceEl ||
    !startingEl ||
    !updatedEl ||
    !nameEl ||
    !emptyEl ||
    !tableWrap ||
    !bodyEl ||
    !moreWrap ||
    !moreLabel ||
    !showMoreBtn
  ) {
    return;
  }

  const ui: AccountsUi = {
    statusEl,
    balanceEl,
    startingEl,
    updatedEl,
    nameEl,
    emptyEl,
    tableWrap,
    bodyEl,
    moreWrap,
    moreLabel,
    showMoreBtn,
  };

  let account: AccountRow | null = null;
  let rows: TxRow[] = [];
  let totalCount = 0;
  let settledJustNow = 0;
  let loadingMore = false;

  function paint() {
    if (!account) return;
    renderLedger(ui, account, rows, totalCount, settledJustNow);
  }

  statusEl.textContent = "Loading account…";

  const loadedAccount = await loadAccount(session.supabase);
  if ("error" in loadedAccount) {
    statusEl.textContent = loadedAccount.error;
    statusEl.classList.add("xa-users__status--error");
    return;
  }
  account = loadedAccount;

  const firstPage = await loadTransactions(session.supabase, account.id, 0, PAGE_SIZE);
  if ("error" in firstPage) {
    statusEl.textContent = firstPage.error;
    statusEl.classList.add("xa-users__status--error");
    return;
  }
  rows = firstPage.rows;
  totalCount = firstPage.totalCount;
  paint();

  showMoreBtn.addEventListener("click", async () => {
    if (!account || loadingMore || rows.length >= totalCount) return;
    loadingMore = true;
    updateMoreControls(ui, rows.length, totalCount, true);

    const next = await loadTransactions(
      session.supabase,
      account.id,
      rows.length,
      PAGE_SIZE,
    );
    loadingMore = false;

    if ("error" in next) {
      statusEl.textContent = next.error;
      statusEl.classList.add("xa-users__status--error");
      updateMoreControls(ui, rows.length, totalCount);
      return;
    }

    // Deduplicate if settlement inserted rows while paging.
    const seen = new Set(rows.map((r) => r.id));
    for (const row of next.rows) {
      if (!seen.has(row.id)) {
        rows.push(row);
        seen.add(row.id);
      }
    }
    totalCount = Math.max(next.totalCount, rows.length);
    paint();
  });

  // Settle closed OPEN windows in the background, then refresh if anything booked.
  statusEl.textContent = `${statusEl.textContent} · checking open trades…`;
  try {
    settledJustNow = await settleOpenVirtualTrades(session.supabase);
    if (settledJustNow <= 0) {
      paint();
      return;
    }

    const refreshedAccount = await loadAccount(session.supabase);
    if ("error" in refreshedAccount) {
      paint();
      return;
    }
    account = refreshedAccount;

    // Keep at least what the user already had open (rounded up to a page).
    const keep = Math.max(PAGE_SIZE, Math.ceil(rows.length / PAGE_SIZE) * PAGE_SIZE);
    const refreshed = await loadTransactions(session.supabase, account.id, 0, keep);
    if ("error" in refreshed) {
      paint();
      return;
    }
    rows = refreshed.rows;
    totalCount = refreshed.totalCount;
    paint();
  } catch {
    paint();
  }
}

void init();
