import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";

const WINDOW_SEC = 4 * 60 * 60;
const PAGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const ANALYSIS_TIMEFRAME = 240;
const BTC_SYMBOL = "BTC";
const DEFAULT_POSITION_USD = 10;

type CryptoPriceSignalRow = {
  bucket_start: string;
  signal: string;
  price_level: number | null;
  price_1m: number | null;
  ema: number | null;
  momentum: number | null;
};

type FourHourPeriod = {
  /** crypto_price.bucket_start (signal candle). */
  signalStartSec: number;
  /** Polymarket 4h window start (= signalStartSec + 4h). */
  startSec: number;
  endSec: number;
  startIso: string;
  endIso: string;
  label: string;
  cryptoPrice: CryptoPriceSignalRow;
};

type DayGroup = {
  dateKey: string;
  dateLabel: string;
  periods: FourHourPeriod[];
};

type PolymarketTick = {
  event_slug: string | null;
  question: string | null;
  up_token_id: string | null;
  down_token_id: string | null;
  up_price: number | null;
  down_price: number | null;
  price_to_beat: number | null;
  spot_price: number | null;
  recorded_at: string;
  market_start_at: string | null;
  market_end_at: string | null;
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

function formatUtcTime(sec: number) {
  const d = new Date(sec * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatUtcDateLabel(dateKey: string) {
  const [y, m, day] = dateKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, day));
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

/** e.g. 13 Oct 2026, 00:00:00 */
function formatCryptoPriceAt(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
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

function formatEtClock(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const period = (parts.find((p) => p.type === "dayPeriod")?.value ?? "").toUpperCase();
  return `${hour}:${minute}${period}`;
}

/** e.g. Bitcoin Up or Down - October 13, 12:00AM-4:00AM ET */
function formatPolymarketTitle(startSec: number, endSec: number) {
  const start = new Date(startSec * 1000);
  const end = new Date(endSec * 1000);
  const monthDay = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
  }).format(start);
  return `Bitcoin Up or Down - ${monthDay}, ${formatEtClock(start)}-${formatEtClock(end)} ET`;
}

function utcDateKey(sec: number) {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

function marketSlugForStart(startSec: number) {
  return `btc-updown-4h-${startSec}`;
}

function directionFromSignal(signal: string): "LONG_UP" | "LONG_DOWN" | null {
  const s = signal.trim().toLowerCase();
  if (s === "above") return "LONG_UP";
  if (s === "below") return "LONG_DOWN";
  return null;
}

function confidenceFromEma(ema: number | null): number {
  if (ema === null) return 0.5;
  const ratio = ema / 50;
  return Math.min(1, Math.max(0, Number(ratio.toFixed(4))));
}

function utcMidnightMs(nowMs = Date.now()) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function currentClosedWindowEndSec(nowMs = Date.now()) {
  const nowSec = Math.floor(nowMs / 1000);
  return Math.floor(nowSec / WINDOW_SEC) * WINDOW_SEC;
}

/** One PAGE_DAYS window. weekOffset 0 = most recent days; higher = earlier. */
function pageRange(weekOffset: number, nowMs = Date.now()) {
  const todayUtc = utcMidnightMs(nowMs);
  const page0StartMs = todayUtc - (PAGE_DAYS - 1) * DAY_MS;
  const fromMs = page0StartMs - weekOffset * PAGE_DAYS * DAY_MS;
  const closedEndSec = currentClosedWindowEndSec(nowMs);
  const beforeMs =
    weekOffset === 0
      ? closedEndSec * 1000
      : page0StartMs - (weekOffset - 1) * PAGE_DAYS * DAY_MS;
  // Inclusive end day for the label (beforeIso is exclusive).
  const endLabelMs = weekOffset === 0 ? todayUtc : beforeMs - DAY_MS;
  return {
    fromIso: new Date(fromMs).toISOString(),
    beforeIso: new Date(beforeMs).toISOString(),
    closedEndSec,
    label: `${formatUtcDateLabel(new Date(fromMs).toISOString().slice(0, 10))} – ${formatUtcDateLabel(new Date(Math.max(fromMs, endLabelMs)).toISOString().slice(0, 10))} UTC`,
  };
}

async function loadBtcAssetId(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase
    .from("crypto_assets")
    .select("id")
    .eq("symbol", BTC_SYMBOL)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const id = asNumber(data?.id);
  if (id === null) throw new Error("BTC asset not found in crypto_assets.");
  return id;
}

async function loadSignaledCryptoPrices(
  supabase: SupabaseClient,
  assetId: number,
  fromIso: string,
  beforeIso: string,
): Promise<CryptoPriceSignalRow[]> {
  const { data, error } = await supabase
    .from("crypto_price")
    .select("bucket_start, signal, price_level, price_1m, ema, momentum")
    .eq("asset_id", assetId)
    .eq("timeframe", ANALYSIS_TIMEFRAME)
    .not("signal", "is", null)
    .neq("signal", "")
    .gte("bucket_start", fromIso)
    .lt("bucket_start", beforeIso)
    .order("bucket_start", { ascending: false });

  if (error) throw new Error(error.message);

  const rows: CryptoPriceSignalRow[] = [];
  for (const row of data ?? []) {
    const bucketStart = asString(row.bucket_start);
    const signal = asString(row.signal);
    if (!bucketStart || !signal) continue;
    rows.push({
      bucket_start: bucketStart,
      signal,
      price_level: asNumber(row.price_level),
      price_1m: asNumber(row.price_1m),
      ema: asNumber(row.ema),
      momentum: asNumber(row.momentum),
    });
  }
  return rows;
}

/**
 * Pair each signaled crypto_price bar with the Polymarket window of the same start.
 * Only rows with a non-null signal are loaded, so create never offers a window
 * that has no signal on crypto_price levels (same bucket_start / tf=4h).
 */
function groupSignaledPeriods(
  rows: CryptoPriceSignalRow[],
  closedPolyEndSec: number,
): DayGroup[] {
  const byDay = new Map<string, FourHourPeriod[]>();

  for (const cryptoPrice of rows) {
    // Skip empty / whitespace signals (defense in depth; query already filters).
    if (!cryptoPrice.signal.trim()) continue;

    const signalMs = Date.parse(cryptoPrice.bucket_start);
    if (!Number.isFinite(signalMs)) continue;
    const signalStartSec = Math.floor(signalMs / 1000);
    // Align to canonical 4h unix starts used by Polymarket slugs.
    if (signalStartSec % WINDOW_SEC !== 0) continue;

    // Same window as the signaled crypto_price bar (matches levels view).
    const startSec = signalStartSec;
    const endSec = startSec + WINDOW_SEC;
    // Only list Polymarket windows that have fully closed.
    if (endSec > closedPolyEndSec) continue;

    const period: FourHourPeriod = {
      signalStartSec,
      startSec,
      endSec,
      startIso: new Date(startSec * 1000).toISOString(),
      endIso: new Date(endSec * 1000).toISOString(),
      label: `${formatUtcTime(startSec)}–${formatUtcTime(endSec)} UTC`,
      cryptoPrice,
    };

    const key = utcDateKey(startSec);
    const list = byDay.get(key);
    if (list) list.push(period);
    else byDay.set(key, [period]);
  }

  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([dateKey, periods]) => ({
      dateKey,
      dateLabel: formatUtcDateLabel(dateKey),
      periods: periods.sort((a, b) => b.startSec - a.startSec),
    }));
}

/** First Polymarket tick at or after the 4h window start (next available data). */
async function loadEntryTick(
  supabase: SupabaseClient,
  startSec: number,
): Promise<PolymarketTick | null> {
  const slug = marketSlugForStart(startSec);
  const startIso = new Date(startSec * 1000).toISOString();
  const endIso = new Date((startSec + WINDOW_SEC) * 1000).toISOString();

  const bySlug = await supabase
    .from("polymarket_ticks")
    .select(
      "event_slug, question, up_token_id, down_token_id, up_price, down_price, price_to_beat, spot_price, recorded_at, market_start_at, market_end_at",
    )
    .eq("event_slug", slug)
    .gte("recorded_at", startIso)
    .lt("recorded_at", endIso)
    .order("recorded_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (bySlug.error) throw new Error(bySlug.error.message);
  if (bySlug.data) return mapTick(bySlug.data);

  // Fallback: any tick in the window whose market_start_at matches.
  const byStart = await supabase
    .from("polymarket_ticks")
    .select(
      "event_slug, question, up_token_id, down_token_id, up_price, down_price, price_to_beat, spot_price, recorded_at, market_start_at, market_end_at",
    )
    .eq("asset", "btc")
    .gte("recorded_at", startIso)
    .lt("recorded_at", endIso)
    .order("recorded_at", { ascending: true })
    .limit(5);

  if (byStart.error) throw new Error(byStart.error.message);
  const match = (byStart.data ?? []).find((row) => {
    const marketStart = asString(row.market_start_at);
    if (marketStart && Date.parse(marketStart) === startSec * 1000) return true;
    const eventSlug = asString(row.event_slug);
    return eventSlug === slug;
  });
  return match ? mapTick(match) : null;
}

function mapTick(row: Record<string, unknown>): PolymarketTick {
  return {
    event_slug: asString(row.event_slug),
    question: asString(row.question),
    up_token_id: asString(row.up_token_id),
    down_token_id: asString(row.down_token_id),
    up_price: asNumber(row.up_price),
    down_price: asNumber(row.down_price),
    price_to_beat: asNumber(row.price_to_beat),
    spot_price: asNumber(row.spot_price),
    recorded_at: asString(row.recorded_at) || new Date().toISOString(),
    market_start_at: asString(row.market_start_at),
    market_end_at: asString(row.market_end_at),
  };
}

async function loadEventPriceToBeat(
  supabase: SupabaseClient,
  startSec: number,
): Promise<number | null> {
  const slug = marketSlugForStart(startSec);
  const { data, error } = await supabase
    .from("polymarket_events")
    .select("price_to_beat")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return asNumber(data?.price_to_beat);
}

/**
 * Canonical strike: prefer polymarket_events.price_to_beat (stable), then the
 * first tick that actually has price_to_beat (early ticks are often null).
 */
async function loadPriceToBeat(
  supabase: SupabaseClient,
  startSec: number,
  tick: PolymarketTick | null,
): Promise<number | null> {
  const fromEvent = await loadEventPriceToBeat(supabase, startSec);
  if (fromEvent !== null) return fromEvent;
  if (tick?.price_to_beat !== null && tick?.price_to_beat !== undefined) {
    return tick.price_to_beat;
  }

  const slug = marketSlugForStart(startSec);
  const { data, error } = await supabase
    .from("polymarket_ticks")
    .select("price_to_beat")
    .eq("event_slug", slug)
    .not("price_to_beat", "is", null)
    .order("recorded_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return asNumber(data?.price_to_beat);
}

function renderDays(container: HTMLElement, days: DayGroup[], rangeLabel: string) {
  if (days.length === 0) {
    container.innerHTML =
      `<p class="xa-muted">No closed 4h periods with a crypto_price signal for ${escapeHtml(rangeLabel)}.</p>`;
    return;
  }

  container.innerHTML = days
    .map(
      (day) => `
      <section class="xa-vt__day" data-date="${escapeHtml(day.dateKey)}">
        <h2 class="xa-vt__day-title">${escapeHtml(day.dateLabel)}</h2>
        <ul class="xa-vt__periods">
          ${day.periods
            .map(
              (period) => `
            <li class="xa-vt__period">
              <label class="xa-vt__period-label">
                <input
                  type="checkbox"
                  class="xa-vt__period-check"
                  data-start-sec="${period.startSec}"
                />
                <span class="xa-vt__period-text">${escapeHtml(period.label)}</span>
                <span class="xa-vt__period-signal">${escapeHtml(period.cryptoPrice.signal)}</span>
              </label>
              <span class="xa-vt__period-status" data-status-for="${period.startSec}" aria-live="polite"></span>
            </li>`,
            )
            .join("")}
        </ul>
      </section>`,
    )
    .join("");
}

async function markAlreadyPlaced(
  supabase: SupabaseClient,
  daysEl: HTMLElement,
  periods: Iterable<FourHourPeriod>,
) {
  const startSecs = [...periods].map((p) => p.startSec);
  if (startSecs.length === 0) return;

  const slugs = startSecs.map((sec) => marketSlugForStart(sec));
  const { data, error } = await supabase
    .from("virtual_trades")
    .select("market_slug")
    .in("market_slug", slugs);
  if (error) return;

  const placed = new Set(
    (data ?? [])
      .map((row) => asString(row.market_slug))
      .filter((slug): slug is string => Boolean(slug)),
  );
  for (const slug of placed) {
    const match = /^btc-updown-4h-(\d+)$/.exec(slug);
    if (!match) continue;
    const startSec = Number(match[1]);
    const box = daysEl.querySelector<HTMLInputElement>(
      `.xa-vt__period-check[data-start-sec="${startSec}"]`,
    );
    const statusFor = daysEl.querySelector<HTMLElement>(
      `[data-status-for="${startSec}"]`,
    );
    if (box) {
      box.checked = true;
      box.disabled = true;
    }
    if (statusFor) statusFor.textContent = "Already placed";
  }
}

function renderPreview(
  el: HTMLElement,
  period: FourHourPeriod,
  tick: PolymarketTick | null,
  priceToBeat: number | null,
) {
  const title = formatPolymarketTitle(period.startSec, period.endSec);
  const cryptoAt = formatCryptoPriceAt(period.cryptoPrice.bucket_start);
  const strike = priceToBeat;
  const spot = tick?.spot_price;

  el.hidden = false;
  el.innerHTML = `
    <p class="xa-vt__preview-title">Selected window</p>
    <dl class="xa-vt__preview-grid">
      <div><dt>Polymarket</dt><dd>${escapeHtml(title)}</dd></div>
      <div><dt>crypto_price</dt><dd>${escapeHtml(cryptoAt)}</dd></div>
      <div><dt>Signal</dt><dd>${escapeHtml(period.cryptoPrice.signal)}</dd></div>
      <div><dt>Price level</dt><dd>${period.cryptoPrice.price_level == null ? "—" : escapeHtml(period.cryptoPrice.price_level.toLocaleString(undefined, { maximumFractionDigits: 2 }))}</dd></div>
      <div><dt>Price to beat</dt><dd>${strike == null ? "—" : escapeHtml(strike.toLocaleString(undefined, { style: "currency", currency: "USD" }))}</dd></div>
      <div><dt>Entry spot</dt><dd>${spot == null ? "Waiting for tick / missing" : escapeHtml(spot.toLocaleString(undefined, { style: "currency", currency: "USD" }))}</dd></div>
      <div><dt>Entry tick</dt><dd>${tick ? escapeHtml(new Date(tick.recorded_at).toISOString()) : "No Polymarket tick found for this window"}</dd></div>
      <div><dt>Market slug</dt><dd><code>${escapeHtml(marketSlugForStart(period.startSec))}</code></dd></div>
    </dl>
  `;
}

async function placeVirtualTrade(
  supabase: SupabaseClient,
  period: FourHourPeriod,
): Promise<{ id: number; message: string }> {
  const direction = directionFromSignal(period.cryptoPrice.signal);
  if (!direction) {
    throw new Error(`Unsupported signal "${period.cryptoPrice.signal}". Expected Above or Below.`);
  }
  if (period.cryptoPrice.price_level === null) {
    throw new Error("crypto_price.price_level is missing for this period.");
  }

  const tick = await loadEntryTick(supabase, period.startSec);
  if (!tick) {
    throw new Error(
      `No Polymarket tick found at/after ${period.startIso} for ${marketSlugForStart(period.startSec)}.`,
    );
  }

  const priceToBeat = await loadPriceToBeat(supabase, period.startSec, tick);
  if (priceToBeat === null) {
    throw new Error("Polymarket price_to_beat is missing for this window.");
  }
  if (tick.spot_price === null) {
    throw new Error("Polymarket spot_price is missing on the entry tick.");
  }

  const entryPolyPrice = direction === "LONG_UP" ? tick.up_price : tick.down_price;
  if (entryPolyPrice === null) {
    throw new Error(`Polymarket ${direction === "LONG_UP" ? "up" : "down"} price is missing.`);
  }

  const tokenId =
    direction === "LONG_UP" ? tick.up_token_id : tick.down_token_id;
  if (!tokenId) {
    throw new Error("Polymarket token_id is missing on the entry tick.");
  }

  const marketTitle = formatPolymarketTitle(period.startSec, period.endSec);
  const slug = marketSlugForStart(period.startSec);

  const payload = {
    timestamp: tick.recorded_at,
    market_slug: slug,
    market_title: marketTitle,
    token_id: tokenId,
    direction,
    entry_poly_price: Number(entryPolyPrice.toFixed(4)),
    entry_spot_price: Number(tick.spot_price.toFixed(2)),
    strike_price: Number(priceToBeat.toFixed(2)),
    price_to_beat: Number(priceToBeat.toFixed(6)),
    price_level: period.cryptoPrice.price_level,
    crypto_price_at: period.cryptoPrice.bucket_start,
    xyrra_confidence: confidenceFromEma(period.cryptoPrice.ema),
    signal_state: period.cryptoPrice.signal,
    position_size_usd: DEFAULT_POSITION_USD,
    status: "OPEN",
  };

  const { data, error } = await supabase
    .from("virtual_trades")
    .insert(payload)
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new Error(`A virtual trade already exists for ${slug}.`);
    }
    throw new Error(error.message);
  }

  const id = asNumber(data?.id);
  if (id === null) throw new Error("Insert succeeded but no trade id was returned.");

  return {
    id,
    message: `Placed trade #${id}: ${marketTitle}`,
  };
}

async function init() {
  const adminSession = await requireAdminSession();
  if (!adminSession) return;

  initAdminShell(adminSession, "virtual-trades");
  setAdminLoading(false);

  const daysRoot = document.getElementById("xa-vt-create-days");
  const statusRoot = document.getElementById("xa-vt-create-status");
  const previewRoot = document.getElementById("xa-vt-create-preview");
  const placeTradeBtn = document.getElementById("xa-vt-place-trade") as HTMLButtonElement | null;
  const pagerRoot = document.getElementById("xa-vt-create-pager");
  const pagerLabel = document.getElementById("xa-vt-pager-label");
  const earlierWeekBtn = document.getElementById("xa-vt-earlier") as HTMLButtonElement | null;
  const laterWeekBtn = document.getElementById("xa-vt-later") as HTMLButtonElement | null;
  if (
    !daysRoot ||
    !statusRoot ||
    !previewRoot ||
    !placeTradeBtn ||
    !pagerRoot ||
    !pagerLabel ||
    !earlierWeekBtn ||
    !laterWeekBtn
  ) {
    return;
  }

  const daysEl = daysRoot;
  const statusEl = statusRoot;
  const previewEl = previewRoot;
  const placeBtn = placeTradeBtn;
  const pagerEl = pagerRoot;
  const pagerLabelEl = pagerLabel;
  const earlierBtn = earlierWeekBtn;
  const laterBtn = laterWeekBtn;
  const supabase = adminSession.supabase;

  const periodByStart = new Map<number, FourHourPeriod>();
  let selectedStartSec: number | null = null;
  let placing = false;
  let weekOffset = 0;
  let loadingPage = false;
  let earliestSignalMs: number | null = null;
  let assetId: number | null = null;

  function setPlaceTradeActive(active: boolean) {
    placeBtn.disabled = !active || placing;
    placeBtn.classList.toggle("xa-vt__place-trade--active", active && !placing);
  }

  function clearSelectionUi() {
    selectedStartSec = null;
    setPlaceTradeActive(false);
    previewEl.hidden = true;
    previewEl.innerHTML = "";
  }

  function hasEarlierThan(fromIso: string) {
    const fromMs = Date.parse(fromIso);
    return earliestSignalMs !== null && Number.isFinite(fromMs) && earliestSignalMs < fromMs;
  }

  function updatePager(offset: number, range: ReturnType<typeof pageRange>, busy: boolean) {
    pagerEl.hidden = false;
    pagerLabelEl.textContent = range.label;
    laterBtn.disabled = busy || offset === 0;
    earlierBtn.disabled = busy || !hasEarlierThan(range.fromIso);
  }

  async function loadEarliestSignalMs(id: number): Promise<number | null> {
    const { data, error } = await supabase
      .from("crypto_price")
      .select("bucket_start")
      .eq("asset_id", id)
      .eq("timeframe", ANALYSIS_TIMEFRAME)
      .not("signal", "is", null)
      .neq("signal", "")
      .order("bucket_start", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const bucket = asString(data?.bucket_start);
    if (!bucket) return null;
    const ms = Date.parse(bucket);
    return Number.isFinite(ms) ? ms : null;
  }

  async function loadWeek(nextOffset: number) {
    if (loadingPage) return;
    loadingPage = true;
    clearSelectionUi();
    periodByStart.clear();
    statusEl.classList.remove("xa-users__status--error");
    statusEl.textContent = "Loading periods with crypto_price signals…";

    const pendingRange = pageRange(nextOffset);
    updatePager(nextOffset, pendingRange, true);

    try {
      if (assetId === null) {
        assetId = await loadBtcAssetId(supabase);
        earliestSignalMs = await loadEarliestSignalMs(assetId);
      }

      const range = pageRange(nextOffset);
      const signaled = await loadSignaledCryptoPrices(
        supabase,
        assetId,
        range.fromIso,
        range.beforeIso,
      );
      const days = groupSignaledPeriods(signaled, range.closedEndSec);
      for (const day of days) {
        for (const period of day.periods) {
          periodByStart.set(period.startSec, period);
        }
      }

      weekOffset = nextOffset;
      renderDays(daysEl, days, range.label);
      await markAlreadyPlaced(supabase, daysEl, periodByStart.values());

      statusEl.textContent =
        days.length === 0
          ? `No closed 4h periods with a crypto_price signal for ${range.label}.`
          : `Select a signaled 4h period, then click Place Trade.`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unable to load crypto_price signals.";
      statusEl.textContent = msg;
      statusEl.classList.add("xa-users__status--error");
      daysEl.innerHTML = "";
    } finally {
      loadingPage = false;
      updatePager(weekOffset, pageRange(weekOffset), false);
    }
  }

  earlierBtn.addEventListener("click", () => {
    void loadWeek(weekOffset + 1);
  });
  laterBtn.addEventListener("click", () => {
    if (weekOffset === 0) return;
    void loadWeek(weekOffset - 1);
  });

  await loadWeek(0);

  daysEl.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") return;

    const startSec = Number(target.dataset.startSec);
    if (!Number.isFinite(startSec)) return;

    if (!target.checked) {
      if (selectedStartSec === startSec) clearSelectionUi();
      return;
    }

    // Single-select: uncheck others.
    daysEl.querySelectorAll<HTMLInputElement>(".xa-vt__period-check").forEach((box) => {
      if (box !== target) box.checked = false;
    });

    const period = periodByStart.get(startSec);
    if (!period) {
      target.checked = false;
      clearSelectionUi();
      return;
    }

    selectedStartSec = startSec;
    setPlaceTradeActive(true);
    statusEl.classList.remove("xa-users__status--error");
    statusEl.textContent = `Selected ${period.label}. Review details, then Place Trade.`;

    void (async () => {
      try {
        const tick = await loadEntryTick(supabase, period.startSec);
        const priceToBeat = await loadPriceToBeat(supabase, period.startSec, tick);
        if (selectedStartSec === startSec) {
          renderPreview(previewEl, period, tick, priceToBeat);
        }
      } catch (error) {
        if (selectedStartSec !== startSec) return;
        const msg = error instanceof Error ? error.message : "Unable to load Polymarket entry tick.";
        previewEl.hidden = false;
        previewEl.innerHTML = `<p class="xa-users__status xa-users__status--error">${escapeHtml(msg)}</p>`;
      }
    })();
  });

  placeBtn.addEventListener("click", () => {
    void (async () => {
      if (placing || selectedStartSec === null) return;
      const period = periodByStart.get(selectedStartSec);
      if (!period) return;

      placing = true;
      setPlaceTradeActive(true);
      placeBtn.textContent = "Placing…";
      statusEl.classList.remove("xa-users__status--error");
      statusEl.textContent = `Placing virtual trade for ${period.label}…`;

      const statusFor = daysEl.querySelector<HTMLElement>(
        `[data-status-for="${period.startSec}"]`,
      );

      try {
        const result = await placeVirtualTrade(supabase, period);
        if (statusFor) statusFor.textContent = `Placed #${result.id}`;
        statusEl.textContent = result.message;
        const checked = daysEl.querySelector<HTMLInputElement>(
          `.xa-vt__period-check[data-start-sec="${period.startSec}"]`,
        );
        if (checked) {
          checked.disabled = true;
          checked.checked = true;
        }
        selectedStartSec = null;
        previewEl.hidden = true;
        previewEl.innerHTML = "";
        setPlaceTradeActive(false);
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unable to place virtual trade.";
        if (statusFor) statusFor.textContent = msg;
        statusEl.textContent = msg;
        statusEl.classList.add("xa-users__status--error");
      } finally {
        placing = false;
        placeBtn.textContent = "Place Trade";
        setPlaceTradeActive(selectedStartSec !== null);
      }
    })();
  });
}

void init();
