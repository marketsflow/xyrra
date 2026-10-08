import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";
import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;

const TICK_LIMIT = 50;
const EVENT_LIMIT = 20;
const AUTO_REFRESH_MS = 30_000;
const TICK_ORDER_CANDIDATES = ["recorded_at", "created_at", "ts", "timestamp", "id"];
const EVENT_ORDER_CANDIDATES = ["updated_at", "created_at", "end_at", "id"];

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

function formatPrice(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return escapeHtml(String(value));
  return n.toFixed(3);
}

function display(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return '<span class="xa-muted">—</span>';
  }
  return escapeHtml(String(value));
}

function asString(value: unknown) {
  return typeof value === "string" ? value : value == null ? null : String(value);
}

function setStatus(message: string, isError = false) {
  const statusEl = document.getElementById("xa-polymarket-status");
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.toggle("xa-users__status--error", isError);
}

function cellValue(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return '<span class="xa-muted">—</span>';
  }
  if (typeof value === "object") {
    return escapeHtml(JSON.stringify(value));
  }
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    return escapeHtml(formatDateTime(text));
  }
  return escapeHtml(text);
}

function looksLikeKnownTickSchema(row: Row | undefined) {
  if (!row) return false;
  return "up_price" in row || "event_slug" in row || "recorded_at" in row;
}

function looksLikeKnownEventSchema(row: Row | undefined) {
  if (!row) return false;
  return "slug" in row && ("updated_at" in row || "end_at" in row);
}

function renderLatest(tick: Row | null) {
  const el = document.getElementById("xa-polymarket-latest");
  if (!el) return;

  if (!tick) {
    el.innerHTML = '<p class="xa-muted">No ticks yet. Run ingest or wait for the cron job.</p>';
    return;
  }

  if (!looksLikeKnownTickSchema(tick)) {
    const entries = Object.entries(tick).slice(0, 8);
    el.innerHTML = entries
      .map(
        ([key, value]) => `
          <article class="xa-polymarket__card">
            <p class="xa-polymarket__card-label">${escapeHtml(key)}</p>
            <p class="xa-polymarket__card-value">${cellValue(value)}</p>
          </article>
        `,
      )
      .join("");
    return;
  }

  el.innerHTML = `
    <article class="xa-polymarket__card">
      <p class="xa-polymarket__card-label">Market</p>
      <p class="xa-polymarket__card-value">${display(tick.question || tick.event_slug)}</p>
      <p class="xa-polymarket__card-meta">${escapeHtml(formatDateTime(asString(tick.recorded_at)))}</p>
    </article>
    <article class="xa-polymarket__card">
      <p class="xa-polymarket__card-label">Up price</p>
      <p class="xa-polymarket__card-value">${formatPrice(tick.up_price)}</p>
      <p class="xa-polymarket__card-meta">bid ${formatPrice(tick.up_bid)} / ask ${formatPrice(tick.up_ask)}</p>
    </article>
    <article class="xa-polymarket__card">
      <p class="xa-polymarket__card-label">Down price</p>
      <p class="xa-polymarket__card-value">${formatPrice(tick.down_price)}</p>
      <p class="xa-polymarket__card-meta">bid ${formatPrice(tick.down_bid)} / ask ${formatPrice(tick.down_ask)}</p>
    </article>
    <article class="xa-polymarket__card">
      <p class="xa-polymarket__card-label">Window ends</p>
      <p class="xa-polymarket__card-value">${escapeHtml(formatDateTime(asString(tick.market_end_at)))}</p>
      <p class="xa-polymarket__card-meta">${display(tick.symbol)} · ${display(tick.asset)}</p>
    </article>
  `;
}

function renderDynamicTable(headId: string, bodyId: string, rows: Row[], emptyMessage: string) {
  const thead = document.getElementById(headId);
  const tbody = document.getElementById(bodyId);
  if (!tbody) return;

  if (rows.length === 0) {
    if (thead) thead.innerHTML = "<tr><th scope=\"col\">—</th></tr>";
    tbody.innerHTML = `<tr><td class="xa-users__empty">${escapeHtml(emptyMessage)}</td></tr>`;
    return;
  }

  const columns = Object.keys(rows[0] ?? {});
  if (thead) {
    thead.innerHTML = `<tr>${columns.map((col) => `<th scope="col">${escapeHtml(col)}</th>`).join("")}</tr>`;
  }
  tbody.innerHTML = rows
    .map((row) => `<tr>${columns.map((col) => `<td>${cellValue(row[col])}</td>`).join("")}</tr>`)
    .join("");
}

