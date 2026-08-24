import { EMAIL_SITE_ORIGIN, resolveEmailBaseUrl } from "./email-templates";

export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function displayNameForEmail(name: string | null | undefined) {
  const trimmed = (name ?? "").trim();
  return trimmed || "there";
}

export function unsubscribeUrl(email?: string | null, baseUrl?: string) {
  const origin = resolveEmailBaseUrl(baseUrl) || EMAIL_SITE_ORIGIN;
  const url = `${origin}/unsubscribe/`;
  const trimmed = (email ?? "").trim();
  if (!trimmed) return url;
  return `${url}?email=${encodeURIComponent(trimmed)}`;
}

export function personalizeEmailSubject(subject: string, name: string | null | undefined) {
  return subject.replaceAll("{{name}}", displayNameForEmail(name));
}

export function personalizeEmailHtml(
  html: string,
  name: string | null | undefined,
  email?: string | null,
  baseUrl?: string,
) {
  return html
    .replaceAll("{{name}}", escapeHtml(displayNameForEmail(name)))
    .replaceAll("{{unsubscribe_url}}", escapeHtml(unsubscribeUrl(email, baseUrl)));
}
