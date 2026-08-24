import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { bindEmailTemplateForm } from "./email-template-form";
import { initAdminShell } from "./shell";
import {
  duplicateTemplateName,
  mapEmailTemplateRow,
} from "../lib/email/email-templates";

function getTemplateId() {
  return new URLSearchParams(window.location.search).get("id")?.trim() ?? "";
}

async function init() {
  const session = await requireAdminSession();
  if (!session) return;

  const templateId = getTemplateId();
  if (!templateId) {
    window.location.replace("/admin/email-templates/");
    return;
  }

  initAdminShell(session, "email-templates");
  setAdminLoading(false);

  const titleEl = document.getElementById("xa-template-title");
  const backLink = document.getElementById("xa-template-back");

  const { data, error } = await session.supabase
    .from("email_templates")
    .select("id, name, subject, body_html, from_email, created_at, updated_at")
    .eq("id", templateId)
    .maybeSingle();

  if (error || !data) {
    if (titleEl) titleEl.textContent = "Template not found";
    const errorEl = document.getElementById("xa-template-error");
    if (errorEl) {
      errorEl.textContent = error?.message ?? "This template could not be found.";
    }
    return;
  }

  const template = mapEmailTemplateRow(data);
  if (titleEl) titleEl.textContent = template.name;
  if (backLink) backLink.setAttribute("href", "/admin/email-templates/");

  bindEmailTemplateForm({
    mode: "edit",
    initialName: template.name,
    initialSubject: template.subject,
    initialFromEmail: template.fromEmail,
    initialBodyHtml: template.bodyHtml,
    onSave: async ({ name, subject, fromEmail, bodyHtml }) => {
      const { error: saveError } = await session.supabase
        .from("email_templates")
        .update({
          name,
          subject,
          body_html: bodyHtml,
          from_email: fromEmail,
        })
        .eq("id", template.id);

      if (saveError) {
        return { ok: false, error: saveError.message };
      }

      if (titleEl) titleEl.textContent = name;
      return { ok: true };
    },
    onDuplicate: async (payload) => {
      const { data: duplicate, error: duplicateError } = await session.supabase
        .from("email_templates")
        .insert({
          name: duplicateTemplateName(payload.name),
          subject: payload.subject,
          body_html: payload.bodyHtml,
          from_email: payload.fromEmail,
          created_by: session.user.id,
        })
        .select("id")
        .single();

      if (duplicateError || !duplicate) {
        const errorEl = document.getElementById("xa-template-error");
        if (errorEl) {
          errorEl.textContent = duplicateError?.message ?? "Unable to duplicate template.";
        }
        return;
      }

      window.location.replace(`/admin/email-templates/edit/?id=${duplicate.id}`);
    },
  });
}

void init();
