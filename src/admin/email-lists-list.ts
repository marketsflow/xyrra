import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";
import { mapEmailListRow } from "../lib/email/email-lists";
import { mapOldUserRow, oldUserDisplayName, type OldUser } from "../lib/users/old-users";

const USER_PAGE_SIZE = 100;

type EmailListItem = ReturnType<typeof mapEmailListRow>;

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function displayValue(value: string | null | number | undefined) {
  if (value === null || value === undefined || value === "") {
    return '<span class="xa-muted">—</span>';
  }
  return escapeHtml(String(value));
}

async function init() {
  const session = await requireAdminSession();
  if (!session) return;

  const adminSession = session;

  initAdminShell(session, "email-lists");
  setAdminLoading(false);

  const listEl = document.getElementById("xa-email-lists-list");
  const emptyEl = document.getElementById("xa-email-lists-empty");
  const errorEl = document.getElementById("xa-email-lists-error");
  const importedUsersListsEl = document.getElementById("xa-old-users-lists");
  const selectedUserEl = document.getElementById("xa-selected-user");
  const usersHeadEl = document.getElementById("xa-old-users-head");
  const usersBodyEl = document.getElementById("xa-old-users-body");
  const usersStatusEl = document.getElementById("xa-old-users-status");
  const usersSummaryEl = document.getElementById("xa-old-users-summary");
  const usersPageEl = document.getElementById("xa-old-users-page");
  const usersSearchEl = document.getElementById("xa-old-users-search") as HTMLInputElement | null;
  const usersPrevBtn = document.getElementById("xa-old-users-prev");
  const usersNextBtn = document.getElementById("xa-old-users-next");
  const usersFirstBtn = document.getElementById("xa-old-users-first");
  const usersLastBtn = document.getElementById("xa-old-users-last");

  let lists: EmailListItem[] = [];
  let selectedUser: OldUser | null = null;
  let pageUsers: OldUser[] = [];
  let membershipByEmail = new Map<string, Set<string>>();
  let userPage = 1;
  let userSearch = "";
  let userTotal = 0;
  let pageMembershipBusy = false;

  function userColumnCount() {
    return 2 + lists.length;
  }

  function listsOldestFirst() {
    return lists.slice().reverse();
  }

  function setUsersStatus(message: string, isError = false) {
    if (!usersStatusEl) return;
    usersStatusEl.textContent = message;
    usersStatusEl.classList.toggle("xa-template__status--error", isError);
  }

  function renderImportedUsersListsHeader() {
    if (!importedUsersListsEl) return;

    if (lists.length === 0) {
      importedUsersListsEl.innerHTML =
        '<p class="xa-old-users__lists-empty">No email lists yet</p>';
      return;
    }

    importedUsersListsEl.innerHTML = `
      <p class="xa-old-users__lists-label">Latest email lists</p>
      <div class="xa-old-users__lists-chips">
        ${listsOldestFirst()
          .map(
            (list) => `
              <a
                class="xa-old-users__lists-chip"
                href="/admin/email-lists/edit/?id=${encodeURIComponent(list.id)}"
                title="${escapeHtml(list.name)} · ${list.memberCount ?? 0} member${list.memberCount === 1 ? "" : "s"}"
              >
                ${escapeHtml(list.name)}
              </a>
            `,
          )
          .join("")}
      </div>
    `;
  }

  function eligiblePageUsers() {
    return pageUsers.filter((user) => Boolean(user.email));
  }

  function pageMembersForList(listId: string) {
    return eligiblePageUsers().filter((user) => {
      const email = user.email?.toLowerCase() ?? "";
      return membershipByEmail.get(email)?.has(listId) ?? false;
    });
  }

  function updateSelectAllCheckboxes() {
    if (!usersHeadEl) return;

    const eligible = eligiblePageUsers();

    usersHeadEl.querySelectorAll<HTMLInputElement>("[data-select-all-list-id]").forEach((checkbox) => {
      const listId = checkbox.dataset.selectAllListId;
      if (!listId) return;

      if (eligible.length === 0) {
        checkbox.checked = false;
        checkbox.indeterminate = false;
        checkbox.disabled = true;
        return;
      }

      const memberCount = pageMembersForList(listId).length;
      checkbox.disabled = pageMembershipBusy;
      checkbox.checked = memberCount === eligible.length;
      checkbox.indeterminate = memberCount > 0 && memberCount < eligible.length;
    });
  }

  function bindHeaderSelectAll() {
    if (!usersHeadEl) return;

    usersHeadEl.querySelectorAll<HTMLInputElement>("[data-select-all-list-id]").forEach((checkbox) => {
      checkbox.addEventListener("click", (event) => {
        event.stopPropagation();
      });

      checkbox.addEventListener("change", () => {
        const listId = checkbox.dataset.selectAllListId;
        if (!listId) {
          checkbox.checked = !checkbox.checked;
          return;
        }

        const nextChecked = checkbox.checked;
        checkbox.indeterminate = false;
        void togglePageMembership(listId, nextChecked);
      });
    });
  }

  function renderUsersTableHead() {
    if (!usersHeadEl) return;

    usersHeadEl.innerHTML = `
      <th scope="col">Name</th>
      <th scope="col">Email</th>
      ${listsOldestFirst()
        .map(
          (list) => `
            <th scope="col" class="xa-old-users__list-col" title="${escapeHtml(list.name)}">
              <div class="xa-old-users__list-head">
                <input
                  type="checkbox"
                  data-select-all-list-id="${escapeHtml(list.id)}"
                  aria-label="Select all users on this page for ${escapeHtml(list.name)}"
                />
                <span class="xa-old-users__list-name">${escapeHtml(list.name)}</span>
              </div>
            </th>
          `,
        )
        .join("")}
    `;

    bindHeaderSelectAll();
    updateSelectAllCheckboxes();
  }

  function renderSelectedUser() {
    if (!selectedUserEl) return;

    if (!selectedUser) {
      selectedUserEl.innerHTML =
        '<p class="xa-selected-user__empty">Click a user below to view their name and email.</p>';
      return;
    }

    const displayName = oldUserDisplayName(selectedUser);
    selectedUserEl.innerHTML = `
      <div>
        <p class="xa-selected-user__label">Selected user</p>
        <p class="xa-selected-user__name">${escapeHtml(displayName)}</p>
        <p class="xa-selected-user__email">${escapeHtml(selectedUser.email ?? "—")}</p>
      </div>
    `;
  }

  async function loadMembershipForEmails(emails: string[]) {
    membershipByEmail = new Map();

    const normalized = emails.map((email) => email.toLowerCase()).filter(Boolean);
    if (normalized.length === 0) {
      return;
    }

    const { data, error } = await adminSession.supabase
      .from("email_list_members")
      .select("list_id, email")
      .in("email", normalized);

    if (error) {
      setUsersStatus(error.message, true);
      return;
    }

    for (const row of data ?? []) {
      const email = String(row.email).toLowerCase();
      const listId = String(row.list_id);
      const current = membershipByEmail.get(email) ?? new Set<string>();
      current.add(listId);
      membershipByEmail.set(email, current);
    }
  }

  async function selectUser(user: OldUser) {
    selectedUser = user;
    renderSelectedUser();
    document.querySelectorAll<HTMLTableRowElement>("[data-old-user-id]").forEach((row) => {
      row.classList.toggle("xa-old-users__row--selected", row.dataset.oldUserId === user.id);
    });
  }

  async function toggleListMembership(user: OldUser, listId: string, checked: boolean) {
    if (!user.email) {
      setUsersStatus("This user does not have an email address.", true);
      return false;
    }

    const displayName = oldUserDisplayName(user);
    const email = user.email.toLowerCase();

    if (checked) {
      const { error } = await adminSession.supabase.from("email_list_members").insert({
        list_id: listId,
        name: displayName,
        email,
        old_user_id: user.id,
      });

      if (error) {
        setUsersStatus(error.message, true);
        return false;
      }

      const current = membershipByEmail.get(email) ?? new Set<string>();
      current.add(listId);
      membershipByEmail.set(email, current);
      setUsersStatus(`Added ${displayName} to the list.`);
    } else {
      const { error } = await adminSession.supabase
        .from("email_list_members")
        .delete()
        .eq("list_id", listId)
        .eq("email", email);

      if (error) {
        setUsersStatus(error.message, true);
        return false;
      }

      const current = membershipByEmail.get(email);
      current?.delete(listId);
      setUsersStatus(`Removed ${displayName} from the list.`);
    }

    await reloadLists(false);
    return true;
  }

  function setPageCheckboxesForList(listId: string, checked: boolean) {
    usersBodyEl?.querySelectorAll<HTMLInputElement>(`input[data-list-id="${listId}"]`).forEach((checkbox) => {
      if (!checkbox.disabled) {
        checkbox.checked = checked;
      }
    });
  }

  async function togglePageMembership(listId: string, checked: boolean) {
    const list = lists.find((item) => item.id === listId);
    const listName = list?.name ?? "the list";
    const eligible = eligiblePageUsers();

    if (eligible.length === 0) {
      setUsersStatus("No users with email addresses on this page.", true);
      updateSelectAllCheckboxes();
      return false;
    }

    if (pageMembershipBusy) {
      updateSelectAllCheckboxes();
      return false;
    }

    pageMembershipBusy = true;
    updateSelectAllCheckboxes();
    setUsersStatus(checked ? `Adding this page to ${listName}…` : `Removing this page from ${listName}…`);

    try {
      if (checked) {
        const toAdd = eligible.filter((user) => {
          const email = user.email?.toLowerCase() ?? "";
          return !membershipByEmail.get(email)?.has(listId);
        });

        if (toAdd.length > 0) {
          const { error } = await adminSession.supabase.from("email_list_members").insert(
            toAdd.map((user) => ({
              list_id: listId,
              name: oldUserDisplayName(user),
              email: user.email!.toLowerCase(),
              old_user_id: user.id,
            })),
          );

          if (error) {
            setUsersStatus(error.message, true);
            return false;
          }

          for (const user of toAdd) {
            const email = user.email!.toLowerCase();
            const current = membershipByEmail.get(email) ?? new Set<string>();
            current.add(listId);
            membershipByEmail.set(email, current);
          }
        }

        setPageCheckboxesForList(listId, true);
        setUsersStatus(
          toAdd.length === 0
            ? `All users on this page are already on ${listName}.`
            : `Added ${toAdd.length} user${toAdd.length === 1 ? "" : "s"} on this page to ${listName}.`,
        );
      } else {
        const toRemove = pageMembersForList(listId);

        if (toRemove.length > 0) {
          const emails = toRemove.map((user) => user.email!.toLowerCase());
          for (let index = 0; index < emails.length; index += 50) {
            const chunk = emails.slice(index, index + 50);
            const { error } = await adminSession.supabase
              .from("email_list_members")
              .delete()
              .eq("list_id", listId)
              .in("email", chunk);

            if (error) {
              setUsersStatus(error.message, true);
              return false;
            }
          }

          for (const email of emails) {
            membershipByEmail.get(email)?.delete(listId);
          }
        }

        setPageCheckboxesForList(listId, false);
        setUsersStatus(
          toRemove.length === 0
            ? `None of the users on this page are on ${listName}.`
            : `Removed ${toRemove.length} user${toRemove.length === 1 ? "" : "s"} on this page from ${listName}.`,
        );
      }

      await reloadLists(false);
      return true;
    } finally {
      pageMembershipBusy = false;
      updateSelectAllCheckboxes();
    }
  }

  async function reloadLists(reloadUsers = true) {
    const { data, error } = await adminSession.supabase
      .from("email_lists")
      .select("id, name, created_at, updated_at, email_list_members(count)")
      .order("updated_at", { ascending: false });

    if (error) {
      if (errorEl) errorEl.textContent = error.message;
      return;
    }

    lists = (data ?? []).map((row) => {
      const mapped = mapEmailListRow(row as Record<string, unknown>);
      const countRow = (row as { email_list_members?: Array<{ count: number }> }).email_list_members?.[0];
      mapped.memberCount = countRow?.count ?? 0;
      return mapped;
    });

    renderLists();
    renderImportedUsersListsHeader();
    renderUsersTableHead();

    if (reloadUsers) {
      await loadUsers();
    }
  }

  function renderLists() {
    if (!listEl) return;

    if (lists.length === 0) {
      emptyEl?.removeAttribute("hidden");
      listEl.innerHTML = "";
      return;
    }

    emptyEl?.setAttribute("hidden", "");

    listEl.innerHTML = lists
      .map(
        (list) => `
          <li class="xa-templates__item">
            <a class="xa-templates__link" href="/admin/email-lists/edit/?id=${encodeURIComponent(list.id)}">
              <span class="xa-templates__icon" aria-hidden="true">☰</span>
              <span class="xa-templates__meta">
                <span class="xa-templates__name">${escapeHtml(list.name)}</span>
                <span class="xa-templates__subject">${list.memberCount ?? 0} member${list.memberCount === 1 ? "" : "s"}</span>
                <span class="xa-templates__updated">Updated ${escapeHtml(formatDate(list.updatedAt))}</span>
              </span>
              <span class="xa-templates__chevron" aria-hidden="true">›</span>
            </a>
          </li>
        `,
      )
      .join("");
  }

  function updateUserPagination(page: number, totalPages: number, total: number) {
    if (usersSummaryEl) {
      usersSummaryEl.textContent = `${total.toLocaleString()} imported user${total === 1 ? "" : "s"}`;
    }
    if (usersPageEl) {
      usersPageEl.textContent = `Page ${page} of ${totalPages}`;
    }
    if (usersFirstBtn) {
      (usersFirstBtn as HTMLButtonElement).disabled = page <= 1;
    }
    if (usersPrevBtn) {
      (usersPrevBtn as HTMLButtonElement).disabled = page <= 1;
    }
    if (usersNextBtn) {
      (usersNextBtn as HTMLButtonElement).disabled = page >= totalPages;
    }
    if (usersLastBtn) {
      (usersLastBtn as HTMLButtonElement).disabled = page >= totalPages;
    }
  }

  function bindRowInteractions(users: OldUser[]) {
    if (!usersBodyEl) return;

    usersBodyEl.querySelectorAll<HTMLInputElement>("[data-list-id]").forEach((checkbox) => {
      checkbox.addEventListener("click", (event) => {
        event.stopPropagation();
      });

      checkbox.addEventListener("change", () => {
        const row = checkbox.closest<HTMLTableRowElement>("[data-old-user-id]");
        const userId = row?.dataset.oldUserId;
        const listId = checkbox.dataset.listId;
        const user = users.find((item) => item.id === userId);

        if (!user || !listId || pageMembershipBusy) {
          checkbox.checked = !checkbox.checked;
          return;
        }

        const nextChecked = checkbox.checked;
        checkbox.disabled = true;

        void toggleListMembership(user, listId, nextChecked).then((ok) => {
          checkbox.disabled = false;
          if (!ok) {
            checkbox.checked = !nextChecked;
          }
        });
      });
    });

    usersBodyEl.querySelectorAll<HTMLTableRowElement>("[data-old-user-id]").forEach((row) => {
      const userId = row.dataset.oldUserId;
      const user = users.find((item) => item.id === userId);
      if (!user) return;

      const activate = () => {
        void selectUser(user);
      };

      row.addEventListener("click", activate);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      });
    });
  }

  async function loadUsers() {
    if (!usersBodyEl) return;

    setUsersStatus("Loading users…");

    const from = (userPage - 1) * USER_PAGE_SIZE;
    const to = from + USER_PAGE_SIZE - 1;
    const columnCount = userColumnCount();

    let query = adminSession.supabase
      .from("old_users")
      .select("id, old_id, name, f_name, l_name, email, created", { count: "exact" })
      .order("old_id", { ascending: true, nullsFirst: false })
      .range(from, to);

    const term = userSearch.trim().replaceAll(",", " ");
    if (term) {
      const pattern = `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      query = query.or(
        `name.ilike."${pattern}",f_name.ilike."${pattern}",l_name.ilike."${pattern}",email.ilike."${pattern}"`,
      );
    }

    const { data, error, count } = await query;

    if (error) {
      pageUsers = [];
      setUsersStatus(error.message, true);
      usersBodyEl.innerHTML = `<tr><td colspan="${columnCount}" class="xa-users__empty">Unable to load users.</td></tr>`;
      updateSelectAllCheckboxes();
      return;
    }

    userTotal = count ?? 0;
    const totalPages = Math.max(1, Math.ceil(userTotal / USER_PAGE_SIZE));
    userPage = Math.min(userPage, totalPages);

    const users = (data ?? []).map((row) => mapOldUserRow(row as Record<string, unknown>));
    pageUsers = users;
    await loadMembershipForEmails(users.map((user) => user.email ?? ""));

    if (users.length === 0) {
      usersBodyEl.innerHTML = `<tr><td colspan="${columnCount}" class="xa-users__empty">No users match your search.</td></tr>`;
    } else {
      usersBodyEl.innerHTML = users
        .map((user) => {
          const isSelected = selectedUser?.id === user.id;
          const emailKey = user.email?.toLowerCase() ?? "";
          const memberLists = membershipByEmail.get(emailKey) ?? new Set<string>();

          return `
            <tr
              class="xa-old-users__row${isSelected ? " xa-old-users__row--selected" : ""}"
              data-old-user-id="${escapeHtml(user.id)}"
              tabindex="0"
              role="button"
              aria-label="Select ${escapeHtml(oldUserDisplayName(user))}"
            >
              <td>${displayValue(oldUserDisplayName(user))}</td>
              <td>${displayValue(user.email)}</td>
              ${listsOldestFirst()
                .map((list) => {
                  const checked = memberLists.has(list.id);
                  const disabled = !user.email;
                  return `
                    <td class="xa-old-users__check-col">
                      <input
                        type="checkbox"
                        data-list-id="${escapeHtml(list.id)}"
                        aria-label="Add ${escapeHtml(oldUserDisplayName(user))} to ${escapeHtml(list.name)}"
                        ${checked ? "checked" : ""}
                        ${disabled ? "disabled" : ""}
                      />
                    </td>
                  `;
                })
                .join("")}
            </tr>
          `;
        })
        .join("");

      bindRowInteractions(users);
    }

    updateUserPagination(userPage, totalPages, userTotal);
    updateSelectAllCheckboxes();
    setUsersStatus(
      userTotal === 0
        ? "No users found."
        : `Showing ${from + 1}–${Math.min(from + USER_PAGE_SIZE, userTotal)} of ${userTotal.toLocaleString()}`,
    );
  }

  let searchTimer: number | undefined;

  usersSearchEl?.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      userSearch = usersSearchEl.value;
      userPage = 1;
      void loadUsers();
    }, 250);
  });

  usersFirstBtn?.addEventListener("click", () => {
    if (userPage <= 1) return;
    userPage = 1;
    void loadUsers();
  });

  usersPrevBtn?.addEventListener("click", () => {
    if (userPage <= 1) return;
    userPage -= 1;
    void loadUsers();
  });

  usersNextBtn?.addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil(userTotal / USER_PAGE_SIZE));
    if (userPage >= totalPages) return;
    userPage += 1;
    void loadUsers();
  });

  usersLastBtn?.addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil(userTotal / USER_PAGE_SIZE));
    if (userPage >= totalPages) return;
    userPage = totalPages;
    void loadUsers();
  });

  await reloadLists(false);
  renderSelectedUser();
  renderUsersTableHead();
  await loadUsers();
}

void init();
