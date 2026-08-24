/**
 * Vercel ships one compiled file for this route — keep webhook logic here
 * (no ./lib/* imports) or Node ESM on /var/task cannot resolve sibling modules.
 *
 * Vercel: Web Standard `default { fetch }` (not legacy (req, res)).
 * Vite: imports named `handleResendWebhook` for the dev middleware.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

type WebhookEnv = {
  RESEND_WEBHOOK_SECRET?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};

type EventType = "opened" | "clicked" | "delivered" | "bounced" | "complained";

type ResendWebhookPayload = {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    created_at?: string;
    click?: {
      link?: string;
      timestamp?: string;
      ipAddress?: string;
      userAgent?: string;
    };
  };
};

type RecipientRow = {
  id: string;
  open_count: number | null;
  click_count: number | null;
  first_opened_at: string | null;
  first_clicked_at: string | null;
  delivery_status: string | null;
};

const TRACKED_EVENT_TYPES = new Set([
  "email.opened",
  "email.clicked",
  "email.delivered",
  "email.bounced",
  "email.complained",
]);

function jsonHeaders() {
  return { "Content-Type": "application/json; charset=utf-8" };
}

function mapEventType(type: string): EventType | null {
  switch (type) {
    case "email.opened":
      return "opened";
    case "email.clicked":
      return "clicked";
    case "email.delivered":
      return "delivered";
    case "email.bounced":
      return "bounced";
    case "email.complained":
      return "complained";
    default:
      return null;
  }
}

function mapDeliveryStatus(eventType: EventType): string | null {
  switch (eventType) {
    case "delivered":
      return "delivered";
    case "bounced":
      return "bounced";
    case "complained":
      return "complained";
    default:
      return null;
  }
}

function parseOccurredAt(payload: ResendWebhookPayload, eventType: EventType): string {
  if (eventType === "clicked" && payload.data?.click?.timestamp) {
    return payload.data.click.timestamp;
  }
  return payload.data?.created_at ?? payload.created_at ?? new Date().toISOString();
}

function verifySvixSignature(
  payload: string,
  headers: { id: string; timestamp: string; signature: string },
  secret: string,
): boolean {
  const timestamp = Number(headers.timestamp);
  if (!Number.isFinite(timestamp)) return false;
  const ageSeconds = Math.abs(Date.now() / 1000 - timestamp);
  if (ageSeconds > 300) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key)
    .update(`${headers.id}.${headers.timestamp}.${payload}`)
    .digest("base64");
  const expectedBuf = Buffer.from(expected);

  const candidates = headers.signature.split(/\s+/).flatMap((part) => {
    const comma = part.indexOf(",");
    if (comma === -1) return [];
    const version = part.slice(0, comma);
    const signature = part.slice(comma + 1);
    return version === "v1" && signature ? [signature] : [];
  });

  return candidates.some((signature) => {
    const actualBuf = Buffer.from(signature);
    return actualBuf.length === expectedBuf.length && timingSafeEqual(actualBuf, expectedBuf);
  });
}

function supabaseConfig(env: WebhookEnv) {
  const url = env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) return null;
  return { url, serviceRoleKey };
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

async function supabaseFetch(
  config: { url: string; serviceRoleKey: string },
  path: string,
  init?: RequestInit,
) {
  const headers = new Headers(init?.headers);
  headers.set("apikey", config.serviceRoleKey);
  headers.set("Authorization", `Bearer ${config.serviceRoleKey}`);
  if (!headers.has("Content-Type") && init?.body) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(`${config.url}${path}`, {
    ...init,
    headers,
  });
}

async function applyResendEvent(
  config: { url: string; serviceRoleKey: string },
  payload: ResendWebhookPayload,
  resendEventId: string,
): Promise<void> {
  const eventType = payload.type ? mapEventType(payload.type) : null;
  const resendEmailId = payload.data?.email_id?.trim();
  if (!eventType || !resendEmailId) return;

  const lookup = await supabaseFetch(
    config,
    `/rest/v1/email_outreach_recipients?resend_email_id=eq.${encodeURIComponent(resendEmailId)}&select=id,open_count,click_count,first_opened_at,first_clicked_at,delivery_status`,
  );
  const rows = (await parseJsonResponse(lookup)) as RecipientRow[] | unknown;
  const emailRow = Array.isArray(rows) ? rows[0] : null;
  if (!lookup.ok || !emailRow) return;

  const occurredAt = parseOccurredAt(payload, eventType);
  const insert = await supabaseFetch(config, "/rest/v1/email_outreach_events", {
    method: "POST",
    body: JSON.stringify({
      recipient_id: emailRow.id,
      event_type: eventType,
      link_url: eventType === "clicked" ? (payload.data?.click?.link ?? null) : null,
      ip_address: eventType === "clicked" ? (payload.data?.click?.ipAddress ?? null) : null,
      user_agent: eventType === "clicked" ? (payload.data?.click?.userAgent ?? null) : null,
      occurred_at: occurredAt,
      resend_event_id: resendEventId,
    }),
  });

  if (!insert.ok) {
    const json = await parseJsonResponse(insert);
    const code =
      json && typeof json === "object" && typeof (json as { code?: unknown }).code === "string"
        ? (json as { code: string }).code
        : "";
    if (code === "23505") return;
    const message =
      json && typeof json === "object" && typeof (json as { message?: unknown }).message === "string"
        ? (json as { message: string }).message
        : "Unable to record Resend event.";
    throw new Error(message);
  }

  const updates: Record<string, unknown> = {};

  if (eventType === "opened") {
    updates.open_count = Number(emailRow.open_count ?? 0) + 1;
    updates.last_opened_at = occurredAt;
    if (!emailRow.first_opened_at) {
      updates.first_opened_at = occurredAt;
    }
  }

  if (eventType === "clicked") {
    updates.click_count = Number(emailRow.click_count ?? 0) + 1;
    updates.last_clicked_at = occurredAt;
    if (!emailRow.first_clicked_at) {
      updates.first_clicked_at = occurredAt;
    }
  }

  const nextDeliveryStatus = mapDeliveryStatus(eventType);
  if (nextDeliveryStatus) {
    updates.delivery_status = nextDeliveryStatus;
  }

  if (Object.keys(updates).length === 0) return;

  const patch = await supabaseFetch(
    config,
    `/rest/v1/email_outreach_recipients?id=eq.${encodeURIComponent(emailRow.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify(updates),
    },
  );
  if (!patch.ok) {
    throw new Error("Unable to update outreach recipient tracking.");
  }
}

export async function handleResendWebhook(
  payloadText: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  env: WebhookEnv,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const webhookSecret = env.RESEND_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) {
    return { status: 503, body: { error: "Webhook not configured" } };
  }

  const svixId = headers.id?.trim() ?? "";
  const svixTimestamp = headers.timestamp?.trim() ?? "";
  const svixSignature = headers.signature?.trim() ?? "";
  if (!svixId || !svixTimestamp || !svixSignature) {
    return { status: 400, body: { error: "Missing webhook signature headers" } };
  }

  if (!verifySvixSignature(payloadText, { id: svixId, timestamp: svixTimestamp, signature: svixSignature }, webhookSecret)) {
    return { status: 400, body: { error: "Invalid webhook signature" } };
  }

  let event: ResendWebhookPayload;
  try {
    event = payloadText ? (JSON.parse(payloadText) as ResendWebhookPayload) : {};
  } catch {
    return { status: 400, body: { error: "Invalid JSON body" } };
  }

  const eventType = typeof event.type === "string" ? event.type : "";
  if (!TRACKED_EVENT_TYPES.has(eventType)) {
    return { status: 200, body: { received: true } };
  }

  const config = supabaseConfig(env);
  if (!config) {
    return { status: 500, body: { error: "Supabase is not configured on the server." } };
  }

  try {
    await applyResendEvent(config, event, svixId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed";
    return { status: 500, body: { error: message } };
  }

  return { status: 200, body: { received: true } };
}

export const config = {
  maxDuration: 30,
};

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405, headers: jsonHeaders() });
    }

    const payloadText = await request.text();
    const result = await handleResendWebhook(
      payloadText,
      {
        id: request.headers.get("svix-id"),
        timestamp: request.headers.get("svix-timestamp"),
        signature: request.headers.get("svix-signature"),
      },
      {
        RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET,
        SUPABASE_URL: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      },
    );

    return Response.json(result.body, { status: result.status, headers: jsonHeaders() });
  },
};
