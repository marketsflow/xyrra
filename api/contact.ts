import { sendContactEmail } from "./lib/sendContactEmail";

export const config = {
  maxDuration: 30,
};

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

/**
 * Vercel Node serverless: Web Standard export (not legacy (req, res) — that shape crashes the runtime).
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

      const env = {
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
