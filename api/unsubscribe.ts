/**
 * Vercel ships one compiled file for this route — keep unsubscribe logic here
 * (no ./lib/* imports) or Node ESM on /var/task cannot resolve sibling modules.
 *
 * Vercel: Web Standard `default { fetch }` (not legacy (req, res)).
 * Vite: imports named `recordEmailUnsubscribe` for the dev middleware.
 */

type UnsubscribeEnv = {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};

type UnsubscribeResult =
  | { success: true }
  | { success: false; message: string; status?: number };

function jsonHeaders() {
  return { "Content-Type": "application/json; charset=utf-8" };
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function supabaseConfig(env: UnsubscribeEnv) {
  const url = (env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) return null;
  return { url, serviceRoleKey };
}

function emailFromSearch(url: URL) {
  return url.searchParams.get("email")?.trim() ?? "";
}

async function emailFromRequest(request: Request): Promise<string> {
  const fromQuery = emailFromSearch(new URL(request.url));
  const ct = (request.headers.get("content-type") || "").toLowerCase();

  if (ct.includes("application/json")) {
    try {
      const payload = (await request.json()) as { email?: unknown };
      const email = typeof payload?.email === "string" ? payload.email.trim() : "";
      return email || fromQuery;
    } catch {
      return fromQuery;
    }
  }

  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data") || ct.includes("text/plain")) {
    try {
      const raw = await request.text();
      if (raw === "List-Unsubscribe=One-Click") return fromQuery;
      const params = new URLSearchParams(raw);
      return params.get("email")?.trim() || fromQuery;
    } catch {
      return fromQuery;
    }
  }

  if (!ct) {
    try {
      const raw = await request.text();
      if (raw === "List-Unsubscribe=One-Click") return fromQuery;
    } catch {
      return fromQuery;
    }
  }

  return fromQuery;
}

export async function recordEmailUnsubscribe(
  emailRaw: string,
  env: UnsubscribeEnv,
): Promise<UnsubscribeResult> {
  const email = emailRaw.trim().toLowerCase();
  if (!isValidEmail(email)) {
    return { success: false, message: "Enter a valid email address.", status: 400 };
  }

  const config = supabaseConfig(env);
  if (!config) {
    return {
      success: false,
      message: "Unsubscribe is not configured on the server.",
      status: 500,
    };
  }

  const res = await fetch(`${config.url}/rest/v1/email_unsubscribes`, {
    method: "POST",
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify({ email }),
  });

  if (!res.ok && res.status !== 409) {
    const rawText = await res.text();
    let message = "Unable to record unsubscribe.";
    try {
      const json = rawText ? (JSON.parse(rawText) as { message?: unknown }) : {};
      if (typeof json.message === "string" && json.message.trim()) message = json.message.trim();
    } catch {
      if (rawText.trim()) message = rawText.trim();
    }
    return { success: false, message, status: 502 };
  }

  return { success: true };
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

      const email = await emailFromRequest(request);
      const env: UnsubscribeEnv = {
        SUPABASE_URL: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      };
      const result = await recordEmailUnsubscribe(email, env);
      if (result.success) {
        return Response.json({ success: true }, { status: 200, headers: jsonHeaders() });
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
