import type { AdminSession } from "./auth-guard";
import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";
import {
  duplicateTemplateName,
  mapEmailTemplateRow,
} from "../lib/email/email-templates";

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

async function duplicateTemplate(session: AdminSession, template: ReturnType<typeof mapEmailTemplateRow>) {
  const { data, error } = await session.supabase
    .from("email_templates")
    .insert({
      name: duplicateTemplateName(template.name),
      subject: template.subject,
      body_html: template.bodyHtml,
      from_email: template.fromEmail,
      created_by: session.user.id,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? "Unable to duplicate template.");
  }

  window.location.replace(`/admin/email-templates/edit/?id=${data.id}`);
}

async function init() {
  const session = await requireAdminSession();
  if (!session) return;

  initAdminShell(session, "email-templates");
  setAdminLoading(false);

  const listEl = document.getElementById("xa-templates-list");
  const emptyEl = document.getElementById("xa-templates-empty");
  const errorEl = document.getElementById("xa-templates-error");

  const { data, error } = await session.supabase
    .from("email_templates")
    .select("id, name, subject, body_html, from_email, created_at, updated_at")
    .order("updated_at", { ascending: false });

  if (error) {
    if (errorEl) errorEl.textContent = error.message;
    return;
  }

  const templates = (data ?? []).map(mapEmailTemplateRow);

  if (templates.length === 0) {
    emptyEl?.removeAttribute("hidden");
    return;
  }

  emptyEl?.setAttribute("hidden", "");

  if (!listEl) return;

  listEl.innerHTML = templates
    .map(
      (template) => `
        <li class="xa-templates__item">
          <a class="xa-templates__link" href="/admin/email-templates/edit/?id=${encodeURIComponent(template.id)}">
            <span class="xa-templates__icon" aria-hidden="true">✉</span>
            <span class="xa-templates__meta">
              <span class="xa-templates__name">${escapeHtml(template.name)}</span>
              <span class="xa-templates__subject">${escapeHtml(template.subject)}</span>
              <span class="xa-templates__updated">Updated ${escapeHtml(formatDate(template.updatedAt))}</span>
            </span>
            <span class="xa-templates__chevron" aria-hidden="true">›</span>
          </a>
          <button
            type="button"
            class="xa-templates__duplicate"
            data-duplicate-id="${escapeHtml(template.id)}"
          >
            Duplicate
          </button>
        </li>
      `,
    )
    .join("");

  listEl.querySelectorAll<HTMLButtonElement>("[data-duplicate-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.duplicateId;
      const template = templates.find((item) => item.id === id);
      if (!template) return;

      button.disabled = true;
      button.textContent = "Duplicating…";

      void duplicateTemplate(session, template).catch((duplicateError) => {
        button.disabled = false;
        button.textContent = "Duplicate";
        if (errorEl) {
          errorEl.textContent =
            duplicateError instanceof Error ? duplicateError.message : "Unable to duplicate template.";
        }
      });
    });
  });
}

void init();
