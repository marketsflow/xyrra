import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDate(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

type ArticleListRow = {
  id: string;
  slug: string;
  title: string;
  status: string;
  updated_at: string;
};

async function init() {
  const session = await requireAdminSession();
  if (!session) return;

  initAdminShell(session, "articles");
  setAdminLoading(false);

  const listEl = document.getElementById("xa-articles-list");
  const emptyEl = document.getElementById("xa-articles-empty");
  const errorEl = document.getElementById("xa-articles-error");

  const { data, error } = await session.supabase
    .from("articles")
    .select("id, slug, title, status, updated_at")
    .order("updated_at", { ascending: false });

  if (error) {
    if (errorEl) errorEl.textContent = error.message;
    return;
  }

  const articles = (data ?? []) as ArticleListRow[];
  if (articles.length === 0) {
    emptyEl?.removeAttribute("hidden");
    return;
  }

  emptyEl?.setAttribute("hidden", "");
  if (!listEl) return;

  listEl.innerHTML = articles
    .map((article) => {
      const published = article.status === "published";
      const publicLink = published
        ? `<a class="xa-articles__view" href="/articles/${escapeHtml(article.slug)}/" target="_blank" rel="noopener">View</a>`
        : "";
      return `<li class="xa-templates__item">
        <a class="xa-templates__link" href="/admin/articles/edit/?id=${encodeURIComponent(article.id)}">
          <span class="xa-articles__status xa-articles__status--${published ? "published" : "draft"}">${published ? "Published" : "Draft"}</span>
          <span class="xa-templates__meta">
            <span class="xa-templates__name">${escapeHtml(article.title)}</span>
            <span class="xa-templates__subject">/articles/${escapeHtml(article.slug)}/</span>
            <span class="xa-templates__updated">Updated ${escapeHtml(formatDate(article.updated_at))}</span>
          </span>
          <span class="xa-templates__chevron" aria-hidden="true">›</span>
        </a>
        ${publicLink}
      </li>`;
    })
    .join("");
}

void init();
