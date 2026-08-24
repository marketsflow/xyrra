import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";
import {
  formatSentEmailDateKeyLabel,
  formatSentEmailDayLabel,
  sentEmailDateKeyWithOffset,
  toSentEmailDateKey,
} from "../lib/email/sent-email-dates";

type EventType = "opened" | "clicked" | "delivered" | "bounced" | "complained";

type SentEmailEvent = {
  id: string;
  eventType: EventType;
  linkUrl: string | null;
  userAgent: string | null;
  occurredAt: string;
};

type SentEmailRow = {
  id: string;
  recipientName: string | null;
  recipientEmail: string;
  subject: string;
  fromEmail: string;
  templateName: string | null;
  listName: string | null;
  sentAt: string;
  deliveryStatus: string;
  error: string | null;
  openCount: number;
  clickCount: number;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  firstClickedAt: string | null;
  lastClickedAt: string | null;
  events: SentEmailEvent[];
};

type DaySummary = {
  dateKey: string;
  emailCount: number;
  totalOpens: number;
  totalClicks: number;
};

type DaySortField = "sentAt" | "views" | "clicks";
type SortDirection = "asc" | "desc";
type DaySort = { field: DaySortField; direction: SortDirection };
type DatePreset = "all" | "today" | "yesterday" | "last7";

const EMAIL_PAGE_SIZE = 1000;
const EVENT_ID_BATCH_SIZE = 100;
const DEFAULT_DAY_SORT: DaySort = { field: "sentAt", direction: "desc" };

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function deliveryStatusLabel(status: string) {
  switch (status) {
    case "delivered":
      return "Delivered";
    case "bounced":
      return "Bounced";
    case "complained":
      return "Spam complaint";
    case "failed":
      return "Failed";
    case "sent":
      return "Sent";
    default:
      return status;
  }
}

function deliveryStatusClass(status: string) {
  switch (status) {
    case "delivered":
      return "xa-sent__badge--delivered";
    case "bounced":
    case "failed":
      return "xa-sent__badge--failed";
    case "complained":
      return "xa-sent__badge--complained";
    default:
      return "xa-sent__badge--sent";
  }
}

function eventLabel(eventType: EventType) {
  switch (eventType) {
    case "opened":
      return "Opened";
    case "clicked":
      return "Clicked";
    case "delivered":
      return "Delivered";
    case "bounced":
      return "Bounced";
    case "complained":
      return "Spam complaint";
    default:
      return eventType;
  }
}

function getPresetRange(preset: DatePreset): { fromDate: string; toDate: string } {
  switch (preset) {
    case "today":
      return { fromDate: sentEmailDateKeyWithOffset(0), toDate: sentEmailDateKeyWithOffset(0) };
    case "yesterday":
      return { fromDate: sentEmailDateKeyWithOffset(-1), toDate: sentEmailDateKeyWithOffset(-1) };
    case "last7":
      return { fromDate: sentEmailDateKeyWithOffset(-6), toDate: sentEmailDateKeyWithOffset(0) };
    case "all":
    default:
      return { fromDate: "", toDate: "" };
  }
}

function detectActivePreset(fromDate: string, toDate: string): DatePreset | null {
  for (const preset of ["all", "today", "yesterday", "last7"] as const) {
    const range = getPresetRange(preset);
    if (range.fromDate === fromDate && range.toDate === toDate) {
      return preset;
    }
  }
  return null;
}

function filterRowsByDateRange(rows: SentEmailRow[], fromDate: string, toDate: string) {
  return rows.filter((row) => {
    const dateKey = toSentEmailDateKey(row.sentAt);
    if (fromDate && dateKey < fromDate) return false;
    if (toDate && dateKey > toDate) return false;
    return true;
  });
}

function sortDayRows(rows: SentEmailRow[], sort: DaySort) {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    let comparison = 0;
    switch (sort.field) {
      case "views":
        comparison = a.openCount - b.openCount;
        break;
      case "clicks":
        comparison = a.clickCount - b.clickCount;
        break;
      case "sentAt":
      default:
        comparison = new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime();
        break;
    }
    if (comparison === 0) {
      comparison = new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime();
    }
    return sort.direction === "asc" ? comparison : -comparison;
  });
  return sorted;
}

function buildDaySummaries(rows: SentEmailRow[]): DaySummary[] {
  const byDay = new Map<string, DaySummary>();
  for (const row of rows) {
    const dateKey = toSentEmailDateKey(row.sentAt);
    const existing = byDay.get(dateKey) ?? { dateKey, emailCount: 0, totalOpens: 0, totalClicks: 0 };
    existing.emailCount += 1;
    existing.totalOpens += row.openCount;
    existing.totalClicks += row.clickCount;
    byDay.set(dateKey, existing);
  }
  return [...byDay.values()].sort((a, b) => b.dateKey.localeCompare(a.dateKey));
}

