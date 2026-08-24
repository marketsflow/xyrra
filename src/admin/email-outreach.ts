import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";
import { mapEmailListRow } from "../lib/email/email-lists";
import {
  DEFAULT_FROM_EMAIL,
  FROM_EMAIL_OPTIONS,
  mapEmailTemplateRow,
} from "../lib/email/email-templates";
import { personalizeEmailHtml } from "../lib/email/personalize";

type TemplateItem = ReturnType<typeof mapEmailTemplateRow>;
type ListItem = ReturnType<typeof mapEmailListRow>;

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function init() {
  const session = await requireAdminSession();
  if (!session) return;

  const adminSession = session;

  initAdminShell(adminSession, "email-outreach");
  setAdminLoading(false);

  const templatesEl = document.getElementById("xa-outreach-templates");
  const listsEl = document.getElementById("xa-outreach-lists");
  const templatesEmptyEl = document.getElementById("xa-outreach-templates-empty");
  const listsEmptyEl = document.getElementById("xa-outreach-lists-empty");
  const errorEl = document.getElementById("xa-outreach-error");
  const statusEl = document.getElementById("xa-outreach-status");
  const subjectInput = document.getElementById("xa-outreach-subject") as HTMLInputElement | null;
  const fromSelect = document.getElementById("xa-outreach-from") as HTMLSelectElement | null;
  const previewFrame = document.getElementById("xa-outreach-preview") as HTMLIFrameElement | null;
  const previewHint = document.getElementById("xa-outreach-preview-hint");
  const sendBtn = document.getElementById("xa-outreach-send") as HTMLButtonElement | null;

  if (!templatesEl || !listsEl || !subjectInput || !fromSelect || !previewFrame || !sendBtn) {
    return;
  }

  const templatesList = templatesEl;
  const listsList = listsEl;
  const subjectField = subjectInput;
  const fromField = fromSelect;
  const preview = previewFrame;
  const sendButton = sendBtn;

  fromField.innerHTML = FROM_EMAIL_OPTIONS.map(
    (email) => `<option value="${escapeHtml(email)}">${escapeHtml(email)}</option>`,
  ).join("");
  fromField.value = DEFAULT_FROM_EMAIL;

  let templates: TemplateItem[] = [];
  let lists: ListItem[] = [];
  let selectedTemplateId = "";
  let selectedListId = "";
  let previewMode: "desktop" | "mobile" = "desktop";
  let sampleName = "Alex";
  let sending = false;

  function setError(message: string) {
    if (errorEl) errorEl.textContent = message;
    if (statusEl && message) statusEl.textContent = "";
  }

  function setStatus(message: string) {
    if (statusEl) statusEl.textContent = message;
    if (errorEl && message) errorEl.textContent = "";
  }

  function selectedTemplate() {
    return templates.find((template) => template.id === selectedTemplateId) ?? null;
  }

  function selectedList() {
    return lists.find((list) => list.id === selectedListId) ?? null;
  }

  function updateSendState() {
    sendButton.disabled =
      sending ||
      !selectedTemplateId ||
      !selectedListId ||
      subjectField.value.trim().length === 0 ||
      !fromField.value;
  }

  function updatePreview() {
    const template = selectedTemplate();
    preview.classList.toggle("xa-outreach-preview__frame--desktop", previewMode === "desktop");
    preview.classList.toggle("xa-outreach-preview__frame--mobile", previewMode === "mobile");

    document.querySelectorAll<HTMLButtonElement>("[data-xa-preview-mode]").forEach((button) => {
      button.classList.toggle("xa-outreach-preview__toggle--active", button.dataset.xaPreviewMode === previewMode);
    });

    if (!template) {
      preview.removeAttribute("srcdoc");
      if (previewHint) {
        previewHint.textContent = "Select a template to preview the email body.";
      }
      return;
    }

    preview.srcdoc = personalizeEmailHtml(template.bodyHtml, sampleName);
    if (previewHint) {
      const list = selectedList();
      previewHint.textContent = list
        ? `Preview personalized with ${sampleName} from “${list.name}”.`
        : `Preview personalized with ${sampleName}. Select a list to use a real recipient name.`;
    }
  }

  function renderTemplates() {
    if (templates.length === 0) {
      templatesEmptyEl?.removeAttribute("hidden");
      templatesList.innerHTML = "";
      return;
    }

    templatesEmptyEl?.setAttribute("hidden", "");
    templatesList.innerHTML = templates
      .map(
        (template) => `
          <li>
            <button
              type="button"
              class="xa-picker__item${template.id === selectedTemplateId ? " xa-picker__item--selected" : ""}"
              data-template-id="${escapeHtml(template.id)}"
            >
              <span class="xa-templates__icon" aria-hidden="true">✉</span>
              <span class="xa-templates__meta">
                <span class="xa-templates__name">${escapeHtml(template.name)}</span>
                <span class="xa-templates__subject">${escapeHtml(template.subject)}</span>
              </span>
            </button>
          </li>
        `,
      )
      .join("");

    templatesList.querySelectorAll<HTMLButtonElement>("[data-template-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const template = templates.find((item) => item.id === button.dataset.templateId);
        if (!template) return;
        selectedTemplateId = template.id;
        subjectField.value = template.subject;
        fromField.value = FROM_EMAIL_OPTIONS.includes(template.fromEmail as (typeof FROM_EMAIL_OPTIONS)[number])
          ? template.fromEmail
          : DEFAULT_FROM_EMAIL;
        renderTemplates();
        updatePreview();
        updateSendState();
      });
    });
  }

  function renderLists() {
    if (lists.length === 0) {
      listsEmptyEl?.removeAttribute("hidden");
      listsList.innerHTML = "";
      return;
    }

    listsEmptyEl?.setAttribute("hidden", "");
    listsList.innerHTML = lists
      .map((list) => {
        const count = list.memberCount ?? 0;
        const countLabel = `${count} recipient${count === 1 ? "" : "s"}`;
        return `
          <li>
            <button
              type="button"
              class="xa-picker__item${list.id === selectedListId ? " xa-picker__item--selected" : ""}"
              data-list-id="${escapeHtml(list.id)}"
            >
              <span class="xa-templates__icon" aria-hidden="true">☰</span>
              <span class="xa-templates__meta">
                <span class="xa-templates__name">${escapeHtml(list.name)}</span>
                <span class="xa-templates__subject">${escapeHtml(countLabel)}</span>
              </span>
            </button>
          </li>
        `;
      })
      .join("");

    listsList.querySelectorAll<HTMLButtonElement>("[data-list-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const list = lists.find((item) => item.id === button.dataset.listId);
        if (!list) return;
        selectedListId = list.id;
        renderLists();
        void loadSampleName(list.id);
        updateSendState();
      });
    });
  }

  async function loadSampleName(listId: string) {
    const { data } = await adminSession.supabase
      .from("email_list_members")
      .select("name")
      .eq("list_id", listId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    sampleName = data?.name?.trim() || "Alex";
    updatePreview();
  }

  subjectField.addEventListener("input", updateSendState);
  fromField.addEventListener("change", updateSendState);

  document.querySelectorAll<HTMLButtonElement>("[data-xa-preview-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.dataset.xaPreviewMode;
      if (mode !== "desktop" && mode !== "mobile") return;
      previewMode = mode;
      updatePreview();
    });
  });

  sendButton.addEventListener("click", () => {
    void (async () => {
      const template = selectedTemplate();
      const list = selectedList();
      const subject = subjectField.value.trim();
      const fromEmail = fromField.value;
      if (!template || !list || !subject || !fromEmail || sending) return;

      const recipientCount = list.memberCount ?? 0;
      const confirmed = window.confirm(
        `Send “${subject}” to ${recipientCount} recipient${recipientCount === 1 ? "" : "s"} on “${list.name}”?`,
      );
      if (!confirmed) return;

      sending = true;
      sendButton.textContent = "Sending…";
      updateSendState();
      setError("");
      setStatus("");

      try {
        const auth = await adminSession.supabase.auth.getSession();
        const accessToken = auth.data.session?.access_token;
        if (!accessToken) {
          throw new Error("Your session expired. Sign in again.");
        }

        const response = await fetch("/api/email-outreach", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            templateId: template.id,
            listId: list.id,
            subject,
            fromEmail,
          }),
        });

        const raw = await response.text();
        let body: { success?: boolean; message?: string; sentCount?: number; failedCount?: number } = {};
        if (raw) {
          try {
            body = JSON.parse(raw) as typeof body;
          } catch {
            throw new Error("The send API did not return JSON.");
          }
        }

        if (!response.ok || !body.success) {
          throw new Error(body.message || "Unable to send this outreach email.");
        }

        const failedNote =
          body.failedCount && body.failedCount > 0
            ? ` ${body.failedCount} failed.`
            : "";
        setStatus(`Sent ${body.sentCount ?? 0} email${body.sentCount === 1 ? "" : "s"}.${failedNote}`);
      } catch (error) {
        setError(error instanceof Error ? error.message : "Unable to send this outreach email.");
      } finally {
        sending = false;
        sendButton.textContent = "Send";
        updateSendState();
      }
    })();
  });

  const [templatesResult, listsResult] = await Promise.all([
    adminSession.supabase
      .from("email_templates")
      .select("id, name, subject, body_html, from_email, created_at, updated_at")
      .order("updated_at", { ascending: false }),
    adminSession.supabase
      .from("email_lists")
      .select("id, name, created_at, updated_at, email_list_members(count)")
      .order("updated_at", { ascending: false }),
  ]);

  if (templatesResult.error) {
    setError(templatesResult.error.message);
    return;
  }
  if (listsResult.error) {
    setError(listsResult.error.message);
    return;
  }

  templates = (templatesResult.data ?? []).map(mapEmailTemplateRow);
  lists = (listsResult.data ?? []).map((row) => {
    const mapped = mapEmailListRow(row as Record<string, unknown>);
    const countRow = (row as { email_list_members?: Array<{ count: number }> }).email_list_members?.[0];
    return {
      ...mapped,
      memberCount: countRow?.count ?? mapped.memberCount ?? 0,
    };
  });

  renderTemplates();
  renderLists();
  updatePreview();
  updateSendState();
}

void init();
