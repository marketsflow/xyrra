type Trade = {
  symbol?: string;
  date?: string;
  buy_time?: string;
  sell_time?: string;
  buy_price?: string | number;
  sell_price?: string | number;
  latest_price?: string | number;
  latest_price_used_for_profit?: string | number;
  profit_loss?: string;
  trade_type?: string;
};

type Page = {
  trades: Trade[];
  page: number;
  lastPage: number;
};

type Tab = "live" | "performance" | "historical";
type Period = "24h" | "7d" | "30d";

const list = document.getElementById("as-list");
const title = document.getElementById("as-title");
const subtitle = document.getElementById("as-subtitle");
const scenarios = [15, 10, 5];
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

let tab: Tab = "live";
let period: Period = "24h";
let livePage = 0;
let liveLastPage = 1;
let historyPage = 0;
let historyLastPage = 1;
let liveLoading = false;
let performanceLoading = false;
let historyLoading = false;
let liveTrades: Trade[] = [];
let historyTrades: Trade[] = [];
let performanceTrades: Trade[] = [];
const periodPl: Record<Period, Map<string, number>> = {
  "24h": new Map(),
  "7d": new Map(),
  "30d": new Map(),
};

function num(value: string | number | undefined | null) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value === undefined || value === null || value === "") return 0;
  const parsed = Number.parseFloat(String(value).replace(/%/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  }).format(value);
}

function esc(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[char] ?? char;
  });
}

