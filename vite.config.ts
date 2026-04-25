import { defineConfig, loadEnv, type Plugin } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendContactEmail } from "./api/contact";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readRequestBody(req: IncomingMessage, maxBytes = 200_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer | string) => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      raw += s;
      if (raw.length > maxBytes) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function resendApiPlugin(env: Record<string, string>): Plugin {
  return {
    name: "resend-contact-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = (req as IncomingMessage & { url?: string }).url?.split("?")[0] ?? "";
        if (path !== "/api/contact") {
          return next();
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ success: false, message: "Method not allowed" }));
          return;
        }
        let raw: string;
        try {
          raw = await readRequestBody(req);
        } catch {
          res.statusCode = 413;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ success: false, message: "Request too large" }));
          return;
        }
        let body: unknown;
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ success: false, message: "Invalid JSON" }));
          return;
        }
        const result = await sendContactEmail(body, {
          RESEND_API_KEY: env.RESEND_API_KEY,
          RESEND_FROM_EMAIL: env.RESEND_FROM_EMAIL,
          RESEND_TO_EMAIL: env.RESEND_TO_EMAIL,
        });
        if (result.success) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ success: true, id: result.id }));
          return;
        }
        res.statusCode = result.status ?? 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: false, message: result.message }));
      });
    },
  };
}

/** Maps clean legal URLs to index.html folders; redirects legacy .html URLs. */
function cleanLegalPathPlugin(): Plugin {
  const attach = (server: { middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void } }) => {
    server.middlewares.use((req, res, next) => {
      const raw = req.url ?? "";
      const path = raw.split("?")[0] ?? "";
      const search = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
      if (path === "/terms-and-conditions.html") {
        res.writeHead(301, { Location: `/terms-and-conditions${search}` });
        res.end();
        return;
      }
      if (path === "/private-policy.html") {
        res.writeHead(301, { Location: `/private-policy${search}` });
        res.end();
        return;
      }
      if (path === "/disclaimer.html") {
        res.writeHead(301, { Location: `/disclaimer${search}` });
        res.end();
        return;
      }
      if (path === "/terms-and-conditions") {
        (req as IncomingMessage & { url?: string }).url = "/terms-and-conditions/" + search;
      } else if (path === "/private-policy") {
        (req as IncomingMessage & { url?: string }).url = "/private-policy/" + search;
      } else if (path === "/disclaimer") {
        (req as IncomingMessage & { url?: string }).url = "/disclaimer/" + search;
      }
      next();
    });
  };
  return {
    name: "xyrra-clean-legal-paths",
    configureServer: attach,
    configurePreviewServer: attach,
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    root: ".",
    publicDir: "public",
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, "index.html"),
          about: resolve(__dirname, "about-us.html"),
          feature: resolve(__dirname, "feature.html"),
          faq: resolve(__dirname, "faq.html"),
          contact: resolve(__dirname, "contact.html"),
          terms: resolve(__dirname, "terms-and-conditions/index.html"),
          privatePolicy: resolve(__dirname, "private-policy/index.html"),
          disclaimer: resolve(__dirname, "disclaimer/index.html"),
        },
      },
    },
    plugins: [cleanLegalPathPlugin(), resendApiPlugin(env)],
  };
});
