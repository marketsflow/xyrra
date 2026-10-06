import { bindArticleForm } from "./article-form";
import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";
import { articleSaveError, articleWritePayload } from "../lib/articles/save";

async function init() {
  const session = await requireAdminSession();
  if (!session) return;

  initAdminShell(session, "articles");
  setAdminLoading(false);

  bindArticleForm({
    supabase: session.supabase,
    uploadScopeId: crypto.randomUUID(),
    onSave: async (values) => {
      const { data, error } = await session.supabase
        .from("articles")
        .insert(articleWritePayload(values, session.user.id, true))
        .select("id")
        .single();

      if (error || !data) {
        return { ok: false, error: articleSaveError(error?.message ?? "Unable to create the article.") };
      }

      window.location.replace(`/admin/articles/edit/?id=${data.id}`);
      return { ok: true };
    },
  });
}

void init();
