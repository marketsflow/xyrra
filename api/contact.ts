import { sendContactEmail } from "../server/resendContactHandler";

/** Force Node: Resend + Buffer body parsing; Edge has no Buffer */
export const config = {
  runtime: "nodejs" as const,
  maxDuration: 30,
};

type ApiResponse = {
  status: (n: number) => ApiResponse;
  setHeader: (name: string, value: string) => void;
  end: (chunk: string) => void;
  headersSent?: boolean;
};

type ApiRequest = { method?: string; body?: unknown };

function safeIsBuffer(b: unknown): b is Buffer {
  return (
    typeof Buffer !== "undefined" && typeof (Buffer as { isBuffer?: (x: unknown) => boolean }).isBuffer === "function" && Buffer.isBuffer(b)
  );
}

function getJsonBody(req: ApiRequest): unknown {
  const b = req.body;
  if (b === undefined || b === null) return undefined;
  if (typeof b === "string") {
    try {
      return JSON.parse(b.trim());
    } catch {
      return undefined;
    }
  }
  if (safeIsBuffer(b)) {
    try {
      const t = b.toString("utf8").trim();
      return t ? JSON.parse(t) : undefined;
    } catch {
      return undefined;
    }
  }
  if (typeof b === "object") return b;
  return undefined;
}

function sendJson(res: ApiResponse, code: number, body: object): void {
  if (res.headersSent) return;
  const s = JSON.stringify(body);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(code).end(s);
}

/**
 * Vercel serverless: POST /api/contact
 * Set RESEND_API_KEY, RESEND_TO_EMAIL, and optionally RESEND_FROM_EMAIL in project env.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
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

    const result = await sendContactEmail(getJsonBody(req), env);

    if (result.success) {
      sendJson(res, 200, { success: true, id: result.id });
      return;
    }
    sendJson(res, result.status ?? 500, { success: false, message: result.message });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Internal error";
    sendJson(res, 500, { success: false, message: msg });
  }
}
