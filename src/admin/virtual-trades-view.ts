import {
  pnlForVirtualTradeStake,
  resolveOpenVirtualTrades,
  VIRTUAL_TRADE_STAKE_USD,
} from "../lib/virtual-trades/settle";
import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";

type VirtualTradeRow = {
  id: number;
  timestamp: string;
  market_slug: string;
  market_title: string | null;
  direction: "LONG_UP" | "LONG_DOWN" | string;
  entry_poly_price: number | null;
  entry_spot_price: number | null;
  signal_rule: number | null;
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

/** Recompute display P&L at $10 when entry price is known (for already-settled rows). */
function displayPnl(row: VirtualTradeRow): number | null {
  if (row.status !== "WIN" && row.status !== "LOSS") return null;
  if (row.entry_poly_price === null || row.entry_poly_price <= 0) return row.pnl_usd;
  try {
    return pnlForVirtualTradeStake(
      row.entry_poly_price,
      row.status === "WIN",
      VIRTUAL_TRADE_STAKE_USD,
    ).pnlUsd;
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
    signal_rule: asNumber(row.signal_rule),
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
  const selectAllNode = document.getElementById("xa-vt-select-all") as HTMLInputElement | null;
  const deleteSelectedNode = document.getElementById(
    "xa-vt-delete-selected",
  ) as HTMLButtonElement | null;
  const filterSignalNode = document.getElementById(
    "xa-vt-filter-signal",
  ) as HTMLSelectElement | null;
  const filterSideNode = document.getElementById("xa-vt-filter-side") as HTMLSelectElement | null;
  const filterRuleNode = document.getElementById("xa-vt-filter-rule") as HTMLSelectElement | null;
  const filterResultNode = document.getElementById(
    "xa-vt-filter-result",
  ) as HTMLSelectElement | null;
  if (
    !statusNode ||
    !emptyNode ||
    !tableWrapNode ||
    !bodyNode ||
    !selectAllNode ||
    !deleteSelectedNode ||
    !filterSignalNode ||
    !filterSideNode ||
    !filterRuleNode ||
    !filterResultNode
  ) {
    return;
  }

  // Locals after the null guard so nested helpers keep non-null types under tsc.
  const statusEl = statusNode;
  const emptyEl = emptyNode;
  const tableWrap = tableWrapNode;
  const bodyEl = bodyNode;
  const selectAllEl = selectAllNode;
  const deleteSelectedBtn = deleteSelectedNode;
  const filterSignalEl = filterSignalNode;
  const filterSideEl = filterSideNode;
  const filterRuleEl = filterRuleNode;
  const filterResultEl = filterResultNode;
  const supabase = session.supabase;

  const selectedIds = new Set<number>();
  let deleting = false;

  statusEl.textContent = "Loading virtual trades…";

  const { data, error } = await supabase
    .from("virtual_trades")
    .select(
      "id, timestamp, market_slug, market_title, direction, entry_poly_price, entry_spot_price, signal_rule, strike_price, price_to_beat, price_level, crypto_price_at, signal_state, status, exit_poly_price, pnl_usd, pnl_percent, closed_at, position_size_usd",
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
    selectAllEl.disabled = true;
    deleteSelectedBtn.disabled = true;
    return;
  }

  let settled = 0;
  try {
    settled = await resolveOpenVirtualTrades(supabase, rows);
  } catch {
    // Still show rows even if settlement fails.
  }

  function sideLabel(direction: string) {
    return direction.replace("LONG_", "");
  }

  function syncRuleFilterOptions() {
    const previous = filterRuleEl.value;
    const rules = [
      ...new Set(
        rows
          .map((row) => row.signal_rule)
          .filter((rule): rule is number => rule !== null)
          .map((rule) => String(rule)),
      ),
    ].sort((a, b) => Number(a) - Number(b));

    filterRuleEl.innerHTML =
      `<option value="">All</option>` +
      rules.map((rule) => `<option value="${escapeHtml(rule)}">${escapeHtml(rule)}</option>`).join("");

    filterRuleEl.value = rules.includes(previous) ? previous : "";
  }

  function filteredRows(): VirtualTradeRow[] {
    const signal = filterSignalEl.value;
    const side = filterSideEl.value;
    const rule = filterRuleEl.value;
    const result = filterResultEl.value;

    return rows.filter((row) => {
      if (signal && row.signal_state !== signal) return false;
      if (side && sideLabel(row.direction) !== side) return false;
      if (rule) {
        if (row.signal_rule === null || String(row.signal_rule) !== rule) return false;
      }
      if (result && row.status !== result) return false;
      return true;
    });
  }

  function filtersActive() {
    return Boolean(
      filterSignalEl.value || filterSideEl.value || filterRuleEl.value || filterResultEl.value,
    );
  }

  function syncSelectionUi(visible: VirtualTradeRow[]) {
    const visibleIds = new Set(visible.map((row) => row.id));
    for (const id of [...selectedIds]) {
      if (!visibleIds.has(id)) selectedIds.delete(id);
    }

    const n = selectedIds.size;
    const total = visible.length;
    selectAllEl.disabled = deleting || total === 0;
    selectAllEl.checked = total > 0 && n === total;
    selectAllEl.indeterminate = n > 0 && n < total;

    deleteSelectedBtn.disabled = deleting || n === 0;
    deleteSelectedBtn.textContent =
      n === 0 ? "Delete selected" : n === 1 ? "Delete 1 trade" : `Delete ${n} trades`;
  }

  function renderStatus(visible: VirtualTradeRow[]) {
    const wins = visible.filter((r) => r.status === "WIN").length;
    const losses = visible.filter((r) => r.status === "LOSS").length;
    const open = visible.filter((r) => r.status === "OPEN").length;
    const totalPnl = visible
      .map((r) => displayPnl(r))
      .filter((n): n is number => n !== null)
      .reduce((sum, n) => sum + n, 0);

    const shown =
      filtersActive() && visible.length !== rows.length
        ? `${visible.length} of ${rows.length} trade${rows.length === 1 ? "" : "s"}`
        : `${rows.length} trade${rows.length === 1 ? "" : "s"}`;

    statusEl.textContent =
      `${shown}` +
      ` · ${wins} win / ${losses} loss / ${open} open` +
      ` · P&L on $${VIRTUAL_TRADE_STAKE_USD}/trade: ${formatPnl(totalPnl)}` +
      (settled > 0 ? ` · settled ${settled} just now` : "");
  }

  function renderRows() {
    if (rows.length === 0) {
      selectedIds.clear();
      emptyEl.hidden = false;
      tableWrap.hidden = true;
      bodyEl.innerHTML = "";
      statusEl.textContent = "";
      syncSelectionUi([]);
      return;
    }

    emptyEl.hidden = true;
    tableWrap.hidden = false;
    const visible = filteredRows();
    renderStatus(visible);

    if (visible.length === 0) {
      bodyEl.innerHTML = `
        <tr>
          <td colspan="14" class="xa-users__empty">No trades match these filters.</td>
        </tr>`;
      syncSelectionUi([]);
      return;
    }

    bodyEl.innerHTML = visible
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
        const checked = selectedIds.has(row.id) ? " checked" : "";

        return `
      <tr data-trade-id="${row.id}">
        <td class="xa-vt__check-col">
          <input
            type="checkbox"
            class="xa-vt__row-check"
            data-trade-id="${row.id}"
            aria-label="Select trade #${row.id}"
            ${checked}
            ${deleting ? "disabled" : ""}
          />
        </td>
        <td>${escapeHtml(String(row.id))}</td>
        <td>${escapeHtml(formatDateTime(row.timestamp))}</td>
        <td>${escapeHtml(row.market_title || row.market_slug)}</td>
        <td>${escapeHtml(formatUsd(row.price_to_beat ?? row.strike_price))}</td>
        <td>${escapeHtml(row.signal_state)}</td>
        <td>${escapeHtml(sideLabel(row.direction))}</td>
        <td>${row.entry_poly_price == null ? "—" : escapeHtml(row.entry_poly_price.toFixed(3))}</td>
        <td>${escapeHtml(formatUsd(row.entry_spot_price))}</td>
        <td>${row.signal_rule == null ? "—" : escapeHtml(String(row.signal_rule))}</td>
        <td><span class="xa-vt__result ${resultClass}">${escapeHtml(resultLabel(row.status))}</span></td>
        <td class="${pnlClass}">${escapeHtml(row.status === "OPEN" ? "—" : formatPnl(pnl))}</td>
        <td>${escapeHtml(formatDateTime(row.closed_at))}</td>
        <td>
          <button
            type="button"
            class="xa-vt__delete"
            data-delete-id="${row.id}"
            data-delete-label="${escapeHtml(row.market_title || row.market_slug)}"
            ${deleting ? "disabled" : ""}
          >Delete</button>
        </td>
      </tr>`;
      })
      .join("");

    syncSelectionUi(visible);
  }

  async function deleteTradeIds(ids: number[]): Promise<{ ok: number[]; failed: string[] }> {
    const ok: number[] = [];
    const failed: string[] = [];
    for (const id of ids) {
      const { error: deleteError } = await supabase
        .from("virtual_trades")
        .delete()
        .eq("id", id);
      if (deleteError) {
        failed.push(`#${id}: ${deleteError.message}`);
        continue;
      }
      ok.push(id);
      const idx = rows.findIndex((row) => row.id === id);
      if (idx >= 0) rows.splice(idx, 1);
      selectedIds.delete(id);
    }
    return { ok, failed };
  }

  syncRuleFilterOptions();
  renderRows();

  for (const el of [filterSignalEl, filterSideEl, filterRuleEl, filterResultEl]) {
    el.addEventListener("change", () => {
      if (deleting) return;
      renderRows();
    });
  }

  selectAllEl.addEventListener("change", () => {
    if (deleting) return;
    const visible = filteredRows();
    if (selectAllEl.checked) {
      for (const row of visible) selectedIds.add(row.id);
    } else {
      for (const row of visible) selectedIds.delete(row.id);
    }
    bodyEl.querySelectorAll<HTMLInputElement>(".xa-vt__row-check").forEach((box) => {
      box.checked = selectAllEl.checked;
    });
    syncSelectionUi(visible);
  });

  bodyEl.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.classList.contains("xa-vt__row-check")) {
      return;
    }
    if (deleting) return;
    const id = Number(target.dataset.tradeId);
    if (!Number.isFinite(id)) return;
    if (target.checked) selectedIds.add(id);
    else selectedIds.delete(id);
    syncSelectionUi(filteredRows());
  });

  deleteSelectedBtn.addEventListener("click", () => {
    void (async () => {
      const visibleIds = new Set(filteredRows().map((row) => row.id));
      const ids = [...selectedIds].filter((id) => visibleIds.has(id));
      if (deleting || ids.length === 0) return;

      const noun = ids.length === 1 ? "trade" : "trades";
      if (
        !window.confirm(
          `Delete ${ids.length} virtual ${noun}? You can re-place them from Create.`,
        )
      ) {
        return;
      }

      deleting = true;
      syncSelectionUi(filteredRows());
      bodyEl.querySelectorAll<HTMLInputElement>(".xa-vt__row-check").forEach((box) => {
        box.disabled = true;
      });
      bodyEl.querySelectorAll<HTMLButtonElement>(".xa-vt__delete").forEach((btn) => {
        btn.disabled = true;
      });
      statusEl.classList.remove("xa-users__status--error");
      statusEl.textContent = `Deleting ${ids.length} ${noun}…`;

      const { ok, failed } = await deleteTradeIds(ids);
      settled = 0;
      deleting = false;
      syncRuleFilterOptions();
      renderRows();

      if (failed.length === 0) {
        statusEl.textContent =
          rows.length === 0
            ? `Deleted ${ok.length} ${ok.length === 1 ? "trade" : "trades"}.`
            : `Deleted ${ok.length} ${ok.length === 1 ? "trade" : "trades"}. ${rows.length} remaining.`;
      } else if (ok.length === 0) {
        statusEl.textContent = failed.join(" · ");
        statusEl.classList.add("xa-users__status--error");
      } else {
        statusEl.textContent = `Deleted ${ok.length} of ${ids.length}. Failed: ${failed.join(" · ")}`;
        statusEl.classList.add("xa-users__status--error");
      }
    })();
  });

  bodyEl.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || !target.classList.contains("xa-vt__delete")) {
      return;
    }
    if (deleting) return;
    const id = Number(target.dataset.deleteId);
    if (!Number.isFinite(id)) return;
    const label = target.dataset.deleteLabel || `trade #${id}`;
    if (!window.confirm(`Delete virtual trade #${id} (${label})? You can re-place it from Create.`)) {
      return;
    }

    void (async () => {
      deleting = true;
      syncSelectionUi(filteredRows());
      target.disabled = true;
      statusEl.classList.remove("xa-users__status--error");
      statusEl.textContent = `Deleting trade #${id}…`;

      const { ok, failed } = await deleteTradeIds([id]);
      settled = 0;
      deleting = false;
      syncRuleFilterOptions();
      renderRows();

      if (failed.length > 0) {
        statusEl.textContent = failed[0];
        statusEl.classList.add("xa-users__status--error");
        return;
      }
      statusEl.textContent =
        rows.length === 0
          ? `Deleted trade #${ok[0]}.`
          : `Deleted trade #${ok[0]}. ${rows.length} remaining.`;
    })();
  });
}

void init();