function sortIcon(active: boolean, direction: SortDirection) {
  if (!active) return "↕";
  return direction === "asc" ? "↑" : "↓";
}

async function init() {
  const session = await requireAdminSession();
  if (!session) return;

  initAdminShell(session, "emails-sent");
  setAdminLoading(false);

  const errorEl = document.getElementById("xa-sent-error");
  const emptyEl = document.getElementById("xa-sent-empty");
  const contentEl = document.getElementById("xa-sent-content");
  const countLabelEl = document.getElementById("xa-sent-count-label");
  const clearBtn = document.getElementById("xa-sent-clear");
  const fromInput = document.getElementById("xa-sent-from") as HTMLInputElement | null;
  const toInput = document.getElementById("xa-sent-to") as HTMLInputElement | null;
  const dateChipsWrap = document.getElementById("xa-sent-date-chips");
  const dateChipList = document.getElementById("xa-sent-date-chip-list");
  const statsEl = document.getElementById("xa-sent-stats");
  const noMatchEl = document.getElementById("xa-sent-no-match");
  const noMatchHintEl = document.getElementById("xa-sent-no-match-hint");
  const showAllBtn = document.getElementById("xa-sent-show-all");
  const daysEl = document.getElementById("xa-sent-days");

  if (!fromInput || !toInput || !statsEl || !daysEl) return;

  const fromField = fromInput;
  const toField = toInput;
  const stats = statsEl;
  const days = daysEl;

  let rows: SentEmailRow[] = [];
  let daySummaries: DaySummary[] = [];
  let fromDate = "";
  let toDate = "";
  let expandedId: string | null = null;
  const daySorts: Record<string, DaySort> = {};

  function setError(message: string) {
    if (errorEl) errorEl.textContent = message;
  }

  function applyPreset(preset: DatePreset) {
    const range = getPresetRange(preset);
    fromDate = range.fromDate;
    toDate = range.toDate;
    fromField.value = fromDate;
    toField.value = toDate;
    render();
  }

  function clearDates() {
    applyPreset("all");
  }

  function toggleDaySort(dateKey: string, field: "views" | "clicks") {
    const existing = daySorts[dateKey] ?? DEFAULT_DAY_SORT;
    if (existing.field === field) {
      daySorts[dateKey] = { field, direction: existing.direction === "asc" ? "desc" : "asc" };
    } else {
      daySorts[dateKey] = { field, direction: "desc" };
    }
    render();
  }

  function renderRow(row: SentEmailRow) {
    const isExpanded = expandedId === row.id;
    const name = row.recipientName?.trim() || row.recipientEmail;
    const eventsHtml =
      row.events.length === 0
        ? `<p class="xa-sent__muted">No opens or clicks recorded yet. Enable open/click tracking and the Resend webhook for your sending domain.</p>`
        : `<ul class="xa-sent__events">${row.events
            .map(
              (event) => `
                <li>
                  <div class="xa-sent__event-top">
                    <strong>${escapeHtml(eventLabel(event.eventType))}</strong>
                    <span>${escapeHtml(formatDateTime(event.occurredAt))}</span>
                  </div>
                  ${
                    event.linkUrl
                      ? `<p class="xa-sent__event-link">Link: <a href="${escapeHtml(event.linkUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(event.linkUrl)}</a></p>`
                      : ""
                  }
                  ${event.userAgent ? `<p class="xa-sent__muted">${escapeHtml(event.userAgent)}</p>` : ""}
                </li>
              `,
            )
            .join("")}</ul>`;

    return `
      <li>
        <button type="button" class="xa-sent__row" data-sent-id="${escapeHtml(row.id)}">
          <span class="xa-sent__row-main">
            <span class="xa-sent__row-title">
              <span>${escapeHtml(name)}</span>
              <span class="xa-sent__badge ${deliveryStatusClass(row.deliveryStatus)}">${escapeHtml(deliveryStatusLabel(row.deliveryStatus))}</span>
            </span>
            <span class="xa-sent__row-subject">${escapeHtml(row.subject)}</span>
            ${row.templateName ? `<span class="xa-sent__row-meta">Template: ${escapeHtml(row.templateName)}</span>` : ""}
            ${row.listName ? `<span class="xa-sent__row-meta">List: ${escapeHtml(row.listName)}</span>` : ""}
            ${row.fromEmail ? `<span class="xa-sent__row-meta">From: ${escapeHtml(row.fromEmail)}</span>` : ""}
            ${row.error ? `<span class="xa-sent__row-meta xa-sent__row-meta--error">${escapeHtml(row.error)}</span>` : ""}
          </span>
          <span class="xa-sent__row-recipients">${escapeHtml(row.recipientEmail)}</span>
          <span class="xa-sent__metric"><span class="xa-sent__metric-label">Views</span> ${row.openCount}</span>
          <span class="xa-sent__metric"><span class="xa-sent__metric-label">Clicks</span> ${row.clickCount}</span>
          <span class="xa-sent__row-sent">
            <span>${escapeHtml(formatDateTime(row.sentAt))}</span>
            <span class="xa-sent__chevron${isExpanded ? " xa-sent__chevron--open" : ""}" aria-hidden="true">▾</span>
          </span>
        </button>
        ${
          isExpanded
            ? `
              <div class="xa-sent__detail">
                <dl class="xa-sent__dl">
                  <div><dt>First opened</dt><dd>${escapeHtml(formatDateTime(row.firstOpenedAt))}</dd></div>
                  <div><dt>Last opened</dt><dd>${escapeHtml(formatDateTime(row.lastOpenedAt))}</dd></div>
                  <div><dt>First clicked</dt><dd>${escapeHtml(formatDateTime(row.firstClickedAt))}</dd></div>
                  <div><dt>Last clicked</dt><dd>${escapeHtml(formatDateTime(row.lastClickedAt))}</dd></div>
                </dl>
                <p class="xa-sent__card-hint xa-sent__card-hint--caps">Activity log</p>
                ${eventsHtml}
              </div>
            `
            : ""
        }
      </li>
    `;
  }

  function render() {
    const filteredRows = filterRowsByDateRange(rows, fromDate, toDate);
    const filteredDaySummaries = daySummaries.filter((summary) => {
      if (fromDate && summary.dateKey < fromDate) return false;
      if (toDate && summary.dateKey > toDate) return false;
      return true;
    });
    const hasDateFilter = Boolean(fromDate || toDate);
    const activePreset = detectActivePreset(fromDate, toDate);
    const totalOpens = filteredRows.reduce((sum, row) => sum + row.openCount, 0);
    const totalClicks = filteredRows.reduce((sum, row) => sum + row.clickCount, 0);
    const openedEmails = filteredRows.filter((row) => row.openCount > 0).length;
    const clickedEmails = filteredRows.filter((row) => row.clickCount > 0).length;

    if (countLabelEl) {
      countLabelEl.textContent = `${filteredRows.length} of ${rows.length} logged email${rows.length === 1 ? "" : "s"} shown${
        filteredDaySummaries.length > 0
          ? ` across ${filteredDaySummaries.length} day${filteredDaySummaries.length === 1 ? "" : "s"}`
          : ""
      }`;
    }

    clearBtn?.toggleAttribute("hidden", !hasDateFilter);

    document.querySelectorAll<HTMLButtonElement>("[data-xa-preset]").forEach((button) => {
      button.classList.toggle("xa-sent__chip--active", button.dataset.xaPreset === activePreset);
    });

    fromField.value = fromDate;
    toField.value = toDate;
    fromField.max = toDate || "";
    toField.min = fromDate || "";

    if (dateChipsWrap && dateChipList) {
      dateChipsWrap.hidden = daySummaries.length === 0;
      dateChipList.innerHTML = daySummaries
        .map((summary) => {
          const isActive = fromDate === summary.dateKey && toDate === summary.dateKey;
          return `
            <button type="button" class="xa-sent__chip${isActive ? " xa-sent__chip--active" : ""}" data-xa-date-key="${escapeHtml(summary.dateKey)}">
              ${escapeHtml(formatSentEmailDateKeyLabel(summary.dateKey))} (${summary.emailCount})
            </button>
          `;
        })
        .join("");
      dateChipList.querySelectorAll<HTMLButtonElement>("[data-xa-date-key]").forEach((button) => {
        button.addEventListener("click", () => {
          const dateKey = button.dataset.xaDateKey;
          if (!dateKey) return;
          fromDate = dateKey;
          toDate = dateKey;
          render();
        });
      });
    }

    stats.innerHTML = `
      <div class="xa-sent__stat">
        <p>Sent emails</p>
        <strong>${filteredRows.length}</strong>
      </div>
      <div class="xa-sent__stat">
        <p>Total views</p>
        <strong>${totalOpens}</strong>
        <span>${openedEmails} email${openedEmails === 1 ? "" : "s"} viewed at least once</span>
      </div>
      <div class="xa-sent__stat">
        <p>Total clicks</p>
        <strong>${totalClicks}</strong>
        <span>${clickedEmails} email${clickedEmails === 1 ? "" : "s"} clicked at least once</span>
      </div>
      <div class="xa-sent__stat xa-sent__stat--accent">
        <p>Tracking</p>
        <span>Views and clicks update automatically from Resend webhooks after delivery.</span>
      </div>
    `;

    if (filteredRows.length === 0) {
      days.innerHTML = "";
      noMatchEl?.removeAttribute("hidden");
      if (noMatchHintEl) {
        noMatchHintEl.textContent =
          rows.length > 0
            ? `Logged sends are available for ${daySummaries.map((summary) => formatSentEmailDateKeyLabel(summary.dateKey)).join(", ")}.`
            : "Try widening the date range or clear the filter.";
      }
      return;
    }

    noMatchEl?.setAttribute("hidden", "");

    const rowsByDay = new Map<string, SentEmailRow[]>();
    for (const row of filteredRows) {
      const dateKey = toSentEmailDateKey(row.sentAt);
      const bucket = rowsByDay.get(dateKey) ?? [];
      bucket.push(row);
      rowsByDay.set(dateKey, bucket);
    }

    const dayKeys =
      filteredDaySummaries.length > 0
        ? filteredDaySummaries.map((summary) => summary.dateKey)
        : [...rowsByDay.keys()].sort((a, b) => b.localeCompare(a));

    days.innerHTML = dayKeys
      .map((dateKey) => {
        const sort = daySorts[dateKey] ?? DEFAULT_DAY_SORT;
        const dayRows = sortDayRows(rowsByDay.get(dateKey) ?? [], sort);
        const summary = filteredDaySummaries.find((item) => item.dateKey === dateKey);
        const emailCount = summary?.emailCount ?? dayRows.length;
        const dayOpens = summary?.totalOpens ?? dayRows.reduce((sum, row) => sum + row.openCount, 0);
        const dayClicks = summary?.totalClicks ?? dayRows.reduce((sum, row) => sum + row.clickCount, 0);

        return `
          <section class="xa-sent__day">
            <div class="xa-sent__day-head">
              <div>
                <h2>${escapeHtml(formatSentEmailDayLabel(dateKey))}</h2>
                <p>${emailCount} email${emailCount === 1 ? "" : "s"} sent · ${dayOpens} views · ${dayClicks} clicks</p>
              </div>
              <div class="xa-sent__sorts">
                <span>Sort by</span>
                <button type="button" class="xa-sent__chip${sort.field === "views" ? " xa-sent__chip--active" : ""}" data-xa-sort-day="${escapeHtml(dateKey)}" data-xa-sort-field="views">
                  Views ${sortIcon(sort.field === "views", sort.direction)}
                </button>
                <button type="button" class="xa-sent__chip${sort.field === "clicks" ? " xa-sent__chip--active" : ""}" data-xa-sort-day="${escapeHtml(dateKey)}" data-xa-sort-field="clicks">
                  Clicks ${sortIcon(sort.field === "clicks", sort.direction)}
                </button>
              </div>
            </div>
            <div class="xa-sent__cols">
              <span>Email</span>
              <span>Recipient</span>
              <span>Views</span>
              <span>Clicks</span>
              <span>Sent</span>
            </div>
            <ul>${dayRows.map(renderRow).join("")}</ul>
          </section>
        `;
      })
      .join("");

    days.querySelectorAll<HTMLButtonElement>("[data-sent-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset.sentId;
        if (!id) return;
        expandedId = expandedId === id ? null : id;
        render();
      });
    });

    days.querySelectorAll<HTMLButtonElement>("[data-xa-sort-day]").forEach((button) => {
      button.addEventListener("click", () => {
        const dateKey = button.dataset.xaSortDay;
        const field = button.dataset.xaSortField;
        if (!dateKey || (field !== "views" && field !== "clicks")) return;
        toggleDaySort(dateKey, field);
      });
    });
  }

  document.querySelectorAll<HTMLButtonElement>("[data-xa-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      const preset = button.dataset.xaPreset;
      if (preset !== "all" && preset !== "today" && preset !== "yesterday" && preset !== "last7") return;
      applyPreset(preset);
    });
  });

  fromField.addEventListener("change", () => {
    fromDate = fromField.value;
    render();
  });
  toField.addEventListener("change", () => {
    toDate = toField.value;
    render();
  });
  clearBtn?.addEventListener("click", clearDates);
  showAllBtn?.addEventListener("click", clearDates);

  const allRecipientRows: Array<Record<string, unknown>> = [];
  let offset = 0;

  while (true) {
    const { data, error } = await session.supabase
      .from("email_outreach_recipients")
      .select(
        `
          id,
          name,
          email,
          resend_email_id,
          status,
          error,
          sent_at,
          created_at,
          delivery_status,
          open_count,
          click_count,
          first_opened_at,
          last_opened_at,
          first_clicked_at,
          last_clicked_at,
          email_outreach (
            subject,
            from_email,
            email_lists ( name ),
            email_templates ( name )
          )
        `,
      )
      .order("sent_at", { ascending: false })
      .range(offset, offset + EMAIL_PAGE_SIZE - 1);

    if (error) {
      setError(error.message);
      emptyEl?.removeAttribute("hidden");
      return;
    }

    const batch = data ?? [];
    allRecipientRows.push(...(batch as Array<Record<string, unknown>>));
    if (batch.length < EMAIL_PAGE_SIZE) break;
    offset += EMAIL_PAGE_SIZE;
  }

  const ids = allRecipientRows.map((row) => String(row.id));
  const eventsByRecipient = new Map<string, SentEmailEvent[]>();

  for (let i = 0; i < ids.length; i += EVENT_ID_BATCH_SIZE) {
    const batchIds = ids.slice(i, i + EVENT_ID_BATCH_SIZE);
    if (batchIds.length === 0) continue;
    const { data: eventRows, error: eventsError } = await session.supabase
      .from("email_outreach_events")
      .select("id, recipient_id, event_type, link_url, user_agent, occurred_at")
      .in("recipient_id", batchIds)
      .order("occurred_at", { ascending: false });

    if (eventsError) {
      setError(eventsError.message);
      emptyEl?.removeAttribute("hidden");
      return;
    }

    for (const event of eventRows ?? []) {
      const recipientId = String(event.recipient_id);
      const bucket = eventsByRecipient.get(recipientId) ?? [];
      bucket.push({
        id: String(event.id),
        eventType: event.event_type as EventType,
        linkUrl: event.link_url ? String(event.link_url) : null,
        userAgent: event.user_agent ? String(event.user_agent) : null,
        occurredAt: String(event.occurred_at),
      });
      eventsByRecipient.set(recipientId, bucket);
    }
  }

  rows = allRecipientRows.map((row) => {
    const outreach = firstRelation(
      row.email_outreach as
        | {
            subject?: string;
            from_email?: string;
            email_lists?: { name?: string } | { name?: string }[] | null;
            email_templates?: { name?: string } | { name?: string }[] | null;
          }
        | Array<{
            subject?: string;
            from_email?: string;
            email_lists?: { name?: string } | { name?: string }[] | null;
            email_templates?: { name?: string } | { name?: string }[] | null;
          }>
        | null,
    );
    const list = firstRelation(outreach?.email_lists);
    const template = firstRelation(outreach?.email_templates);
    const sentAt = String(row.sent_at || row.created_at || "");

    return {
      id: String(row.id),
      recipientName: row.name ? String(row.name) : null,
      recipientEmail: String(row.email ?? ""),
      subject: outreach?.subject ? String(outreach.subject) : "Untitled",
      fromEmail: outreach?.from_email ? String(outreach.from_email) : "",
      templateName: template?.name ? String(template.name) : null,
      listName: list?.name ? String(list.name) : null,
      sentAt,
      deliveryStatus: String(row.delivery_status ?? row.status ?? "sent"),
      error: row.error ? String(row.error) : null,
      openCount: Number(row.open_count ?? 0),
      clickCount: Number(row.click_count ?? 0),
      firstOpenedAt: row.first_opened_at ? String(row.first_opened_at) : null,
      lastOpenedAt: row.last_opened_at ? String(row.last_opened_at) : null,
      firstClickedAt: row.first_clicked_at ? String(row.first_clicked_at) : null,
      lastClickedAt: row.last_clicked_at ? String(row.last_clicked_at) : null,
      events: eventsByRecipient.get(String(row.id)) ?? [],
    };
  });

  daySummaries = buildDaySummaries(rows);

  if (rows.length === 0) {
    emptyEl?.removeAttribute("hidden");
    contentEl?.setAttribute("hidden", "");
    return;
  }

  emptyEl?.setAttribute("hidden", "");
  contentEl?.removeAttribute("hidden");
  render();
}

void init();
