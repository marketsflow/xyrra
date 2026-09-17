import { requireAdminSession, setAdminLoading } from "./auth-guard";
import {
  bindEmailListMembers,
  readMemberForm,
  validateMemberInput,
} from "./email-list-members";
import { initAdminShell } from "./shell";

type PendingMember = {
  id: string;
  name: string;
  email: string;
};

function makePendingId() {
  return `pending-${crypto.randomUUID()}`;
}

async function init() {
  const session = await requireAdminSession();
  if (!session) return;

  initAdminShell(session, "email-lists");
  setAdminLoading(false);

  const nameInput = document.getElementById("xa-email-list-name") as HTMLInputElement | null;
  const addForm = document.getElementById("xa-email-list-add-form") as HTMLFormElement | null;
  const createBtn = document.getElementById("xa-email-list-create") as HTMLButtonElement | null;
  const errorEl = document.getElementById("xa-email-list-error");
  const statusEl = document.getElementById("xa-email-list-status");

  if (!nameInput || !addForm || !createBtn) {
    return;
  }

  const listNameInput = nameInput;
  const createButton = createBtn;

  let pendingMembers: PendingMember[] = [];

  const membersUi = bindEmailListMembers({
    membersBodyId: "xa-email-list-members-body",
    memberCountId: "xa-email-list-member-count",
    onRemove: (memberId) => {
      pendingMembers = pendingMembers.filter((member) => member.id !== memberId);
      membersUi.setMembers(
        pendingMembers.map((member) => ({
          id: member.id,
          listId: "pending",
          name: member.name,
          email: member.email,
          oldUserId: null,
          createdAt: "",
        })),
      );
      updateCreateState();
    },
  });

  membersUi.render();

  function setError(message: string) {
    if (errorEl) errorEl.textContent = message;
    if (statusEl) statusEl.textContent = "";
  }

  function setStatus(message: string) {
    if (statusEl) statusEl.textContent = message;
    if (errorEl) errorEl.textContent = "";
  }

  function updateCreateState() {
    createButton.disabled =
      createButton.dataset.pending === "true" || !listNameInput.value.trim();
  }

  addForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const { name, email, clear } = readMemberForm(addForm);
    const validationError = validateMemberInput(
      email,
      pendingMembers.map((member) => member.email),
    );
    if (validationError) {
      setError(validationError);
      return;
    }

    pendingMembers = [
      ...pendingMembers,
      { id: makePendingId(), name, email: email.toLowerCase() },
    ];
    membersUi.setMembers(
      pendingMembers.map((member) => ({
        id: member.id,
        listId: "pending",
        name: member.name,
        email: member.email,
        oldUserId: null,
        createdAt: "",
      })),
    );
    clear();
    setStatus("Member added.");
    updateCreateState();
  });

  listNameInput.addEventListener("input", updateCreateState);

  createButton.addEventListener("click", () => {
    void (async () => {
      const listName = listNameInput.value.trim();
      if (!listName) {
        setError("List name is required.");
        return;
      }

      setError("");
      createButton.dataset.pending = "true";
      createButton.textContent = "Creating…";
      updateCreateState();

      const { data: list, error: listError } = await session.supabase
        .from("email_lists")
        .insert({
          name: listName,
          created_by: session.user.id,
        })
        .select("id")
        .single();

      if (listError || !list) {
        createButton.dataset.pending = "false";
        createButton.textContent = "Create list";
        setError(listError?.message ?? "Unable to create email list.");
        updateCreateState();
        return;
      }

      if (pendingMembers.length > 0) {
        const { error: membersError } = await session.supabase.from("email_list_members").insert(
          pendingMembers.map((member) => ({
            list_id: list.id,
            name: member.name,
            email: member.email,
          })),
        );

        if (membersError) {
          await session.supabase.from("email_lists").delete().eq("id", list.id);
          createButton.dataset.pending = "false";
          createButton.textContent = "Create list";
          setError(membersError.message);
          updateCreateState();
          return;
        }
      }

      window.location.replace(`/admin/email-lists/edit/?id=${list.id}`);
    })();
  });

  updateCreateState();
}

void init();
