/** Article SEO contract — maps to future admin/CMS fields. */

export type ArticleBreadcrumb = {
  name: string;
  path: string;
};

export type ArticleSeoInput = {
  slug: string;
  category: string;
  categorySlug: string;
  title: string;
  alternativeHeadline?: string;
  description: string;
  abstract: string;
  /** Plain-text excerpt for articleBody schema (keep under ~5000 chars). */
  articleBodyExcerpt: string;
  publishedAt: string;
  modifiedAt: string;
  authorName: string;
  authorUrl: string;
  section: string;
  tags: string[];
  keywords: string[];
  readTimeMinutes: number;
  wordCount: number;
  canonicalPath: string;
  heroImage: {
    url: string;
    width: number;
    height: number;
    alt: string;
  };
  breadcrumbs: ArticleBreadcrumb[];
  about?: string[];
  mentions?: string[];
};