function issuedAt(raw?: string) {
  if (!raw) return null;
  const parsed = new Date(raw.includes("T") ? raw : raw.replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function stamp(date: Date, withYear: boolean) {
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const month = months[date.getMonth()];
  return withYear
    ? `${day} ${month} ${date.getFullYear()}, ${hours}:${minutes}`
    : `${day} ${month}, ${hours}:${minutes}`;
}

function isOngoing(trade: Trade) {
  return Boolean(trade.buy_time) && !trade.sell_time;
}

function isClosed(trade: Trade) {
  return Boolean(trade.sell_time);
}

function isShort(trade: Trade) {
  return (trade.trade_type ?? "").toLowerCase().includes("short sale");
}

function symbolKey(symbol?: string) {
  const cleaned = (symbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  for (const quote of ["USDT", "USD", "USDC", "BUSD", "BTC", "ETH"]) {
    if (cleaned.endsWith(quote) && cleaned.length > quote.length) {
      return cleaned.slice(0, -quote.length);
    }
  }
  return cleaned;
}

function tradePl(trade: Trade) {
  return num(trade.profit_loss);
}

function periodValue(trade: Trade) {
  const mapped = periodPl[period].get(symbolKey(trade.symbol));
  return mapped === undefined ? tradePl(trade) : mapped;
}

function currentPrice(trade: Trade) {
  return (
    num(trade.latest_price) ||
    num(trade.latest_price_used_for_profit) ||
    num(trade.sell_price) ||
    num(trade.buy_price)
  );
}

function parsePage(body: { data?: Trade[] | { data?: Trade[]; current_page?: number; last_page?: number } }, fallbackPage: number): Page {
  const payload = body.data;
  if (Array.isArray(payload)) return { trades: payload, page: 1, lastPage: 1 };
  return {
    trades: Array.isArray(payload?.data) ? payload.data : [],
    page: Number(payload?.current_page) || fallbackPage,
    lastPage: Number(payload?.last_page) || fallbackPage,
  };
}

function plMap(body: unknown) {
  const root = body && typeof body === "object" ? (body as { data?: unknown }).data ?? body : {};
  const payload = root && typeof root === "object" ? (root as { trades?: unknown; stocks?: unknown }) : {};
  const rows = Array.isArray(payload.stocks) && payload.stocks.length
    ? payload.stocks
    : Array.isArray(payload.trades)
      ? payload.trades
      : [];
  const map = new Map<string, number>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as { symbol?: string; pl_percent?: string | number };
    const symbol = symbolKey(record.symbol);
    if (!symbol || record.pl_percent === undefined || record.pl_percent === null || record.pl_percent === "") continue;
    const pl = num(record.pl_percent);
    const existing = map.get(symbol);
    if (existing === undefined || pl > existing) map.set(symbol, pl);
  }
  return map;
}

function chartSvg(perf: number, scenario: number, shortSale: boolean) {
  const projection = scenarios[scenario] ?? 15;
  const downside = scenario === 2;
  const progress = Math.max(0, Math.min(1, Math.abs(perf) / 30));
  const buyY = 67;
  const upY = 19;
  const downY = 101;
  const actualY = perf >= 0 ? buyY - (buyY - upY) * progress : buyY + (downY - buyY) * progress;
  const ratio = Math.max(0, Math.min(1, projection / 30));
  const targetY = downside ? buyY + (downY - buyY) * ratio : buyY - (buyY - upY) * ratio;
  const stroke = shortSale ? "#f472b6" : "#3ef0b0";
  const dash = downside ? "#f87171" : stroke;
  return `<svg viewBox="0 0 320 120" role="img" aria-label="Performance ${perf.toFixed(2)} percent">
    <path d="M26 82 C58 86 90 55 160 ${buyY}" fill="none" stroke="${stroke}" stroke-width="2.6" stroke-linecap="round"/>
    <path d="M160 ${buyY} Q236 ${(buyY + actualY) / 2} 288 ${actualY} L288 ${buyY} Z" fill="rgba(11,122,57,0.9)"/>
    <line x1="160" y1="${buyY}" x2="288" y2="${buyY}" stroke="#0b7a39" stroke-width="2"/>
    <path d="M160 ${buyY} Q236 ${(buyY + actualY) / 2} 288 ${actualY}" fill="none" stroke="#0b7a39" stroke-width="2.6" stroke-linecap="round"/>
    <path d="M160 ${buyY} L288 ${upY}" fill="none" stroke="${stroke}" stroke-opacity="0.35" stroke-width="1.6" stroke-dasharray="8 4"/>
    <path d="M160 ${buyY} L288 ${downY}" fill="none" stroke="${stroke}" stroke-opacity="0.35" stroke-width="1.6" stroke-dasharray="8 4"/>
    <path d="M160 ${buyY} L288 ${targetY}" fill="none" stroke="${dash}" stroke-width="2.2" stroke-dasharray="8 4"/>
    <circle cx="26" cy="82" r="3" fill="white"/>
    <circle cx="160" cy="${buyY}" r="4" fill="white"/>
    <circle cx="288" cy="${targetY}" r="3" fill="white"/>
  </svg>`;
}

function insightCard(trade: Trade, index: number, closed: boolean, status: string, perf = tradePl(trade)) {
  const symbol = trade.symbol?.trim() || "—";
  const buy = num(trade.buy_price);
  const price = currentPrice(trade);
  const shortSale = isShort(trade);
  const perfClass = perf > 0 ? "as-perf--up" : perf < 0 ? "as-perf--down" : "as-perf--flat";
  const signed = `${perf >= 0 ? "+" : ""}${perf.toFixed(2)}%`;
  const target = buy * (1 + scenarios[0] / 100);
  const when = issuedAt(closed ? trade.sell_time || trade.buy_time || trade.date : trade.buy_time || trade.date);
  return `<article class="as-card" data-card="${index}" data-buy="${buy}" data-perf="${perf}" data-short="${shortSale ? "1" : "0"}">
    <div class="as-card__top">
      <svg class="as-card__mark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 19h16v2H2V3h2v16zm3-5 4-4 3 3 6-7 1.6 1.2-7.4 8.6-3-3-2.6 2.6L7 14z"/></svg>
      <h2 class="as-card__sym">Stock: ${esc(symbol)}</h2>
      <span class="as-card__status"><i class="as-card__dot${closed ? " as-card__dot--closed" : ""}" aria-hidden="true"></i>${esc(status)}</span>
    </div>
    <p class="as-card__time">${when ? esc(stamp(when, true)) : ""}</p>
    <div class="as-card__prices">
      <span>Current Price: <b>${money(price)}</b></span>
      <span>Perf: <b class="${perfClass}">${signed}</b></span>
    </div>
    <div class="as-chart">
      <div data-chart>${chartSvg(perf, 0, shortSale)}</div>
      <div class="as-chart__ends">
        <div>
          <p>Start Price</p>
          <strong>${money(buy)}</strong>
        </div>
        <div>
          <p data-target-label>Upside +15%</p>
          <strong data-target>${money(target)}</strong>
        </div>
      </div>
      <div class="as-scenarios" role="group" aria-label="Projection scenario for ${esc(symbol)}">
        <button type="button" data-scenario="0" aria-pressed="true">Scenario 1</button>
        <button type="button" data-scenario="1" aria-pressed="false">Scenario 2</button>
        <button type="button" data-scenario="2" aria-pressed="false">Scenario 3</button>
      </div>
    </div>
  </article>`;
}

function closedCard(trade: Trade) {
  const shortSale = isShort(trade);
  const perf = tradePl(trade);
  const perfClass = perf > 0 ? "as-perf--up" : perf < 0 ? "as-perf--down" : "as-perf--flat";
  const buyTime = issuedAt(shortSale ? trade.sell_time : trade.buy_time);
  const sellTime = issuedAt(shortSale ? trade.buy_time : trade.sell_time);
  const buyPrice = num(shortSale ? trade.sell_price : trade.buy_price);
  const sellPrice = num(shortSale ? trade.buy_price : trade.sell_price);
  const arrow = perf >= 0 ? "M5 16 L12 8 L19 16" : "M5 8 L12 16 L19 8";
  return `<article class="as-closed">
    <div class="as-closed__top">
      <span class="as-closed__mark ${perf >= 0 ? "as-closed__mark--up" : "as-closed__mark--down"}" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="${arrow}"/></svg></span>
      <h2 class="as-closed__sym">${esc(trade.symbol?.trim() || "—")}</h2>
      <span class="as-closed__pl ${perfClass}">P/L: ${perf.toFixed(2)}%</span>
    </div>
    <div class="as-closed__rule"></div>
    <div class="as-closed__head"><span></span><span>Time</span><span>Price</span></div>
    <div class="as-closed__row"><span class="as-chip as-chip--buy">Buy</span><span>${buyTime ? esc(stamp(buyTime, false)) : ""}</span><b>${money(buyPrice)}</b></div>
    <div class="as-closed__row"><span class="as-chip as-chip--sell">Sell</span><span>${sellTime ? esc(stamp(sellTime, false)) : ""}</span><b>${money(sellPrice)}</b></div>
  </article>`;
}

function statusCard(titleText: string, copy: string, retry?: Tab) {
  const button = retry ? `<button type="button" class="as-retry" data-retry="${retry}">Retry</button>` : "";
  return `<article class="as-card as-card--status"><p class="as-status__title">${esc(titleText)}</p><p class="as-status__copy">${esc(copy)}</p>${button}</article>`;
}

function moreButton(id: string) {
  return `<button type="button" class="as-more" id="${id}">Load more</button>`;
}

function renderLive() {
  if (!list || tab !== "live") return;
  const ongoing = liveTrades.filter(isOngoing).sort(compareIssued);
  const rows = ongoing.length ? ongoing : liveTrades.filter((trade) => !isOngoing(trade)).sort(compareIssued);
  const closed = ongoing.length === 0;
  if (!rows.length) {
    list.innerHTML = statusCard("No current Live AI insights", "See previous ones below");
    return;
  }
  const cards = rows.map((trade, index) => insightCard(trade, index, closed, closed ? "Closed" : "Live")).join("");
  const note = closed ? statusCard("No current Live AI insights", "See previous ones below") : "";
  list.innerHTML = note + cards + (livePage < liveLastPage ? moreButton("as-more-live") : "");
}

function renderPerformance() {
  if (!list || tab !== "performance") return;
  const rows = performanceTrades.filter(isOngoing).sort((a, b) => {
    const aPeriod = periodPl[period].has(symbolKey(a.symbol));
    const bPeriod = periodPl[period].has(symbolKey(b.symbol));
    if (aPeriod && !bPeriod) return -1;
    if (!aPeriod && bPeriod) return 1;
    const byPeriod = periodValue(b) - periodValue(a);
    if (byPeriod !== 0) return byPeriod;
    return tradePl(b) - tradePl(a);
  });
  const label = period === "24h" ? "24H" : period === "7d" ? "7D" : "30D";
  const chips = (["24h", "7d", "30d"] as Period[])
    .map((item) => {
      const name = item === "24h" ? "24H" : item === "7d" ? "7D" : "30D";
      return `<button type="button" data-period="${item}" aria-pressed="${item === period ? "true" : "false"}">${name}</button>`;
    })
    .join("");
  const cards = rows.length
    ? rows.map((trade, index) => insightCard(trade, index, false, "Ongoing AI", periodValue(trade))).join("")
    : statusCard("No open AI insights available right now.", "Open stock insights will appear here when the AI has a live position.");
  list.innerHTML = `<div class="as-section">
      <p class="as-period__label">Best Performance</p>
      <div class="as-periods" role="group" aria-label="Best performance period">${chips}</div>
      <h2>Open AI Insights</h2>
      <p>All open AI stock insights, ranked by best ${label} performance.</p>
    </div>${cards}`;
}

function renderHistorical() {
  if (!list || tab !== "historical") return;
  const rows = historyTrades.filter(isClosed).sort(compareClosed);
  if (!rows.length) {
    list.innerHTML = statusCard("No historical trades available right now.", "Closed AI stock trades will show here.", "historical");
    return;
  }
  list.innerHTML = rows.map((trade) => closedCard(trade)).join("") + (historyPage < historyLastPage ? moreButton("as-more-history") : "");
}

function compareIssued(a: Trade, b: Trade) {
  const aTime = issuedAt(a.buy_time) ?? issuedAt(a.date);
  const bTime = issuedAt(b.buy_time) ?? issuedAt(b.date);
  if (!aTime && !bTime) return 0;
  if (!aTime) return 1;
  if (!bTime) return -1;
  return bTime.getTime() - aTime.getTime();
}

function compareClosed(a: Trade, b: Trade) {
  const aTime = issuedAt(a.sell_time) ?? issuedAt(a.buy_time) ?? issuedAt(a.date);
  const bTime = issuedAt(b.sell_time) ?? issuedAt(b.buy_time) ?? issuedAt(b.date);
  if (!aTime && !bTime) return 0;
  if (!aTime) return 1;
  if (!bTime) return -1;
  return bTime.getTime() - aTime.getTime();
}

function paintChrome() {
  const copy = {
    live: ["Live AI Insights", "Real-time AI insights for U.S. & global stock markets.", "AI Stocks | Xyrra"],
    performance: ["AI Performance", "", "AI Performance | Xyrra"],
    historical: ["AI Historical", "Past AI trades and outcomes for U.S. & global stocks.", "AI Historical | Xyrra"],
  }[tab];
  if (title) title.textContent = copy[0];
  if (subtitle) {
    subtitle.textContent = copy[1];
    subtitle.classList.toggle("as-subtitle-hidden", !copy[1]);
  }
  document.title = copy[2];
  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
    const selected = button.dataset.tab === tab;
    button.setAttribute("aria-selected", String(selected));
  });
}

