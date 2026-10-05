type Portfolio = {
  account?: string;
  name?: string;
  ytd_change_perc?: number;
  thirty_day_change_perc?: number;
  volatility?: string;
  stroke?: string | null;
  chart_start?: string | null;
  chart_end?: string | null;
  values?: number[];
};

type FilterId = "best_performing" | "trending" | "ai_recommended" | "lower_risk";

const filters: { id: FilterId; label: string; caption: string; sort: string; category?: string }[] = [
  {
    id: "best_performing",
    label: "Best Performing",
    caption: "Showing AI portfolios with the strongest historical performance.",
    sort: "best_performing",
  },
  {
    id: "trending",
    label: "Trending",
    caption: "Showing portfolios gaining momentum across markets right now.",
    sort: "best_performing",
    category: "most_trending",
  },
  {
    id: "ai_recommended",
    label: "AI Recommended",
    caption: "AI-curated portfolios matched to diversified, data-driven strategies.",
    sort: "best_performing",
  },
  {
    id: "lower_risk",
    label: "Lower Risk",
    caption: "More conservative portfolios with relatively smaller swings.",
    sort: "worst_performing",
  },
];

const list = document.getElementById("ap-list");
const caption = document.getElementById("ap-caption");
let filter: FilterId = filterFromLocation();
let page = 0;
let lastPage = 1;
let loading = false;
let portfolios: Portfolio[] = [];

function num(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function esc(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[char] ?? char;
  });
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function percent(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function filterFromLocation(): FilterId {
  const hash = location.hash.replace("#", "");
  if (hash === "trending" || hash === "ai-recommended" || hash === "lower-risk") {
    return hash === "ai-recommended" ? "ai_recommended" : hash === "lower-risk" ? "lower_risk" : "trending";
  }
  return "best_performing";
}

function hashFor(id: FilterId) {
  if (id === "trending") return "#trending";
  if (id === "ai_recommended") return "#ai-recommended";
  if (id === "lower_risk") return "#lower-risk";
  return "";
}

function currentFilter() {
  return filters.find((item) => item.id === filter) ?? filters[0];
}

function sparkline(values: number[], positive: boolean) {
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const width = 320;
  const height = 88;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - ((value - min) / span) * (height - 8) - 4;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const color = positive ? "#54d8a7" : "#f87171";
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="One year performance">
    <polyline points="${points.join(" ")}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

function rankBadge(rank: number) {
  return `<span class="ap-rank ap-rank--${rank}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v2a5 5 0 0 1-4 4.9V14h3v2H8v-2h3v-3.1A5 5 0 0 1 7 6V4zm-3 0h3v2a4 4 0 0 1-3 3.9V4zm16 0h3v5.9A4 4 0 0 1 17 6V4z"/></svg>#${rank} Performing</span>`;
}

function card(portfolio: Portfolio, index: number) {
  const ytd = num(portfolio.ytd_change_perc);
  const month = num(portfolio.thirty_day_change_perc);
  const positive = ytd >= 0;
  const endValue = 1000 * (1 + ytd / 100);
  const profit = endValue - 1000;
  const name = portfolio.name?.trim() || portfolio.account || "Portfolio";
  const rank = filter === "best_performing" ? index + 1 : 0;
  const accent = portfolio.stroke && /^#[0-9a-fA-F]{6}$/.test(portfolio.stroke) ? portfolio.stroke : "#54d8a7";
  const chart = sparkline(Array.isArray(portfolio.values) ? portfolio.values : [], positive);
  const labels = portfolio.chart_start || portfolio.chart_end
    ? `<div class="ap-chart__ends"><span>${esc(portfolio.chart_start || "")}</span><span>${esc(portfolio.chart_end || "")}</span></div>`
    : "";
  return `<article class="ap-card">
    <div class="ap-card__top">
      <div>
        <h2 class="ap-card__name"><a href="/login/">${esc(name)}</a></h2>
        <p class="ap-managed" style="color:${accent}">AI managed</p>
      </div>
      ${rank > 0 && rank <= 3 ? rankBadge(rank) : ""}
    </div>
    <div class="ap-return">
      <div>
        <strong class="${positive ? "ap-up" : "ap-down"}">${percent(ytd)}</strong>
        <p>YTD return</p>
      </div>
      <div class="ap-growth">
        <b>$1,000 → ${money(endValue)}</b>
        <p style="color:${accent}">${profit >= 0 ? "+" : ""}${money(profit)} profit</p>
      </div>
    </div>
    <div class="ap-chart">${chart}${labels}</div>
    <div class="ap-meta">
      <div>
        <strong class="${month >= 0 ? "ap-up" : "ap-down"}">${percent(month)}</strong>
        <p>Last 30 days</p>
      </div>
      <div>
        <strong>${esc(portfolio.volatility || "Medium")}</strong>
        <p>Volatility</p>
      </div>
    </div>
    <div class="ap-actions">
      <a href="/login/">Favourites</a>
      <a href="/login/">View Details</a>
    </div>
  </article>`;
}

function statusCard(title: string, copy: string, retry = false) {
  const button = retry ? `<button type="button" class="ap-retry" id="ap-retry">Retry</button>` : "";
  return `<article class="ap-status"><h2>${esc(title)}</h2><p>${esc(copy)}</p>${button}</article>`;
}

function paintFilters() {
  document.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.filter === filter));
  });
  if (caption) caption.textContent = currentFilter().caption;
}

