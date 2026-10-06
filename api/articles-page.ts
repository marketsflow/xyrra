/**
 * Server-rendered /articles pages, sitemap, and AI article list.
 *
 * Vercel ships this file alone — do not import ./lib or ../src from here.
 * Vite dev middleware and the admin editor import the named exports.
 */

const SITE_ORIGIN = "https://xyrra.ai";
const ARTICLE_SELECT =
  "slug,title,meta_title,meta_description,excerpt,body_html,key_points,faqs,hero_image_url,hero_image_alt,keywords,author_name,published_at,updated_at";
const LIST_SELECT = "slug,title,meta_title,meta_description,excerpt,keywords,author_name,published_at,updated_at";

const ALLOWED_TAGS = new Set([
  "p",
  "h2",
  "h3",
  "h4",
  "ul",
  "ol",
  "li",
  "a",
  "strong",
  "em",
  "b",
  "i",
  "blockquote",
  "br",
  "figure",
  "img",
  "figcaption",
]);

export type ArticlesEnv = {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};

export type ArticlesHttpResult = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

type Faq = { question: string; answer: string };

type PublicArticle = {
  slug: string;
  title: string;
  metaTitle: string;
  description: string;
  excerpt: string;
  bodyHtml: string;
  keyPoints: string[];
  faqs: Faq[];
  heroImageUrl: string | null;
  heroImageAlt: string;
  keywords: string[];
  authorName: string;
  publishedAt: string | null;
  updatedAt: string | null;
};

type ArticleKind =
  | { kind: "index" }
  | { kind: "article"; slug: string }
  | { kind: "sitemap" }
  | { kind: "llms" };

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function readAttr(attrs: string, name: string): string | null {
  const re = new RegExp(
    `\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`,
    "i",
  );
  const match = attrs.match(re);
  if (!match) return null;
  return decodeBasicEntities(match[2] ?? match[3] ?? match[4] ?? "");
}

export function slugifyArticleTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

export function isArticleSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 80;
}

function safeHref(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2000) return null;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//") && !trimmed.includes("\\")) {
    return trimmed;
  }
  if (trimmed.toLowerCase().startsWith("mailto:")) {
    const address = trimmed.slice("mailto:".length).split("?")[0] ?? "";
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return trimmed;
    return null;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.href;
  } catch {
    return null;
  }
}

function safeSrc(value: string | null): string | null {
  const href = safeHref(value);
  if (!href || href.toLowerCase().startsWith("mailto:")) return null;
  return href;
}

/** Keep article HTML limited to headings, lists, links, and images. */
export function sanitizeArticleHtml(input: string): string {
  const withoutDanger = input
    .replace(/\0/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\s*(script|style|iframe|object|embed|svg|math|form|input|button|textarea|link|meta|noscript)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|style|iframe|object|embed|svg|math|form|input|button|textarea|link|meta|noscript)[^>]*\/?>/gi, "");

  return withoutDanger.replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, (match, rawTag: string, attrs: string) => {
    let tag = rawTag.toLowerCase();
    if (tag === "div") tag = "p";
    if (tag === "h1") tag = "h2";
    if (!ALLOWED_TAGS.has(tag)) return "";
    if (match.startsWith("</")) return `</${tag}>`;
    if (tag === "br") return "<br>";
    if (tag === "a") {
      const href = safeHref(readAttr(attrs, "href"));
      return href ? `<a href="${escapeAttr(href)}">` : "<a>";
    }
    if (tag === "img") {
      const src = safeSrc(readAttr(attrs, "src"));
      if (!src) return "";
      const alt = readAttr(attrs, "alt") ?? "";
      return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}">`;
    }
    return `<${tag}>`;
  });
}

