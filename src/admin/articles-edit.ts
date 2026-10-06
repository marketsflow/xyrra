import { bindArticleForm, type ArticleFormValues } from "./article-form";
import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";
import { articleSaveError, articleWritePayload } from "../lib/articles/save";

type ArticleRow = {
  id: string;
  slug: string;
  title: string;
  meta_title: string | null;
  meta_description: string | null;
  excerpt: string | null;
  body_html: string;
  key_points: string[] | null;
  faqs: ArticleFormValues["faqs"] | null;
  hero_image_url: string | null;
  hero_image_alt: string | null;
  keywords: string[] | null;
  author_name: string | null;
  status: string;
};

function getArticleId() {
  return new URLSearchParams(window.location.search).get("id")?.trim() ?? "";
}

async function init() {
  const session = await requireAdminSession();
  if (!session) return;

  const articleId = getArticleId();
  if (!articleId) {
    window.location.replace("/admin/articles/");
    return;
  }

  initAdminShell(session, "articles");

  const { data, error } = await session.supabase
    .from("articles")
    .select("id, slug, title, meta_title, meta_description, excerpt, body_html, key_points, faqs, hero_image_url, hero_image_alt, keywords, author_name, status")
    .eq("id", articleId)
    .maybeSingle();

  setAdminLoading(false);

  if (error || !data) {
    const errorEl = document.getElementById("xa-article-error");
    if (errorEl) errorEl.textContent = error?.message ?? "This article could not be found.";
    return;
  }

  const article = data as ArticleRow;
  const titleEl = document.getElementById("xa-article-page-title");
  if (titleEl) titleEl.textContent = article.title;

  bindArticleForm({
    publicPath: `/articles/${article.slug}/`,
    initial: {
      title: article.title,
      slug: article.slug,
      status: article.status === "published" ? "published" : "draft",
      metaTitle: article.meta_title ?? "",
      metaDescription: article.meta_description ?? "",
      excerpt: article.excerpt ?? "",
      heroImageUrl: article.hero_image_url ?? "",
      heroImageAlt: article.hero_image_alt ?? "",
      keywords: article.keywords ?? [],
      authorName: article.author_name ?? "Xyrra Editorial Team",
      keyPoints: article.key_points ?? [],
      bodyHtml: article.body_html,
      faqs: Array.isArray(article.faqs) ? article.faqs : [],
    },
    onSave: async (values) => {
      const { error: updateError } = await session.supabase
        .from("articles")
        .update(articleWritePayload(values, session.user.id, false))
        .eq("id", articleId);

      if (updateError) return { ok: false, error: articleSaveError(updateError.message) };
      if (titleEl) titleEl.textContent = values.title;
      return { ok: true };
    },
    onDelete: async () => {
      const { error: deleteError } = await session.supabase.from("articles").delete().eq("id", articleId);
      if (deleteError) return { ok: false, error: deleteError.message };
      window.location.replace("/admin/articles/");
      return { ok: true };
    },
  });
}

void init();