function render() {
  if (!list) return;
  paintFilters();
  if (!portfolios.length) {
    list.innerHTML = statusCard("No AI portfolios available right now.", "Try another filter or check back in a moment.", true);
    return;
  }
  const more = page < lastPage ? `<button type="button" class="ap-more" id="ap-more">Load more</button>` : "";
  list.innerHTML = portfolios.map((portfolio, index) => card(portfolio, index)).join("") + more;
}

async function load(nextPage: number, replace: boolean) {
  if (!list || loading) return;
  loading = true;
  const selected = currentFilter();
  if (replace && portfolios.length === 0) {
    list.innerHTML = statusCard("AI Portfolios are loading", "Pulling the latest AI-generated portfolios…");
  }
  try {
    const params = new URLSearchParams({
      page: String(nextPage),
      per_page: "10",
      sort: selected.sort,
    });
    if (selected.category) params.set("category", selected.category);
    const response = await fetch(`/api/website/ai-portfolios?${params.toString()}`);
    if (!response.ok) throw new Error(String(response.status));
    const body = await response.json();
    const rows = Array.isArray(body.data) ? body.data as Portfolio[] : [];
    portfolios = replace ? rows : portfolios.concat(rows);
    page = Number(body.meta?.page) || nextPage;
    lastPage = Number(body.meta?.last_page) || nextPage;
    render();
  } catch {
    if (replace && portfolios.length === 0) {
      list.innerHTML = statusCard("AI portfolios are unavailable", "The portfolio feed could not be loaded. Try again in a moment.", true);
    }
  } finally {
    loading = false;
  }
}

function showFilter(next: FilterId, push: boolean) {
  filter = next;
  portfolios = [];
  page = 0;
  lastPage = 1;
  paintFilters();
  if (push) {
    const hash = hashFor(next);
    history.pushState(null, "", hash ? `/ai_portfolios/${hash}` : "/ai_portfolios/");
  }
  void load(1, true);
}

document.querySelector(".ap-filters")?.addEventListener("click", (event) => {
  const button = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>("[data-filter]") : null;
  const next = button?.dataset.filter;
  if (next !== "best_performing" && next !== "trending" && next !== "ai_recommended" && next !== "lower_risk") return;
  if (next !== filter) showFilter(next, true);
});

list?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.id === "ap-more") void load(page + 1, false);
  if (target.id === "ap-retry") void load(1, true);
});

window.addEventListener("popstate", () => showFilter(filterFromLocation(), false));
window.addEventListener("hashchange", () => showFilter(filterFromLocation(), false));
document.querySelectorAll<HTMLAnchorElement>('a[href="/ai_portfolios/"]').forEach((link) => {
  link.addEventListener("click", (event) => {
    if (!location.pathname.startsWith("/ai_portfolios")) return;
    event.preventDefault();
    if (filter !== "best_performing") showFilter("best_performing", true);
  });
});

paintFilters();
void load(1, true);
