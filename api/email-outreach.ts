/**
 * Vercel ships one compiled file for this route — keep all outreach/mail logic here
 * (no ./lib/* imports) or Node ESM on /var/task cannot resolve sibling modules.
 *
 * Vercel: Web Standard `default { fetch }` (not legacy (req, res)).
 * Vite: imports named `sendEmailOutreach` for the dev middleware.
 */

const RESEND_BATCH_URL = "https://api.resend.com/emails/batch";
const MAX_SUBJECT = 200;
const MEMBER_PAGE_SIZE = 1000;
const BATCH_SIZE = 100;
const FROM_EMAIL_OPTIONS = ["Xyrra <onboarding@resend.dev>", "Xyrra <hello@xyrra.ai>"] as const;
const EMAIL_BODY_START = "<!--xyrra-email-body-->";
const EMAIL_BODY_END = "<!--/xyrra-email-body-->";
const EMAIL_SITE_ORIGIN = "https://www.xyrra.ai";
const EMAIL_COMPANY_ADDRESS =
  "Xyrra Ltd, Office One, 1 coldbath Square, London, England, EC1R 5HL";

export type OutreachEnv = {
  RESEND_API_KEY?: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
};

type SendResult =
  | {
      success: true;
      outreachId: string;
      recipientCount: number;
      sentCount: number;
      failedCount: number;
    }
  | { success: false; message: string; status?: number };

type OutreachPayload = {
  templateId: string;
  listId: string;
  subject: string;
  fromEmail: string;
};

type TemplateRow = {
  id: string;
  subject: string;
  body_html: string;
  from_email: string;
};

type ListRow = {
  id: string;
  name: string;
};

type MemberRow = {
  id: string;
  name: string | null;
  email: string;
};

type RecipientResult = {
  list_member_id: string;
  name: string | null;
  email: string;
  resend_email_id: string | null;
  status: "sent" | "failed";
  delivery_status: "sent" | "failed";
  error: string | null;
  sent_at: string | null;
};

type ResendErrorJson = { message?: string; name?: string; statusCode?: number };

function jsonHeaders() {
  return { "Content-Type": "application/json; charset=utf-8" };
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function displayNameForEmail(name: string | null | undefined) {
  const trimmed = (name ?? "").trim();
  return trimmed || "there";
}

function personalizeSubject(subject: string, name: string | null | undefined) {
  return subject.replaceAll("{{name}}", displayNameForEmail(name));
}

function personalizeHtml(html: string, name: string | null | undefined, email?: string | null) {
  const unsubscribe = `${EMAIL_SITE_ORIGIN}/unsubscribe/${email ? `?email=${encodeURIComponent(email.trim())}` : ""}`;
  return html
    .replaceAll("{{name}}", escapeHtml(displayNameForEmail(name)))
    .replaceAll("{{unsubscribe_url}}", escapeHtml(unsubscribe));
}

function escapeHtmlAttr(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

const EMAIL_INLINE_IMAGE_MARKER = 'data-xyrra-email-inline-image="true"';
const EMAIL_INLINE_IMAGE_WIDTH = 600;
const EMAIL_INLINE_IMAGE_MIN_WIDTH = 120;
const EMAIL_INLINE_IMAGE_MAX_WIDTH = 600;
const EMAIL_TEMPLATE_BUCKET = "email-templates";

function clampOutreachImageWidth(width: number) {
  if (!Number.isFinite(width)) return EMAIL_INLINE_IMAGE_WIDTH;
  return Math.min(EMAIL_INLINE_IMAGE_MAX_WIDTH, Math.max(EMAIL_INLINE_IMAGE_MIN_WIDTH, Math.round(width)));
}

function parseOutreachImageWidth(html: string) {
  const maxWidthPx = html.match(/max-width:\s*(\d+)px/i)?.[1];
  const widthPx = html.match(/(?:^|[;\s])width:\s*(\d+)px/i)?.[1];
  const widthAttr = html.match(/\bwidth="(\d+)"/i)?.[1];
  return clampOutreachImageWidth(Number(maxWidthPx || widthPx || widthAttr || EMAIL_INLINE_IMAGE_WIDTH));
}

function buildOutreachInlineImageBlock(publicUrl: string, fileName: string, width = EMAIL_INLINE_IMAGE_WIDTH) {
  const safeUrl = escapeHtmlAttr(publicUrl.trim());
  const safeName = escapeHtmlAttr(fileName.trim() || "Image");
  const next = clampOutreachImageWidth(width);

  return `<div ${EMAIL_INLINE_IMAGE_MARKER} style="margin:0 0 16px;text-align:center;">
  <img src="${safeUrl}" alt="${safeName}" width="${next}" style="display:block;width:${next}px;max-width:100%;height:auto;margin:0 auto;border:0;border-radius:8px;" />
</div>`;
}

function extractOutreachImageFromBlock(block: string) {
  const src = block.match(/\bsrc="([^"]+)"/i)?.[1]?.trim();
  if (!src) return null;
  return {
    src,
    fileName: block.match(/\balt="([^"]*)"/i)?.[1]?.trim() || "Image",
    width: parseOutreachImageWidth(block),
  };
}

