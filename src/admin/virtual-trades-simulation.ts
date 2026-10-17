import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";

const PAGE_SIZE = 1000;
const STORAGE_KEY = "xyrra-vt-simulation-inputs";
const DEFAULT_STARTING = 4.71;
const DEFAULT_STAKE_PCT = 10;

type SettledTrade = {
  id: number;
  timestamp: string;
  market_slug: string;
  market_title: string | null;
  direction: string;
  entry_poly_price: number;
  status: "WIN" | "LOSS";
};

type SimStep = {
  index: number;
  trade: SettledTrade;
  balanceBefore: number;
  stakeUsd: number;
  pnlUsd: number;
  balanceAfter: number;
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

function formatUsd(value: number) {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPnl(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatUsd(value)}`;
}

function formatPercent(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString(undefined, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}%`;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
}

function sideLabel(direction: string) {
  if (direction === "LONG_UP") return "UP";
  if (direction === "LONG_DOWN") return "DOWN";
  return direction.replace(/^LONG_/, "") || "—";
}

/**
 * Binary Polymarket Up/Down: $stake buys stake/entry shares.
 * WIN pays $1/share → profit = stake/entry - stake; LOSS → -stake.
 */
function pnlForStake(entryPolyPrice: number, won: boolean, stakeUsd: number) {
  if (!(entryPolyPrice > 0) || entryPolyPrice > 1 || !(stakeUsd > 0)) {
    return null;
  }
  if (won) {
    const payout = stakeUsd / entryPolyPrice;
    return Number((payout - stakeUsd).toFixed(4));
  }
  return Number((-stakeUsd).toFixed(4));
}

function loadInputs(): { starting: number; stakePct: number } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { starting: DEFAULT_STARTING, stakePct: DEFAULT_STAKE_PCT };
    const parsed = JSON.parse(raw) as { starting?: unknown; stakePct?: unknown };
    const starting = asNumber(parsed.starting);
    const stakePct = asNumber(parsed.stakePct);
    return {
      starting: starting !== null && starting > 0 ? starting : DEFAULT_STARTING,
      stakePct:
        stakePct !== null && stakePct > 0 && stakePct <= 100 ? stakePct : DEFAULT_STAKE_PCT,
    };
  } catch {
    return { starting: DEFAULT_STARTING, stakePct: DEFAULT_STAKE_PCT };
  }
}

function saveInputs(starting: number, stakePct: number) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ starting, stakePct }));
  } catch {
    /* ignore quota / private mode */
  }
}

