import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";

type OldUser = {
  id: string;
  old_id: number | null;
  name: string | null;
  f_name: string | null;
  l_name: string | null;
  email: string | null;
  created: string;
};

const PAGE_SIZE = 50;

const SORT_FIELDS = ["old_id", "name", "f_name", "l_name", "email", "created"] as const;
type SortField = (typeof SORT_FIELDS)[number];

function isSortField(value: string): value is SortField {
  return (SORT_FIELDS as readonly string[]).includes(value);
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function displayValue(value: string | null | number | undefined) {
  if (value === null || value === undefined || value === "") {
    return '<span class="xa-muted">—</span>';
  }
  return escapeHtml(String(value));
}

function setStatus(message: string, isError = false) {
  const statusEl = document.getElementById("xa-users-status");
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.toggle("xa-users__status--error", isError);
}

function renderRows(users: OldUser[]) {
  const tbody = document.getElementById("xa-users-body");
  if (!tbody) return;

  if (users.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="6" class="xa-users__empty">No users match your search.</td></tr>';
    return;
  }

  tbody.innerHTML = users
    .map(
      (user) => `
        <tr>
          <td>${displayValue(user.old_id)}</td>
          <td>${displayValue(user.name)}</td>
          <td>${displayValue(user.f_name)}</td>
          <td>${displayValue(user.l_name)}</td>
          <td>${displayValue(user.email)}</td>
          <td>${escapeHtml(formatDate(user.created))}</td>
        </tr>
      `,
    )
    .join("");
}

function updateSortHeaders(sortField: SortField, sortAsc: boolean) {
  document.querySelectorAll<HTMLButtonElement>(".xa-users__sort").forEach((button) => {
    const field = button.dataset.sort ?? "";
    const label = button.dataset.label ?? "";
    const isActive = field === sortField;

    button.classList.toggle("xa-users__sort--active", isActive);
    button.textContent = isActive ? `${label} ${sortAsc ? "↑" : "↓"}` : label;

    const th = button.closest("th");
    th?.setAttribute("aria-sort", isActive ? (sortAsc ? "ascending" : "descending") : "none");
  });
}

function updatePagination(page: number, totalPages: number, total: number) {
  const summaryEl = document.getElementById("xa-users-summary");
  const pageEl = document.getElementById("xa-users-page");
  const prevBtn = document.getElementById("xa-users-prev") as HTMLButtonElement | null;
  const nextBtn = document.getElementById("xa-users-next") as HTMLButtonElement | null;

  if (summaryEl) {
    summaryEl.textContent = `${total.toLocaleString()} user${total === 1 ? "" : "s"} total`;
  }

  if (pageEl) {
    pageEl.textContent = `Page ${page} of ${totalPages}`;
  }

  if (prevBtn) {
    prevBtn.disabled = page <= 1;
  }

  if (nextBtn) {
    nextBtn.disabled = page >= totalPages;
  }
}

async function init() {
  const session = await requireAdminSession();
  if (!session) return;

  initAdminShell(session, "users");
  setAdminLoading(false);

  const { supabase } = session;
  let page = 1;
  let search = "";
  let total = 0;
  let sortField: SortField = "old_id";
  let sortAsc = true;

  const searchInput = document.getElementById("xa-users-search") as HTMLInputElement | null;
  const prevBtn = document.getElementById("xa-users-prev");
  const nextBtn = document.getElementById("xa-users-next");
  const sortButtons = document.querySelectorAll<HTMLButtonElement>(".xa-users__sort");

  sortButtons.forEach((button) => {
    const label = button.textContent?.trim() ?? "";
    button.dataset.label = label;
  });

  async function loadUsers() {
    setStatus("Loading users…");
    updateSortHeaders(sortField, sortAsc);

    const from = (page - 1) * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    let query = supabase
      .from("old_users")
      .select("id, old_id, name, f_name, l_name, email, created", { count: "exact" })
      .order(sortField, { ascending: sortAsc, nullsFirst: false })
      .range(from, to);

    const term = search.trim().replaceAll(",", " ");
    if (term) {
      const pattern = `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      query = query.or(
        `name.ilike."${pattern}",f_name.ilike."${pattern}",l_name.ilike."${pattern}",email.ilike."${pattern}"`,
      );
    }

    const { data, error, count } = await query;

    if (error) {
      setStatus(error.message, true);
      renderRows([]);
      updatePagination(1, 1, 0);
      return;
    }

    total = count ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    page = Math.min(page, totalPages);

    renderRows((data ?? []) as OldUser[]);
    updatePagination(page, totalPages, total);
    setStatus(
      total === 0
        ? "No users found."
        : `Showing ${from + 1}–${Math.min(from + PAGE_SIZE, total)} of ${total.toLocaleString()}`,
    );
  }

  let searchTimer: number | undefined;

  searchInput?.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      search = searchInput.value;
      page = 1;
      void loadUsers();
    }, 250);
  });

  prevBtn?.addEventListener("click", () => {
    if (page <= 1) return;
    page -= 1;
    void loadUsers();
  });

  nextBtn?.addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (page >= totalPages) return;
    page += 1;
    void loadUsers();
  });

  sortButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const field = button.dataset.sort;
      if (!field || !isSortField(field)) return;

      if (sortField === field) {
        sortAsc = !sortAsc;
      } else {
        sortField = field;
        sortAsc = true;
      }

      page = 1;
      void loadUsers();
    });
  });

  await loadUsers();
}

void init();