function mapOutreachInlineImages(html: string, transform: (content: string) => string) {
  const blocks: string[] = [];
  const placeholder = (index: number) => `<!--xyrra-inline-image-${index}-->`;

  let content = html.replace(/<div[^>]*data-xyrra-email-inline-image="true"[^>]*>[\s\S]*?<\/div>/gi, (block) => {
    const image = extractOutreachImageFromBlock(block);
    const rebuilt = image
      ? buildOutreachInlineImageBlock(image.src, image.fileName, image.width)
      : block;
    const index = blocks.length;
    blocks.push(rebuilt);
    return placeholder(index);
  });

  content = content.replace(/<img\b[^>]*\bsrc="([^"]+)"[^>]*\/?>/gi, (tag, src: string) => {
    if (!src.includes(`/${EMAIL_TEMPLATE_BUCKET}/`) && !src.includes(`${EMAIL_TEMPLATE_BUCKET}/`)) {
      return tag;
    }
    const image = extractOutreachImageFromBlock(tag);
    if (!image) return tag;
    const index = blocks.length;
    blocks.push(buildOutreachInlineImageBlock(image.src, image.fileName, image.width));
    return placeholder(index);
  });

  let out = transform(content);
  blocks.forEach((block, index) => {
    out = out.replace(placeholder(index), block);
  });
  return out.replace(
    /(<div[^>]*data-xyrra-email-inline-image="true"[^>]*>[\s\S]*?<\/div>)(?:\s*<p\b[^>]*>\s*(?:<br\s*\/?>|&nbsp;|\s)*<\/p>)+/gi,
    "$1",
  );
}