function renderEvents(events: Row[]) {
  const thead = document.getElementById("xa-polymarket-events-head");
  const tbody = document.getElementById("xa-polymarket-events-body");
  if (!tbody) return;

  if (events.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="xa-users__empty">No events stored yet.</td></tr>';
    return;
  }

  if (!looksLikeKnownEventSchema(events[0])) {
    renderDynamicTable("xa-polymarket-events-head", "xa-polymarket-events-body", events, "No events stored yet.");
    return;
  }

  if (thead) {
    thead.innerHTML = `
      <tr>
        <th scope="col">Slug</th>
        <th scope="col">Title</th>
        <th scope="col">Asset</th>
        <th scope="col">Ends</th>
        <th scope="col">Updated</th>
      </tr>
    `;
  }

  tbody.innerHTML = events
    .map(
      (event) => `
        <tr>
          <td>${display(event.slug)}</td>
          <td>${display(event.title)}</td>
          <td>${display(event.asset)}</td>
          <td>${escapeHtml(formatDateTime(asString(event.end_at)))}</td>
          <td>${escapeHtml(formatDateTime(asString(event.updated_at)))}</td>
        </tr>
      `,
    )
    .join("");
}

function renderTicks(ticks: Row[]) {
  const thead = document.getElementById("xa-polymarket-ticks-head");
  const tbody = document.getElementById("xa-polymarket-ticks-body");
  if (!tbody) return;

  if (ticks.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="xa-users__empty">No ticks stored yet.</td></tr>';
    return;
  }

  if (!looksLikeKnownTickSchema(ticks[0])) {
    renderDynamicTable("xa-polymarket-ticks-head", "xa-polymarket-ticks-body", ticks, "No ticks stored yet.");
    return;
  }

  if (thead) {
    thead.innerHTML = `
      <tr>
        <th scope="col">Recorded</th>
        <th scope="col">Asset</th>
        <th scope="col">Event</th>
        <th scope="col">Up</th>
        <th scope="col">Down</th>
        <th scope="col">Up bid/ask</th>
        <th scope="col">Market end</th>
      </tr>
    `;
  }

  tbody.innerHTML = ticks
    .map(
      (tick) => `
        <tr>
          <td>${escapeHtml(formatDateTime(asString(tick.recorded_at)))}</td>
          <td>${display(tick.asset)}</td>
          <td>${display(tick.event_slug || tick.question)}</td>
          <td>${formatPrice(tick.up_price)}</td>
          <td>${formatPrice(tick.down_price)}</td>
          <td>${formatPrice(tick.up_bid)} / ${formatPrice(tick.up_ask)}</td>
          <td>${escapeHtml(formatDateTime(asString(tick.market_end_at)))}</td>
        </tr>
      `,
    )
    .join("");
}

async function loadRows(
  supabase: SupabaseClient,
  table: string,
  orderCandidates: string[],
  limit: number,
): Promise<{ rows: Row[]; error: string | null }> {
  let lastError: string | null = null;

  for (const orderCol of orderCandidates) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .order(orderCol, { ascending: false })
      .limit(limit);

    if (!error) {
      return { rows: (data as Row[] | null) ?? [], error: null };
    }
    lastError = error.message;
    // Missing column for order — try the next candidate.
    if (!/column|does not exist|could not find/i.test(error.message)) {
      break;
    }
  }

  const { data, error } = await supabase.from(table).select("*").limit(limit);
  if (!error) {
    return { rows: (data as Row[] | null) ?? [], error: null };
  }
  return { rows: [], error: error.message || lastError };
}

