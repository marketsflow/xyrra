import { isArticleSlug, sanitizeArticleHtml, slugifyArticleTitle } from "../../api/articles-page";
import type { ArticleFaq, ArticleFormValues } from "../lib/articles/save";

export type { ArticleFormValues };

type BindOptions = {
  initial?: Partial<ArticleFormValues> & { keywordsText?: string; keyPointsText?: string };
  publicPath?: string;
  onSave: (values: ArticleFormValues) => Promise<{ ok: true } | { ok: false; error: string }>;
  onDelete?: () => Promise<{ ok: true } | { ok: false; error: string }>;
};

function lines(value: string, limit: number, maxLength: number): string[] {
  const out: string[] = [];
  for (const line of value.split("\n")) {
    const text = line.trim().replace(/\s+/g, " ");
    if (!text) continue;
    out.push(text.slice(0, maxLength));
    if (out.length >= limit) break;
  }
  return out;
}

function keywords(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(",")) {
    const tag = part.trim().replace(/\s+/g, " ").slice(0, 40);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 20) break;
  }
  return out;
}

function readFaqs(root: HTMLElement): ArticleFaq[] {
  const faqs: ArticleFaq[] = [];
  root.querySelectorAll<HTMLElement>("[data-faq-row]").forEach((row) => {
    const question = row.querySelector<HTMLInputElement>("[data-faq-question]")?.value.trim() ?? "";
    const answer = row.querySelector<HTMLTextAreaElement>("[data-faq-answer]")?.value.trim() ?? "";
    if (!question || !answer) return;
    faqs.push({ question: question.slice(0, 200), answer: answer.slice(0, 2000) });
  });
  return faqs.slice(0, 12);
}

function faqRow(faq?: ArticleFaq): HTMLElement {
  const row = document.createElement("div");
  row.className = "xa-article-faq";
  row.dataset.faqRow = "true";
  row.innerHTML = `
    <label>Question<input type="text" data-faq-question maxlength="200" value=""></label>
    <label>Answer<textarea data-faq-answer maxlength="2000" rows="3"></textarea></label>
    <button type="button" data-faq-remove>Remove</button>
  `;
  const question = row.querySelector<HTMLInputElement>("[data-faq-question]");
  const answer = row.querySelector<HTMLTextAreaElement>("[data-faq-answer]");
  if (question) question.value = faq?.question ?? "";
  if (answer) answer.value = faq?.answer ?? "";
  row.querySelector("[data-faq-remove]")?.addEventListener("click", () => row.remove());
  return row;
}