function tabFromLocation(): Tab {
  const hash = location.hash.replace("#", "");
  if (hash === "performance" || hash === "historical") return hash;
  return "live";
}

function showTab(next: Tab, push: boolean) {
  tab = next;
  if (push) {
    const url = next === "live" ? "/ai_stocks/" : `/ai_stocks/#${next}`;
    history.pushState(null, "", url);
  }
  paintChrome();
  if (next === "live") {
    if (liveTrades.length || livePage > 0) renderLive();
    else void loadLive(1, true);
  } else if (next === "performance") {
    if (performanceTrades.length) renderPerformance();
    else void loadPerformance();
  } else if (historyTrades.length || historyPage > 0) renderHistorical();
  else void loadHistorical(1, true);
}

async function loadLive(nextPage: number, replace: boolean) {
  if (!list || liveLoading) return;
  liveLoading = true;
  if (replace && !liveTrades.length && tab === "live") {
    list.innerHTML = statusCard("Live AI is loading", "Scanning U.S. & global stock markets for your live insight…");
  }
  try {
    const response = await fetch(`/api/website/ai-stocks?page=${nextPage}&per_page=25`);
    if (!response.ok) throw new Error(String(response.status));
    const parsed = parsePage(await response.json(), nextPage);
    liveTrades = replace ? parsed.trades : liveTrades.concat(parsed.trades);
    livePage = parsed.page;
    liveLastPage = parsed.lastPage;
    renderLive();
  } catch {
    if (replace && liveTrades.length === 0 && tab === "live") {
      list.innerHTML = statusCard("Live AI insights are unavailable", "The stock insight feed could not be loaded. Try again in a moment.", "live");
    }
  } finally {
    liveLoading = false;
  }
}

