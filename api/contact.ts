import { sendContactEmail } from "../server/resendContactHandler";

type VercelRequest = { method?: string; body?: unknown };
type VercelResponse = {
  status: (n: number) => VercelResponse;
  setHeader: (name: string, value: string) => void;
  json: (b: unknown) => void;
};

function getJsonBody(req: VercelRequest): unknown {
  const b = req.body;
  if (b === undefined || b === null) return undefined;
  if (typeof b === "string") {
    try {
      return JSON.parse(b.trim());
    } catch {
      return undefined;
    }
  }
  if (typeof b === "object" && !Buffer.isBuffer(b)) return b;
  return undefined;
}

/**
 * Vercel serverless: POST /api/contact
 * Set RESEND_API_KEY, RESEND_TO_EMAIL, and optionally RESEND_FROM_EMAIL in project env.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "POST") {
    res.status(405).json({ success: false, message: "Method not allowed" });
    return;
  }

  try {
    const env = {
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
      RESEND_TO_EMAIL: process.env.RESEND_TO_EMAIL,
    };

    const result = await sendContactEmail(getJsonBody(req), env);

    if (result.success) {
      res.status(200).json({ success: true, id: result.id });
      return;
    }
    res.status(result.status ?? 500).json({ success: false, message: result.message });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Internal error";
    res.status(500).json({ success: false, message: msg });
  }
}