function normalizeOutreachBodyHtml(html: string) {
  return mapOutreachInlineImages(html, (content) => {
    const textStyle = "font-family:Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#141820;";
    const reset = new Set(["font", "font-family", "font-size", "font-weight", "line-height", "color"]);
    const keep = (style: string) =>
      style
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .filter((decl) => {
          const prop = decl.split(":")[0]?.trim().toLowerCase();
          return Boolean(prop) && !reset.has(prop);
        })
        .join(";");

    let out = content.replace(/<\/?font\b[^>]*>/gi, "");
    out = out.replace(/<(\/?)h[1-6]\b([^>]*)>/gi, "<$1p$2>");
    out = out.replace(/\sstyle=(["'])([\s\S]*?)\1/gi, (_match, quote: string, style: string) => {
      const kept = keep(style);
      return kept ? ` style=${quote}${kept}${quote}` : "";
    });
    out = out.replace(/\s(?:face|size)=["'][^"']*["']/gi, "");
    out = out.replace(/<(p|div|li)\b([^>]*)>/gi, (_match, tag: string, rest: string) => {
      const extra = tag === "li" ? "margin:0 0 8px;" : "margin:0 0 16px;";
      if (/\sstyle=/i.test(rest)) {
        return `<${tag}${rest.replace(/\sstyle=(["'])([\s\S]*?)\1/i, (_s, quote: string, style: string) => {
          const kept = keep(style);
          return ` style=${quote}${extra}${textStyle}${kept ? `${kept};` : ""}${quote}`;
        })}>`;
      }
      return `<${tag}${rest} style="${extra}${textStyle}">`;
    });
    return out;
  });
}

function wrapOutreachHtml(fullHtml: string) {
  const startMarkerIndex = fullHtml.indexOf(EMAIL_BODY_START);
  const endMarkerIndex = fullHtml.indexOf(EMAIL_BODY_END);
  const editableContent = normalizeOutreachBodyHtml(
    startMarkerIndex !== -1 && endMarkerIndex > startMarkerIndex
      ? fullHtml.slice(startMarkerIndex + EMAIL_BODY_START.length, endMarkerIndex)
      : fullHtml,
  );

  const logoUrl = escapeHtmlAttr(`${EMAIL_SITE_ORIGIN}/images/email/xyrra-logo-black.png`);
  const articlesUrl = escapeHtmlAttr(
    `${EMAIL_SITE_ORIGIN}/article/ai-hardware/Why-AI-Demands-a-New-Kind-of-Machine/`,
  );
  const privacyUrl = escapeHtmlAttr(`${EMAIL_SITE_ORIGIN}/private-policy/`);
  const termsUrl = escapeHtmlAttr(`${EMAIL_SITE_ORIGIN}/terms-and-conditions/`);
  const linkStyle = "color:#6b7280;text-decoration:underline;";
  const pipe = '<span style="color:#c5cad3;">&nbsp;|&nbsp;</span>';
  const bodyTextStyle =
    "font-family:Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#141820;";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Xyrra email</title>
    <style>
      .xyrra-email-body, .xyrra-email-body p, .xyrra-email-body div, .xyrra-email-body span,
      .xyrra-email-body li, .xyrra-email-body h1, .xyrra-email-body h2, .xyrra-email-body h3,
      .xyrra-email-body h4, .xyrra-email-body h5, .xyrra-email-body h6 {
        font-family: Arial, Helvetica, sans-serif !important;
        font-size: 16px !important;
        line-height: 1.6 !important;
        color: #141820 !important;
      }
      .xyrra-email-body h1, .xyrra-email-body h2, .xyrra-email-body h3,
      .xyrra-email-body h4, .xyrra-email-body h5, .xyrra-email-body h6 {
        font-weight: 400 !important;
        margin: 0 0 16px !important;
      }
      .xyrra-email-body strong, .xyrra-email-body b { font-weight: 700 !important; }
      .xyrra-email-body [data-xyrra-email-inline-image] {
        text-align: center !important;
        margin: 0 0 16px !important;
        line-height: 0 !important;
        font-size: 0 !important;
      }
      .xyrra-email-body [data-xyrra-email-inline-image] img {
        display: block !important;
        max-width: 100% !important;
        height: auto !important;
        margin: 0 auto !important;
        border: 0 !important;
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background-color:#f8f9fd;font-family:Arial,Helvetica,sans-serif;color:#141820;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8f9fd;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e0deed;">
            <tr>
              <td style="padding:28px 32px 12px;text-align:center;">
                <img src="${logoUrl}" alt="Xyrra" width="120" style="display:block;margin:0 auto;height:auto;max-width:120px;border:0;" />
              </td>
            </tr>
            <tr>
              <td class="xyrra-email-body" style="padding:32px;${bodyTextStyle}">${EMAIL_BODY_START}${editableContent}${EMAIL_BODY_END}
              </td>
            </tr>
            <tr>
              <td style="padding:28px 32px 32px;text-align:center;">
                <img src="${logoUrl}" alt="Xyrra" width="100" style="display:block;margin:0 auto 16px;height:auto;max-width:100px;border:0;" />
                <p style="margin:0 0 16px;font-size:12px;line-height:1.6;color:#6b7280;">${EMAIL_COMPANY_ADDRESS}</p>
                <p style="margin:0;font-size:12px;line-height:1.6;">
                  <a href="${articlesUrl}" style="${linkStyle}">Articles</a>${pipe}<a href="${privacyUrl}" style="${linkStyle}">Privacy</a>${pipe}<a href="${termsUrl}" style="${linkStyle}">Terms</a>${pipe}<a href="{{unsubscribe_url}}" style="${linkStyle}">Unsubscribe</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function resendErrorMessage(json: unknown, status: number): string {
  if (json && typeof json === "object") {
    const o = json as ResendErrorJson;
    if (typeof o.message === "string" && o.message.trim()) return o.message.trim();
  }
  return `Resend request failed (HTTP ${status}).`;
}

function bearerToken(authHeader: string | null | undefined) {
  if (!authHeader) return "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

function parsePayload(raw: unknown): { ok: true; data: OutreachPayload } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Invalid JSON body." };
  const o = raw as Record<string, unknown>;
  const templateId = String(o.templateId ?? "").trim();
  const listId = String(o.listId ?? "").trim();
  const subject = String(o.subject ?? "").trim();
  const fromEmail = String(o.fromEmail ?? "").trim();

  if (!templateId || !listId || !subject || !fromEmail) {
    return { ok: false, error: "Template, list, subject, and from address are required." };
  }
  if (subject.length > MAX_SUBJECT) {
    return { ok: false, error: "Subject is too long." };
  }
  if (!FROM_EMAIL_OPTIONS.includes(fromEmail as (typeof FROM_EMAIL_OPTIONS)[number])) {
    return { ok: false, error: "Invalid send-from address." };
  }

  return { ok: true, data: { templateId, listId, subject, fromEmail } };
}

async function parseJsonResponse(res: Response): Promise<unknown> {
  const rawText = await res.text();
  if (!rawText) return {};
  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    return rawText;
  }
}

function supabaseConfig(env: OutreachEnv) {
  const url = env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const anonKey = env.SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) {
    return null;
  }
  return { url, anonKey };
}

async function supabaseFetch(
  config: { url: string; anonKey: string },
  token: string,
  path: string,
  init?: RequestInit,
) {
  const headers = new Headers(init?.headers);
  headers.set("apikey", config.anonKey);
  headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type") && init?.body) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(`${config.url}${path}`, {
    ...init,
    headers,
  });
}

