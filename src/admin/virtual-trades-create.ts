import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";

const WINDOW_SEC = 4 * 60 * 60;
/** How many UTC calendar days to list (including today). */
const LOOKBACK_DAYS = 7;

type FourHourPeriod = {
  startSec: number;
  endSec: number;
  startIso: string;
  endIso: string;
  label: string;
};

type DayGroup = {
  dateKey: string;
  dateLabel: string;
  periods: FourHourPeriod[];
};

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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

function utcDateKey(sec: number) {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

/** Closed 4h windows aligned to Polymarket btc-updown-4h-{unix} starts. */
function buildPassedFourHourDays(nowMs = Date.now()): DayGroup[] {
  const nowSec = Math.floor(nowMs / 1000);
  const currentStart = Math.floor(nowSec / WINDOW_SEC) * WINDOW_SEC;
  // Last fully closed window ends at currentStart.
  let endSec = currentStart;
  if (endSec <= 0) return [];

  const earliestDayStart =
    Date.UTC(
      new Date(nowMs).getUTCFullYear(),
      new Date(nowMs).getUTCMonth(),
      new Date(nowMs).getUTCDate() - (LOOKBACK_DAYS - 1),
    ) / 1000;

  const byDay = new Map<string, FourHourPeriod[]>();

  for (let end = endSec; end - WINDOW_SEC >= earliestDayStart; end -= WINDOW_SEC) {
    const start = end - WINDOW_SEC;
    if (start < earliestDayStart) break;

    const period: FourHourPeriod = {
      startSec: start,
      endSec: end,
      startIso: new Date(start * 1000).toISOString(),
      endIso: new Date(end * 1000).toISOString(),
      label: `${formatUtcTime(start)}–${formatUtcTime(end)} UTC`,
    };

    const key = utcDateKey(start);
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

/**
 * Placeholder until trade-run details are provided.
 * Selecting a 4h checkbox calls this with the period start (unix seconds / ISO).
 */
async function runVirtualTrade(period: FourHourPeriod): Promise<string> {
  // Hook for the next prompt: implement actual virtual-trade logic here.
  return `Selected ${period.label} (start ${period.startIso}). Trade logic will run in the next step.`;
}

function renderDays(container: HTMLElement, days: DayGroup[]) {
  if (days.length === 0) {
    container.innerHTML = `<p class="xa-muted">No closed 4h periods in the lookback window.</p>`;
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
                  data-start-iso="${escapeHtml(period.startIso)}"
                  data-end-iso="${escapeHtml(period.endIso)}"
                  data-label="${escapeHtml(period.label)}"
                />
                <span class="xa-vt__period-text">${escapeHtml(period.label)}</span>
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

async function init() {
  const session = await requireAdminSession();
  if (!session) return;

  initAdminShell(session, "virtual-trades");
  setAdminLoading(false);

  const daysEl = document.getElementById("xa-vt-create-days");
  const statusEl = document.getElementById("xa-vt-create-status");
  if (!daysEl || !statusEl) return;

  const days = buildPassedFourHourDays();
  renderDays(daysEl, days);
  statusEl.textContent = `Showing closed 4h periods for the last ${LOOKBACK_DAYS} UTC days.`;

  const running = new Set<number>();

  daysEl.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") return;
    if (!target.checked) return;

    const startSec = Number(target.dataset.startSec);
    const startIso = target.dataset.startIso || "";
    const endIso = target.dataset.endIso || "";
    const label = target.dataset.label || "";
    if (!Number.isFinite(startSec) || !startIso) return;

    const statusFor = daysEl.querySelector<HTMLElement>(
      `[data-status-for="${startSec}"]`,
    );

    void (async () => {
      if (running.has(startSec)) return;
      running.add(startSec);
      target.disabled = true;
      if (statusFor) statusFor.textContent = "Running…";
      statusEl.textContent = `Running virtual trade for ${label}…`;
      statusEl.classList.remove("xa-users__status--error");

      try {
        const message = await runVirtualTrade({
          startSec,
          endSec: startSec + WINDOW_SEC,
          startIso,
          endIso,
          label,
        });
        if (statusFor) statusFor.textContent = message;
        statusEl.textContent = message;
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Virtual trade failed.";
        if (statusFor) statusFor.textContent = msg;
        statusEl.textContent = msg;
        statusEl.classList.add("xa-users__status--error");
        target.checked = false;
        target.disabled = false;
      } finally {
        running.delete(startSec);
      }
    })();
  });
}

void init();