function htmlToText(html: string): string {
  return decodeBasicEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|h2|h3|h4|li|blockquote|figcaption)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\u00a0/g, " "),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function wordCount(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

function readTimeMinutes(words: number): number {
  return Math.max(1, Math.round(words / 220));
}

function isoDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function formatDate(value: string | null): string | null {
  const iso = isoDate(value);
  if (!iso) return null;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}

function showsUpdated(publishedAt: string | null, updatedAt: string | null): boolean {
  const published = isoDate(publishedAt);
  const updated = isoDate(updatedAt);
  if (!published || !updated) return false;
  return new Date(updated).getTime() - new Date(published).getTime() > 24 * 60 * 60 * 1000;
}

function absoluteUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${SITE_ORIGIN}${normalized}`;
}

function articlePath(slug: string): string {
  return `/articles/${slug}/`;
}

function textList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = String(item ?? "").trim().replace(/\s+/g, " ");
    if (!text) continue;
    out.push(text.slice(0, 240));
    if (out.length >= limit) break;
  }
  return out;
}

function readFaqs(value: unknown): Faq[] {
  if (!Array.isArray(value)) return [];
  const out: Faq[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const question = String(record.question ?? "").trim().replace(/\s+/g, " ");
    const answer = String(record.answer ?? "").trim();
    if (!question || !answer) continue;
    out.push({ question: question.slice(0, 200), answer: answer.slice(0, 2000) });
    if (out.length >= 12) break;
  }
  return out;
}

function mapArticle(row: Record<string, unknown>, includeBody: boolean): PublicArticle | null {
  const slug = String(row.slug ?? "").trim();
  const title = String(row.title ?? "").trim();
  if (!isArticleSlug(slug) || !title) return null;
  const excerpt = String(row.excerpt ?? "").trim();
  const metaDescription = String(row.meta_description ?? "").trim();
  const metaTitle = String(row.meta_title ?? "").trim();
  const author = String(row.author_name ?? "").trim();
  return {
    slug,
    title,
    metaTitle: metaTitle || title,
    description: metaDescription || excerpt || title,
    excerpt,
    bodyHtml: includeBody ? sanitizeArticleHtml(String(row.body_html ?? "")) : "",
    keyPoints: includeBody ? textList(row.key_points, 12) : [],
    faqs: includeBody ? readFaqs(row.faqs) : [],
    heroImageUrl: safeSrc(typeof row.hero_image_url === "string" ? row.hero_image_url : null),
    heroImageAlt: String(row.hero_image_alt ?? "").trim() || title,
    keywords: textList(row.keywords, 20),
    authorName: author || "Xyrra Editorial Team",
    publishedAt: typeof row.published_at === "string" ? row.published_at : null,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

function paragraphs(text: string): string {
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (blocks.length === 0) return "";
  return blocks
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function jsonLdScript(data: unknown): string {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}

function organizationNode() {
  return {
    "@type": "Organization",
    "@id": `${SITE_ORIGIN}/#organization`,
    name: "Xyrra",
    url: `${SITE_ORIGIN}/`,
    logo: {
      "@type": "ImageObject",
      url: `${SITE_ORIGIN}/images/new/xyrra-logo.png`,
    },
  };
}

function websiteNode() {
  return {
    "@type": "WebSite",
    "@id": `${SITE_ORIGIN}/#website`,
    name: "Xyrra",
    url: `${SITE_ORIGIN}/`,
    publisher: { "@id": `${SITE_ORIGIN}/#organization` },
    inLanguage: "en",
  };
}

function documentPage(input: {
  title: string;
  description: string;
  canonicalPath: string | null;
  robots: string;
  extraHead: string;
  main: string;
}): string {
  const canonical = input.canonicalPath
    ? `<link rel="canonical" href="${escapeAttr(absoluteUrl(input.canonicalPath))}">`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)}</title>
  <meta name="description" content="${escapeAttr(input.description)}">
  <meta name="robots" content="${escapeAttr(input.robots)}">
  <meta name="googlebot" content="${escapeAttr(input.robots)}">
  ${canonical}
  <link rel="icon" href="/favicon.png" type="image/png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/articles.css">
  ${input.extraHead}