async function init() {
  const session = await requireAdminSession();
  if (!session) return;

  initAdminShell(session, "polymarket");
  setAdminLoading(false);

  const { supabase } = session;
  const summaryEl = document.getElementById("xa-polymarket-summary");
  const refreshBtn = document.getElementById("xa-polymarket-refresh") as HTMLButtonElement | null;
  const ingestBtn = document.getElementById("xa-polymarket-ingest") as HTMLButtonElement | null;

  let loading = false;
  let ingesting = false;

  async function loadData() {
    if (loading) return;
    loading = true;
    setStatus("Loading latest Polymarket data…");

    const [eventsResult, ticksResult, tickCountResult, eventCountResult] = await Promise.all([
      loadRows(supabase, "polymarket_events", EVENT_ORDER_CANDIDATES, EVENT_LIMIT),
      loadRows(supabase, "polymarket_ticks", TICK_ORDER_CANDIDATES, TICK_LIMIT),
      supabase.from("polymarket_ticks").select("*", { count: "exact", head: true }),
      supabase.from("polymarket_events").select("*", { count: "exact", head: true }),
    ]);

    loading = false;

    if (eventsResult.error && ticksResult.error) {
      setStatus(ticksResult.error || eventsResult.error || "Unable to load data.", true);
      if (summaryEl) {
        summaryEl.textContent =
          "Could not read polymarket tables. Apply the polymarket migration, then run ingest.";
      }
      renderLatest(null);
      renderEvents([]);
      renderTicks([]);
      return;
    }

    const events = eventsResult.rows;
    const ticks = ticksResult.rows;
    const tickCount = tickCountResult.count ?? ticks.length;
    const eventCount = eventCountResult.count ?? events.length;

    if (summaryEl) {
      summaryEl.textContent = `${tickCount.toLocaleString()} tick${tickCount === 1 ? "" : "s"} · ${eventCount.toLocaleString()} event${eventCount === 1 ? "" : "s"} stored. Showing the latest ${ticks.length} tick${ticks.length === 1 ? "" : "s"}.`;
    }

    renderLatest(ticks[0] ?? null);
    if (eventsResult.error) {
      renderDynamicTable("xa-polymarket-events-head", "xa-polymarket-events-body", [], eventsResult.error);
    } else {
      renderEvents(events);
    }
    if (ticksResult.error) {
      renderDynamicTable("xa-polymarket-ticks-head", "xa-polymarket-ticks-body", [], ticksResult.error);
      setStatus(ticksResult.error, true);
    } else {
      renderTicks(ticks);
      setStatus(`Updated ${new Date().toLocaleTimeString()}.`);
    }
  }

  refreshBtn?.addEventListener("click", () => {
    void loadData();
  });

  ingestBtn?.addEventListener("click", () => {
    void (async () => {
      if (ingesting) return;
      ingesting = true;
      if (ingestBtn) {
        ingestBtn.disabled = true;
        ingestBtn.textContent = "Ingesting…";
      }
      setStatus("Fetching a live Polymarket tick…");

      try {
        const auth = await supabase.auth.getSession();
        const accessToken = auth.data.session?.access_token;
        if (!accessToken) {
          throw new Error("Your session expired. Sign in again.");
        }

        const response = await fetch("/api/ingest-polymarket", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

        const raw = await response.text();
        let body: { success?: boolean; message?: string; tick?: Row } = {};
        if (raw) {
          try {
            body = JSON.parse(raw) as typeof body;
          } catch {
            throw new Error("Ingest API did not return JSON.");
          }
        }

        if (!response.ok || !body.success) {
          throw new Error(body.message || "Unable to ingest Polymarket tick.");
        }

        setStatus(
          `Ingested ${asString(body.tick?.event_slug) ?? "tick"} · Up ${formatPrice(body.tick?.up_price)} / Down ${formatPrice(body.tick?.down_price)}.`,
        );
        await loadData();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Unable to ingest tick.", true);
      } finally {
        ingesting = false;
        if (ingestBtn) {
          ingestBtn.disabled = false;
          ingestBtn.textContent = "Ingest tick now";
        }
      }
    })();
  });

  await loadData();
  window.setInterval(() => {
    void loadData();
  }, AUTO_REFRESH_MS);
}

void init();
