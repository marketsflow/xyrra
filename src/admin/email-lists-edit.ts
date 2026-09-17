import { requireAdminSession, setAdminLoading } from "./auth-guard";
import {
  bindEmailListMembers,
  mapMemberRows,
  readMemberForm,
  validateMemberInput,
} from "./email-list-members";
import { initAdminShell } from "./shell";
import { mapEmailListRow } from "../lib/email/email-lists";

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
  const errorEl = document.getElementById("xa-email-list-error");
  const statusEl = document.getElementById("xa-email-list-status");

  if (!nameInput || !addForm || !saveBtn) {
    return;
  }

  const listNameInput = nameInput;
  const saveButton = saveBtn;
  const adminSession = session;

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
      membersUi.removeMember(memberId);
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

      membersUi.addMember(mapMemberRows([data as Record<string, unknown>])[0]);
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
  updateSaveState();
}

void init();