</head>
<body class="xa-pub">
  <a class="xa-pub-skip" href="#main">Skip to content</a>
  <header class="xa-pub-header">
    <a class="xa-pub-brand" href="/" aria-label="Xyrra home">
      <img src="/images/new/xyrra-logo.png" alt="" width="954" height="115">
    </a>
    <nav class="xa-pub-nav" aria-label="Primary">
      <a href="/aiperformance/">Performance</a>
      <a href="/ai_stocks/">AI Stocks</a>
      <a href="/articles/"${input.canonicalPath === "/articles/" ? ' aria-current="page"' : ""}>Articles</a>
    </nav>
  </header>
  ${input.main}
  <footer class="xa-pub-footer">
    <nav aria-label="Footer">
      <a href="/">Home</a>
      <a href="/articles/">Articles</a>
      <a href="/disclaimer/">Disclaimer</a>
      <a href="/private-policy/">Privacy</a>
    </nav>
    <p>Insights are educational and are not financial advice.</p>
  </footer>
  <script>
    (function () {
      var key = "xyrra-cookie-consent";
      try {
        var choice = localStorage.getItem(key);
        if (choice === "accepted" || choice === "denied") return;
      } catch (e) { return; }
      var notice = document.createElement("section");
      notice.className = "xa-pub-cookies";
      notice.setAttribute("aria-label", "Cookies");
      notice.innerHTML = '<p>Your browser assigns cookies for this site. A cookie is a small file stored in the browser. On a later visit the browser sends that cookie back, so the site can recognise this browser.</p><div><button type="button" data-choice="accepted">Accept cookies</button><button type="button" data-choice="denied">Deny cookies</button><a href="/private-policy/">Privacy</a></div>';
      notice.querySelectorAll("button").forEach(function (button) {
        button.addEventListener("click", function () {
          try { localStorage.setItem(key, button.getAttribute("data-choice") === "denied" ? "denied" : "accepted"); } catch (e) {}
          notice.remove();
        });
      });
      document.body.appendChild(notice);
    })();
  </script>
</body>
</html>`;
}

function breadcrumb(items: Array<{ name: string; path: string | null }>): string {
  const parts = items
    .map((item, index) => {
      const last = index === items.length - 1;
      const inner = !last && item.path
        ? `<a href="${escapeAttr(item.path)}">${escapeHtml(item.name)}</a>`
        : `<span>${escapeHtml(item.name)}</span>`;
      return `<li>${inner}</li>`;
    })
    .join('<li aria-hidden="true">&gt;</li>');
  return `<nav class="xa-pub-crumbs" aria-label="Breadcrumb"><ol>${parts}</ol></nav>`;
}

function hero(article: PublicArticle): string {
  const image = article.heroImageUrl
    ? `<img class="xa-pub-hero__media" src="${escapeAttr(article.heroImageUrl)}" alt="" width="1600" height="900">
       <div class="xa-pub-hero__shade" aria-hidden="true"></div>`
    : "";
  return `<header class="xa-pub-hero${article.heroImageUrl ? " xa-pub-hero--image" : ""}">
    ${image}
    <div class="xa-pub-hero__inner">
      <h1>${escapeHtml(article.title)}</h1>
    </div>
  </header>`;
}

function articleJsonLd(article: PublicArticle): unknown {
  const path = articlePath(article.slug);
  const pageUrl = absoluteUrl(path);
  const published = isoDate(article.publishedAt);
  const modified = isoDate(article.updatedAt) ?? published;
  const bodyText = htmlToText(`${article.excerpt}\n\n${article.bodyHtml}`).slice(0, 5000);
  const imageUrl = article.heroImageUrl
    ? /^https?:\/\//i.test(article.heroImageUrl)
      ? article.heroImageUrl
      : absoluteUrl(article.heroImageUrl)
    : null;

  const articleNode: Record<string, unknown> = {
    "@type": "Article",
    "@id": `${pageUrl}#article`,
    headline: article.title,
    description: article.description,
    abstract: article.excerpt || article.description,
    articleBody: bodyText,
    wordCount: wordCount(bodyText),
    timeRequired: `PT${readTimeMinutes(wordCount(bodyText))}M`,
    url: pageUrl,
    mainEntityOfPage: { "@id": `${pageUrl}#webpage` },
    inLanguage: "en",
    isAccessibleForFree: true,
    author: {
      "@type": "Organization",
      name: article.authorName,
      url: `${SITE_ORIGIN}/about-xyrra/`,
    },
    publisher: { "@id": `${SITE_ORIGIN}/#organization` },
    isPartOf: { "@id": `${absoluteUrl("/articles/")}#blog` },
    keywords: article.keywords.join(", "),
    ...(article.metaTitle !== article.title ? { alternativeHeadline: article.metaTitle } : {}),
    ...(published ? { datePublished: published } : {}),
    ...(modified ? { dateModified: modified } : {}),
    ...(imageUrl ? { image: [imageUrl] } : {}),
    ...(article.keywords.length
      ? { about: article.keywords.slice(0, 8).map((name) => ({ "@type": "Thing", name })) }
      : {}),
  };

  const graph: Record<string, unknown>[] = [
    websiteNode(),
    organizationNode(),
    {
      "@type": "Blog",
      "@id": `${absoluteUrl("/articles/")}#blog`,
      name: "Xyrra Articles",
      url: absoluteUrl("/articles/"),
      publisher: { "@id": `${SITE_ORIGIN}/#organization` },
      inLanguage: "en",
    },
    {
      "@type": "WebPage",
      "@id": `${pageUrl}#webpage`,
      url: pageUrl,
      name: article.metaTitle,
      description: article.description,
      isPartOf: { "@id": `${SITE_ORIGIN}/#website` },
      breadcrumb: { "@id": `${pageUrl}#breadcrumb` },
      mainEntity: { "@id": `${pageUrl}#article` },
      inLanguage: "en",
      speakable: {
        "@type": "SpeakableSpecification",
        cssSelector: [".xa-pub-lede", ".xa-pub-prose p", ".xa-pub-faq"],
      },
      ...(published ? { datePublished: published } : {}),
      ...(modified ? { dateModified: modified } : {}),
    },
    {
      "@type": "BreadcrumbList",
      "@id": `${pageUrl}#breadcrumb`,
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: `${SITE_ORIGIN}/` },
        { "@type": "ListItem", position: 2, name: "Articles", item: absoluteUrl("/articles/") },
        { "@type": "ListItem", position: 3, name: article.title, item: pageUrl },
      ],
    },
    articleNode,
  ];

  if (article.faqs.length > 0) {
    graph.push({
      "@type": "FAQPage",
      "@id": `${pageUrl}#faq`,
      url: pageUrl,
      mainEntity: article.faqs.map((faq) => ({
        "@type": "Question",
        name: faq.question,
        acceptedAnswer: { "@type": "Answer", text: faq.answer },
      })),
    });
  }

  return { "@context": "https://schema.org", "@graph": graph };
}

