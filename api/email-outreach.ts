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

function personalizeHtml(html: string, name: string | null | undefined) {
  return html.replaceAll("{{name}}", escapeHtml(displayNameForEmail(name)));
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

  const recipients = [...uniqueByEmail.values()];
  if (recipients.length === 0) {
    return { success: false, message: "This list has no valid email addresses.", status: 400 };
  }

  let outreachId: string;
  try {
    outreachId = await insertOutreach(config, token, {
      template_id: template.id,
      list_id: list.id,
      subject: parsed.data.subject,
      from_email: parsed.data.fromEmail,
      body_html: template.body_html,
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
    const batch = group.map((member) => ({
      from: parsed.data.fromEmail,
      to: [member.email],
      subject: personalizeSubject(parsed.data.subject, member.name),
      html: personalizeHtml(template.body_html, member.name),
      tags: [
        { name: "xyrra_outreach", value: "true" },
        { name: "outreach_id", value: outreachId },
        { name: "list_id", value: list.id },
        { name: "template_id", value: template.id },
      ],
    }));

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
