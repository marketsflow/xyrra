import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { bindEmailTemplateForm } from "./email-template-form";
import { initAdminShell } from "./shell";
import { buildEmailHtml, getDefaultEditableContent } from "../lib/email/email-templates";

async function init() {
  const session = await requireAdminSession();
  if (!session) return;

  initAdminShell(session, "email-templates");
  setAdminLoading(false);

  bindEmailTemplateForm({
    mode: "create",
    supabase: session.supabase,
    uploadScopeId: crypto.randomUUID(),
    initialBodyHtml: buildEmailHtml(getDefaultEditableContent()),
    onSave: async ({ name, subject, fromEmail, bodyHtml }) => {
      const { data, error } = await session.supabase
        .from("email_templates")
        .insert({
          name,
          subject,
          body_html: bodyHtml,
          from_email: fromEmail,
          created_by: session.user.id,
        })
        .select("id")
        .single();

      if (error) {
        return { ok: false, error: error.message };
      }

      window.location.replace(`/admin/email-templates/edit/?id=${data.id}`);
      return { ok: true };
    },
  });
}

void init();