function renderArticle(article: PublicArticle): string {
  const path = articlePath(article.slug);
  const pageUrl = absoluteUrl(path);
  const publishedLabel = formatDate(article.publishedAt);
  const updatedLabel = showsUpdated(article.publishedAt, article.updatedAt) ? formatDate(article.updatedAt) : null;
  const plain = htmlToText(`${article.excerpt}\n\n${article.bodyHtml}`);
  const minutes = readTimeMinutes(wordCount(plain));
  const imageUrl = article.heroImageUrl && /^https?:\/\//i.test(article.heroImageUrl)
    ? article.heroImageUrl
    : article.heroImageUrl
      ? absoluteUrl(article.heroImageUrl)
      : `${SITE_ORIGIN}/images/new/xyrra-logo.png`;
  const published = isoDate(article.publishedAt);
  const modified = isoDate(article.updatedAt) ?? published;
  const keywordMeta = article.keywords.map((keyword) => `<meta name="article:tag" content="${escapeAttr(keyword)}">`).join("");

  const metaBits = [
    publishedLabel && article.publishedAt
      ? `Published <time datetime="${escapeAttr(isoDate(article.publishedAt) ?? "")}">${escapeHtml(publishedLabel)}</time>`
      : "",
    updatedLabel && article.updatedAt
      ? `Updated <time datetime="${escapeAttr(isoDate(article.updatedAt) ?? "")}">${escapeHtml(updatedLabel)}</time>`
      : "",
    `${minutes} min read`,
    `By ${escapeHtml(article.authorName)}`,
  ].filter(Boolean);

  const points = article.keyPoints.length
    ? `<aside class="xa-pub-aside"><h2>Key points</h2><ul>${article.keyPoints.map((point) => `<li>${escapeHtml(point)}</li>`).join("")}</ul></aside>`
    : "";

  const faqs = article.faqs.length
    ? `<section class="xa-pub-faq" aria-labelledby="article-faq-title">
        <h2 id="article-faq-title">Questions</h2>
        ${article.faqs
          .map(
            (faq, index) => `<details${index === 0 ? " open" : ""}>
              <summary>${escapeHtml(faq.question)}</summary>
              ${paragraphs(faq.answer)}
            </details>`,
          )
          .join("")}
      </section>`
    : "";

  const extraHead = `
  <meta name="author" content="${escapeAttr(article.authorName)}">
  <meta name="abstract" content="${escapeAttr((article.excerpt || article.description).slice(0, 500))}">
  ${article.keywords.length ? `<meta name="keywords" content="${escapeAttr(article.keywords.join(", "))}">` : ""}
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="Xyrra">
  <meta property="og:locale" content="en_US">
  <meta property="og:url" content="${escapeAttr(pageUrl)}">
  <meta property="og:title" content="${escapeAttr(article.metaTitle)}">
  <meta property="og:description" content="${escapeAttr(article.description)}">
  <meta property="og:image" content="${escapeAttr(imageUrl)}">
  <meta property="og:image:alt" content="${escapeAttr(article.heroImageAlt)}">
  ${published ? `<meta property="article:published_time" content="${escapeAttr(published)}">` : ""}
  ${modified ? `<meta property="article:modified_time" content="${escapeAttr(modified)}">` : ""}
  <meta property="article:author" content="${escapeAttr(article.authorName)}">
  ${keywordMeta}
  <meta name="twitter:card" content="${article.heroImageUrl ? "summary_large_image" : "summary"}">
  <meta name="twitter:title" content="${escapeAttr(article.metaTitle)}">
  <meta name="twitter:description" content="${escapeAttr(article.description)}">
  <meta name="twitter:image" content="${escapeAttr(imageUrl)}">
  <link rel="alternate" type="text/plain" href="${SITE_ORIGIN}/llms-articles.txt" title="Xyrra articles for AI systems">
  ${jsonLdScript(articleJsonLd(article))}
  `;

  const main = `${hero(article)}
  <main id="main" class="xa-pub-wrap">
    ${breadcrumb([
      { name: "Home", path: "/" },
      { name: "Articles", path: "/articles/" },
      { name: article.title, path: null },
    ])}
    <section class="xa-pub-intro">
      <p class="xa-pub-meta">${metaBits.join('<span aria-hidden="true"> · </span>')}</p>
      ${article.excerpt ? `<div class="xa-pub-lede">${paragraphs(article.excerpt)}</div>` : ""}
    </section>
    <div class="xa-pub-grid${points ? "" : " xa-pub-grid--single"}">
      <article class="xa-pub-prose">${article.bodyHtml || "<p></p>"}</article>
      ${points}
    </div>
    ${faqs}
  </main>`;

  return documentPage({
    title: `${article.metaTitle} | Xyrra`,
    description: article.description,
    canonicalPath: path,
    robots: "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1",
    extraHead,
    main,
  });
}

