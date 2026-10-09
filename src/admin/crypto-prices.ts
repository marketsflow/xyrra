import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";
import type { SupabaseClient } from "@supabase/supabase-js";

type CryptoAsset = {
  id: number;
  symbol: string;
  name: string | null;
  exchange: string | null;
  enabled: boolean;
};

type Candle = {
  bucket_start: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

type MaRow = {
  timestamp: string;
  sma_20: number | null;
  sma_50: number | null;
  ema_9: number | null;
  ema_20: number | null;
  ema_50: number | null;
  sma_20_50_factor: number | null;
  ema_9_20_factor: number | null;
  ema_20_50_factor: number | null;
};

type BarCharacteristicRow = {
  timestamp: string;
  price_change_pct: number | null;
  direction: number | null;
  body: number | null;
  body_pct: number | null;
  range: number | null;
  range_pct: number | null;
  upper_wick: number | null;
  lower_wick: number | null;
  body_to_range: number | null;
  close_position: number | null;
};

type PriceActionRow = {
  timestamp: string;
  is_strong_bullish: boolean;
  is_strong_bearish: boolean;
  is_doji: boolean;
  is_hammer: boolean;
  is_shooting_star: boolean;
  is_momentum: boolean;
  is_inside_bar: boolean;
  is_engulfing: boolean;
  engulfing_direction: number | null;
  is_breakout: boolean;
  breakout_direction: number | null;
  is_breakdown: boolean;
  is_rejection: boolean;
  rejection_direction: number | null;
  is_high_volume: boolean;
};

type TimeframeOption = {
  label: string;
  minutes: number;
};

type DetailView = "prices" | "ma" | "bars" | "pa";

const TIMEFRAMES: TimeframeOption[] = [
  { label: "1m", minutes: 1 },
  { label: "5m", minutes: 5 },
  { label: "15m", minutes: 15 },
  { label: "1h", minutes: 60 },
  { label: "4h", minutes: 240 },
  { label: "1D", minutes: 1440 },
];

const DISPLAY_LIMIT = 200;
const ONE_M_PAGE = 1000;
const ONE_M_MAX_FETCH = 10_000;

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function asString(value: unknown) {
  return typeof value === "string" ? value : value == null ? null : String(value);
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
  });
}

function formatPrice(value: unknown, digits = 2) {
  const n = asNumber(value);
  if (n === null) return "—";
  const abs = Math.abs(n);
  const fractionDigits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
  return n.toLocaleString(undefined, {
    minimumFractionDigits: Math.min(digits, fractionDigits),
    maximumFractionDigits: fractionDigits,
  });
}

