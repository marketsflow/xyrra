export type ArticleFaq = { question: string; answer: string };

export type ArticleFormValues = {
  title: string;
  slug: string;
  status: "draft" | "published";
  metaTitle: string;
  metaDescription: string;
  excerpt: string;
  heroImageUrl: string;
  heroImageAlt: string;
  keywords: string[];
  authorName: string;
  keyPoints: string[];
  bodyHtml: string;
  faqs: ArticleFaq[];
};

export function articleWritePayload(values: ArticleFormValues, userId: string, creating: boolean) {
  return {
    slug: values.slug,
    title: values.title,
    meta_title: values.metaTitle || null,
    meta_description: values.metaDescription || null,
    excerpt: values.excerpt || null,
    body_html: values.bodyHtml,
    key_points: values.keyPoints,
    faqs: values.faqs,
    hero_image_url: values.heroImageUrl || null,
    hero_image_alt: values.heroImageAlt || null,
    keywords: values.keywords,
    author_name: values.authorName,
    status: values.status,
    ...(creating ? { created_by: userId } : {}),
  };
}

export function articleSaveError(message: string): string {
  if (/articles_slug_key|duplicate key/i.test(message)) return "That slug is already in use.";
  if (/articles_slug_format/i.test(message)) {
    return "Use a lowercase slug with letters, numbers, and hyphens.";
  }
  return message;
}