function indexJsonLd(articles: PublicArticle[]): unknown {
  const pageUrl = absoluteUrl("/articles/");
  return {
    "@context": "https://schema.org",
    "@graph": [
      websiteNode(),
      organizationNode(),
      {
        "@type": "Blog",
        "@id": `${pageUrl}#blog`,
        name: "Xyrra Articles",
        description: "Editorial articles from Xyrra on AI insights for stocks, crypto, and portfolios.",
        url: pageUrl,
        publisher: { "@id": `${SITE_ORIGIN}/#organization` },
        inLanguage: "en",
      },
      {
        "@type": "CollectionPage",
        "@id": `${pageUrl}#webpage`,
        url: pageUrl,
        name: "Xyrra Articles",
        description: "Editorial articles from Xyrra on AI insights for stocks, crypto, and portfolios.",
        isPartOf: { "@id": `${SITE_ORIGIN}/#website` },
        mainEntity: { "@id": `${pageUrl}#itemlist` },
        inLanguage: "en",
      },
      {
        "@type": "ItemList",
        "@id": `${pageUrl}#itemlist`,
        itemListElement: articles.map((article, index) => ({
          "@type": "ListItem",
          position: index + 1,
          item: {
            "@type": "Article",
            headline: article.title,
            url: absoluteUrl(articlePath(article.slug)),
            description: article.description,
            ...(isoDate(article.publishedAt) ? { datePublished: isoDate(article.publishedAt) } : {}),
          },
        })),
      },
    ],
  };
}

