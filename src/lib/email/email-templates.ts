export const EMAIL_BODY_START = "<!--xyrra-email-body-->";
export const EMAIL_BODY_END = "<!--/xyrra-email-body-->";

export const DEFAULT_FROM_EMAIL = "Xyrra <onboarding@resend.dev>";

export const FROM_EMAIL_OPTIONS = [
  DEFAULT_FROM_EMAIL,
  "Xyrra <hello@xyrra.ai>",
] as const;

export type EmailTemplate = {
  id: string;
  name: string;
  subject: string;
  bodyHtml: string;
  fromEmail: string;
  createdAt: string;
  updatedAt: string;
};

export type EmailHtmlParts = {
  shellBefore: string;
  editableContent: string;
  shellAfter: string;
};

export function getDefaultEditableContent() {
  return "<p>Dear {{name}},</p><p><br></p>";
}

function escapeHtmlAttr(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}

export function getEmailShellBefore(baseUrl = window.location.origin) {
  const logoUrl = escapeHtmlAttr(`${baseUrl.replace(/\/+$/, "")}/images/new/xyrra-logo.png`);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Xyrra email</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f8f9fd;font-family:Arial,Helvetica,sans-serif;color:#141820;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8f9fd;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e0deed;">
            <tr>
              <td style="padding:28px 32px 12px;text-align:center;border-bottom:1px solid #eef0f5;">
                <img src="${logoUrl}" alt="Xyrra" width="120" style="display:block;margin:0 auto;height:auto;max-width:120px;" />
              </td>
            </tr>
            <tr>
              <td style="padding:32px;font-size:16px;line-height:1.6;">${EMAIL_BODY_START}`;
}

export function getEmailShellAfter() {
  return `${EMAIL_BODY_END}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function mergeEmailHtml(parts: EmailHtmlParts) {
  if (!parts.shellBefore && !parts.shellAfter) {
    return parts.editableContent;
  }

  return `${parts.shellBefore}${parts.editableContent}${parts.shellAfter}`;
}

export function splitEmailHtml(fullHtml: string): EmailHtmlParts {
  const startMarkerIndex = fullHtml.indexOf(EMAIL_BODY_START);
  const endMarkerIndex = fullHtml.indexOf(EMAIL_BODY_END);

  if (startMarkerIndex !== -1 && endMarkerIndex !== -1 && endMarkerIndex > startMarkerIndex) {
    const contentStart = startMarkerIndex + EMAIL_BODY_START.length;
    return {
      shellBefore: fullHtml.slice(0, contentStart),
      editableContent: fullHtml.slice(contentStart, endMarkerIndex),
      shellAfter: fullHtml.slice(endMarkerIndex),
    };
  }

  return {
    shellBefore: "",
    editableContent: fullHtml,
    shellAfter: "",
  };
}

export function buildEmailHtml(editableContent: string, baseUrl?: string) {
  return mergeEmailHtml({
    shellBefore: getEmailShellBefore(baseUrl),
    editableContent,
    shellAfter: getEmailShellAfter(),
  });
}

export function mapEmailTemplateRow(row: Record<string, unknown>): EmailTemplate {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    subject: String(row.subject ?? ""),
    bodyHtml: String(row.body_html ?? ""),
    fromEmail: String(row.from_email ?? DEFAULT_FROM_EMAIL),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

export function duplicateTemplateName(name: string) {
  const trimmed = name.trim() || "Untitled template";
  const copyPrefix = "Copy of ";
  if (trimmed.startsWith(copyPrefix)) {
    return `${copyPrefix}${trimmed.slice(copyPrefix.length)}`;
  }
  return `${copyPrefix}${trimmed}`;
}