async function loadPerformance() {
  if (!list || performanceLoading) return;
  performanceLoading = true;
  if (!performanceTrades.length && tab === "performance") {
    list.innerHTML = statusCard("AI Performance is loading", "Pulling the latest returns and recent AI insights…");
  }
  try {
    const [today, day, week, month] = await Promise.all([
      fetch("/api/website/ai-stocks?page=1&per_page=100"),
      fetch("/api/website/ai-stocks/last-24-hours"),
      fetch("/api/website/ai-stocks/last-7-days"),
      fetch("/api/website/ai-stocks/last-30-days"),
    ]);
    if (!today.ok) throw new Error(String(today.status));
    performanceTrades = parsePage(await today.json(), 1).trades;
    if (day.ok) periodPl["24h"] = plMap(await day.json());
    if (week.ok) periodPl["7d"] = plMap(await week.json());
    if (month.ok) periodPl["30d"] = plMap(await month.json());
    renderPerformance();
  } catch {
    if (!performanceTrades.length && tab === "performance") {
      list.innerHTML = statusCard("Unable to load performance data right now.", "Try again in a moment.", "performance");
    }
  } finally {
    performanceLoading = false;
  }
}

async function loadHistorical(nextPage: number, replace: boolean) {
  if (!list || historyLoading) return;
  historyLoading = true;
  if (replace && !historyTrades.length && tab === "historical") {
    list.innerHTML = statusCard("Historical AI is loading", "Pulling closed trades and past AI outcomes…");
  }
  try {
    const response = await fetch(`/api/website/ai-stocks/history?page=${nextPage}&per_page=25&recent_count=10000`);
    if (!response.ok) throw new Error(String(response.status));
    const parsed = parsePage(await response.json(), nextPage);
    historyTrades = replace ? parsed.trades : historyTrades.concat(parsed.trades);
    historyPage = parsed.page;
    historyLastPage = parsed.lastPage;
    renderHistorical();
  } catch {
    if (replace && historyTrades.length === 0 && tab === "historical") {
      list.innerHTML = statusCard("Unable to load historical data right now.", "Try again in a moment.", "historical");
    }
  } finally {
    historyLoading = false;
  }
}

