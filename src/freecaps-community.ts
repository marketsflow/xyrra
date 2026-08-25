const SIGNUP_API = "/api/freecaps-signup";

const form = document.querySelector<HTMLFormElement>("#fc-form");
const statusEl = document.getElementById("fc-form-status");

if (form && statusEl) {
  const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const defaultBtnLabel = submitBtn?.textContent?.trim() || "Secure My Spot";

  const clearStatus = () => {
    statusEl.textContent = "";
    statusEl.hidden = true;
    statusEl.className = "fc-status";
  };

  const setStatus = (kind: "success" | "error", text: string) => {
    statusEl.hidden = false;
    statusEl.className = `fc-status fc-status--${kind}`;
    statusEl.textContent = text;
    statusEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const bot = (form.querySelector<HTMLInputElement>('input[name="botcheck"]')?.value ?? "").trim();
    if (bot) {
      return;
    }

    const kickstarterConfirmed = form.querySelector<HTMLInputElement>("#fc-kickstarter")?.checked ?? false;
    if (!kickstarterConfirmed) {
      setStatus(
        "error",
        "Please confirm you have registered for Notify me on launch on Kickstarter.",
      );
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.setAttribute("aria-busy", "true");
      submitBtn.textContent = "Sending…";
    }
    form.setAttribute("aria-busy", "true");
    clearStatus();

    const name = (form.querySelector<HTMLInputElement>("#fc-name")?.value ?? "").trim();
    const email = (form.querySelector<HTMLInputElement>("#fc-email")?.value ?? "").trim();

    try {
      const res = await fetch(SIGNUP_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          kickstarterNotifyConfirmed: true,
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
              ? "The signup form could not reach the API. Deploy with Supabase configured, or run npm run dev locally."
              : `The server response was not valid JSON (HTTP ${res.status}). Please try again.`,
          );
          return;
        }
      }

      if (res.ok && data.success) {
        form.reset();
        setStatus(
          "success",
          "You’re in. We’ll email you if you win a cap or a spot in the AI Builder Community.",
        );
      } else {
        setStatus(
          "error",
          data.message ||
            (res.status === 404
              ? "Signup API not found. Run npm run dev locally or deploy with /api/freecaps-signup."
              : `Could not submit your details (${res.status}).`),
        );
      }
    } catch {
      setStatus(
        "error",
        "Could not reach the server. Use the dev server (npm run dev) or a deployed site with /api/freecaps-signup.",
      );
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.removeAttribute("aria-busy");
        submitBtn.textContent = defaultBtnLabel;
      }
      form.removeAttribute("aria-busy");
    }
  });
}