async function loadSettledTrades(supabase: SupabaseClient): Promise<{
  trades: SettledTrade[];
  openCount: number;
  skippedCount: number;
}> {
  const trades: SettledTrade[] = [];
  let openCount = 0;
  let skippedCount = 0;
  let from = 0;

  for (;;) {
    const { data, error } = await supabase
      .from("virtual_trades")
      .select(
        "id, timestamp, market_slug, market_title, direction, entry_poly_price, status",
      )
      .order("timestamp", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      throw new Error(error.message);
    }

    const rows = data ?? [];
    for (const row of rows) {
      const status = asString(row.status) || "";
      if (status === "OPEN") {
        openCount += 1;
        continue;
      }
      if (status !== "WIN" && status !== "LOSS") {
        skippedCount += 1;
        continue;
      }
      const entry = asNumber(row.entry_poly_price);
      if (entry === null || !(entry > 0) || entry > 1) {
        skippedCount += 1;
        continue;
      }
      trades.push({
        id: asNumber(row.id) ?? 0,
        timestamp: asString(row.timestamp) || "",
        market_slug: asString(row.market_slug) || "",
        market_title: asString(row.market_title),
        direction: asString(row.direction) || "",
        entry_poly_price: entry,
        status,
      });
    }

    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return { trades, openCount, skippedCount };
}

function runSimulation(
  trades: SettledTrade[],
  startingCapital: number,
  stakePct: number,
): SimStep[] {
  const steps: SimStep[] = [];
  let balance = Number(startingCapital.toFixed(4));
  const pct = stakePct / 100;

  for (const trade of trades) {
    if (!(balance > 0)) break;

    const stakeUsd = Number(Math.min(balance, balance * pct).toFixed(4));
    if (!(stakeUsd > 0)) break;

    const pnlUsd = pnlForStake(trade.entry_poly_price, trade.status === "WIN", stakeUsd);
    if (pnlUsd === null) continue;

    const balanceBefore = balance;
    const balanceAfter = Number(Math.max(0, balance + pnlUsd).toFixed(4));
    balance = balanceAfter;

    steps.push({
      index: steps.length + 1,
      trade,
      balanceBefore,
      stakeUsd,
      pnlUsd,
      balanceAfter,
    });
  }

  return steps;
}

function renderSteps(bodyEl: HTMLElement, steps: SimStep[]) {
  if (steps.length === 0) {
    bodyEl.innerHTML = `<tr><td colspan="10" class="xa-users__empty">No trades to simulate.</td></tr>`;
    return;
  }

  bodyEl.innerHTML = steps
    .map((step) => {
      const title = step.trade.market_title || step.trade.market_slug;
      const resultClass =
        step.trade.status === "WIN" ? "xa-vt__result--win" : "xa-vt__result--loss";
      const pnlClass = step.pnlUsd >= 0 ? "xa-vt__pnl--win" : "xa-vt__pnl--loss";
      return `<tr>
        <td>${step.index}</td>
        <td>${escapeHtml(formatDateTime(step.trade.timestamp))}</td>
        <td title="${escapeHtml(step.trade.market_slug)}">${escapeHtml(title)}</td>
        <td>${escapeHtml(sideLabel(step.trade.direction))}</td>
        <td>${step.trade.entry_poly_price.toFixed(3)}</td>
        <td><span class="xa-vt__result ${resultClass}">${step.trade.status === "WIN" ? "Win" : "Loss"}</span></td>
        <td>${escapeHtml(formatUsd(step.balanceBefore))}</td>
        <td>${escapeHtml(formatUsd(step.stakeUsd))}</td>
        <td class="${pnlClass}">${escapeHtml(formatPnl(step.pnlUsd))}</td>
        <td><strong>${escapeHtml(formatUsd(step.balanceAfter))}</strong></td>
      </tr>`;
    })
    .join("");
}

async function init() {
  const session = await requireAdminSession();
  if (!session) return;

  initAdminShell(session, "virtual-trades-simulation");
  setAdminLoading(false);

  const form = document.getElementById("xa-sim-form") as HTMLFormElement | null;
  const startingInput = document.getElementById("xa-sim-starting") as HTMLInputElement | null;
  const stakePctInput = document.getElementById("xa-sim-stake-pct") as HTMLInputElement | null;
  const statusEl = document.getElementById("xa-sim-status");
  const emptyEl = document.getElementById("xa-sim-empty");
  const tableWrap = document.getElementById("xa-sim-table-wrap");
  const bodyEl = document.getElementById("xa-sim-body");
  const summaryEl = document.getElementById("xa-sim-summary");
  const tradesEl = document.getElementById("xa-sim-trades");
  const wlEl = document.getElementById("xa-sim-wl");
  const firstStakeEl = document.getElementById("xa-sim-first-stake");
  const finalEl = document.getElementById("xa-sim-final");
  const growthEl = document.getElementById("xa-sim-growth");

  if (
    !form ||
    !startingInput ||
    !stakePctInput ||
    !statusEl ||
    !emptyEl ||
    !tableWrap ||
    !bodyEl ||
    !summaryEl ||
    !tradesEl ||
    !wlEl ||
    !firstStakeEl ||
    !finalEl ||
    !growthEl
  ) {
    return;
  }

  const saved = loadInputs();
  startingInput.value = String(saved.starting);
  stakePctInput.value = String(saved.stakePct);

  statusEl.textContent = "Loading virtual trades…";

  let trades: SettledTrade[] = [];
  let openCount = 0;
  let skippedCount = 0;

  try {
    const loaded = await loadSettledTrades(session.supabase);
    trades = loaded.trades;
    openCount = loaded.openCount;
    skippedCount = loaded.skippedCount;
  } catch (err) {
    statusEl.textContent =
      err instanceof Error ? err.message : "Failed to load virtual trades.";
    return;
  }

  function applySimulation() {
    const starting = asNumber(startingInput!.value);
    const stakePct = asNumber(stakePctInput!.value);
    if (starting === null || !(starting > 0)) {
      statusEl!.textContent = "Enter a starting capital greater than 0.";
      return;
    }
    if (stakePct === null || !(stakePct > 0) || stakePct > 100) {
      statusEl!.textContent = "Stake size must be between 0.01% and 100%.";
      return;
    }

    saveInputs(starting, stakePct);

    if (trades.length === 0) {
      summaryEl!.hidden = true;
      tableWrap!.hidden = true;
      emptyEl!.hidden = false;
      const notes: string[] = [];
      if (openCount > 0) notes.push(`${openCount} open`);
      if (skippedCount > 0) notes.push(`${skippedCount} skipped`);
      statusEl!.textContent =
        notes.length > 0
          ? `No settled trades to simulate (${notes.join(", ")}).`
          : "No settled trades to simulate.";
      return;
    }

    emptyEl!.hidden = true;
    const steps = runSimulation(trades, starting, stakePct);
    renderSteps(bodyEl!, steps);
    tableWrap!.hidden = false;
    summaryEl!.hidden = false;

    const wins = steps.filter((s) => s.trade.status === "WIN").length;
    const losses = steps.filter((s) => s.trade.status === "LOSS").length;
    const finalBalance = steps.length > 0 ? steps[steps.length - 1]!.balanceAfter : starting;
    const growthUsd = finalBalance - starting;
    const growthPct = starting > 0 ? (growthUsd / starting) * 100 : 0;
    const firstStake = steps[0]?.stakeUsd ?? starting * (stakePct / 100);

    tradesEl!.textContent = String(steps.length);
    wlEl!.textContent = `${wins} / ${losses}`;
    firstStakeEl!.textContent = formatUsd(firstStake);
    finalEl!.textContent = formatUsd(finalBalance);
    growthEl!.textContent = `${formatPnl(growthUsd)} (${formatPercent(growthPct)})`;
    growthEl!.classList.toggle("xa-vt__pnl--win", growthUsd >= 0);
    growthEl!.classList.toggle("xa-vt__pnl--loss", growthUsd < 0);

    const notes: string[] = [
      `${steps.length} settled trade${steps.length === 1 ? "" : "s"} in chronological order`,
    ];
    if (openCount > 0) notes.push(`${openCount} open skipped`);
    if (skippedCount > 0) notes.push(`${skippedCount} invalid skipped`);
    if (steps.length < trades.length) {
      notes.push(`stopped early after ${steps.length} (balance depleted)`);
    }
    statusEl!.textContent = notes.join(" · ");
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    applySimulation();
  });

  startingInput.addEventListener("change", () => applySimulation());
  stakePctInput.addEventListener("change", () => applySimulation());

  applySimulation();
}

void init();