async function requireAdminUser(
  config: { url: string; anonKey: string },
  token: string,
): Promise<{ ok: true; userId: string } | { ok: false; message: string; status: number }> {
  const userRes = await supabaseFetch(config, token, "/auth/v1/user");
  const userJson = await parseJsonResponse(userRes);
  if (!userRes.ok) {
    return { ok: false, message: "Sign in required.", status: 401 };
  }

  const userId =
    userJson && typeof userJson === "object" && typeof (userJson as { id?: unknown }).id === "string"
      ? (userJson as { id: string }).id
      : "";
  if (!userId) {
    return { ok: false, message: "Sign in required.", status: 401 };
  }

  const profileRes = await supabaseFetch(
    config,
    token,
    `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=role`,
  );
  const profiles = (await parseJsonResponse(profileRes)) as Array<{ role?: string }> | unknown;
  const role =
    Array.isArray(profiles) && profiles[0] && typeof profiles[0].role === "string" ? profiles[0].role : "user";

  if (role !== "admin" && role !== "editor") {
    return { ok: false, message: "Not authorized for the admin console.", status: 403 };
  }

  return { ok: true, userId };
}

async function fetchTemplate(
  config: { url: string; anonKey: string },
  token: string,
  templateId: string,
): Promise<TemplateRow | null> {
  const res = await supabaseFetch(
    config,
    token,
    `/rest/v1/email_templates?id=eq.${encodeURIComponent(templateId)}&select=id,subject,body_html,from_email`,
  );
  if (!res.ok) return null;
  const rows = (await parseJsonResponse(res)) as TemplateRow[] | unknown;
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function fetchList(
  config: { url: string; anonKey: string },
  token: string,
  listId: string,
): Promise<ListRow | null> {
  const res = await supabaseFetch(
    config,
    token,
    `/rest/v1/email_lists?id=eq.${encodeURIComponent(listId)}&select=id,name`,
  );
  if (!res.ok) return null;
  const rows = (await parseJsonResponse(res)) as ListRow[] | unknown;
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function fetchMembers(
  config: { url: string; anonKey: string },
  token: string,
  listId: string,
): Promise<MemberRow[]> {
  const members: MemberRow[] = [];
  let offset = 0;

  while (true) {
    const res = await supabaseFetch(
      config,
      token,
      `/rest/v1/email_list_members?list_id=eq.${encodeURIComponent(listId)}&select=id,name,email&order=created_at.asc&limit=${MEMBER_PAGE_SIZE}&offset=${offset}`,
    );
    if (!res.ok) {
      throw new Error("Unable to load email list members.");
    }
    const rows = (await parseJsonResponse(res)) as MemberRow[] | unknown;
    const page = Array.isArray(rows) ? rows : [];
    members.push(...page);
    if (page.length < MEMBER_PAGE_SIZE) break;
    offset += MEMBER_PAGE_SIZE;
  }

  return members;
}

async function fetchUnsubscribedEmails(
  config: { url: string; anonKey: string },
  token: string,
  emails: string[],
): Promise<Set<string>> {
  const unsubscribed = new Set<string>();
  if (emails.length === 0) return unsubscribed;

  for (const group of chunk(emails, BATCH_SIZE)) {
    const filter = group.map((email) => `"${email.replaceAll('"', "")}"`).join(",");
    const res = await supabaseFetch(
      config,
      token,
      `/rest/v1/email_unsubscribes?select=email&email=in.(${filter})`,
    );
    if (!res.ok) {
      break;
    }
    const rows = (await parseJsonResponse(res)) as Array<{ email?: string }> | unknown;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const email = String(row.email ?? "")
        .trim()
        .toLowerCase();
      if (email) unsubscribed.add(email);
    }
  }

  return unsubscribed;
}

async function insertOutreach(
  config: { url: string; anonKey: string },
  token: string,
  row: Record<string, unknown>,
): Promise<string> {
  const res = await supabaseFetch(config, token, "/rest/v1/email_outreach", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  const json = await parseJsonResponse(res);
  if (!res.ok) {
    const message =
      json && typeof json === "object" && typeof (json as { message?: unknown }).message === "string"
        ? (json as { message: string }).message
        : "Unable to record outreach send.";
    throw new Error(message);
  }
  const rows = json as Array<{ id?: string }> | { id?: string };
  const id = Array.isArray(rows) ? rows[0]?.id : rows.id;
  if (!id) throw new Error("Unable to record outreach send.");
  return id;
}

async function updateOutreach(
  config: { url: string; anonKey: string },
  token: string,
  outreachId: string,
  patch: Record<string, unknown>,
) {
  const res = await supabaseFetch(
    config,
    token,
    `/rest/v1/email_outreach?id=eq.${encodeURIComponent(outreachId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) {
    throw new Error("Unable to update outreach send.");
  }
}

async function insertRecipients(
  config: { url: string; anonKey: string },
  token: string,
  outreachId: string,
  results: RecipientResult[],
) {
  for (let i = 0; i < results.length; i += BATCH_SIZE) {
    const chunk = results.slice(i, i + BATCH_SIZE).map((result) => ({
      outreach_id: outreachId,
      list_member_id: result.list_member_id,
      name: result.name,
      email: result.email,
      resend_email_id: result.resend_email_id,
      status: result.status,
      delivery_status: result.delivery_status,
      error: result.error,
      sent_at: result.sent_at,
    }));
    const res = await supabaseFetch(config, token, "/rest/v1/email_outreach_recipients", {
      method: "POST",
      body: JSON.stringify(chunk),
    });
    if (!res.ok) {
      throw new Error("Emails were sent but recipient records could not be saved.");
    }
  }
}

function chunk<T>(items: T[], size: number) {
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    groups.push(items.slice(i, i + size));
  }
  return groups;
}

async function sendResendBatch(
  apiKey: string,
  batch: Array<{
    from: string;
    to: string[];
    subject: string;
    html: string;
    headers?: Record<string, string>;
    tags?: Array<{ name: string; value: string }>;
  }>,
): Promise<{ ok: true; ids: Array<string | null> } | { ok: false; message: string }> {
  const res = await fetch(RESEND_BATCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(batch),
  });

  const json = await parseJsonResponse(res);
  if (!res.ok) {
    return { ok: false, message: resendErrorMessage(json, res.status) };
  }

  const data =
    json && typeof json === "object" && Array.isArray((json as { data?: unknown }).data)
      ? ((json as { data: Array<{ id?: unknown }> }).data)
      : Array.isArray(json)
        ? (json as Array<{ id?: unknown }>)
        : [];

  const ids = batch.map((_, index) => {
    const id = data[index]?.id;
    return typeof id === "string" ? id : null;
  });

  return { ok: true, ids };
}

export async function sendEmailOutreach(
  payload: unknown,
  env: OutreachEnv,
  authHeader: string | null | undefined,
): Promise<SendResult> {
  const token = bearerToken(authHeader);
  if (!token) {
    return { success: false, message: "Sign in required.", status: 401 };
  }

  const parsed = parsePayload(payload);
  if (!parsed.ok) {
    return { success: false, message: parsed.error, status: 400 };
  }

  const config = supabaseConfig(env);
  if (!config) {
    return {
      success: false,
      message: "Supabase is not configured on the server.",
      status: 500,
    };
  }

  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    return {
      success: false,
      message: "Email is not configured (RESEND_API_KEY).",
      status: 500,
    };
  }

  const admin = await requireAdminUser(config, token);
  if (!admin.ok) {
    return { success: false, message: admin.message, status: admin.status };
  }

  const [template, list] = await Promise.all([
    fetchTemplate(config, token, parsed.data.templateId),
    fetchList(config, token, parsed.data.listId),
  ]);

  if (!template) {
    return { success: false, message: "Email template was not found.", status: 404 };
  }
  if (!list) {
    return { success: false, message: "Email list was not found.", status: 404 };
  }

  let members: MemberRow[];
  try {
    members = await fetchMembers(config, token, list.id);
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unable to load email list members.",
      status: 500,
    };
  }

  const uniqueByEmail = new Map<string, MemberRow>();
  for (const member of members) {
    const email = member.email.trim().toLowerCase();
    if (!isValidEmail(email)) continue;
    if (!uniqueByEmail.has(email)) {
      uniqueByEmail.set(email, { ...member, email });
    }
  }

  let unsubscribed = new Set<string>();
  try {
    unsubscribed = await fetchUnsubscribedEmails(config, token, [...uniqueByEmail.keys()]);
  } catch {
    unsubscribed = new Set();
  }

  const recipients = [...uniqueByEmail.values()].filter((member) => !unsubscribed.has(member.email));
  if (recipients.length === 0) {
    return {
      success: false,
      message: uniqueByEmail.size === 0
        ? "This list has no valid email addresses."
        : "Every recipient on this list has unsubscribed.",
      status: 400,
    };
  }

  const wrappedHtml = wrapOutreachHtml(template.body_html);

  let outreachId: string;
  try {
    outreachId = await insertOutreach(config, token, {
      template_id: template.id,
      list_id: list.id,
      subject: parsed.data.subject,
      from_email: parsed.data.fromEmail,
      body_html: wrappedHtml,
      recipient_count: recipients.length,
      sent_count: 0,
      failed_count: 0,
      status: "sending",
      sent_by: admin.userId,
    });
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unable to record outreach send.",
      status: 500,
    };
  }

  const nowIso = () => new Date().toISOString();
  const results: RecipientResult[] = [];

  for (const group of chunk(recipients, BATCH_SIZE)) {
    const batch = group.map((member) => {
      const unsubscribeApi = `${EMAIL_SITE_ORIGIN}/api/unsubscribe?email=${encodeURIComponent(member.email)}`;
      return {
        from: parsed.data.fromEmail,
        to: [member.email],
        subject: personalizeSubject(parsed.data.subject, member.name),
        html: personalizeHtml(wrappedHtml, member.name, member.email),
        headers: {
          "List-Unsubscribe": `<${unsubscribeApi}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
        tags: [
          { name: "xyrra_outreach", value: "true" },
          { name: "outreach_id", value: outreachId },
          { name: "list_id", value: list.id },
          { name: "template_id", value: template.id },
        ],
      };
    });

    const sent = await sendResendBatch(apiKey, batch);
    if (!sent.ok) {
      for (const member of group) {
        results.push({
          list_member_id: member.id,
          name: member.name,
          email: member.email,
          resend_email_id: null,
          status: "failed",
          delivery_status: "failed",
          error: sent.message,
          sent_at: null,
        });
      }
      continue;
    }

    group.forEach((member, index) => {
      const resendId = sent.ids[index];
      results.push({
        list_member_id: member.id,
        name: member.name,
        email: member.email,
        resend_email_id: resendId,
        status: resendId ? "sent" : "failed",
        delivery_status: resendId ? "sent" : "failed",
        error: resendId ? null : "Resend did not return an email id.",
        sent_at: resendId ? nowIso() : null,
      });
    });
  }

  const sentCount = results.filter((result) => result.status === "sent").length;
  const failedCount = results.length - sentCount;
  const status = failedCount === 0 ? "sent" : sentCount === 0 ? "failed" : "partial";

  try {
    await insertRecipients(config, token, outreachId, results);
    await updateOutreach(config, token, outreachId, {
      sent_count: sentCount,
      failed_count: failedCount,
      status,
    });
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unable to save outreach results.",
      status: 500,
    };
  }

  if (sentCount === 0) {
    return {
      success: false,
      message: results[0]?.error ?? "No emails were sent.",
      status: 502,
    };
  }

  return {
    success: true,
    outreachId,
    recipientCount: recipients.length,
    sentCount,
    failedCount,
  };
}