export function bindArticleForm(options: BindOptions) {
  const titleEl = document.getElementById("xa-article-title") as HTMLInputElement | null;
  const slugEl = document.getElementById("xa-article-slug") as HTMLInputElement | null;
  const statusEl = document.getElementById("xa-article-status") as HTMLSelectElement | null;
  const metaTitleEl = document.getElementById("xa-article-meta-title") as HTMLInputElement | null;
  const metaDescriptionEl = document.getElementById("xa-article-meta-description") as HTMLTextAreaElement | null;
  const excerptEl = document.getElementById("xa-article-excerpt") as HTMLTextAreaElement | null;
  const heroUrlEl = document.getElementById("xa-article-hero-url") as HTMLInputElement | null;
  const heroAltEl = document.getElementById("xa-article-hero-alt") as HTMLInputElement | null;
  const keywordsEl = document.getElementById("xa-article-keywords") as HTMLInputElement | null;
  const authorEl = document.getElementById("xa-article-author") as HTMLInputElement | null;
  const pointsEl = document.getElementById("xa-article-points") as HTMLTextAreaElement | null;
  const bodyEl = document.getElementById("xa-article-body");
  const faqsEl = document.getElementById("xa-article-faqs");
  const saveBtn = document.getElementById("xa-article-save") as HTMLButtonElement | null;
  const deleteBtn = document.getElementById("xa-article-delete") as HTMLButtonElement | null;
  const statusMsg = document.getElementById("xa-article-status-msg");
  const errorEl = document.getElementById("xa-article-error");
  const publicLink = document.getElementById("xa-article-public") as HTMLAnchorElement | null;

  const initial = options.initial ?? {};
  if (titleEl) titleEl.value = initial.title ?? "";
  if (slugEl) slugEl.value = initial.slug ?? "";
  if (statusEl) statusEl.value = initial.status === "published" ? "published" : "draft";
  if (metaTitleEl) metaTitleEl.value = initial.metaTitle ?? "";
  if (metaDescriptionEl) metaDescriptionEl.value = initial.metaDescription ?? "";
  if (excerptEl) excerptEl.value = initial.excerpt ?? "";
  if (heroUrlEl) heroUrlEl.value = initial.heroImageUrl ?? "";
  if (heroAltEl) heroAltEl.value = initial.heroImageAlt ?? "";
  if (keywordsEl) keywordsEl.value = initial.keywordsText ?? (initial.keywords ?? []).join(", ");
  if (authorEl) authorEl.value = initial.authorName ?? "Xyrra Editorial Team";
  if (pointsEl) pointsEl.value = initial.keyPointsText ?? (initial.keyPoints ?? []).join("\n");
  if (bodyEl) bodyEl.innerHTML = sanitizeArticleHtml(initial.bodyHtml ?? "<p></p>") || "<p></p>";
  if (faqsEl) {
    const faqs = initial.faqs?.length ? initial.faqs : [{ question: "", answer: "" }];
    faqs.forEach((faq) => faqsEl.append(faqRow(faq)));
  }

  const syncPublicLink = () => {
    if (!publicLink || !slugEl) return;
    const slug = slugifyArticleTitle(slugEl.value);
    const path = slug ? `/articles/${slug}/` : "/articles/";
    publicLink.textContent = path;
    publicLink.href = path;
  };
  syncPublicLink();

  let slugTouched = Boolean(initial.slug);
  slugEl?.addEventListener("input", () => {
    slugTouched = true;
    syncPublicLink();
  });
  titleEl?.addEventListener("input", () => {
    if (!slugEl || slugTouched) return;
    slugEl.value = slugifyArticleTitle(titleEl.value);
    syncPublicLink();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-xa-article-cmd]").forEach((button) => {
    button.addEventListener("click", () => {
      const command = button.dataset.xaArticleCmd ?? "";
      bodyEl?.focus();
      if (command === "link") {
        const href = window.prompt("Link URL");
        if (href) document.execCommand("createLink", false, href);
        return;
      }
      if (command === "h2" || command === "h3" || command === "p") {
        document.execCommand("defaultParagraphSeparator", false, "p");
        document.execCommand("formatBlock", false, command);
        return;
      }
      if (command) document.execCommand(command, false);
    });
  });

  document.getElementById("xa-article-faq-add")?.addEventListener("click", () => {
    faqsEl?.append(faqRow());
  });

  const showError = (message: string) => {
    if (errorEl) errorEl.textContent = message;
    if (statusMsg) statusMsg.textContent = "";
  };

  saveBtn?.addEventListener("click", () => {
    const title = titleEl?.value.trim() ?? "";
    const slug = slugifyArticleTitle(slugEl?.value.trim() || title);
    const status = statusEl?.value === "published" ? "published" : "draft";
    const bodyHtml = sanitizeArticleHtml(bodyEl?.innerHTML ?? "");
    const bodyText = bodyEl?.textContent?.trim() ?? "";
    const metaDescription = metaDescriptionEl?.value.trim() ?? "";

    if (!title) {
      showError("Add a title.");
      return;
    }
    if (!isArticleSlug(slug)) {
      showError("Use a lowercase slug with letters, numbers, and hyphens.");
      return;
    }
    if (status === "published") {
      if (metaDescription.length < 50) {
        showError("Add a meta description of at least 50 characters before publishing.");
        return;
      }
      if (!bodyText) {
        showError("Add the article body before publishing.");
        return;
      }
    }

    if (slugEl) slugEl.value = slug;
    syncPublicLink();
    if (saveBtn) saveBtn.disabled = true;
    if (statusMsg) statusMsg.textContent = "Saving…";
    if (errorEl) errorEl.textContent = "";

    const values: ArticleFormValues = {
      title,
      slug,
      status,
      metaTitle: metaTitleEl?.value.trim() ?? "",
      metaDescription,
      excerpt: excerptEl?.value.trim() ?? "",
      heroImageUrl: heroUrlEl?.value.trim() ?? "",
      heroImageAlt: heroAltEl?.value.trim() ?? "",
      keywords: keywords(keywordsEl?.value ?? ""),
      authorName: authorEl?.value.trim() || "Xyrra Editorial Team",
      keyPoints: lines(pointsEl?.value ?? "", 12, 240),
      bodyHtml,
      faqs: faqsEl ? readFaqs(faqsEl) : [],
    };

    void options.onSave(values).then((result) => {
      if (saveBtn) saveBtn.disabled = false;
      if (!result.ok) {
        showError(result.error);
        return;
      }
      if (statusMsg) statusMsg.textContent = "Saved.";
    });
  });

  deleteBtn?.addEventListener("click", () => {
    if (!options.onDelete) return;
    if (!window.confirm("Delete this article?")) return;
    deleteBtn.disabled = true;
    void options.onDelete().then((result) => {
      deleteBtn.disabled = false;
      if (!result.ok) showError(result.error);
    });
  });

  if (options.publicPath && publicLink) {
    publicLink.href = options.publicPath;
    publicLink.textContent = options.publicPath;
  }
}