function applyScenario(cardEl: HTMLElement, scenario: number) {
  const buy = num(cardEl.dataset.buy);
  const perf = num(cardEl.dataset.perf);
  const shortSale = cardEl.dataset.short === "1";
  const projection = scenarios[scenario] ?? 15;
  const downside = scenario === 2;
  const target = downside ? buy * (1 - projection / 100) : buy * (1 + projection / 100);
  const chart = cardEl.querySelector("[data-chart]");
  const label = cardEl.querySelector("[data-target-label]");
  const value = cardEl.querySelector("[data-target]");
  if (chart) chart.innerHTML = chartSvg(perf, scenario, shortSale);
  if (label) label.textContent = downside ? `Downside -${projection}%` : `Upside +${projection}%`;
  if (value) value.textContent = money(target);
  cardEl.querySelectorAll<HTMLButtonElement>("[data-scenario]").forEach((button) => {
    button.setAttribute("aria-pressed", button.dataset.scenario === String(scenario) ? "true" : "false");
  });
}

document.querySelector(".as-tabs")?.addEventListener("click", (event) => {
  const button = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>("[data-tab]") : null;
  const next = button?.dataset.tab;
  if (next !== "live" && next !== "performance" && next !== "historical") return;
  if (next !== tab) showTab(next, true);
});

list?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.id === "as-more-live") {
    void loadLive(livePage + 1, false);
    return;
  }
  if (target.id === "as-more-history") {
    void loadHistorical(historyPage + 1, false);
    return;
  }
  const retry = target.closest<HTMLButtonElement>("[data-retry]")?.dataset.retry;
  if (retry === "live") void loadLive(1, true);
  if (retry === "performance") void loadPerformance();
  if (retry === "historical") void loadHistorical(1, true);
  const periodButton = target.closest<HTMLButtonElement>("[data-period]");
  if (periodButton?.dataset.period === "24h" || periodButton?.dataset.period === "7d" || periodButton?.dataset.period === "30d") {
    period = periodButton.dataset.period;
    renderPerformance();
    return;
  }
  const scenarioButton = target.closest<HTMLButtonElement>("[data-scenario]");
  const cardEl = target.closest<HTMLElement>("[data-card]");
  if (!scenarioButton || !cardEl) return;
  applyScenario(cardEl, Number(scenarioButton.dataset.scenario) || 0);
});

window.addEventListener("popstate", () => showTab(tabFromLocation(), false));
window.addEventListener("hashchange", () => showTab(tabFromLocation(), false));
document.querySelectorAll<HTMLAnchorElement>('a[href="/ai_stocks/"]').forEach((link) => {
  link.addEventListener("click", (event) => {
    if (!location.pathname.startsWith("/ai_stocks")) return;
    event.preventDefault();
    if (tab !== "live") showTab("live", true);
  });
});

showTab(tabFromLocation(), false);
window.setInterval(() => {
  if (tab === "live") void loadLive(1, true);
}, 60_000);
