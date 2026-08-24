import {
  buildEmailHtml,
  DEFAULT_FROM_EMAIL,
  FROM_EMAIL_OPTIONS,
  getDefaultEditableContent,
  splitEmailHtml,
} from "../lib/email/email-templates";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function bindEmailTemplateForm(options: {
  mode: "create" | "edit";
  initialName?: string;
  initialSubject?: string;
  initialFromEmail?: string;
  initialBodyHtml?: string;
  onSave: (payload: {
    name: string;
    subject: string;
    fromEmail: string;
    bodyHtml: string;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  onDuplicate?: (payload: {
    name: string;
    subject: string;
    fromEmail: string;
    bodyHtml: string;
  }) => Promise<void>;
}) {
  const nameInput = document.getElementById("xa-template-name") as HTMLInputElement | null;
  const subjectInput = document.getElementById("xa-template-subject") as HTMLInputElement | null;
  const fromSelect = document.getElementById("xa-template-from") as HTMLSelectElement | null;
  const editor = document.getElementById("xa-template-body") as HTMLDivElement | null;
  const previewFrame = document.getElementById("xa-template-preview") as HTMLIFrameElement | null;
  const saveBtn = document.getElementById("xa-template-save") as HTMLButtonElement | null;
  const duplicateBtn = document.getElementById("xa-template-duplicate") as HTMLButtonElement | null;
  const statusEl = document.getElementById("xa-template-status");
  const errorEl = document.getElementById("xa-template-error");

  if (!subjectInput || !fromSelect || !editor || !previewFrame || !saveBtn) {
    throw new Error("Email template form elements are missing");
  }

  const subjectField = subjectInput;
  const fromField = fromSelect;
  const editorField = editor;
  const previewField = previewFrame;
  const saveButton = saveBtn;

  if (options.mode === "create" && !nameInput) {
    throw new Error("Template name input is required for create mode");
  }

  const initialParts = splitEmailHtml(options.initialBodyHtml ?? buildEmailHtml(getDefaultEditableContent()));
  let savedBaseline = {
    name: options.initialName ?? "",
    subject: options.initialSubject ?? "",
    fromEmail: options.initialFromEmail ?? DEFAULT_FROM_EMAIL,
    editableContent: initialParts.editableContent || getDefaultEditableContent(),
  };

  if (nameInput) nameInput.value = savedBaseline.name;
  subjectField.value = savedBaseline.subject;
  fromField.innerHTML = FROM_EMAIL_OPTIONS.map(
    (email) => `<option value="${escapeHtml(email)}">${escapeHtml(email)}</option>`,
  ).join("");
  fromField.value = FROM_EMAIL_OPTIONS.includes(savedBaseline.fromEmail as (typeof FROM_EMAIL_OPTIONS)[number])
    ? savedBaseline.fromEmail
    : DEFAULT_FROM_EMAIL;
  editorField.innerHTML = savedBaseline.editableContent;

  function currentEditableContent() {
    return editorField.innerHTML.trim();
  }

  function currentBodyHtml() {
    return buildEmailHtml(currentEditableContent());
  }

  function updatePreview() {
    previewField.srcdoc = currentBodyHtml();
  }

  function setStatus(message: string, isError = false) {
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.classList.toggle("xa-template__status--error", isError);
    }
    if (errorEl && !isError) {
      errorEl.textContent = "";
    }
  }

  function setError(message: string) {
    if (errorEl) {
      errorEl.textContent = message;
    }
    setStatus("", false);
  }

  function hasChanges() {
    const name = nameInput?.value.trim() ?? "";
    return (
      name !== savedBaseline.name ||
      subjectField.value.trim() !== savedBaseline.subject ||
      fromField.value !== savedBaseline.fromEmail ||
      currentEditableContent() !== savedBaseline.editableContent
    );
  }

  function isValidContent(content: string) {
    const stripped = content.replace(/<[^>]+>/g, "").trim();
    return stripped.length > 0;
  }

  function updateSaveState() {
    saveButton.disabled =
      saveButton.dataset.pending === "true" ||
      subjectField.value.trim().length === 0 ||
      !isValidContent(currentEditableContent()) ||
      (options.mode === "create" ? !nameInput?.value.trim() : !hasChanges());
  }

  function execCommand(command: string, value?: string) {
    editorField.focus();
    document.execCommand(command, false, value);
    updatePreview();
    updateSaveState();
  }

  document.querySelectorAll<HTMLButtonElement>("[data-xa-editor-cmd]").forEach((button) => {
    button.addEventListener("click", () => {
      const command = button.dataset.xaEditorCmd;
      if (!command) return;
      if (command === "createLink") {
        const url = window.prompt("Link URL");
        if (url?.trim()) execCommand("createLink", url.trim());
        return;
      }
      execCommand(command);
    });
  });

  editorField.addEventListener("input", () => {
    updatePreview();
    updateSaveState();
  });

  nameInput?.addEventListener("input", updateSaveState);
  subjectField.addEventListener("input", () => {
    updatePreview();
    updateSaveState();
  });
  fromField.addEventListener("change", updateSaveState);

  saveButton.addEventListener("click", () => {
    void (async () => {
      setError("");
      saveButton.dataset.pending = "true";
      saveButton.textContent = "Saving…";
      updateSaveState();

      const result = await options.onSave({
        name: nameInput?.value.trim() ?? "",
        subject: subjectField.value.trim(),
        fromEmail: fromField.value,
        bodyHtml: currentBodyHtml(),
      });

      saveButton.dataset.pending = "false";
      saveButton.textContent = "Save template";

      if (!result.ok) {
        setError(result.error);
        updateSaveState();
        return;
      }

      savedBaseline = {
        name: nameInput?.value.trim() ?? "",
        subject: subjectField.value.trim(),
        fromEmail: fromField.value,
        editableContent: currentEditableContent(),
      };
      setStatus("Template saved.");
      updateSaveState();
    })();
  });

  duplicateBtn?.addEventListener("click", () => {
    if (!options.onDuplicate) return;
    void options.onDuplicate({
      name: nameInput?.value.trim() ?? "",
      subject: subjectField.value.trim(),
      fromEmail: fromField.value,
      bodyHtml: currentBodyHtml(),
    });
  });

  updatePreview();
  updateSaveState();

  return {
    getCurrentPayload() {
      return {
        name: nameInput?.value.trim() ?? "",
        subject: subjectField.value.trim(),
        fromEmail: fromField.value,
        bodyHtml: currentBodyHtml(),
      };
    },
  };
}
