const nav = document.getElementById("nh-nav");
const menu = document.getElementById("nh-menu");
const year = document.getElementById("nh-year");

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

const form = document.querySelector<HTMLFormElement>("#unsubscribe-form");
const statusEl = document.getElementById("unsubscribe-form-status");
const emailInput = document.getElementById("unsubscribe-email") as HTMLInputElement | null;

const prefill = new URLSearchParams(window.location.search).get("email")?.trim() ?? "";
if (emailInput && prefill) {
  emailInput.value = prefill;
}

if (form && statusEl && emailInput) {
  const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const defaultBtnLabel = submitBtn?.textContent?.trim() || "Unsubscribe";

  const setStatus = (message: string, isError = false) => {
    statusEl.hidden = !message;
    statusEl.textContent = message;
    statusEl.classList.toggle("contact-form__status--error", Boolean(message) && isError);
    statusEl.classList.toggle("contact-form__status--success", Boolean(message) && !isError);
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const honeypot = (form.querySelector<HTMLInputElement>('[name="botcheck"]')?.value ?? "").trim();
    if (honeypot) return;

    const email = emailInput.value.trim();
    if (!email) {
      setStatus("Enter your email address.", true);
      return;
    }

    void (async () => {
      setStatus("");
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Unsubscribing…";
      }

      try {
        const res = await fetch("/api/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        const json = (await res.json().catch(() => null)) as { success?: boolean; message?: string } | null;
        if (!res.ok || !json?.success) {
          setStatus(json?.message || "Unable to unsubscribe. Please try again.", true);
          return;
        }
        setStatus("You have been unsubscribed from Xyrra campaign emails.");
        form.reset();
        emailInput.value = email;
      } catch {
        setStatus("Could not reach the server. Please try again.", true);
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = defaultBtnLabel;
        }
      }
    })();
  });
}
