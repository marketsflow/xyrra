const nav = document.getElementById("nh-nav");
const menu = document.getElementById("nh-menu");
const year = document.getElementById("nh-year");
const modal = document.getElementById("video");

if (year) {
  year.textContent = String(new Date().getFullYear());
}

menu?.addEventListener("click", () => {
  const open = nav?.getAttribute("data-open") === "true";
  nav?.setAttribute("data-open", open ? "false" : "true");
  menu.setAttribute("aria-expanded", open ? "false" : "true");
  menu.setAttribute("aria-label", open ? "Open menu" : "Close menu");
});

nav?.querySelectorAll("a").forEach((a) => {
  a.addEventListener("click", () => {
    nav.setAttribute("data-open", "false");
    menu?.setAttribute("aria-expanded", "false");
    menu?.setAttribute("aria-label", "Open menu");
  });
});

document.querySelectorAll('a[href^="#"]').forEach((a) => {
  a.addEventListener("click", (e) => {
    const id = a.getAttribute("href");
    if (!id || id === "#") return;
    const el = document.querySelector(id);
    if (!el) return;
    e.preventDefault();
    if (id === "#video") {
      openModal();
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  });
});

function openModal() {
  if (!modal) return;
  modal.hidden = false;
  modal.setAttribute("data-open", "true");
  document.body.style.overflow = "hidden";
}

function closeModal() {
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute("data-open", "false");
  document.body.style.overflow = "";
}

modal?.querySelectorAll("[data-close-modal]").forEach((el) => {
  el.addEventListener("click", () => {
    closeModal();
  });
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && modal && !modal.hidden) {
    closeModal();
  }
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
          data = JSON.parse(trimmed) as { success?: boolean; message?: string };
        } catch {
          const looksLikeHtml = /^\s*</.test(trimmed);
          const ct = (res.headers.get("content-type") || "").toLowerCase();
          const probablyNotJson = looksLikeHtml || ct.includes("text/html");
          setStatus(
            "error",
            res.status === 404 || probablyNotJson
              ? "The contact form could not reach the mail API. Deploy with the api/ folder enabled and RESEND env vars set, or run npm run dev locally."
              : `The server response was not valid JSON (HTTP ${res.status}). Please try again.`
          );
          return;
        }
      }

      if (res.ok && data.success) {
        contactForm.reset();
        setStatus("success", "Thanks — your message was sent. We will get back to you soon.");
      } else {
        setStatus(
          "error",
          data.message ||
            (res.status === 404
              ? "Contact API not found. Run npm run dev locally or deploy with /api/contact."
              : `Could not send your message (${res.status}).`)
        );
      }
    } catch {
      setStatus(
        "error",
        "Could not reach the server. Use the dev server (npm run dev) or a deployed site with /api/contact."
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
