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

const preorderForm = document.querySelector<HTMLFormElement>("#preorder-form");
const preorderStatus = document.getElementById("preorder-form-status");
if (preorderForm && preorderStatus) {
  const submitBtn = preorderForm.querySelector<HTMLButtonElement>('button[type="submit"]');
  const defaultBtnLabel = submitBtn?.textContent?.trim() || "Pre-Order Now";

  const clearStatus = () => {
    preorderStatus.textContent = "";
    preorderStatus.hidden = true;
    preorderStatus.className = "contact-form__status";
  };

  const setStatus = (kind: "success" | "error", text: string) => {
    preorderStatus.hidden = false;
    preorderStatus.className = `contact-form__status contact-form__status--${kind}`;
    preorderStatus.textContent = text;
    preorderStatus.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  preorderForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!preorderForm.checkValidity()) {
      preorderForm.reportValidity();
      return;
    }

    const bot = (preorderForm.querySelector<HTMLInputElement>('input[name="botcheck"]')?.value ?? "").trim();
    if (bot) {
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.setAttribute("aria-busy", "true");
      submitBtn.textContent = "Sending…";
    }
    preorderForm.setAttribute("aria-busy", "true");
    clearStatus();

    const name = (preorderForm.querySelector<HTMLInputElement>("#preorder-name")?.value ?? "").trim();
    const email = (preorderForm.querySelector<HTMLInputElement>("#preorder-email")?.value ?? "").trim();
    const country = (preorderForm.querySelector<HTMLInputElement>("#preorder-country")?.value ?? "").trim();
    const quantity = (preorderForm.querySelector<HTMLSelectElement>("#preorder-quantity")?.value ?? "").trim();
    const use = (preorderForm.querySelector<HTMLSelectElement>("#preorder-use")?.value ?? "").trim();
    const notes = (preorderForm.querySelector<HTMLTextAreaElement>("#preorder-notes")?.value ?? "").trim();

    const message = [
      "Xyrra PC pre-order reservation",
      "",
      `Country: ${country}`,
      `Quantity: ${quantity}`,
      `Primary use: ${use}`,
      notes ? `Notes:\n${notes}` : "Notes: (none)",
    ].join("\n");

    const url = contactApiUrl();

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          subject: "Xyrra PC Pre-Order",
          message,
        }),
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
              ? "The pre-order form could not reach the mail API. Deploy with the api/ folder enabled and RESEND env vars set, or run npm run dev locally."
              : `The server response was not valid JSON (HTTP ${res.status}). Please try again.`
          );
          return;
        }
      }

      if (res.ok && data.success) {
        preorderForm.reset();
        setStatus(
          "success",
          "Thanks — your Xyrra PC reservation is in. We’ll email you with allocation and next steps."
        );
      } else {
        setStatus(
          "error",
          data.message ||
            (res.status === 404
              ? "Pre-order API not found. Run npm run dev locally or deploy with /api/contact."
              : `Could not send your reservation (${res.status}).`)
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
      preorderForm.removeAttribute("aria-busy");
    }
  });
}

const AGENT_DL_STORAGE_KEY = "xyrra-agent-download-unlocked";

type AgentDownloadUrls = {
  mac: string;
  win: string;
  linux: string;
};

function agentDownloadUrls(): AgentDownloadUrls {
  const read = (key: string) => {
    const fromEnv = import.meta.env[key];
    return typeof fromEnv === "string" ? fromEnv.trim() : "";
  };
  return {
    mac: read("VITE_XYRRA_AGENT_DOWNLOAD_MAC"),
    win: read("VITE_XYRRA_AGENT_DOWNLOAD_WIN"),
    linux: read("VITE_XYRRA_AGENT_DOWNLOAD_LINUX"),
  };
}

