export const EMAIL_INLINE_IMAGE_MARKER = 'data-xyrra-email-inline-image="true"';

export const EMAIL_INLINE_IMAGE_WIDTH = 600;

export const EMAIL_TEMPLATE_BUCKET = "email-templates";

type InlineImageRecord = {
  src: string;
  fileName: string;
};

function escapeHtmlAttr(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export function buildEmailInlineImageBlock(publicUrl: string, fileName: string) {
  const safeUrl = escapeHtmlAttr(publicUrl.trim());
  const safeName = escapeHtmlAttr(fileName.trim() || "Image");
  const width = EMAIL_INLINE_IMAGE_WIDTH;
  const linkStyle = "color:#2563eb;font-weight:600;font-size:13px;text-decoration:underline;";

  return `<div ${EMAIL_INLINE_IMAGE_MARKER} style="margin:24px 0 0;text-align:center;">
  <img src="${safeUrl}" alt="${safeName}" width="${width}" style="display:block;width:100%;max-width:${width}px;height:auto;margin:0 auto;border:0;border-radius:8px;" />
  <p style="margin:8px 0 0;font-size:13px;line-height:1.4;text-align:center;">
    <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="${linkStyle}">Download full-size image</a>
  </p>
</div>`;
}

function extractImageFromBlock(block: string): InlineImageRecord | null {
  const src = block.match(/\bsrc="([^"]+)"/i)?.[1]?.trim();
  if (!src) return null;

  const alt = block.match(/\balt="([^"]*)"/i)?.[1]?.trim() || "Image";
  return { src, fileName: alt };
}

function isEmailTemplateImageSrc(src: string) {
  return src.includes(`/${EMAIL_TEMPLATE_BUCKET}/`) || src.includes(`${EMAIL_TEMPLATE_BUCKET}/`);
}

export function extractEmailInlineImages(html: string): { content: string; images: InlineImageRecord[] } {
  const images: InlineImageRecord[] = [];
  let content = html;

  const markedBlockRegex = /<div[^>]*data-xyrra-email-inline-image="true"[^>]*>[\s\S]*?<\/div>/gi;
  content = content.replace(markedBlockRegex, (block) => {
    const image = extractImageFromBlock(block);
    if (image) images.push(image);
    return "";
  });

  content = content.replace(/<img\b[^>]*\bsrc="([^"]+)"[^>]*\/?>/gi, (tag, src: string) => {
    if (!isEmailTemplateImageSrc(src)) return tag;
    const image = extractImageFromBlock(tag);
    if (image) images.push(image);
    return "";
  });

  return { content, images };
}

export function appendEmailInlineImages(content: string, images: InlineImageRecord[]) {
  if (images.length === 0) return content;
  const trimmed = content.replace(/(\s*<p><br><\/p>\s*)+$/gi, "").trimEnd();
  const blocks = images.map((image) => buildEmailInlineImageBlock(image.src, image.fileName)).join("");
  return `${trimmed}${blocks}`;
}

export function normalizeEmailInlineImages(html: string) {
  const { content, images } = extractEmailInlineImages(html);
  if (images.length === 0) return html;
  return appendEmailInlineImages(content, images);
}