function renderIndex(articles: PublicArticle[]): string {
  const description = "Editorial articles from Xyrra on AI insights for stocks, crypto, and portfolios.";
  const cards = articles.length
    ? `<ul class="xa-pub-index">${articles
        .map((article) => {
          const date = formatDate(article.publishedAt);
          return `<li><a href="${escapeAttr(articlePath(article.slug))}">
            <h2>${escapeHtml(article.title)}</h2>
            ${article.description ? `<p>${escapeHtml(article.description)}</p>` : ""}
            ${date && article.publishedAt ? `<time datetime="${escapeAttr(isoDate(article.publishedAt) ?? "")}">${escapeHtml(date)}</time>` : ""}
          </a></li>`;
        })
        .join("")}</ul>`
    : `<p class="xa-pub-empty">No articles are published yet.</p>`;

  const main = `<header class="xa-pub-hero">
      <div class="xa-pub-hero__inner">
        <h1>Articles</h1>
      </div>
    </header>
    <main id="main" class="xa-pub-wrap">
      ${breadcrumb([
        { name: "Home", path: "/" },
        { name: "Articles", path: null },
      ])}
      <section class="xa-pub-intro">
        <div class="xa-pub-lede"><p>${escapeHtml(description)}</p></div>
      </section>
      ${cards}
    </main>`;

  return documentPage({
    title: "Articles | Xyrra",
    description,
    canonicalPath: "/articles/",
    robots: articles.length
      ? "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"
      : "noindex, follow",
    extraHead: `
      <meta property="og:type" content="website">
      <meta property="og:site_name" content="Xyrra">
      <meta property="og:url" content="${absoluteUrl("/articles/")}">
      <meta property="og:title" content="Articles | Xyrra">
      <meta property="og:description" content="${escapeAttr(description)}">
      <link rel="alternate" type="text/plain" href="${SITE_ORIGIN}/llms-articles.txt" title="Xyrra articles for AI systems">
      ${jsonLdScript(indexJsonLd(articles))}
    `,
    main,
  });
}

