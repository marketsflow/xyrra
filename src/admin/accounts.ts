import { settleOpenVirtualTrades } from "../lib/virtual-trades/settle";
import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";

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
  if (
    !statusEl ||
    !balanceEl ||
    !startingEl ||
    !updatedEl ||
    !nameEl ||
    !emptyEl ||
    !tableWrap ||
    !bodyEl
  ) {
    return;
  }

  statusEl.textContent = "Loading account…";

  // Settle closed OPEN windows first so P&L triggers book into account_transactions.
  let settledJustNow = 0;
  try {
    settledJustNow = await settleOpenVirtualTrades(session.supabase);
  } catch {
    // Still show the ledger even if settlement fails.
  }

  const { data: accountData, error: accountError } = await session.supabase
    .from("accounts")
    .select("id, name, starting_balance_usd, balance_usd, updated_at")
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (accountError) {
    statusEl.textContent = accountError.message;
    statusEl.classList.add("xa-users__status--error");
    return;
  }

  if (!accountData) {
    statusEl.textContent = "No account found. Run the accounts migration first.";
    statusEl.classList.add("xa-users__status--error");
    return;
  }

  const account: AccountRow = {
    id: asNumber(accountData.id) ?? 0,
    name: asString(accountData.name) || "Account",
    starting_balance_usd: asNumber(accountData.starting_balance_usd) ?? 10,
    balance_usd: asNumber(accountData.balance_usd) ?? 10,
    updated_at: asString(accountData.updated_at),
  };

  nameEl.textContent = account.name;
  startingEl.textContent = formatUsd(account.starting_balance_usd);
  balanceEl.textContent = formatUsd(account.balance_usd);
  balanceEl.classList.toggle("xa-vt__pnl--win", account.balance_usd > account.starting_balance_usd);
  balanceEl.classList.toggle("xa-vt__pnl--loss", account.balance_usd < account.starting_balance_usd);
  updatedEl.textContent = formatDateTime(account.updated_at);

  const { data: txData, error: txError } = await session.supabase
    .from("account_transactions")
    .select("id, kind, amount_usd, balance_after_usd, description, virtual_trade_id, created_at")
    .eq("account_id", account.id)
    .order("created_at", { ascending: false })
    .limit(200);

  if (txError) {
    statusEl.textContent = txError.message;
    statusEl.classList.add("xa-users__status--error");
    return;
  }

  const rows: TxRow[] = (txData ?? []).map((row) => ({
    id: asNumber(row.id) ?? 0,
    kind: asString(row.kind) || "",
    amount_usd: asNumber(row.amount_usd) ?? 0,
    balance_after_usd: asNumber(row.balance_after_usd) ?? 0,
    description: asString(row.description),
    virtual_trade_id: asNumber(row.virtual_trade_id),
    created_at: asString(row.created_at) || "",
  }));

  const pnlTotal = account.balance_usd - account.starting_balance_usd;
  statusEl.textContent =
    `${rows.length} transaction${rows.length === 1 ? "" : "s"}` +
    ` · net P&L ${formatSignedUsd(pnlTotal)}` +
    (settledJustNow > 0 ? ` · settled ${settledJustNow} trade${settledJustNow === 1 ? "" : "s"}` : "");

  if (rows.length === 0) {
    emptyEl.hidden = false;
    tableWrap.hidden = true;
    return;
  }

  emptyEl.hidden = true;
  tableWrap.hidden = false;
  bodyEl.innerHTML = rows
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

void init();
