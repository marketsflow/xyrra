import type { IncomingMessage, ServerResponse } from "node:http";
import { sendContactEmail } from "../server/resendContactHandler";

/** Node runtime: Resend + Buffer; do not use Edge */
export const config = {
  runtime: "nodejs" as const,
  maxDuration: 30,
};

type ReqWithBody = IncomingMessage & { body?: unknown };

function safeIsBuffer(b: unknown): b is Buffer {
  return (
    typeof Buffer !== "undefined" &&
    typeof (Buffer as { isBuffer?: (x: unknown) => boolean }).isBuffer === "function" &&
    Buffer.isBuffer(b)
  );
}

function getJsonBodyField(body: unknown): unknown {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") {
    try {
      return JSON.parse(body.trim());
    } catch {
      return undefined;
    }
  }
  if (safeIsBuffer(body)) {
    try {
      const t = body.toString("utf8").trim();
      return t ? JSON.parse(t) : undefined;
    } catch {
      return undefined;
    }
  }
  if (typeof body === "object") return body;
  return undefined;
}

/** Raw Node ServerResponse: use statusCode + end — Vercel’s res.status() is not the native http API. */
function sendJson(res: ServerResponse, code: number, body: object): void {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function readStreamToString(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (chunk: string | Buffer) => {
      parts.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

async function getRequestJson(req: ReqWithBody): Promise<unknown> {
  const fromField = getJsonBodyField(req.body);
  if (fromField !== undefined) return fromField;

  const contentType = (req.headers["content-type"] || "").toLowerCase();
  if (req.method !== "POST" || !contentType.includes("application/json")) {
    return undefined;
  }
  // If the host already read the body into req.body, the stream may be ended — don’t hang waiting for "end"
  if (req.readableEnded) return undefined;

  const raw = (await readStreamToString(req)).trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Vercel serverless: POST /api/contact
 * Set RESEND_API_KEY, RESEND_TO_EMAIL, and optionally RESEND_FROM_EMAIL in project env.
 */
export default async function handler(req: ReqWithBody, res: ServerResponse): Promise<void> {
  try {
    if (req.method !== "POST") {
      sendJson(res, 405, { success: false, message: "Method not allowed" });
      return;
    }

    const env = {
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
      RESEND_TO_EMAIL: process.env.RESEND_TO_EMAIL,
    };

    const payload = await getRequestJson(req);
    const result = await sendContactEmail(payload, env);

    if (result.success) {
      sendJson(res, 200, { success: true, id: result.id });
      return;
    }
    sendJson(res, result.status ?? 500, { success: false, message: result.message });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Internal error";
    try {
      sendJson(res, 500, { success: false, message: msg });
    } catch {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ success: false, message: "Internal error" }));
      }
    }
  }
}
