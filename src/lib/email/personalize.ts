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

export function personalizeEmailSubject(subject: string, name: string | null | undefined) {
  return subject.replaceAll("{{name}}", displayNameForEmail(name));
}

export function personalizeEmailHtml(html: string, name: string | null | undefined) {
  return html.replaceAll("{{name}}", escapeHtml(displayNameForEmail(name)));
}
