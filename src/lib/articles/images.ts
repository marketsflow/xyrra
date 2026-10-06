import type { SupabaseClient } from "@supabase/supabase-js";

export const ARTICLE_IMAGE_BUCKET = "article-images";
export const ARTICLE_IMAGE_MAX_UPLOAD_BYTES = 6 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
]);

export function buildArticleImageStoragePath(params: { scopeId: string; fileName: string }) {
  const safeName = params.fileName
    .trim()
    .replace(/[^\w.\-() ]+/g, "_")
    .replace(/\s+/g, "-")
    .slice(0, 120);
  return `${params.scopeId}/${crypto.randomUUID()}-${safeName || "image"}`;
}

export function validateArticleImage(file: File): { ok: true; mimeType: string } | { ok: false; error: string } {
  const mimeType = file.type.trim().toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return { ok: false, error: "Use a JPEG, PNG, WebP, AVIF, or GIF image." };
  }
  if (file.size > ARTICLE_IMAGE_MAX_UPLOAD_BYTES) {
    return { ok: false, error: "Images must be 6MB or smaller." };
  }
  return { ok: true, mimeType };
}

export async function uploadArticleImage(
  supabase: SupabaseClient,
  params: { scopeId: string; file: File },
): Promise<{ ok: true; publicUrl: string } | { ok: false; error: string }> {
  const scopeId = params.scopeId.trim();
  if (!scopeId) {
    return { ok: false, error: "Save the article before uploading images." };
  }

  const validation = validateArticleImage(params.file);
  if (!validation.ok) return validation;

  const storagePath = buildArticleImageStoragePath({
    scopeId,
    fileName: params.file.name || "image",
  });

  const { error: uploadError } = await supabase.storage.from(ARTICLE_IMAGE_BUCKET).upload(storagePath, params.file, {
    contentType: validation.mimeType,
    upsert: false,
  });

  if (uploadError) {
    return { ok: false, error: uploadError.message };
  }

  const { data } = supabase.storage.from(ARTICLE_IMAGE_BUCKET).getPublicUrl(storagePath);
  const publicUrl = data.publicUrl?.trim();
  if (!publicUrl) {
    return { ok: false, error: "Upload succeeded but the image URL is unavailable." };
  }

  return { ok: true, publicUrl };
}