function formatVolume(value: unknown) {
  const n = asNumber(value);
  if (n === null) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatPct(value: unknown, digits = 2) {
  const n = asNumber(value);
  if (n === null) return "—";
  return `${n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    signDisplay: "exceptZero",
  })}%`;
}

function formatRatio(value: unknown, digits = 3) {
  const n = asNumber(value);
  if (n === null) return "—";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function parseTimeframe(raw: string | null): number {
  const match = TIMEFRAMES.find((tf) => tf.label === raw || String(tf.minutes) === raw);
  return match?.minutes ?? 1;
}

function parseView(raw: string | null): DetailView {
  if (raw === "ma" || raw === "moving-averages") return "ma";
  if (raw === "bars" || raw === "characteristics" || raw === "bar-characteristics") return "bars";
  if (
    raw === "pa" ||
    raw === "price-action" ||
    raw === "price_action" ||
    raw === "priceaction"
  ) {
    return "pa";
  }
  return "prices";
}

function viewLabel(view: DetailView) {
  if (view === "ma") return "Moving averages";
  if (view === "bars") return "Bar characteristics";
  if (view === "pa") return "Price action";
  return "OHLCV candles";
}

function asBool(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function timeframeLabel(minutes: number) {
  return TIMEFRAMES.find((tf) => tf.minutes === minutes)?.label ?? `${minutes}m`;
}

function setListStatus(message: string, isError = false) {
  const el = document.getElementById("xa-crypto-status");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("xa-users__status--error", isError);
}

function setDetailStatus(message: string, isError = false) {
  const el = document.getElementById("xa-crypto-detail-status");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("xa-users__status--error", isError);
}

function floorToTimeframeMs(ms: number, timeframeMinutes: number) {
  const size = timeframeMinutes * 60_000;
  return Math.floor(ms / size) * size;
}

function aggregateCandles(oneMinute: Candle[], timeframeMinutes: number, limit: number): Candle[] {
  if (timeframeMinutes <= 1) {
    return oneMinute.slice(0, limit);
  }

  const buckets = new Map<number, Candle>();

  // Newest-first input; walk oldest→newest so open/close aggregation is correct.
  const chronological = [...oneMinute].sort(
    (a, b) => new Date(a.bucket_start).getTime() - new Date(b.bucket_start).getTime(),
  );

  for (const bar of chronological) {
    const startMs = floorToTimeframeMs(new Date(bar.bucket_start).getTime(), timeframeMinutes);
    const existing = buckets.get(startMs);
    if (!existing) {
      buckets.set(startMs, {
        bucket_start: new Date(startMs).toISOString(),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      });
      continue;
    }
    existing.high = Math.max(existing.high, bar.high);
    existing.low = Math.min(existing.low, bar.low);
    existing.close = bar.close;
    if (existing.volume === null && bar.volume === null) {
      existing.volume = null;
    } else {
      existing.volume = (existing.volume ?? 0) + (bar.volume ?? 0);
    }
  }

  return [...buckets.values()]
    .sort((a, b) => new Date(b.bucket_start).getTime() - new Date(a.bucket_start).getTime())
    .slice(0, limit);
}

function toCandle(row: Record<string, unknown>): Candle | null {
  const bucket = asString(row.bucket_start);
  const open = asNumber(row.open);
  const high = asNumber(row.high);
  const low = asNumber(row.low);
  const close = asNumber(row.close);
  if (!bucket || open === null || high === null || low === null || close === null) return null;
  return {
    bucket_start: bucket,
    open,
    high,
    low,
    close,
    volume: asNumber(row.volume),
  };
}

function toMaRow(row: Record<string, unknown>): MaRow | null {
  const timestamp = asString(row.timestamp);
  if (!timestamp) return null;
  return {
    timestamp,
    sma_20: asNumber(row.sma_20),
    sma_50: asNumber(row.sma_50),
    ema_9: asNumber(row.ema_9),
    ema_20: asNumber(row.ema_20),
    ema_50: asNumber(row.ema_50),
    sma_20_50_factor: asNumber(row.sma_20_50_factor),
    ema_9_20_factor: asNumber(row.ema_9_20_factor),
    ema_20_50_factor: asNumber(row.ema_20_50_factor),
  };
}

function toBarCharacteristicRow(row: Record<string, unknown>): BarCharacteristicRow | null {
  const timestamp = asString(row.timestamp);
  if (!timestamp) return null;
  return {
    timestamp,
    price_change_pct: asNumber(row.price_change_pct),
    direction: asNumber(row.direction),
    body: asNumber(row.body),
    body_pct: asNumber(row.body_pct),
    range: asNumber(row.range),
    range_pct: asNumber(row.range_pct),
    upper_wick: asNumber(row.upper_wick),
    lower_wick: asNumber(row.lower_wick),
    body_to_range: asNumber(row.body_to_range),
    close_position: asNumber(row.close_position),
  };
}

function toPriceActionRow(row: Record<string, unknown>): PriceActionRow | null {
  const timestamp = asString(row.timestamp);
  if (!timestamp) return null;
  return {
    timestamp,
    is_strong_bullish: asBool(row.is_strong_bullish),
    is_strong_bearish: asBool(row.is_strong_bearish),
    is_doji: asBool(row.is_doji),
    is_hammer: asBool(row.is_hammer),
    is_shooting_star: asBool(row.is_shooting_star),
    is_momentum: asBool(row.is_momentum),
    is_inside_bar: asBool(row.is_inside_bar),
    is_engulfing: asBool(row.is_engulfing),
    engulfing_direction: asNumber(row.engulfing_direction),
    is_breakout: asBool(row.is_breakout),
    breakout_direction: asNumber(row.breakout_direction),
    is_breakdown: asBool(row.is_breakdown),
    is_rejection: asBool(row.is_rejection),
    rejection_direction: asNumber(row.rejection_direction),
    is_high_volume: asBool(row.is_high_volume),
  };
}

/** Boolean flag → green check or muted dash. */
function renderBoolFlag(value: boolean) {
  if (!value) return '<span class="xa-muted">—</span>';
  return '<span class="xa-crypto__flag xa-crypto__flag--on" title="True" aria-label="True">✓</span>';
}

/** Active directional pattern → factor box; inactive → muted dash. */
function renderDirectedFlag(active: boolean, direction: number | null) {
  if (!active) return '<span class="xa-muted">—</span>';
  if (direction === null) return renderBoolFlag(true);
  return renderFactorBox(direction);
}

/** 1 → green, -1 → red, 0 → orange, missing → muted empty. */
function renderFactorBox(value: unknown) {
  const n = asNumber(value);
  if (n === null) {
    return '<span class="xa-crypto__factor xa-crypto__factor--empty" title="—" aria-label="No factor"></span>';
  }
  const tone = n > 0 ? "up" : n < 0 ? "down" : "flat";
  const label = n > 0 ? "Bullish (1)" : n < 0 ? "Bearish (-1)" : "Neutral (0)";
  return `<span class="xa-crypto__factor xa-crypto__factor--${tone}" title="${label}" aria-label="${label}"></span>`;
}

async function fetchStoredCandles(
  supabase: SupabaseClient,
  assetId: number,
  timeframeMinutes: number,
  limit: number,
): Promise<{ candles: Candle[]; error: string | null }> {
  const { data, error } = await supabase
    .from("crypto_prices")
    .select("bucket_start, open, high, low, close, volume")
    .eq("asset_id", assetId)
    .eq("timeframe", timeframeMinutes)
    .order("bucket_start", { ascending: false })
    .limit(limit);

  if (error) {
    return { candles: [], error: error.message };
  }

  const candles = ((data as Record<string, unknown>[] | null) ?? [])
    .map(toCandle)
    .filter((c): c is Candle => c !== null);
  return { candles, error: null };
}

async function fetchOneMinuteCandles(
  supabase: SupabaseClient,
  assetId: number,
  needed: number,
): Promise<{ candles: Candle[]; error: string | null }> {
  const target = Math.min(Math.max(needed, DISPLAY_LIMIT), ONE_M_MAX_FETCH);
  const candles: Candle[] = [];
  let offset = 0;

  while (candles.length < target) {
    const end = offset + ONE_M_PAGE - 1;
    const { data, error } = await supabase
      .from("crypto_prices")
      .select("bucket_start, open, high, low, close, volume")
      .eq("asset_id", assetId)
      .eq("timeframe", 1)
      .order("bucket_start", { ascending: false })
      .range(offset, end);

    if (error) return { candles: [], error: error.message };

    const page = ((data as Record<string, unknown>[] | null) ?? [])
      .map(toCandle)
      .filter((c): c is Candle => c !== null);

    if (page.length === 0) break;
    candles.push(...page);
    if (page.length < ONE_M_PAGE) break;
    offset += ONE_M_PAGE;
  }

  return { candles, error: null };
}

async function loadCandlesForTimeframe(
  supabase: SupabaseClient,
  assetId: number,
  timeframeMinutes: number,
): Promise<{ candles: Candle[]; source: "stored" | "aggregated"; error: string | null }> {
  if (timeframeMinutes === 1) {
    const result = await fetchStoredCandles(supabase, assetId, 1, DISPLAY_LIMIT);
    return { candles: result.candles, source: "stored", error: result.error };
  }

  const stored = await fetchStoredCandles(supabase, assetId, timeframeMinutes, DISPLAY_LIMIT);
  if (stored.error) return { candles: [], source: "stored", error: stored.error };
  if (stored.candles.length > 0) {
    return { candles: stored.candles, source: "stored", error: null };
  }

  const neededOneMinute = Math.min(DISPLAY_LIMIT * timeframeMinutes, ONE_M_MAX_FETCH);
  const oneMinute = await fetchOneMinuteCandles(supabase, assetId, neededOneMinute);
  if (oneMinute.error) return { candles: [], source: "aggregated", error: oneMinute.error };

  return {
    candles: aggregateCandles(oneMinute.candles, timeframeMinutes, DISPLAY_LIMIT),
    source: "aggregated",
    error: null,
  };
}

async function loadMovingAverages(
  supabase: SupabaseClient,
  assetId: number,
  timeframeMinutes: number,
): Promise<{ rows: MaRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from("crypto_moving_averages")
    .select(
      "timestamp, sma_20, sma_50, ema_9, ema_20, ema_50, sma_20_50_factor, ema_9_20_factor, ema_20_50_factor",
    )
    .eq("asset_id", assetId)
    .eq("timeframe", timeframeMinutes)
    .order("timestamp", { ascending: false })
    .limit(DISPLAY_LIMIT);

  if (error) {
    return { rows: [], error: error.message };
  }

  const rows = ((data as Record<string, unknown>[] | null) ?? [])
    .map(toMaRow)
    .filter((row): row is MaRow => row !== null);
  return { rows, error: null };
}

async function loadBarCharacteristics(
  supabase: SupabaseClient,
  assetId: number,
  timeframeMinutes: number,
): Promise<{ rows: BarCharacteristicRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from("crypto_bar_characteristics")
    .select(
      "timestamp, price_change_pct, direction, body, body_pct, range, range_pct, upper_wick, lower_wick, body_to_range, close_position",
    )
    .eq("asset_id", assetId)
    .eq("timeframe", timeframeMinutes)
    .order("timestamp", { ascending: false })
    .limit(DISPLAY_LIMIT);

  if (error) {
    return { rows: [], error: error.message };
  }

  const rows = ((data as Record<string, unknown>[] | null) ?? [])
    .map(toBarCharacteristicRow)
    .filter((row): row is BarCharacteristicRow => row !== null);
  return { rows, error: null };
}

async function loadPriceAction(
  supabase: SupabaseClient,
  assetId: number,
  timeframeMinutes: number,
): Promise<{ rows: PriceActionRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from("crypto_price_action")
    .select(
      "timestamp, is_strong_bullish, is_strong_bearish, is_doji, is_hammer, is_shooting_star, is_momentum, is_inside_bar, is_engulfing, engulfing_direction, is_breakout, breakout_direction, is_breakdown, is_rejection, rejection_direction, is_high_volume",
    )
    .eq("asset_id", assetId)
    .eq("timeframe", timeframeMinutes)
    .order("timestamp", { ascending: false })
    .limit(DISPLAY_LIMIT);

  if (error) {
    return { rows: [], error: error.message };
  }

  const rows = ((data as Record<string, unknown>[] | null) ?? [])
    .map(toPriceActionRow)
    .filter((row): row is PriceActionRow => row !== null);
  return { rows, error: null };
}

function renderAssets(
  assets: Array<
    CryptoAsset & {
      lastClose: number | null;
      lastBucket: string | null;
    }
  >,
) {
  const tbody = document.getElementById("xa-crypto-assets-body");
  if (!tbody) return;

  if (assets.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="6" class="xa-users__empty">No crypto assets yet. Run ingest or seed crypto_assets.</td></tr>';
    return;
  }

  tbody.innerHTML = assets
    .map((asset) => {
      const pricesHref = `/admin/polymarket/crypto-prices/?symbol=${encodeURIComponent(asset.symbol)}&view=prices`;
      const maHref = `/admin/polymarket/crypto-prices/?symbol=${encodeURIComponent(asset.symbol)}&view=ma`;
      const barsHref = `/admin/polymarket/crypto-prices/?symbol=${encodeURIComponent(asset.symbol)}&view=bars`;
      const paHref = `/admin/polymarket/crypto-prices/?symbol=${encodeURIComponent(asset.symbol)}&view=pa`;
      return `
        <tr class="xa-crypto__asset-row" data-symbol="${escapeHtml(asset.symbol)}">
          <td>
            <a class="xa-crypto__symbol-link" href="${pricesHref}">${escapeHtml(asset.symbol)}</a>
          </td>
          <td>${asset.name ? escapeHtml(asset.name) : '<span class="xa-muted">—</span>'}</td>
          <td>${asset.exchange ? escapeHtml(asset.exchange) : '<span class="xa-muted">—</span>'}</td>
          <td>${escapeHtml(formatPrice(asset.lastClose))}</td>
          <td>${escapeHtml(formatDateTime(asset.lastBucket))}</td>
          <td>
            <div class="xa-crypto__view-links">
              <a href="${pricesHref}">Prices</a>
              <a href="${maHref}">MA</a>
              <a href="${barsHref}">Bars</a>
              <a href="${paHref}">PA</a>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderTimeframeButtons(activeMinutes: number) {
  const el = document.getElementById("xa-crypto-timeframes");
  if (!el) return;

  el.innerHTML = TIMEFRAMES.map((tf) => {
    const active = tf.minutes === activeMinutes;
    return `
      <button
        type="button"
        class="xa-crypto__tf${active ? " xa-crypto__tf--active" : ""}"
        data-tf="${tf.minutes}"
        aria-pressed="${active ? "true" : "false"}"
      >
        ${escapeHtml(tf.label)}
      </button>
    `;
  }).join("");
}

function renderViewModeButtons(activeView: DetailView) {
  const el = document.getElementById("xa-crypto-view-modes");
  if (!el) return;

  el.querySelectorAll<HTMLButtonElement>("button[data-view]").forEach((button) => {
    const isActive = button.dataset.view === activeView;
    button.classList.toggle("xa-crypto__tf--active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

function renderPrices(candles: Candle[]) {
  const tbody = document.getElementById("xa-crypto-prices-body");
  if (!tbody) return;

  if (candles.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="6" class="xa-users__empty">No prices for this timeframe yet.</td></tr>';
    return;
  }

  tbody.innerHTML = candles
    .map(
      (candle) => `
        <tr>
          <td>${escapeHtml(formatDateTime(candle.bucket_start))}</td>
          <td>${escapeHtml(formatPrice(candle.open))}</td>
          <td>${escapeHtml(formatPrice(candle.high))}</td>
          <td>${escapeHtml(formatPrice(candle.low))}</td>
          <td>${escapeHtml(formatPrice(candle.close))}</td>
          <td>${escapeHtml(formatVolume(candle.volume))}</td>
        </tr>
      `,
    )
    .join("");
}

function renderMovingAverages(rows: MaRow[]) {
  const tbody = document.getElementById("xa-crypto-ma-body");
  if (!tbody) return;

  if (rows.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="9" class="xa-users__empty">No moving averages for this timeframe yet.</td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(formatDateTime(row.timestamp))}</td>
          <td>${escapeHtml(formatPrice(row.sma_20))}</td>
          <td>${escapeHtml(formatPrice(row.sma_50))}</td>
          <td>${escapeHtml(formatPrice(row.ema_9))}</td>
          <td>${escapeHtml(formatPrice(row.ema_20))}</td>
          <td>${escapeHtml(formatPrice(row.ema_50))}</td>
          <td>${renderFactorBox(row.sma_20_50_factor)}</td>
          <td>${renderFactorBox(row.ema_9_20_factor)}</td>
          <td>${renderFactorBox(row.ema_20_50_factor)}</td>
        </tr>
      `,
    )
    .join("");
}

function renderBarCharacteristics(rows: BarCharacteristicRow[]) {
  const tbody = document.getElementById("xa-crypto-bars-body");
  if (!tbody) return;

  if (rows.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="11" class="xa-users__empty">No bar characteristics for this timeframe yet.</td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(formatDateTime(row.timestamp))}</td>
          <td>${escapeHtml(formatPct(row.price_change_pct))}</td>
          <td>${renderFactorBox(row.direction)}</td>
          <td>${escapeHtml(formatPrice(row.body))}</td>
          <td>${escapeHtml(formatPct(row.body_pct))}</td>
          <td>${escapeHtml(formatPrice(row.range))}</td>
          <td>${escapeHtml(formatPct(row.range_pct))}</td>
          <td>${escapeHtml(formatPrice(row.upper_wick))}</td>
          <td>${escapeHtml(formatPrice(row.lower_wick))}</td>
          <td>${escapeHtml(formatRatio(row.body_to_range))}</td>
          <td>${escapeHtml(formatRatio(row.close_position))}</td>
        </tr>
      `,
    )
    .join("");
}

function renderPriceAction(rows: PriceActionRow[]) {
  const tbody = document.getElementById("xa-crypto-pa-body");
  if (!tbody) return;

  if (rows.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="13" class="xa-users__empty">No price-action rows for this timeframe yet.</td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(formatDateTime(row.timestamp))}</td>
          <td>${renderBoolFlag(row.is_strong_bullish)}</td>
          <td>${renderBoolFlag(row.is_strong_bearish)}</td>
          <td>${renderBoolFlag(row.is_doji)}</td>
          <td>${renderBoolFlag(row.is_hammer)}</td>
          <td>${renderBoolFlag(row.is_shooting_star)}</td>
          <td>${renderBoolFlag(row.is_momentum)}</td>
          <td>${renderBoolFlag(row.is_inside_bar)}</td>
          <td>${renderDirectedFlag(row.is_engulfing, row.engulfing_direction)}</td>
          <td>${renderDirectedFlag(row.is_breakout, row.breakout_direction)}</td>
          <td>${renderBoolFlag(row.is_breakdown)}</td>
          <td>${renderDirectedFlag(row.is_rejection, row.rejection_direction)}</td>
          <td>${renderBoolFlag(row.is_high_volume)}</td>
        </tr>
      `,
    )
    .join("");
}

function showListView() {
  document.getElementById("xa-crypto-list-view")?.removeAttribute("hidden");
  document.getElementById("xa-crypto-detail-view")?.setAttribute("hidden", "");
}

function showDetailView() {
  document.getElementById("xa-crypto-list-view")?.setAttribute("hidden", "");
  document.getElementById("xa-crypto-detail-view")?.removeAttribute("hidden");
}

function showDetailPanels(view: DetailView) {
  const pricesPanel = document.getElementById("xa-crypto-prices-panel");
  const maPanel = document.getElementById("xa-crypto-ma-panel");
  const barsPanel = document.getElementById("xa-crypto-bars-panel");
  const paPanel = document.getElementById("xa-crypto-pa-panel");
  pricesPanel?.setAttribute("hidden", "");
  maPanel?.setAttribute("hidden", "");
  barsPanel?.setAttribute("hidden", "");
  paPanel?.setAttribute("hidden", "");
  if (view === "ma") {
    maPanel?.removeAttribute("hidden");
  } else if (view === "bars") {
    barsPanel?.removeAttribute("hidden");
  } else if (view === "pa") {
    paPanel?.removeAttribute("hidden");
  } else {
    pricesPanel?.removeAttribute("hidden");
  }
}

async function init() {
  const session = await requireAdminSession();
  if (!session) return;

  initAdminShell(session, "polymarket-crypto-prices");
  setAdminLoading(false);

  const { supabase } = session;
  const params = new URLSearchParams(window.location.search);
  const symbolParam = params.get("symbol")?.trim().toUpperCase() || null;
  let activeTimeframe = parseTimeframe(params.get("tf"));
  let activeView = parseView(params.get("view"));

  const refreshBtn = document.getElementById("xa-crypto-refresh") as HTMLButtonElement | null;
  const ingestBtn = document.getElementById("xa-crypto-ingest") as HTMLButtonElement | null;
  const detailRefreshBtn = document.getElementById(
    "xa-crypto-detail-refresh",
  ) as HTMLButtonElement | null;
  const summaryEl = document.getElementById("xa-crypto-summary");
  const detailSummaryEl = document.getElementById("xa-crypto-detail-summary");
  const detailTitleEl = document.getElementById("xa-crypto-detail-title");
  const detailLedeEl = document.getElementById("xa-crypto-detail-lede");
  const timeframesEl = document.getElementById("xa-crypto-timeframes");
  const viewModesEl = document.getElementById("xa-crypto-view-modes");

  let listLoading = false;
  let detailLoading = false;
  let ingesting = false;
  let selectedAsset: CryptoAsset | null = null;

  async function loadAssetList() {
    if (listLoading) return;
    listLoading = true;
    setListStatus("Loading tokens…");

    const { data, error } = await supabase
      .from("crypto_assets")
      .select("id, symbol, name, exchange, enabled")
      .order("symbol", { ascending: true });

    if (error) {
      listLoading = false;
      setListStatus(error.message, true);
      if (summaryEl) summaryEl.textContent = "Could not read crypto_assets.";
      renderAssets([]);
      return;
    }

    const assets = ((data as CryptoAsset[] | null) ?? []).filter((a) => a.enabled !== false);

    const withLast = await Promise.all(
      assets.map(async (asset) => {
        const { data: priceRows } = await supabase
          .from("crypto_prices")
          .select("close, bucket_start")
          .eq("asset_id", asset.id)
          .eq("timeframe", 1)
          .order("bucket_start", { ascending: false })
          .limit(1);

        const latest = (priceRows as Array<{ close: unknown; bucket_start: unknown }> | null)?.[0];
        return {
          ...asset,
          lastClose: asNumber(latest?.close),
          lastBucket: asString(latest?.bucket_start),
        };
      }),
    );

    listLoading = false;
    if (summaryEl) {
      summaryEl.textContent = `${withLast.length.toLocaleString()} token${withLast.length === 1 ? "" : "s"}. Open Prices, MA, Bars, or PA for a symbol.`;
    }
    renderAssets(withLast);
    setListStatus(`Updated ${new Date().toLocaleTimeString()}.`);
  }

  function updateUrl(symbol: string, timeframeMinutes: number, view: DetailView) {
    const next = new URLSearchParams();
    next.set("symbol", symbol);
    next.set("view", view);
    next.set("tf", timeframeLabel(timeframeMinutes));
    const url = `${window.location.pathname}?${next.toString()}`;
    window.history.replaceState({}, "", url);
  }

  async function loadDetailData() {
    if (!selectedAsset || detailLoading) return;
    detailLoading = true;
    renderViewModeButtons(activeView);
    renderTimeframeButtons(activeTimeframe);
    showDetailPanels(activeView);

    if (activeView === "ma") {
      setDetailStatus(`Loading ${timeframeLabel(activeTimeframe)} moving averages…`);
      const result = await loadMovingAverages(supabase, selectedAsset.id, activeTimeframe);
      detailLoading = false;

      if (result.error) {
        setDetailStatus(result.error, true);
        renderMovingAverages([]);
        if (detailSummaryEl) detailSummaryEl.textContent = "";
        return;
      }

      renderMovingAverages(result.rows);
      if (detailSummaryEl) {
        detailSummaryEl.textContent = `${result.rows.length.toLocaleString()} MA row${result.rows.length === 1 ? "" : "s"} · ${timeframeLabel(activeTimeframe)} (SMA/EMA + cross factors).`;
      }
      setDetailStatus(`Updated ${new Date().toLocaleTimeString()}.`);
      return;
    }

    if (activeView === "bars") {
      setDetailStatus(`Loading ${timeframeLabel(activeTimeframe)} bar characteristics…`);
      const result = await loadBarCharacteristics(supabase, selectedAsset.id, activeTimeframe);
      detailLoading = false;

      if (result.error) {
        setDetailStatus(result.error, true);
        renderBarCharacteristics([]);
        if (detailSummaryEl) detailSummaryEl.textContent = "";
        return;
      }

      renderBarCharacteristics(result.rows);
      if (detailSummaryEl) {
        detailSummaryEl.textContent = `${result.rows.length.toLocaleString()} bar${result.rows.length === 1 ? "" : "s"} · ${timeframeLabel(activeTimeframe)} (direction, size, wicks).`;
      }
      setDetailStatus(`Updated ${new Date().toLocaleTimeString()}.`);
      return;
    }

    if (activeView === "pa") {
      setDetailStatus(`Loading ${timeframeLabel(activeTimeframe)} price action…`);
      const result = await loadPriceAction(supabase, selectedAsset.id, activeTimeframe);
      detailLoading = false;

      if (result.error) {
        setDetailStatus(result.error, true);
        renderPriceAction([]);
        if (detailSummaryEl) detailSummaryEl.textContent = "";
        return;
      }

      renderPriceAction(result.rows);
      if (detailSummaryEl) {
        detailSummaryEl.textContent = `${result.rows.length.toLocaleString()} row${result.rows.length === 1 ? "" : "s"} · ${timeframeLabel(activeTimeframe)} (patterns, breakouts, volume).`;
      }
      setDetailStatus(`Updated ${new Date().toLocaleTimeString()}.`);
      return;
    }

    setDetailStatus(`Loading ${timeframeLabel(activeTimeframe)} prices…`);
    const result = await loadCandlesForTimeframe(supabase, selectedAsset.id, activeTimeframe);
    detailLoading = false;

    if (result.error) {
      setDetailStatus(result.error, true);
      renderPrices([]);
      if (detailSummaryEl) detailSummaryEl.textContent = "";
      return;
    }

    renderPrices(result.candles);
    if (detailSummaryEl) {
      const sourceNote =
        result.source === "aggregated"
          ? ` Aggregated from 1m candles (${timeframeLabel(activeTimeframe)} not stored yet).`
          : "";
      detailSummaryEl.textContent = `${result.candles.length.toLocaleString()} candle${result.candles.length === 1 ? "" : "s"} · ${timeframeLabel(activeTimeframe)}.${sourceNote}`;
    }
    setDetailStatus(`Updated ${new Date().toLocaleTimeString()}.`);
  }

  async function openAsset(symbol: string) {
    showDetailView();
    setDetailStatus("Loading token…");
    renderPrices([]);
    renderMovingAverages([]);
    renderBarCharacteristics([]);
    renderPriceAction([]);
    showDetailPanels(activeView);
    renderViewModeButtons(activeView);

    const { data, error } = await supabase
      .from("crypto_assets")
      .select("id, symbol, name, exchange, enabled")
      .eq("symbol", symbol)
      .maybeSingle();

    if (error || !data) {
      selectedAsset = null;
      if (detailTitleEl) detailTitleEl.textContent = symbol;
      if (detailLedeEl) {
        detailLedeEl.textContent = error?.message || "Token not found in crypto_assets.";
      }
      setDetailStatus(error?.message || "Token not found.", true);
      return;
    }

    selectedAsset = data as CryptoAsset;
    if (detailTitleEl) detailTitleEl.textContent = selectedAsset.symbol;
    if (detailLedeEl) {
      const parts = [
        selectedAsset.name?.trim() || null,
        selectedAsset.exchange ? `Exchange: ${selectedAsset.exchange}` : null,
        viewLabel(activeView),
      ].filter(Boolean);
      detailLedeEl.textContent = parts.join(" · ");
    }

    updateUrl(selectedAsset.symbol, activeTimeframe, activeView);
    await loadDetailData();
  }

  viewModesEl?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLButtonElement>("button[data-view]");
    if (!button || !selectedAsset) return;
    const nextView = parseView(button.dataset.view ?? null);
    if (nextView === activeView) return;
    activeView = nextView;
    if (detailLedeEl) {
      const parts = [
        selectedAsset.name?.trim() || null,
        selectedAsset.exchange ? `Exchange: ${selectedAsset.exchange}` : null,
        viewLabel(activeView),
      ].filter(Boolean);
      detailLedeEl.textContent = parts.join(" · ");
    }
    updateUrl(selectedAsset.symbol, activeTimeframe, activeView);
    void loadDetailData();
  });

  timeframesEl?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLButtonElement>("button[data-tf]");
    if (!button || !selectedAsset) return;
    const minutes = Number(button.dataset.tf);
    if (!Number.isFinite(minutes) || minutes === activeTimeframe) return;
    activeTimeframe = minutes;
    updateUrl(selectedAsset.symbol, activeTimeframe, activeView);
    void loadDetailData();
  });

  refreshBtn?.addEventListener("click", () => {
    void loadAssetList();
  });

  detailRefreshBtn?.addEventListener("click", () => {
    void loadDetailData();
  });

  ingestBtn?.addEventListener("click", () => {
    void (async () => {
      if (ingesting) return;
      ingesting = true;
      if (ingestBtn) {
        ingestBtn.disabled = true;
        ingestBtn.textContent = "Ingesting…";
      }
      setListStatus("Fetching the current 1m candle…");

      try {
        const auth = await supabase.auth.getSession();
        const accessToken = auth.data.session?.access_token;
        if (!accessToken) {
          throw new Error("Your session expired. Sign in again.");
        }

        const response = await fetch("/api/ingest-crypto", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

        const raw = await response.text();
        let body: { success?: boolean; message?: string; pair?: string } = {};
        if (raw) {
          try {
            body = JSON.parse(raw) as typeof body;
          } catch {
            throw new Error("Ingest API did not return JSON.");
          }
        }

        if (!response.ok || !body.success) {
          throw new Error(body.message || "Unable to ingest crypto price.");
        }

        setListStatus(`Ingested ${body.pair ?? "1m candle"}.`);
        await loadAssetList();
        if (selectedAsset) await loadDetailData();
      } catch (error) {
        setListStatus(error instanceof Error ? error.message : "Unable to ingest.", true);
      } finally {
        ingesting = false;
        if (ingestBtn) {
          ingestBtn.disabled = false;
          ingestBtn.textContent = "Ingest 1m now";
        }
      }
    })();
  });

  if (symbolParam) {
    await openAsset(symbolParam);
  } else {
    showListView();
    await loadAssetList();
  }
}

void init();
