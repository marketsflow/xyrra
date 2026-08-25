import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";
import {
  formatSentEmailDateKeyLabel,
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

type OutreachSend = {
  id: string;
  listName: string;
  subject: string;
  fromEmail: string;
  templateName: string | null;
  sentAt: string;
  recipientCount: number;
  sentCount: number;
  failedCount: number;
  status: string;
};

type SentEmailRow = {
  id: string;
  recipientName: string | null;
  recipientEmail: string;
  sentAt: string;
  deliveryStatus: string;
  error: string | null;
  openCount: number;
  clickCount: number;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  firstClickedAt: string | null;
  lastClickedAt: string | null;
  events: SentEmailEvent[] | null;
};

type RecipientSortField = "sentAt" | "views" | "clicks";
type SortDirection = "asc" | "desc";
type RecipientSort = { field: RecipientSortField; direction: SortDirection };
type DatePreset = "all" | "today" | "yesterday" | "last7";

type RecipientStat = {
  outreachId: string;
  openCount: number;
  clickCount: number;
};

const RECIPIENT_PAGE_SIZE = 1000;
const DEFAULT_RECIPIENT_SORT: RecipientSort = { field: "sentAt", direction: "desc" };

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

function filterSendsByDateRange(sends: OutreachSend[], fromDate: string, toDate: string) {
  return sends.filter((send) => {
    const dateKey = toSentEmailDateKey(send.sentAt);
    if (fromDate && dateKey < fromDate) return false;
    if (toDate && dateKey > toDate) return false;
    return true;
  });
}

function sortRecipientRows(rows: SentEmailRow[], sort: RecipientSort) {
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

function sortIcon(active: boolean, direction: SortDirection) {
  if (!active) return "↕";
  return direction === "asc" ? "↑" : "↓";
}

function buildSendDateKeys(sends: OutreachSend[]) {
  const keys = new Set<string>();
  for (const send of sends) {
    keys.add(toSentEmailDateKey(send.sentAt));
  }
  return [...keys].sort((a, b) => b.localeCompare(a));
}

async function init() {
  const session = await requireAdminSession();
  if (!session) return;

  const adminSession = session;

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
  const sendsEl = document.getElementById("xa-sent-sends");

  if (!fromInput || !toInput || !statsEl || !sendsEl) return;

  const fromField = fromInput;
  const toField = toInput;
  const stats = statsEl;
  const sendsList = sendsEl;

  let sends: OutreachSend[] = [];
  let recipientStats: RecipientStat[] = [];
  let fromDate = "";
  let toDate = "";
  let expandedSendId: string | null = null;
  let expandedRecipientId: string | null = null;
  let loadingSendId: string | null = null;
  let loadingEventsId: string | null = null;
  const recipientsBySend = new Map<string, SentEmailRow[]>();
  const recipientSorts: Record<string, RecipientSort> = {};

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

  function toggleRecipientSort(sendId: string, field: "views" | "clicks") {
    const existing = recipientSorts[sendId] ?? DEFAULT_RECIPIENT_SORT;
    if (existing.field === field) {
      recipientSorts[sendId] = { field, direction: existing.direction === "asc" ? "desc" : "asc" };
    } else {
      recipientSorts[sendId] = { field, direction: "desc" };
    }
    render();
  }

  async function loadSendRecipients(sendId: string) {
    if (recipientsBySend.has(sendId)) return;

    loadingSendId = sendId;
    render();

    const allRows: Array<Record<string, unknown>> = [];
    let offset = 0;

    while (true) {
      const { data, error } = await adminSession.supabase
        .from("email_outreach_recipients")
        .select(
          `
            id,
            name,
            email,
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
            last_clicked_at
          `,
        )
        .eq("outreach_id", sendId)
        .order("sent_at", { ascending: false, nullsFirst: false })
        .range(offset, offset + RECIPIENT_PAGE_SIZE - 1);

      if (error) {
        setError(error.message);
        loadingSendId = null;
        render();
        return;
      }

      const batch = data ?? [];
      allRows.push(...(batch as Array<Record<string, unknown>>));
      if (batch.length < RECIPIENT_PAGE_SIZE) break;
      offset += RECIPIENT_PAGE_SIZE;
    }

    recipientsBySend.set(
      sendId,
      allRows.map((row) => ({
        id: String(row.id),
        recipientName: row.name ? String(row.name) : null,
        recipientEmail: String(row.email ?? ""),
        sentAt: String(row.sent_at || row.created_at || ""),
        deliveryStatus: String(row.delivery_status ?? row.status ?? "sent"),
        error: row.error ? String(row.error) : null,
        openCount: Number(row.open_count ?? 0),
        clickCount: Number(row.click_count ?? 0),
        firstOpenedAt: row.first_opened_at ? String(row.first_opened_at) : null,
        lastOpenedAt: row.last_opened_at ? String(row.last_opened_at) : null,
        firstClickedAt: row.first_clicked_at ? String(row.first_clicked_at) : null,
        lastClickedAt: row.last_clicked_at ? String(row.last_clicked_at) : null,
        events: null,
      })),
    );

    if (loadingSendId === sendId) loadingSendId = null;
    render();
  }

  async function loadRecipientEvents(sendId: string, recipientId: string) {
    const rows = recipientsBySend.get(sendId);
    const recipient = rows?.find((row) => row.id === recipientId);
    if (!recipient || recipient.events) return;

    loadingEventsId = recipientId;
    render();

    const { data, error } = await adminSession.supabase
      .from("email_outreach_events")
      .select("id, event_type, link_url, user_agent, occurred_at")
      .eq("recipient_id", recipientId)
      .order("occurred_at", { ascending: false });

    if (error) {
      setError(error.message);
      loadingEventsId = null;
      render();
      return;
    }

    recipient.events = (data ?? []).map((event) => ({
      id: String(event.id),
      eventType: event.event_type as EventType,
      linkUrl: event.link_url ? String(event.link_url) : null,
      userAgent: event.user_agent ? String(event.user_agent) : null,
      occurredAt: String(event.occurred_at),
    }));

    if (loadingEventsId === recipientId) loadingEventsId = null;
    render();
  }

  function renderRecipient(row: SentEmailRow) {
    const isExpanded = expandedRecipientId === row.id;
    const name = row.recipientName?.trim() || row.recipientEmail;
    const events = row.events;
    let eventsHtml = "";

    if (!isExpanded) {
      eventsHtml = "";
    } else if (loadingEventsId === row.id && !events) {
      eventsHtml = `<p class="xa-sent__muted">Loading activity…</p>`;
    } else if (!events || events.length === 0) {
      eventsHtml = `<p class="xa-sent__muted">No opens or clicks recorded yet. Enable open/click tracking and the Resend webhook for your sending domain.</p>`;
    } else {
      eventsHtml = `<ul class="xa-sent__events">${events
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
    }

    return `
      <li>
        <button type="button" class="xa-sent__row" data-sent-id="${escapeHtml(row.id)}">
          <span class="xa-sent__row-main">
            <span class="xa-sent__row-title">
              <span>${escapeHtml(name)}</span>
              <span class="xa-sent__badge ${deliveryStatusClass(row.deliveryStatus)}">${escapeHtml(deliveryStatusLabel(row.deliveryStatus))}</span>
            </span>
            ${row.error ? `<span class="xa-sent__row-meta xa-sent__row-meta--error">${escapeHtml(row.error)}</span>` : ""}
          </span>
          <span class="xa-sent__row-recipients">${escapeHtml(row.recipientEmail)}</span>
          <span class="xa-sent__metric"><span class="xa-sent__metric-label">Opened</span> ${row.openCount > 0 ? "Yes" : "No"} · ${row.openCount}</span>
          <span class="xa-sent__metric"><span class="xa-sent__metric-label">Clicked</span> ${row.clickCount > 0 ? "Yes" : "No"} · ${row.clickCount}</span>
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

  function renderSendPanel(send: OutreachSend) {
    if (loadingSendId === send.id && !recipientsBySend.has(send.id)) {
      return `<div class="xa-sent__send-panel"><p class="xa-sent__muted">Loading recipients…</p></div>`;
    }

    const recipients = recipientsBySend.get(send.id) ?? [];
    if (recipients.length === 0) {
      return `<div class="xa-sent__send-panel"><p class="xa-sent__muted">No recipient records for this send.</p></div>`;
    }

    const sort = recipientSorts[send.id] ?? DEFAULT_RECIPIENT_SORT;
    const sorted = sortRecipientRows(recipients, sort);
    const opened = recipients.filter((row) => row.openCount > 0).length;
    const clicked = recipients.filter((row) => row.clickCount > 0).length;
    const totalOpens = recipients.reduce((sum, row) => sum + row.openCount, 0);
    const totalClicks = recipients.reduce((sum, row) => sum + row.clickCount, 0);

    return `
      <div class="xa-sent__send-panel">
        <div class="xa-sent__day-head">
          <div>
            <h2>${escapeHtml(send.subject)}</h2>
            <p>${recipients.length} email${recipients.length === 1 ? "" : "s"} · ${opened} opened · ${clicked} clicked · ${totalOpens} views · ${totalClicks} clicks</p>
            ${send.templateName ? `<p>Template: ${escapeHtml(send.templateName)}</p>` : ""}
            ${send.fromEmail ? `<p>From: ${escapeHtml(send.fromEmail)}</p>` : ""}
          </div>
          <div class="xa-sent__sorts">
            <span>Sort by</span>
            <button type="button" class="xa-sent__chip${sort.field === "views" ? " xa-sent__chip--active" : ""}" data-xa-sort-send="${escapeHtml(send.id)}" data-xa-sort-field="views">
              Opened ${sortIcon(sort.field === "views", sort.direction)}
            </button>
            <button type="button" class="xa-sent__chip${sort.field === "clicks" ? " xa-sent__chip--active" : ""}" data-xa-sort-send="${escapeHtml(send.id)}" data-xa-sort-field="clicks">
              Clicked ${sortIcon(sort.field === "clicks", sort.direction)}
            </button>
          </div>
        </div>
        <div class="xa-sent__cols">
          <span>Email</span>
          <span>Recipient</span>
          <span>Opened</span>
          <span>Clicked</span>
          <span>Sent</span>
        </div>
        <ul>${sorted.map(renderRecipient).join("")}</ul>
      </div>
    `;
  }

  function render() {
    const filteredSends = filterSendsByDateRange(sends, fromDate, toDate);
    const dateKeys = buildSendDateKeys(sends);
    const hasDateFilter = Boolean(fromDate || toDate);
    const activePreset = detectActivePreset(fromDate, toDate);
    const filteredSendIds = new Set(filteredSends.map((send) => send.id));
    const filteredStats = recipientStats.filter((row) => filteredSendIds.has(row.outreachId));
    const totalOpens = filteredStats.reduce((sum, row) => sum + row.openCount, 0);
    const totalClicks = filteredStats.reduce((sum, row) => sum + row.clickCount, 0);
    const openedEmails = filteredStats.filter((row) => row.openCount > 0).length;
    const clickedEmails = filteredStats.filter((row) => row.clickCount > 0).length;

    if (countLabelEl) {
      countLabelEl.textContent = `${filteredSends.length} of ${sends.length} send${sends.length === 1 ? "" : "s"} shown`;
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
      dateChipsWrap.hidden = dateKeys.length === 0;
      dateChipList.innerHTML = dateKeys
        .map((dateKey) => {
          const isActive = fromDate === dateKey && toDate === dateKey;
          const count = sends.filter((send) => toSentEmailDateKey(send.sentAt) === dateKey).length;
          return `
            <button type="button" class="xa-sent__chip${isActive ? " xa-sent__chip--active" : ""}" data-xa-date-key="${escapeHtml(dateKey)}">
              ${escapeHtml(formatSentEmailDateKeyLabel(dateKey))} (${count})
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
        <strong>${filteredStats.length.toLocaleString()}</strong>
      </div>
      <div class="xa-sent__stat">
        <p>Total views</p>
        <strong>${totalOpens.toLocaleString()}</strong>
        <span>${openedEmails} email${openedEmails === 1 ? "" : "s"} viewed at least once</span>
      </div>
      <div class="xa-sent__stat">
        <p>Total clicks</p>
        <strong>${totalClicks.toLocaleString()}</strong>
        <span>${clickedEmails} email${clickedEmails === 1 ? "" : "s"} clicked at least once</span>
      </div>
      <div class="xa-sent__stat xa-sent__stat--accent">
        <p>Tracking</p>
        <span>Views and clicks update automatically from Resend webhooks after delivery.</span>
      </div>
    `;

    if (filteredSends.length === 0) {
      sendsList.innerHTML = "";
      noMatchEl?.removeAttribute("hidden");
      if (noMatchHintEl) {
        noMatchHintEl.textContent =
          sends.length > 0
            ? `Sends are logged for ${dateKeys.map((key) => formatSentEmailDateKeyLabel(key)).join(", ")}.`
            : "Try widening the date range or clear the filter.";
      }
      return;
    }

    noMatchEl?.setAttribute("hidden", "");

    sendsList.innerHTML = filteredSends
      .map((send) => {
        const isOpen = expandedSendId === send.id;
        return `
          <li class="xa-sent__send${isOpen ? " xa-sent__send--open" : ""}">
            <button type="button" class="xa-sent__send-tab" data-send-id="${escapeHtml(send.id)}" aria-expanded="${isOpen ? "true" : "false"}">
              <span class="xa-sent__send-main">
                <span class="xa-sent__send-name">${escapeHtml(send.listName)}</span>
                <span class="xa-sent__send-meta">${escapeHtml(send.subject)} · ${send.sentCount.toLocaleString()} sent</span>
              </span>
              <span class="xa-sent__send-date">
                <span>${escapeHtml(formatDateTime(send.sentAt))}</span>
                <span class="xa-sent__chevron${isOpen ? " xa-sent__chevron--open" : ""}" aria-hidden="true">▾</span>
              </span>
            </button>
            ${isOpen ? renderSendPanel(send) : ""}
          </li>
        `;
      })
      .join("");

    sendsList.querySelectorAll<HTMLButtonElement>("[data-send-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset.sendId;
        if (!id) return;
        expandedRecipientId = null;
        if (expandedSendId === id) {
          expandedSendId = null;
          render();
          return;
        }
        expandedSendId = id;
        void loadSendRecipients(id);
        render();
      });
    });

    sendsList.querySelectorAll<HTMLButtonElement>("[data-sent-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset.sentId;
        if (!id || !expandedSendId) return;
        if (expandedRecipientId === id) {
          expandedRecipientId = null;
          render();
          return;
        }
        expandedRecipientId = id;
        void loadRecipientEvents(expandedSendId, id);
        render();
      });
    });

    sendsList.querySelectorAll<HTMLButtonElement>("[data-xa-sort-send]").forEach((button) => {
      button.addEventListener("click", () => {
        const sendId = button.dataset.xaSortSend;
        const field = button.dataset.xaSortField;
        if (!sendId || (field !== "views" && field !== "clicks")) return;
        toggleRecipientSort(sendId, field);
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

  async function loadRecipientStats() {
    const rows: RecipientStat[] = [];
    let offset = 0;

    while (true) {
      const { data, error } = await adminSession.supabase
        .from("email_outreach_recipients")
        .select("outreach_id, open_count, click_count")
        .order("id", { ascending: true })
        .range(offset, offset + RECIPIENT_PAGE_SIZE - 1);

      if (error) {
        throw new Error(error.message);
      }

      const batch = data ?? [];
      for (const row of batch) {
        rows.push({
          outreachId: String(row.outreach_id),
          openCount: Number(row.open_count ?? 0),
          clickCount: Number(row.click_count ?? 0),
        });
      }

      if (batch.length < RECIPIENT_PAGE_SIZE) break;
      offset += RECIPIENT_PAGE_SIZE;
    }

    return rows;
  }

  let loadedStats: RecipientStat[] = [];
  try {
    const [sendsResult, statsRows] = await Promise.all([
      adminSession.supabase
        .from("email_outreach")
        .select(
          `
            id,
            subject,
            from_email,
            recipient_count,
            sent_count,
            failed_count,
            status,
            created_at,
            email_lists ( name ),
            email_templates ( name )
          `,
        )
        .in("status", ["sending", "sent", "failed", "partial"])
        .order("created_at", { ascending: false }),
      loadRecipientStats(),
    ]);

    if (sendsResult.error) {
      setError(sendsResult.error.message);
      emptyEl?.removeAttribute("hidden");
      return;
    }

    loadedStats = statsRows;
    sends = (sendsResult.data ?? []).map((row) => {
      const list = firstRelation(row.email_lists as { name?: string } | { name?: string }[] | null);
      const template = firstRelation(row.email_templates as { name?: string } | { name?: string }[] | null);
      return {
        id: String(row.id),
        listName: list?.name ? String(list.name) : "Untitled list",
        subject: row.subject ? String(row.subject) : "Untitled",
        fromEmail: row.from_email ? String(row.from_email) : "",
        templateName: template?.name ? String(template.name) : null,
        sentAt: String(row.created_at ?? ""),
        recipientCount: Number(row.recipient_count ?? 0),
        sentCount: Number(row.sent_count ?? 0),
        failedCount: Number(row.failed_count ?? 0),
        status: String(row.status ?? "sent"),
      };
    });
  } catch (error) {
    setError(error instanceof Error ? error.message : "Unable to load sent email stats.");
    emptyEl?.removeAttribute("hidden");
    return;
  }

  recipientStats = loadedStats;

  if (sends.length === 0) {
    emptyEl?.removeAttribute("hidden");
    contentEl?.setAttribute("hidden", "");
    return;
  }

  emptyEl?.setAttribute("hidden", "");
  contentEl?.removeAttribute("hidden");
  render();
}

void init();