function showAgentDownloadPanel(platform: string, email: string) {
  const formWrap = document.getElementById("agent-dl-form-wrap");
  const downloadPanel = document.getElementById("agent-dl-download-panel");
  const downloadsEl = document.getElementById("agent-dl-downloads");
  const emailNote = document.getElementById("agent-dl-email-note");
  const successLede = document.getElementById("agent-dl-success-lede");
  if (!formWrap || !downloadPanel || !downloadsEl) return;

  const urls = agentDownloadUrls();
  const platforms: { id: keyof AgentDownloadUrls; label: string; url: string }[] = [
    { id: "mac", label: "Download for macOS", url: urls.mac },
    { id: "win", label: "Download for Windows", url: urls.win },
    { id: "linux", label: "Download for Linux", url: urls.linux },
  ];

  downloadsEl.replaceChildren();
  let hasAnyUrl = false;

  for (const item of platforms) {
    const isRecommended =
      (platform === "macOS" && item.id === "mac") ||
      (platform === "Windows" && item.id === "win") ||
      (platform === "Linux" && item.id === "linux");

    if (item.url) {
      hasAnyUrl = true;
      const link = document.createElement("a");
      link.className = `nh-btn nh-btn--solid nh-btn--lg${isRecommended ? " nh-btn--recommended" : ""}`;
      link.href = item.url;
      link.textContent = item.label;
      if (isRecommended) {
        link.setAttribute("download", "");
      }
      downloadsEl.appendChild(link);
    } else {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `nh-btn nh-btn--ghost nh-btn--lg${isRecommended ? " nh-btn--recommended" : ""}`;
      btn.textContent = item.label;
      btn.disabled = true;
      btn.setAttribute("aria-disabled", "true");
      downloadsEl.appendChild(btn);
    }
  }

  if (successLede) {
    successLede.textContent = hasAnyUrl
      ? "Thanks — your download is ready. Pick your platform below."
      : "Thanks — we received your details. We'll email your download link shortly.";
  }

  if (emailNote) {
    emailNote.hidden = false;
    emailNote.textContent = hasAnyUrl
      ? `We also sent confirmation to ${email}.`
      : `We'll send the installer to ${email} as soon as it's available for your platform.`;
  }

  formWrap.hidden = true;
  formWrap.setAttribute("data-unlocked", "true");
  downloadPanel.hidden = false;
  downloadPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

const agentDlForm = document.querySelector<HTMLFormElement>("#agent-dl-form");
const agentDlStatus = document.getElementById("agent-dl-form-status");
if (agentDlForm && agentDlStatus) {
  const submitBtn = agentDlForm.querySelector<HTMLButtonElement>('button[type="submit"]');
  const defaultBtnLabel = submitBtn?.textContent?.trim() || "Continue to download";

  const clearStatus = () => {
    agentDlStatus.textContent = "";
    agentDlStatus.hidden = true;
    agentDlStatus.className = "contact-form__status";
  };

  const setStatus = (kind: "success" | "error", text: string) => {
    agentDlStatus.hidden = false;
    agentDlStatus.className = `contact-form__status contact-form__status--${kind}`;
    agentDlStatus.textContent = text;
    agentDlStatus.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  try {
    const saved = sessionStorage.getItem(AGENT_DL_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as { platform?: string; email?: string };
      if (parsed.platform && parsed.email) {
        showAgentDownloadPanel(parsed.platform, parsed.email);
      }
    }
  } catch {
    sessionStorage.removeItem(AGENT_DL_STORAGE_KEY);
  }

  agentDlForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!agentDlForm.checkValidity()) {
      agentDlForm.reportValidity();
      return;
    }

    const bot = (agentDlForm.querySelector<HTMLInputElement>('input[name="botcheck"]')?.value ?? "").trim();
    if (bot) {
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.setAttribute("aria-busy", "true");
      submitBtn.textContent = "Sending…";
    }
    agentDlForm.setAttribute("aria-busy", "true");
    clearStatus();

    const name = (agentDlForm.querySelector<HTMLInputElement>("#agent-dl-name")?.value ?? "").trim();
    const email = (agentDlForm.querySelector<HTMLInputElement>("#agent-dl-email")?.value ?? "").trim();
    const company = (agentDlForm.querySelector<HTMLInputElement>("#agent-dl-company")?.value ?? "").trim();
    const role = (agentDlForm.querySelector<HTMLSelectElement>("#agent-dl-role")?.value ?? "").trim();
    const platform = (agentDlForm.querySelector<HTMLSelectElement>("#agent-dl-platform")?.value ?? "").trim();
    const use = (agentDlForm.querySelector<HTMLSelectElement>("#agent-dl-use")?.value ?? "").trim();
    const notes = (agentDlForm.querySelector<HTMLTextAreaElement>("#agent-dl-notes")?.value ?? "").trim();

    const message = [
      "Xyrra Agent download request",
      "",
      company ? `Company: ${company}` : "Company: (none)",
      `Role: ${role}`,
      `Platform: ${platform}`,
      `Primary use: ${use}`,
      notes ? `Notes:\n${notes}` : "Notes: (none)",
    ].join("\n");

    const url = contactApiUrl();

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          subject: "Xyrra Agent Download Request",
          message,
        }),
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
              ? "The download form could not reach the mail API. Deploy with the api/ folder enabled and RESEND env vars set, or run npm run dev locally."
              : `The server response was not valid JSON (HTTP ${res.status}). Please try again.`
          );
          return;
        }
      }

      if (res.ok && data.success) {
        sessionStorage.setItem(AGENT_DL_STORAGE_KEY, JSON.stringify({ platform, email }));
        showAgentDownloadPanel(platform, email);
      } else {
        setStatus(
          "error",
          data.message ||
            (res.status === 404
              ? "Download API not found. Run npm run dev locally or deploy with /api/contact."
              : `Could not submit your details (${res.status}).`)
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
      agentDlForm.removeAttribute("aria-busy");
    }
  });
}
