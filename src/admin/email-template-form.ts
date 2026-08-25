import type { SupabaseClient } from "@supabase/supabase-js";
import { bindEmailImageResize } from "./email-image-resize";
import { buildEmailInlineImageBlock } from "../lib/email/email-inline-images";
import { uploadEmailTemplateImage } from "../lib/email/email-template-images";
import {
  buildEmailHtml,
  DEFAULT_FROM_EMAIL,
  FROM_EMAIL_OPTIONS,
  getDefaultEditableContent,
  normalizeEmailBodyHtml,
  splitEmailHtml,
} from "../lib/email/email-templates";
import { personalizeEmailHtml } from "../lib/email/personalize";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function bindEmailTemplateForm(options: {
  mode: "create" | "edit";
  supabase: SupabaseClient;
  uploadScopeId: string;
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
  const imageBtn = document.getElementById("xa-template-image") as HTMLButtonElement | null;
  const imageInput = document.getElementById("xa-template-image-input") as HTMLInputElement | null;
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
    editableContent: normalizeEmailBodyHtml(initialParts.editableContent || getDefaultEditableContent()),
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

  function emptyParagraph() {
    const p = document.createElement("p");
    p.innerHTML = "<br>";
    return p;
  }

  function meaningfulSibling(node: ChildNode | null, direction: "next" | "previous") {
    let current = node;
    while (current) {
      if (current.nodeType === Node.TEXT_NODE && !current.textContent?.trim()) {
        current = direction === "next" ? current.nextSibling : current.previousSibling;
        continue;
      }
      return current;
    }
    return null;
  }

  function isImageBlock(node: ChildNode | null) {
    return node instanceof HTMLElement && node.matches("[data-xyrra-email-inline-image]");
  }

  function prepareEditorImages() {
    editorField.querySelectorAll("p > [data-xyrra-email-inline-image]").forEach((block) => {
      const parent = block.parentElement;
      if (!parent) return;
      parent.before(block);
      if (!parent.textContent?.trim()) parent.remove();
    });

    editorField.querySelectorAll("[data-xyrra-email-inline-image]").forEach((block) => {
      if (!(block instanceof HTMLElement)) return;
      block.setAttribute("contenteditable", "false");
      const prev = meaningfulSibling(block.previousSibling, "previous");
      if (!prev || isImageBlock(prev)) block.before(emptyParagraph());
      const next = meaningfulSibling(block.nextSibling, "next");
      if (!next || isImageBlock(next)) block.after(emptyParagraph());
    });
  }

  function placeCaretIn(el: HTMLElement) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  prepareEditorImages();

  function isEmptyParagraph(node: ChildNode | null) {
    return (
      node instanceof HTMLElement &&
      node.tagName === "P" &&
      !node.textContent?.trim()
    );
  }

  function currentEditableContent() {
    const clone = editorField.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("[data-xyrra-email-inline-image]").forEach((block) => {
      block.removeAttribute("contenteditable");
      let next = block.nextSibling;
      while (next) {
        if (next.nodeType === Node.TEXT_NODE && !next.textContent?.trim()) {
          const whitespace = next;
          next = next.nextSibling;
          whitespace.remove();
          continue;
        }
        if (!isEmptyParagraph(next)) break;
        const empty = next;
        next = next.nextSibling;
        empty.remove();
      }
    });
    return clone.innerHTML.trim();
  }

  savedBaseline.editableContent = currentEditableContent();

  function currentBodyHtml() {
    return buildEmailHtml(currentEditableContent());
  }

  function updatePreview() {
    previewField.srcdoc = personalizeEmailHtml(currentBodyHtml(), "Alex");
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
    return stripped.length > 0 || /<img\b/i.test(content);
  }

  function updateSaveState() {
    saveButton.disabled =
      saveButton.dataset.pending === "true" ||
      subjectField.value.trim().length === 0 ||
      !isValidContent(currentEditableContent()) ||
      (options.mode === "create" ? !nameInput?.value.trim() : !hasChanges());
  }

  let previewRaf = 0;
  function schedulePreviewAndSaveState() {
    imageResize.sync();
    updateSaveState();
    cancelAnimationFrame(previewRaf);
    previewRaf = requestAnimationFrame(updatePreview);
  }

  const imageResize = bindEmailImageResize(editorField, {
    onChange: schedulePreviewAndSaveState,
  });

  function setImageBusy(busy: boolean) {
    if (imageBtn) {
      imageBtn.disabled = busy;
      imageBtn.textContent = busy ? "Uploading…" : "Image";
    }
    if (imageInput) imageInput.disabled = busy;
  }

  let savedRange: Range | null = null;

  function saveEditorRange() {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && editorField.contains(selection.anchorNode)) {
      savedRange = selection.getRangeAt(0).cloneRange();
    }
  }

  function restoreEditorRange() {
    editorField.focus();
    if (!savedRange) return;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    try {
      selection?.addRange(savedRange);
    } catch {
      savedRange = null;
    }
  }

  function insertImageHtml(html: string) {
    const insertId = `xa-img-${crypto.randomUUID()}`;
    const marked = html.replace(
      'data-xyrra-email-inline-image="true"',
      `data-xyrra-email-inline-image="true" data-xa-inserted="${insertId}"`,
    );
    restoreEditorRange();
    document.execCommand("insertHTML", false, marked);
    if (!editorField.querySelector(`[data-xa-inserted="${insertId}"]`)) {
      const last = editorField.lastElementChild;
      if (last) last.insertAdjacentHTML("beforebegin", marked);
      else editorField.insertAdjacentHTML("beforeend", marked);
    }

    prepareEditorImages();
    const block = editorField.querySelector(`[data-xa-inserted="${insertId}"]`);
    if (block instanceof HTMLElement) {
      block.removeAttribute("data-xa-inserted");
      const after = meaningfulSibling(block.nextSibling, "next");
      if (after instanceof HTMLElement) placeCaretIn(after);
    }
    imageResize.sync();
  }

  async function insertSelectedImage(files: FileList | null) {
    const file = files?.[0];
    if (!file || !options.uploadScopeId) return;

    setError("");
    setImageBusy(true);
    const result = await uploadEmailTemplateImage(options.supabase, {
      scopeId: options.uploadScopeId,
      file,
    });
    setImageBusy(false);
    if (imageInput) imageInput.value = "";

    if (!result.ok) {
      setError(result.error);
      return;
    }

    insertImageHtml(buildEmailInlineImageBlock(result.publicUrl, file.name.trim() || "Image"));
    updatePreview();
    updateSaveState();
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

  imageBtn?.addEventListener("mousedown", (event) => {
    event.preventDefault();
    saveEditorRange();
  });
  imageBtn?.addEventListener("click", () => {
    saveEditorRange();
    imageInput?.click();
  });
  imageInput?.addEventListener("change", () => {
    void insertSelectedImage(imageInput.files);
  });

  editorField.addEventListener("input", () => {
    imageResize.sync();
    updatePreview();
    updateSaveState();
  });

  editorField.addEventListener("click", (event) => {
    if (event.target !== editorField) return;
    const last = editorField.lastElementChild;
    if (!(last instanceof HTMLElement) || !last.matches("[data-xyrra-email-inline-image]")) return;
    const p = emptyParagraph();
    editorField.appendChild(p);
    placeCaretIn(p);
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