export const config = {
  maxDuration: 60,
};

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== "POST") {
        return Response.json(
          { success: false, message: "Method not allowed" },
          { status: 405, headers: jsonHeaders() },
        );
      }

      let payload: unknown;
      const ct = (request.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("application/json")) {
        return Response.json(
          { success: false, message: "Content-Type must be application/json." },
          { status: 400, headers: jsonHeaders() },
        );
      }

      try {
        payload = await request.json();
      } catch {
        return Response.json(
          { success: false, message: "Invalid JSON body." },
          { status: 400, headers: jsonHeaders() },
        );
      }

      const env: OutreachEnv = {
        RESEND_API_KEY: process.env.RESEND_API_KEY,
        SUPABASE_URL: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
        SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY,
      };

      const result = await sendEmailOutreach(payload, env, request.headers.get("authorization"));
      if (result.success) {
        return Response.json(
          {
            success: true,
            outreachId: result.outreachId,
            recipientCount: result.recipientCount,
            sentCount: result.sentCount,
            failedCount: result.failedCount,
          },
          { status: 200, headers: jsonHeaders() },
        );
      }

      return Response.json(
        { success: false, message: result.message },
        { status: result.status ?? 500, headers: jsonHeaders() },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Internal error";
      return Response.json({ success: false, message: msg }, { status: 500, headers: jsonHeaders() });
    }
  },
};
