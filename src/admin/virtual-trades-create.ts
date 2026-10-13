import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";

const WINDOW_SEC = 4 * 60 * 60;
const LOOKBACK_DAYS = 7;
const ANALYSIS_TIMEFRAME = 240;
const BTC_SYMBOL = "BTC";
const DEFAULT_POSITION_USD = 100;

type CryptoPriceSignalRow = {
  bucket_start: string;
  signal: string;
  price_level: number | null;
  price_1m: number | null;
  ema: number | null;
  momentum: number | null;
};

type FourHourPeriod = {
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

function lookbackStartIso(nowMs = Date.now()) {
  const startMs = Date.UTC(
    new Date(nowMs).getUTCFullYear(),
    new Date(nowMs).getUTCMonth(),
    new Date(nowMs).getUTCDate() - (LOOKBACK_DAYS - 1),
  );
  return new Date(startMs).toISOString();
}

function currentClosedWindowEndSec(nowMs = Date.now()) {
  const nowSec = Math.floor(nowMs / 1000);
  return Math.floor(nowSec / WINDOW_SEC) * WINDOW_SEC;
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

function groupSignaledPeriods(rows: CryptoPriceSignalRow[]): DayGroup[] {
  const byDay = new Map<string, FourHourPeriod[]>();

  for (const cryptoPrice of rows) {
    const startMs = Date.parse(cryptoPrice.bucket_start);
    if (!Number.isFinite(startMs)) continue;
    const startSec = Math.floor(startMs / 1000);
    // Align to canonical 4h unix starts used by Polymarket slugs.
    if (startSec % WINDOW_SEC !== 0) continue;

    const period: FourHourPeriod = {
      startSec,
      endSec: startSec + WINDOW_SEC,
      startIso: new Date(startSec * 1000).toISOString(),
      endIso: new Date((startSec + WINDOW_SEC) * 1000).toISOString(),
      label: `${formatUtcTime(startSec)}–${formatUtcTime(startSec + WINDOW_SEC)} UTC`,
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

function renderDays(container: HTMLElement, days: DayGroup[]) {
  if (days.length === 0) {
    container.innerHTML =
      `<p class="xa-muted">No closed 4h periods with a crypto_price signal in the last ${LOOKBACK_DAYS} UTC days.</p>`;
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

function renderPreview(
  el: HTMLElement,
  period: FourHourPeriod,
  tick: PolymarketTick | null,
  priceToBeat: number | null,
) {
  const title = formatPolymarketTitle(period.startSec, period.endSec);
  const cryptoAt = formatCryptoPriceAt(period.cryptoPrice.bucket_start);
  const strike = priceToBeat ?? tick?.price_to_beat;
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

  const priceToBeat =
    tick.price_to_beat ?? (await loadEventPriceToBeat(supabase, period.startSec));
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
  const session = await requireAdminSession();
  if (!session) return;

  initAdminShell(session, "virtual-trades");
  setAdminLoading(false);

  const daysEl = document.getElementById("xa-vt-create-days");
  const statusEl = document.getElementById("xa-vt-create-status");
  const previewEl = document.getElementById("xa-vt-create-preview");
  const placeBtn = document.getElementById("xa-vt-place-trade") as HTMLButtonElement | null;
  if (!daysEl || !statusEl || !previewEl || !placeBtn) return;

  const periodByStart = new Map<number, FourHourPeriod>();
  let selectedStartSec: number | null = null;
  let placing = false;

  function setPlaceTradeActive(active: boolean) {
    placeBtn!.disabled = !active || placing;
    placeBtn!.classList.toggle("xa-vt__place-trade--active", active && !placing);
  }

  function clearSelectionUi() {
    selectedStartSec = null;
    setPlaceTradeActive(false);
    previewEl!.hidden = true;
    previewEl!.innerHTML = "";
  }

  statusEl.textContent = "Loading periods with crypto_price signals…";

  try {
    const closedEndSec = currentClosedWindowEndSec();
    const fromIso = lookbackStartIso();
    const beforeIso = new Date(closedEndSec * 1000).toISOString();
    const assetId = await loadBtcAssetId(session.supabase);
    const signaled = await loadSignaledCryptoPrices(
      session.supabase,
      assetId,
      fromIso,
      beforeIso,
    );
    const days = groupSignaledPeriods(signaled);
    for (const day of days) {
      for (const period of day.periods) {
        periodByStart.set(period.startSec, period);
      }
    }
    renderDays(daysEl, days);

    const existingSlugs = await session.supabase
      .from("virtual_trades")
      .select("market_slug")
      .like("market_slug", "btc-updown-4h-%");
    if (!existingSlugs.error) {
      const placed = new Set(
        (existingSlugs.data ?? [])
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

    statusEl.textContent =
      days.length === 0
        ? `No closed 4h periods with a crypto_price signal in the last ${LOOKBACK_DAYS} UTC days.`
        : `Select a signaled 4h period, then click Place Trade.`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unable to load crypto_price signals.";
    statusEl.textContent = msg;
    statusEl.classList.add("xa-users__status--error");
    daysEl.innerHTML = "";
    return;
  }

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
        const tick = await loadEntryTick(session.supabase, period.startSec);
        const priceToBeat =
          tick?.price_to_beat ?? (await loadEventPriceToBeat(session.supabase, period.startSec));
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
        const result = await placeVirtualTrade(session.supabase, period);
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
