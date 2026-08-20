import type { ArticleSeoInput } from "./articles/types";

export const SITE_ORIGIN = "https://xyrra.ai";

export function absoluteArticleUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${SITE_ORIGIN}${normalized}`;
}

export function articlePageTitle(input: ArticleSeoInput): string {
  return `${input.title} | Xyrra`;
}

export function articleIsoDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString();
}

export function articleReadTimeLabel(minutes: number): string {
  return `${minutes} min read`;
}

/** Google-rich-results-friendly BlogPosting + WebPage + BreadcrumbList graph. */
export function buildArticleJsonLd(input: ArticleSeoInput): Record<string, unknown> {
  const pageUrl = absoluteArticleUrl(input.canonicalPath);
  const blogUrl = `${SITE_ORIGIN}/article/`;
  const categoryUrl = absoluteArticleUrl(`/article/${input.categorySlug}/`);

  const publisher = {
    "@type": "Organization",
    "@id": `${SITE_ORIGIN}/#organization`,
    name: "Xyrra",
    url: `${SITE_ORIGIN}/`,
    logo: {
      "@type": "ImageObject",
      url: `${SITE_ORIGIN}/images/new/xyrra-logo.png`,
      width: 954,
      height: 115,
    },
  };

  const author = {
    "@type": "Organization",
    name: input.authorName,
    url: input.authorUrl,
  };

  const breadcrumbItems = input.breadcrumbs.map((item, index) => ({
    "@type": "ListItem",
    position: index + 1,
    name: item.name,
    item: absoluteArticleUrl(item.path),
  }));

  const blogPosting: Record<string, unknown> = {
    "@type": "BlogPosting",
    "@id": `${pageUrl}#article`,
    headline: input.title,
    ...(input.alternativeHeadline
      ? { alternativeHeadline: input.alternativeHeadline }
      : {}),
    description: input.description,
    abstract: input.abstract,
    articleBody: input.articleBodyExcerpt,
    wordCount: input.wordCount,
    timeRequired: `PT${input.readTimeMinutes}M`,
    url: pageUrl,
    mainEntityOfPage: { "@id": `${pageUrl}#webpage` },
    image: [
      {
        "@type": "ImageObject",
        url: input.heroImage.url,
        width: input.heroImage.width,
        height: input.heroImage.height,
        caption: input.heroImage.alt,
      },
    ],
    datePublished: articleIsoDate(input.publishedAt),
    dateModified: articleIsoDate(input.modifiedAt),
    author,
    publisher: { "@id": `${SITE_ORIGIN}/#organization` },
    isPartOf: { "@id": `${blogUrl}#blog` },
    articleSection: input.section,
    keywords: input.keywords.join(", "),
    inLanguage: "en-US",
    ...(input.about?.length
      ? { about: input.about.map((name) => ({ "@type": "Thing", name })) }
      : {}),
    ...(input.mentions?.length
      ? { mentions: input.mentions.map((name) => ({ "@type": "Thing", name })) }
      : {}),
  };

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${SITE_ORIGIN}/#website`,
        name: "Xyrra",
        url: `${SITE_ORIGIN}/`,
        publisher: { "@id": `${SITE_ORIGIN}/#organization` },
        inLanguage: "en-US",
      },
      publisher,
      {
        "@type": "Blog",
        "@id": `${blogUrl}#blog`,
        name: "Xyrra Insights",
        description:
          "Articles on AI hardware, local computing, and the future of purpose-built machines.",
        url: blogUrl,
        publisher: { "@id": `${SITE_ORIGIN}/#organization` },
        inLanguage: "en-US",
      },
      {
        "@type": "CollectionPage",
        "@id": `${categoryUrl}#collection`,
        name: `${input.section} Articles`,
        url: categoryUrl,
        isPartOf: { "@id": `${blogUrl}#blog` },
        inLanguage: "en-US",
      },
      {
        "@type": "WebPage",
        "@id": `${pageUrl}#webpage`,
        url: pageUrl,
        name: input.title,
        description: input.description,
        isPartOf: { "@id": `${SITE_ORIGIN}/#website` },
        breadcrumb: { "@id": `${pageUrl}#breadcrumb` },
        mainEntity: { "@id": `${pageUrl}#article` },
        primaryImageOfPage: {
          "@type": "ImageObject",
          url: input.heroImage.url,
          width: input.heroImage.width,
          height: input.heroImage.height,
        },
        datePublished: articleIsoDate(input.publishedAt),
        dateModified: articleIsoDate(input.modifiedAt),
        inLanguage: "en-US",
        speakable: {
          "@type": "SpeakableSpecification",
          cssSelector: [".article-hero__lede", ".article-section p"],
        },
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${pageUrl}#breadcrumb`,
        itemListElement: breadcrumbItems,
      },
      blogPosting,
    ],
  };
}