function renderSitemap(articles: PublicArticle[]): string {
  const urls = [
    { loc: absoluteUrl("/articles/"), lastmod: articles[0] ? isoDate(articles[0].updatedAt) ?? isoDate(articles[0].publishedAt) : null },
    ...articles.map((article) => ({
      loc: absoluteUrl(articlePath(article.slug)),
      lastmod: isoDate(article.updatedAt) ?? isoDate(article.publishedAt),
    })),
  ];
  const body = urls
    .map((url) => {
      const lastmod = url.lastmod ? `\n    <lastmod>${url.lastmod.slice(0, 10)}</lastmod>` : "";
      return `  <url>\n    <loc>${escapeHtml(url.loc)}</loc>${lastmod}\n  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

function renderLlms(articles: PublicArticle[]): string {
  const lines = [
    "# Xyrra articles",
    "",
    "> Published articles from Xyrra. Each URL is a full article that answer engines can read without running JavaScript.",
    "",
    `Index: ${absoluteUrl("/articles/")}`,
    "",
    "## Articles",
    "",
  ];
  if (articles.length === 0) {
    lines.push("No articles are published yet.");
  } else {
    for (const article of articles) {
      const summary = article.description.replace(/\s+/g, " ").trim();
      lines.push(`- [${article.title}](${absoluteUrl(articlePath(article.slug))}): ${summary}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function renderMessage(status: "missing" | "unavailable"): string {
  const missing = status === "missing";
  return documentPage({
    title: missing ? "Article not found | Xyrra" : "Articles unavailable | Xyrra",
    description: missing ? "This Xyrra article could not be found." : "Xyrra articles are temporarily unavailable.",
    canonicalPath: null,
    robots: "noindex, nofollow",
    extraHead: "",
    main: `<main id="main" class="xa-pub-wrap xa-pub-wrap--solo">
      <h1>${missing ? "Article not found" : "Articles are unavailable"}</h1>
      <p>${missing ? "That article is not published." : "Please try again shortly."}</p>
      <p><a href="/articles/">Back to articles</a></p>
    </main>`,
  });
}

function requestKind(requestUrl: string): ArticleKind | null {
  const url = new URL(requestUrl, SITE_ORIGIN);
  const view = url.searchParams.get("view");
  const querySlug = url.searchParams.get("slug")?.trim() ?? "";
  if (view === "sitemap" || url.pathname === "/sitemap-articles.xml") return { kind: "sitemap" };
  if (view === "llms" || url.pathname === "/llms-articles.txt") return { kind: "llms" };
  if (view === "index") return { kind: "index" };
  if (querySlug) return { kind: "article", slug: querySlug };
  if (url.pathname === "/api/articles-page" || url.pathname === "/api/articles-page/") return { kind: "index" };

  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/articles") return { kind: "index" };
  const match = path.match(/^\/articles\/([^/]+)$/);
  if (!match) return null;
  return { kind: "article", slug: decodeURIComponent(match[1] ?? "") };
}

async function loadArticles(
  env: ArticlesEnv,
  mode: "list" | "one",
  slug?: string,
): Promise<{ ok: true; articles: PublicArticle[] } | { ok: false }> {
  const base = env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!base || !key) return { ok: false };

  const params = new URLSearchParams();
  params.set("status", "eq.published");
  params.set("select", mode === "one" ? ARTICLE_SELECT : LIST_SELECT);
  params.set("order", "published_at.desc.nullslast");
  if (mode === "one" && slug) {
    params.set("slug", `eq.${slug}`);
    params.set("limit", "1");
  } else {
    params.set("limit", "100");
  }

  let response: Response;
  try {
    response = await fetch(`${base}/rest/v1/articles?${params.toString()}`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
    });
  } catch {
    return { ok: false };
  }
  if (!response.ok) return { ok: false };
  let rows: unknown;
  try {
    rows = await response.json();
  } catch {
    return { ok: false };
  }
  if (!Array.isArray(rows)) return { ok: false };
  const articles = rows
    .map((row) => (row && typeof row === "object" ? mapArticle(row as Record<string, unknown>, mode === "one") : null))
    .filter((article): article is PublicArticle => article !== null);
  return { ok: true, articles };
}

function htmlResult(status: number, body: string, indexable: boolean): ArticlesHttpResult {
  return {
    status,
    body,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
      "X-Robots-Tag": indexable
        ? "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"
        : "noindex, nofollow",
    },
  };
}

export async function renderArticlesResponse(
  requestUrl: string,
  env: ArticlesEnv,
): Promise<ArticlesHttpResult | null> {
  const kind = requestKind(requestUrl);
  if (!kind) return null;

  if (kind.kind === "article" && !isArticleSlug(kind.slug)) {
    return htmlResult(404, renderMessage("missing"), false);
  }

  const loaded = await loadArticles(env, kind.kind === "article" ? "one" : "list", kind.kind === "article" ? kind.slug : undefined);
  if (!loaded.ok) return htmlResult(503, renderMessage("unavailable"), false);

  if (kind.kind === "sitemap") {
    return {
      status: 200,
      body: renderSitemap(loaded.articles),
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600",
      },
    };
  }

  if (kind.kind === "llms") {
    return {
      status: 200,
      body: renderLlms(loaded.articles),
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600",
      },
    };
  }

  if (kind.kind === "index") {
    return htmlResult(200, renderIndex(loaded.articles), loaded.articles.length > 0);
  }

  const article = loaded.articles[0];
  if (!article) return htmlResult(404, renderMessage("missing"), false);
  return htmlResult(200, renderArticle(article), true);
}

export const config = { maxDuration: 30 };

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    const rendered = await renderArticlesResponse(request.url, {
      SUPABASE_URL: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    });
    if (!rendered) {
      return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return new Response(request.method === "HEAD" ? null : rendered.body, {
      status: rendered.status,
      headers: rendered.headers,
    });
  },
};
