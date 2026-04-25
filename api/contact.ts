/**
 * Vercel ships one compiled file for this route — keep all contact/mail logic here
 * (no ./lib/* imports) or Node ESM on /var/task cannot resolve sibling modules.
 *
 * Vercel: Web Standard `default { fetch }` (not legacy (req, res)).
 * Vite: imports named `sendContactEmail` for the dev middleware.
 */

const MAX = { name: 200, email: 320, subject: 200, message: 10000 } as const;
const RESEND_SEND_URL = "https://api.resend.com/emails";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type ResendEnv = {
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  RESEND_TO_EMAIL?: string;
};

type SendResult =
  | { success: true; id?: string }
  | { success: false; message: string; status?: number };

type ResendErrorJson = { message?: string; name?: string; statusCode?: number };

function resendErrorMessage(json: unknown, status: number): string {
  if (json && typeof json === "object") {
    const o = json as ResendErrorJson;
    if (typeof o.message === "string" && o.message.trim()) return o.message.trim();
  }
  return `Resend request failed (HTTP ${status}).`;
}

function validatePayload(
  raw: unknown
):
  | { ok: true; data: { name: string; email: string; subject: string; message: string } }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Invalid JSON body." };
  const o = raw as Record<string, unknown>;
  const name = String(o.name ?? "").trim();
  const email = String(o.email ?? "").trim();
  const subject = String(o.subject ?? "").trim();
  const message = String(o.message ?? "").trim();
  if (!name || !email || !subject || !message) {
    return { ok: false, error: "Name, email, subject, and message are required." };
  }
  if (name.length > MAX.name) return { ok: false, error: "Name is too long." };
  if (email.length > MAX.email) return { ok: false, error: "Email is too long." };
  if (subject.length > MAX.subject) return { ok: false, error: "Subject is too long." };
  if (message.length > MAX.message) return { ok: false, error: "Message is too long." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "Invalid email address." };
  }
  return { ok: true, data: { name, email, subject, message } };
}

/**
 * Send contact form content via Resend HTTP API. Used by this route and by Vite dev.
 */
export async function sendContactEmail(payload: unknown, env: ResendEnv): Promise<SendResult> {
  const parsed = validatePayload(payload);
  if (!parsed.ok) {
    return { success: false, message: parsed.error, status: 400 };
  }
  const { name, email, subject, message } = parsed.data;

  const key = env.RESEND_API_KEY?.trim();
  if (!key) {
    return {
      success: false,
      message:
        "Email is not configured (RESEND_API_KEY). Set it in a .env file for local dev or in your host’s environment (e.g. Vercel) for production.",
      status: 500,
    };
  }

  const to = env.RESEND_TO_EMAIL?.trim();
  if (!to) {
    return {
      success: false,
      message:
        "Inbox is not configured (RESEND_TO_EMAIL). Set the address that should receive contact form messages.",
      status: 500,
    };
  }

  const from = env.RESEND_FROM_EMAIL?.trim() || "Xyrra <onboarding@resend.dev>";
  const text = `Name: ${name}\nEmail: ${email}\n\n${message}`;
  const html = `<p><strong>Name:</strong> ${escapeHtml(name)}</p>
<p><strong>Email:</strong> <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>
<p><strong>Subject:</strong> ${escapeHtml(subject)}</p>
<p><strong>Message:</strong></p>
<p style="white-space:pre-wrap">${escapeHtml(message)}</p>`;

  try {
    const res = await fetch(RESEND_SEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `[Xyrra contact] ${subject}`,
        reply_to: [email],
        text,
        html,
      }),
    });

    const rawText = await res.text();
    let bodyParsed: unknown;
    if (rawText) {
      try {
        bodyParsed = JSON.parse(rawText) as unknown;
      } catch {
        if (!res.ok) {
          return {
            success: false,
            message: resendErrorMessage(null, res.status),
            status: 502,
          };
        }
        bodyParsed = {};
      }
    } else {
      bodyParsed = {};
    }

    if (!res.ok) {
      return {
        success: false,
        message: resendErrorMessage(bodyParsed, res.status),
        status: 502,
      };
    }

    const id =
      bodyParsed &&
      typeof bodyParsed === "object" &&
      "id" in bodyParsed &&
      typeof (bodyParsed as { id: unknown }).id === "string"
        ? (bodyParsed as { id: string }).id
        : undefined;
    return { success: true, id };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "Resend could not send the message.";
    return { success: false, message: errMsg, status: 502 };
  }
}

export const config = {
  maxDuration: 30,
};

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

/**
 * Vercel Node serverless: Web Standard export.
 * @see https://vercel.com/docs/functions/runtimes/node-js
 */
export default {
  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== "POST") {
        return Response.json(
          { success: false, message: "Method not allowed" },
          { status: 405, headers: jsonHeaders }
        );
      }

      let payload: unknown;
      const ct = (request.headers.get("content-type") || "").toLowerCase();
      if (ct.includes("application/json")) {
        try {
          payload = await request.json();
        } catch {
          return Response.json(
            { success: false, message: "Invalid JSON body." },
            { status: 400, headers: jsonHeaders }
          );
        }
      } else {
        return Response.json(
          { success: false, message: "Content-Type must be application/json." },
          { status: 400, headers: jsonHeaders }
        );
      }

      const env: ResendEnv = {
        RESEND_API_KEY: process.env.RESEND_API_KEY,
        RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
        RESEND_TO_EMAIL: process.env.RESEND_TO_EMAIL,
      };

      const result = await sendContactEmail(payload, env);

      if (result.success) {
        return Response.json({ success: true, id: result.id }, { status: 200, headers: jsonHeaders });
      }
      return Response.json(
        { success: false, message: result.message },
        { status: result.status ?? 500, headers: jsonHeaders }
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Internal error";
      return Response.json(
        { success: false, message: msg },
        { status: 500, headers: jsonHeaders }
      );
    }
  },
};
