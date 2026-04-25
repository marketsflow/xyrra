import { sendContactEmail } from "../server/resendContactHandler";

type VercelRequest = { method?: string; body?: unknown };
type VercelResponse = {
  status: (n: number) => VercelResponse;
  json: (b: unknown) => void;
};

/**
 * Vercel serverless: POST /api/contact
 * Set RESEND_API_KEY, RESEND_TO_EMAIL, and optionally RESEND_FROM_EMAIL in project env.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ success: false, message: "Method not allowed" });
    return;
  }

  const env = {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
    RESEND_TO_EMAIL: process.env.RESEND_TO_EMAIL,
  };

  const result = await sendContactEmail(req.body, env);

  if (result.success) {
    res.status(200).json({ success: true, id: result.id });
    return;
  }
  res.status(result.status ?? 500).json({ success: false, message: result.message });
}
