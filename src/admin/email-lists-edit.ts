import { requireAdminSession, setAdminLoading } from "./auth-guard";
import {
  bindEmailListMembers,
  mapMemberRows,
  readMemberForm,
  validateMemberInput,
} from "./email-list-members";
import { initAdminShell } from "./shell";
import { mapEmailListRow } from "../lib/email/email-lists";
import { mapOldUserRow, oldUserDisplayName, type OldUser } from "../lib/users/old-users";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function getListId() {
  return new URLSearchParams(window.location.search).get("id")?.trim() ?? "";
}

async function init() {
  const session = await requireAdminSession();
  if (!session) return;

  const listId = getListId();
  if (!listId) {
    window.location.replace("/admin/email-lists/");
    return;
  }

  initAdminShell(session, "email-lists");
  setAdminLoading(false);

  const titleEl = document.getElementById("xa-email-list-title");
  const nameInput = document.getElementById("xa-email-list-name") as HTMLInputElement | null;
  const addForm = document.getElementById("xa-email-list-add-form") as HTMLFormElement | null;
  const saveBtn = document.getElementById("xa-email-list-save") as HTMLButtonElement | null;
  const usersBody = document.getElementById("xa-email-list-users-body");
  const usersStatus = document.getElementById("xa-email-list-users-status");
  const errorEl = document.getElementById("xa-email-list-error");
  const statusEl = document.getElementById("xa-email-list-status");

  if (!nameInput || !addForm || !saveBtn) {
    return;
  }

  const listNameInput = nameInput;
  const saveButton = saveBtn;
  const adminSession = session;
  let listEmails = new Set<string>();

  const { data: listData, error: listError } = await adminSession.supabase
    .from("email_lists")
    .select("id, name, created_at, updated_at")
    .eq("id", listId)
    .maybeSingle();

  if (listError || !listData) {
    if (titleEl) titleEl.textContent = "List not found";
    if (errorEl) {
      errorEl.textContent = listError?.message ?? "This email list could not be found.";
    }
    return;
  }

  const list = mapEmailListRow(listData);
  if (titleEl) titleEl.textContent = list.name;
  listNameInput.value = list.name;
  let savedName = list.name;

  const membersUi = bindEmailListMembers({
    membersBodyId: "xa-email-list-members-body",
    memberCountId: "xa-email-list-member-count",
    onRemove: async (memberId) => {
      const { error } = await adminSession.supabase.from("email_list_members").delete().eq("id", memberId);
      if (error) {
        setError(error.message);
        return;
      }
      const removedMember = membersUi.getMembers().find((member) => member.id === memberId);
      membersUi.removeMember(memberId);
      if (removedMember) listEmails.delete(removedMember.email.toLowerCase());
      setStatus("Member removed.");
      updateSaveState();
    },
  });

  async function loadMembers() {
    const { data, error } = await adminSession.supabase
      .from("email_list_members")
      .select("id, list_id, name, email, created_at")
      .eq("list_id", listId)
      .order("created_at", { ascending: true });

    if (error) {
      setError(error.message);
      return;
    }

    membersUi.setMembers(mapMemberRows((data ?? []) as Record<string, unknown>[]));
    listEmails = new Set(membersUi.getMembers().map((member) => member.email.toLowerCase()));
  }

  function renderUsers(users: OldUser[]) {
    if (!usersBody) return;

    if (users.length === 0) {
      usersBody.innerHTML = '<tr><td colspan="3" class="xa-users__empty">No users found.</td></tr>';
      return;
    }

    usersBody.innerHTML = users
      .map((user) => {
        const email = user.email?.trim().toLowerCase() ?? "";
        const displayName = oldUserDisplayName(user);
        return `
          <tr>
            <td>${escapeHtml(displayName)}</td>
            <td>${escapeHtml(user.email ?? "—")}</td>
            <td class="xa-email-list__check-cell">
              <input
                type="checkbox"
                data-user-id="${escapeHtml(user.id)}"
                aria-label="Add ${escapeHtml(displayName)} to this list"
                ${email && listEmails.has(email) ? "checked" : ""}
                ${email ? "" : "disabled"}
              />
            </td>
          </tr>
        `;
      })
      .join("");

    usersBody.querySelectorAll<HTMLInputElement>("[data-user-id]").forEach((checkbox) => {
      checkbox.addEventListener("change", () => {
        const user = users.find((item) => item.id === checkbox.dataset.userId);
        if (!user?.email) return;

        checkbox.disabled = true;
        void toggleUserMembership(user, checkbox.checked).then((success) => {
          checkbox.disabled = false;
          if (!success) checkbox.checked = !checkbox.checked;
        });
      });
    });
  }

  async function toggleUserMembership(user: OldUser, checked: boolean) {
    const email = user.email!.trim().toLowerCase();
    const displayName = oldUserDisplayName(user);
    const result = checked
      ? await adminSession.supabase
          .from("email_list_members")
          .insert({ list_id: listId, name: displayName, email, old_user_id: user.id })
      : await adminSession.supabase
          .from("email_list_members")
          .delete()
          .eq("list_id", listId)
          .eq("email", email);

    if (result.error) {
      setError(result.error.message);
      return false;
    }

    if (checked) {
      listEmails.add(email);
      setStatus(`${displayName} added to the list.`);
    } else {
      listEmails.delete(email);
      setStatus(`${displayName} removed from the list.`);
    }
    return true;
  }

  async function loadUsers() {
    if (!usersBody) return;
    if (usersStatus) usersStatus.textContent = "Loading users…";

    const { data, error } = await adminSession.supabase
      .from("old_users")
      .select("id, old_id, name, f_name, l_name, email, created")
      .order("old_id", { ascending: false, nullsFirst: false });

    if (error) {
      usersBody.innerHTML = `<tr><td colspan="3" class="xa-users__empty">${escapeHtml(error.message)}</td></tr>`;
      if (usersStatus) usersStatus.textContent = "Unable to load users.";
      return;
    }

    const users = (data ?? []).map((row) => mapOldUserRow(row as Record<string, unknown>));
    renderUsers(users);
    if (usersStatus) {
      usersStatus.textContent = `${users.length.toLocaleString()} users, sorted newest first`;
    }
  }

  function setError(message: string) {
    if (errorEl) errorEl.textContent = message;
    if (statusEl && message) statusEl.textContent = "";
  }

  function setStatus(message: string) {
    if (statusEl) statusEl.textContent = message;
    if (errorEl) errorEl.textContent = "";
  }

  function updateSaveState() {
    saveButton.disabled =
      saveButton.dataset.pending === "true" ||
      !listNameInput.value.trim() ||
      listNameInput.value.trim() === savedName;
  }

  addForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const { name, email, clear } = readMemberForm(addForm);
      const validationError = validateMemberInput(
        email,
        membersUi.getMembers().map((member) => member.email),
      );
      if (validationError) {
        setError(validationError);
        return;
      }

      const { data, error } = await adminSession.supabase
        .from("email_list_members")
        .insert({
          list_id: listId,
          name: name || null,
          email: email.toLowerCase(),
        })
        .select("id, list_id, name, email, created_at")
        .single();

      if (error || !data) {
        setError(error?.message ?? "Unable to add member.");
        return;
      }

      const addedMember = mapMemberRows([data as Record<string, unknown>])[0];
      membersUi.addMember(addedMember);
      listEmails.add(addedMember.email.toLowerCase());
      clear();
      setStatus("Member added.");
      updateSaveState();
    })();
  });

  listNameInput.addEventListener("input", updateSaveState);

  saveButton.addEventListener("click", () => {
    void (async () => {
      const nextName = listNameInput.value.trim();
      if (!nextName) {
        setError("List name is required.");
        return;
      }

      saveButton.dataset.pending = "true";
      saveButton.textContent = "Saving…";
      updateSaveState();

      const { error } = await adminSession.supabase
        .from("email_lists")
        .update({ name: nextName })
        .eq("id", listId);

      saveButton.dataset.pending = "false";
      saveButton.textContent = "Save list name";

      if (error) {
        setError(error.message);
        updateSaveState();
        return;
      }

      savedName = nextName;
      if (titleEl) titleEl.textContent = nextName;
      setStatus("List name saved.");
      updateSaveState();
    })();
  });

  await loadMembers();
  await loadUsers();
  updateSaveState();
}

void init();
