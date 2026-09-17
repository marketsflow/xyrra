export const EMAIL_INLINE_IMAGE_MARKER = 'data-xyrra-email-inline-image="true"';

export const EMAIL_INLINE_IMAGE_WIDTH = 600;

export const EMAIL_INLINE_IMAGE_MIN_WIDTH = 120;

export const EMAIL_INLINE_IMAGE_MAX_WIDTH = 600;

export const EMAIL_TEMPLATE_BUCKET = "email-templates";

type InlineImageRecord = {
  src: string;
  fileName: string;
  width: number;
  href?: string;
};

function escapeHtmlAttr(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export function clampEmailInlineImageWidth(width: number) {
  if (!Number.isFinite(width)) return EMAIL_INLINE_IMAGE_WIDTH;
  return Math.min(EMAIL_INLINE_IMAGE_MAX_WIDTH, Math.max(EMAIL_INLINE_IMAGE_MIN_WIDTH, Math.round(width)));
}

export function parseEmailInlineImageWidth(html: string) {
  const maxWidthPx = html.match(/max-width:\s*(\d+)px/i)?.[1];
  const widthPx = html.match(/(?:^|[;\s])width:\s*(\d+)px/i)?.[1];
  const widthAttr = html.match(/\bwidth="(\d+)"/i)?.[1];
  return clampEmailInlineImageWidth(Number(maxWidthPx || widthPx || widthAttr || EMAIL_INLINE_IMAGE_WIDTH));
}

export function emailInlineImageStyle(width: number) {
  const next = clampEmailInlineImageWidth(width);
  return `display:block;width:${next}px;max-width:100%;height:auto;margin:0 auto;border:0;border-radius:8px;`;
}

export function applyEmailInlineImageWidth(img: HTMLImageElement, width: number) {
  const next = clampEmailInlineImageWidth(width);
  img.setAttribute("width", String(next));
  img.setAttribute("style", emailInlineImageStyle(next));
  return next;
}

export function buildEmailInlineImageBlock(
  publicUrl: string,
  fileName: string,
  width = EMAIL_INLINE_IMAGE_WIDTH,
  href?: string,
) {
  const safeUrl = escapeHtmlAttr(publicUrl.trim());
  const safeName = escapeHtmlAttr(fileName.trim() || "Image");
  const safeHref = href?.trim() ? escapeHtmlAttr(href.trim()) : "";
  const next = clampEmailInlineImageWidth(width);
  const image = `<img src="${safeUrl}" alt="${safeName}" width="${next}" style="${emailInlineImageStyle(next)}" />`;

  return `<div ${EMAIL_INLINE_IMAGE_MARKER} style="margin:0 0 16px;text-align:center;">
  ${safeHref ? `<a href="${safeHref}">${image}</a>` : image}
</div>`;
}

function extractImageFromBlock(block: string): InlineImageRecord | null {
  const src = block.match(/\bsrc="([^"]+)"/i)?.[1]?.trim();
  if (!src) return null;

  const alt = block.match(/\balt="([^"]*)"/i)?.[1]?.trim() || "Image";
  const href = block.match(/<a\b[^>]*\bhref="([^"]+)"[^>]*>/i)?.[1]?.trim();
  return { src, fileName: alt, width: parseEmailInlineImageWidth(block), href };
}

function isEmailTemplateImageSrc(src: string) {
  return src.includes(`/${EMAIL_TEMPLATE_BUCKET}/`) || src.includes(`${EMAIL_TEMPLATE_BUCKET}/`);
}

function placeholderFor(index: number) {
  return `<!--xyrra-inline-image-${index}-->`;
}

export function mapEmailInlineImages(html: string, transform: (content: string) => string) {
  const blocks: string[] = [];

  let content = html.replace(/<div[^>]*data-xyrra-email-inline-image="true"[^>]*>[\s\S]*?<\/div>/gi, (block) => {
    const image = extractImageFromBlock(block);
    const rebuilt = image
      ? buildEmailInlineImageBlock(image.src, image.fileName, image.width, image.href)
      : block;
    const index = blocks.length;
    blocks.push(rebuilt);
    return placeholderFor(index);
  });

  content = content.replace(/<img\b[^>]*\bsrc="([^"]+)"[^>]*\/?>/gi, (tag, src: string) => {
    if (!isEmailTemplateImageSrc(src)) return tag;
    const image = extractImageFromBlock(tag);
    if (!image) return tag;
    const index = blocks.length;
    blocks.push(buildEmailInlineImageBlock(image.src, image.fileName, image.width, image.href));
    return placeholderFor(index);
  });

  let out = transform(content);
  blocks.forEach((block, index) => {
    out = out.replace(placeholderFor(index), block);
  });
  return out.replace(
    /(<div[^>]*data-xyrra-email-inline-image="true"[^>]*>[\s\S]*?<\/div>)(?:\s*<p\b[^>]*>\s*(?:<br\s*\/?>|&nbsp;|\s)*<\/p>)+/gi,
    "$1",
  );
}
