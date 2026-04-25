const nav = document.getElementById("site-nav");
const toggle = document.getElementById("nav-toggle");

toggle?.addEventListener("click", () => {
  const open = nav?.getAttribute("data-open") === "true";
  nav?.setAttribute("data-open", open ? "false" : "true");
  toggle.setAttribute("aria-expanded", open ? "false" : "true");
});

nav?.querySelectorAll("a").forEach((a) => {
  a.addEventListener("click", () => {
    nav.setAttribute("data-open", "false");
    toggle?.setAttribute("aria-expanded", "false");
  });
});

document.querySelectorAll('a[href^="#"]').forEach((a) => {
  a.addEventListener("click", (e) => {
    const id = a.getAttribute("href");
    if (!id || id === "#") return;
    const el = document.querySelector(id);
    if (el) {
      e.preventDefault();
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
});

function contactApiUrl(): string {
  const fromEnv = import.meta.env.VITE_CONTACT_API_URL;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.replace(/\/$/, "");
  }
  return "/api/contact";
}

const contactForm = document.querySelector<HTMLFormElement>("#contact-form");
const contactStatus = document.getElementById("contact-form-status");
if (contactForm && contactStatus) {
  const submitBtn = contactForm.querySelector<HTMLButtonElement>('button[type="submit"]');
  const defaultBtnLabel = submitBtn?.textContent?.trim() || "Send message";

  const clearStatus = () => {
    contactStatus.textContent = "";
    contactStatus.hidden = true;
    contactStatus.className = "contact-form__status";
  };

  const setStatus = (kind: "success" | "error", text: string) => {
    contactStatus.hidden = false;
    contactStatus.className = `contact-form__status contact-form__status--${kind}`;
    contactStatus.textContent = text;
    contactStatus.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  contactForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!contactForm.checkValidity()) {
      contactForm.reportValidity();
      return;
    }

    const bot = (contactForm.querySelector<HTMLInputElement>('input[name="botcheck"]')?.value ?? "").trim();
    if (bot) {
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.setAttribute("aria-busy", "true");
      submitBtn.textContent = "Sending…";
    }
    contactForm.setAttribute("aria-busy", "true");
    clearStatus();

    const name = (contactForm.querySelector<HTMLInputElement>("#contact-name")?.value ?? "").trim();
    const email = (contactForm.querySelector<HTMLInputElement>("#contact-email")?.value ?? "").trim();
    const subject = (contactForm.querySelector<HTMLInputElement>("#contact-subject")?.value ?? "").trim();
    const message = (contactForm.querySelector<HTMLTextAreaElement>("#contact-message")?.value ?? "").trim();

    const url = contactApiUrl();

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, subject, message }),
      });

      const raw = await res.text();
      const trimmed = raw.trim();
      let data: { success?: boolean; message?: string } = {};
      if (trimmed.length > 0) {
        try {
          // Proxies/CDNs may prepend whitespace or a BOM; JSON.parse() rejects leading space
          data = JSON.parse(trimmed) as { success?: boolean; message?: string };
        } catch {
          const looksLikeHtml = /^\s*</.test(trimmed);
          const ct = (res.headers.get("content-type") || "").toLowerCase();
          const probablyNotJson = looksLikeHtml || ct.includes("text/html");
          setStatus(
            "error",
            res.status === 404 || probablyNotJson
              ? "The contact form could not reach the mail API (the server returned a page instead of JSON). Deploy this project on Vercel with the api/ folder enabled, set RESEND_API_KEY and RESEND_TO_EMAIL in project settings, and redeploy — or point VITE_CONTACT_API_URL at a working JSON /api/contact endpoint."
              : `The server response was not valid JSON (HTTP ${res.status}). Please try again or contact support if this continues.`
          );
          return;
        }
      }

      if (res.ok && data.success) {
        contactForm.reset();
        setStatus(
          "success",
          "Thanks — your message was sent. We will get back to you soon."
        );
      } else {
        setStatus(
          "error",
          data.message ||
            (res.status === 404
              ? "Contact API not found. Deploy with a Resend backend (e.g. /api/contact on Vercel) or run npm run dev locally."
              : `Could not send your message (${res.status}).`)
        );
      }
    } catch {
      setStatus(
        "error",
        "Could not reach the server. If you opened this page as a file, use the dev server (npm run dev) or a deployed site with /api/contact."
      );
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.removeAttribute("aria-busy");
        submitBtn.textContent = defaultBtnLabel;
      }
      contactForm.removeAttribute("aria-busy");
    }
  });
}
