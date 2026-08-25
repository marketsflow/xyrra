/**
 * Vercel ships one compiled file for this route — keep signup logic here
 * (no ./lib/* imports) or Node ESM on /var/task cannot resolve sibling modules.
 *
 * Vercel: Web Standard `default { fetch }` (not legacy (req, res)).
 * Vite: imports named `recordFreecapsSignup` for the dev middleware.
 */

const MAX = { name: 200, email: 320, subject: 200, message: 10000 } as const;
const RESEND_SEND_URL = "https://api.resend.com/emails";

type SignupEnv = {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  RESEND_TO_EMAIL?: string;
};

type SignupResult =
  | { success: true; id?: string }
  | { success: false; message: string; status?: number };

function jsonHeaders() {
  return { "Content-Type": "application/json; charset=utf-8" };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function supabaseConfig(env: SignupEnv) {
  const url = (env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) return null;
  return { url, serviceRoleKey };
}

function validatePayload(raw: unknown):
  | {
      ok: true;
      data: {
        name: string;
        email: string;
        kickstarterNotifyConfirmed: boolean;
      };
    }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Invalid JSON body." };
  const o = raw as Record<string, unknown>;
  const name = String(o.name ?? "").trim();
  const email = String(o.email ?? "").trim().toLowerCase();
  const kickstarterNotifyConfirmed = o.kickstarterNotifyConfirmed === true;

  if (!name || !email) {
    return { ok: false, error: "Name and email are required." };
  }
  if (!kickstarterNotifyConfirmed) {
    return {
      ok: false,
      error: "Please confirm you have registered for Notify me on launch on Kickstarter.",
    };
  }
  if (name.length > MAX.name) return { ok: false, error: "Name is too long." };
  if (email.length > MAX.email) return { ok: false, error: "Email is too long." };
  if (!isValidEmail(email)) return { ok: false, error: "Invalid email address." };

  return { ok: true, data: { name, email, kickstarterNotifyConfirmed } };
}

async function sendSignupNotification(
  name: string,
  email: string,
  signupId: string | undefined,
  env: SignupEnv,
): Promise<void> {
  const key = env.RESEND_API_KEY?.trim();
  const to = env.RESEND_TO_EMAIL?.trim();
  if (!key || !to) return;

  const subject = "Free Caps Community Giveaway";
  const message = [
    "Free Caps Community giveaway signup",
    "",
    "Kickstarter Notify confirmed: yes",
    signupId ? `Signup ID: ${signupId}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const from = env.RESEND_FROM_EMAIL?.trim() || "Xyrra <onboarding@resend.dev>";
  const text = `Name: ${name}\nEmail: ${email}\n\n${message}`;
  const html = `<p><strong>Name:</strong> ${escapeHtml(name)}</p>
<p><strong>Email:</strong> <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>
<p><strong>Subject:</strong> ${escapeHtml(subject)}</p>
<p><strong>Message:</strong></p>
<p style="white-space:pre-wrap">${escapeHtml(message)}</p>`;

  try {
    await fetch(RESEND_SEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        reply_to: [email],
        text,
        html,
      }),
    });
  } catch {
    // Signup is already saved; notification email is best-effort.
  }
}

export async function recordFreecapsSignup(payload: unknown, env: SignupEnv): Promise<SignupResult> {
  const parsed = validatePayload(payload);
  if (!parsed.ok) {
    return { success: false, message: parsed.error, status: 400 };
  }

  const { name, email, kickstarterNotifyConfirmed } = parsed.data;

  const config = supabaseConfig(env);
  if (!config) {
    return {
      success: false,
      message: "Signup storage is not configured on the server (Supabase).",
      status: 500,
    };
  }

  const insertRes = await fetch(`${config.url}/rest/v1/freecaps_signups`, {
    method: "POST",
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      full_name: name,
      email,
      kickstarter_notify_confirmed: kickstarterNotifyConfirmed,
    }),
  });

  if (insertRes.status === 409) {
    return {
      success: false,
      message: "This email is already registered for the giveaway.",
      status: 409,
    };
  }

  if (!insertRes.ok) {
    const rawText = await insertRes.text();
    let message = "Unable to save your signup.";
    try {
      const json = rawText ? (JSON.parse(rawText) as { message?: unknown; code?: string }) : {};
      if (json.code === "23505") {
        return {
          success: false,
          message: "This email is already registered for the giveaway.",
          status: 409,
        };
      }
      if (typeof json.message === "string" && json.message.trim()) message = json.message.trim();
    } catch {
      if (rawText.trim()) message = rawText.trim();
    }
    return { success: false, message, status: 502 };
  }

  let signupId: string | undefined;
  try {
    const rows = (await insertRes.json()) as Array<{ id?: string }>;
    signupId = typeof rows[0]?.id === "string" ? rows[0].id : undefined;
  } catch {
    signupId = undefined;
  }

  await sendSignupNotification(name, email, signupId, env);

  return { success: true, id: signupId };
}

export const config = {
  maxDuration: 30,
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
      if (ct.includes("application/json")) {
        try {
          payload = await request.json();
        } catch {
          return Response.json(
            { success: false, message: "Invalid JSON body." },
            { status: 400, headers: jsonHeaders() },
          );
        }
      } else {
        return Response.json(
          { success: false, message: "Content-Type must be application/json." },
          { status: 400, headers: jsonHeaders() },
        );
      }

      const env: SignupEnv = {
        SUPABASE_URL: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        RESEND_API_KEY: process.env.RESEND_API_KEY,
        RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
        RESEND_TO_EMAIL: process.env.RESEND_TO_EMAIL,
      };

      const result = await recordFreecapsSignup(payload, env);

      if (result.success) {
        return Response.json({ success: true, id: result.id }, { status: 200, headers: jsonHeaders() });
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
