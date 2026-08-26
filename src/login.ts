import {
  continuePathFromSearch,
  destinationLabel,
  type AuthMode,
} from "./lib/auth/continue";
import { pcSystemFromSearch } from "./lib/pc-systems";
import { getAuthenticatedUser } from "./lib/auth/session";
import { getSupabaseClient } from "./lib/supabase/client";

const params = new URLSearchParams(window.location.search);
const nextKey = params.get("next");
const continuePath = continuePathFromSearch(params);
const requestedMode = params.get("mode") === "signin" ? "signin" : "signup";

function showError(message: string) {
  const el = document.getElementById("login-form-status");
  if (!el) return;
  el.hidden = false;
  el.className = "contact-form__status contact-form__status--error";
  el.textContent = message;
}

function showSuccess(message: string) {
  const el = document.getElementById("login-form-status");
  if (!el) return;
  el.hidden = false;
  el.className = "contact-form__status contact-form__status--success";
  el.textContent = message;
}

function clearStatus() {
  const el = document.getElementById("login-form-status");
  if (!el) return;
  el.hidden = true;
  el.textContent = "";
  el.className = "contact-form__status";
}

function goToContinue() {
  window.location.replace(continuePath);
}

function setMode(mode: AuthMode) {
  const signupForm = document.getElementById("login-signup-form");
  const signinForm = document.getElementById("login-signin-form");
  const signupTab = document.getElementById("login-tab-signup");
  const signinTab = document.getElementById("login-tab-signin");

  const isSignup = mode === "signup";
  signupForm?.toggleAttribute("hidden", !isSignup);
  signinForm?.toggleAttribute("hidden", isSignup);
  signupTab?.setAttribute("aria-selected", isSignup ? "true" : "false");
  signinTab?.setAttribute("aria-selected", isSignup ? "false" : "true");
  signupTab?.classList.toggle("login-tabs__btn--active", isSignup);
  signinTab?.classList.toggle("login-tabs__btn--active", !isSignup);

  const title = document.getElementById("login-card-title");
  const lede = document.getElementById("login-card-lede");
  if (title) {
    title.textContent = isSignup ? "Create your account" : "Sign in";
  }
  if (lede) {
    const dest = destinationLabel(nextKey, pcSystemFromSearch(params)?.name);
    lede.textContent = isSignup
      ? `Sign up to ${dest}. It only takes a moment.`
      : `Sign in to ${dest}.`;
  }

  clearStatus();
}

function setBusy(form: HTMLFormElement, busy: boolean, label: string) {
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) {
    submit.disabled = busy;
    submit.setAttribute("aria-busy", busy ? "true" : "false");
    if (busy) {
      submit.dataset.label = submit.textContent?.trim() || label;
      submit.textContent = "Please wait…";
    } else {
      submit.textContent = submit.dataset.label || label;
    }
  }
  form.setAttribute("aria-busy", busy ? "true" : "false");
}

async function redirectIfSignedIn() {
  try {
    const supabase = getSupabaseClient();
    const user = await getAuthenticatedUser(supabase);
    if (user) {
      goToContinue();
      return true;
    }
  } catch {
    // Stay on the form if session lookup fails.
  }
  return false;
}

async function handleSignUp(event: SubmitEvent) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const name = (form.elements.namedItem("name") as HTMLInputElement).value.trim();
  const email = (form.elements.namedItem("email") as HTMLInputElement).value.trim();
  const password = (form.elements.namedItem("password") as HTMLInputElement).value;
  const confirm = (form.elements.namedItem("confirm") as HTMLInputElement).value;

  if (password.length < 8) {
    showError("Password must be at least 8 characters.");
    return;
  }
  if (password !== confirm) {
    showError("Passwords do not match.");
    return;
  }

  clearStatus();
  setBusy(form, true, "Create account");

  try {
    const supabase = getSupabaseClient();
    const emailRedirectTo = `${window.location.origin}${continuePath}`;
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo,
        data: { full_name: name },
      },
    });

    if (error) {
      showError(error.message);
      return;
    }

    if (data.session) {
      goToContinue();
      return;
    }

    showSuccess(
      `Check ${email} to confirm your account. After that you’ll continue to ${destinationLabel(nextKey, pcSystemFromSearch(params)?.name)}.`,
    );
    form.setAttribute("hidden", "");
  } catch (error) {
    showError(error instanceof Error ? error.message : "Unable to create your account.");
  } finally {
    setBusy(form, false, "Create account");
  }
}

async function handleSignIn(event: SubmitEvent) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const email = (form.elements.namedItem("email") as HTMLInputElement).value.trim();
  const password = (form.elements.namedItem("password") as HTMLInputElement).value;

  if (!email || !password) {
    showError("Enter your email and password.");
    return;
  }

  clearStatus();
  setBusy(form, true, "Sign in");

  try {
    const supabase = getSupabaseClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      showError(error.message);
      return;
    }
    goToContinue();
  } catch (error) {
    showError(error instanceof Error ? error.message : "Unable to sign in.");
  } finally {
    setBusy(form, false, "Sign in");
  }
}

function applyDestinationCopy() {
  const eyebrow = document.getElementById("login-eyebrow");
  const heading = document.getElementById("login-title");
  const lede = document.getElementById("login-lede");
  const visual = document.querySelector<HTMLImageElement>("#login-visual img");

  if (nextKey === "agent") {
    if (eyebrow) eyebrow.textContent = "Xyrra Agent";
    if (heading) heading.innerHTML = "Try <em>Xyrra Agent</em>";
    if (lede) {
      lede.textContent =
        "Create a free account to download Xyrra Agent for your machine.";
    }
    if (visual) {
      visual.src = "/images/new/xyrra-agent-ui.png";
      visual.alt = "Xyrra Agent desktop interface";
    }
    return;
  }

  if (nextKey === "pre-order") {
    const system = pcSystemFromSearch(params);
    if (eyebrow) eyebrow.textContent = system ? system.name : "Xyrra PC";
    if (heading) {
      heading.innerHTML = system
        ? `Pre-order the <em>${system.name}</em>`
        : "Pre-order the <em>Xyrra PC</em>";
    }
    if (lede) {
      lede.textContent = system
        ? `Create an account to reserve the ${system.name}. No payment today.`
        : "Create an account to reserve your Xyrra PC. No payment today.";
    }
    if (visual) {
      visual.src = "/images/new/xyrra-pc.png";
      visual.alt = system?.name ?? "Xyrra PC compact AI workstation";
    }
  }
}

applyDestinationCopy();
setMode(requestedMode);

document.body.classList.add("auth-checking");
void redirectIfSignedIn().then((redirecting) => {
  if (!redirecting) {
    document.body.classList.remove("auth-checking");
  }
});

document.getElementById("login-tab-signup")?.addEventListener("click", () => {
  setMode("signup");
});
document.getElementById("login-tab-signin")?.addEventListener("click", () => {
  setMode("signin");
});
document.getElementById("login-switch-signin")?.addEventListener("click", (event) => {
  event.preventDefault();
  setMode("signin");
});
document.getElementById("login-switch-signup")?.addEventListener("click", (event) => {
  event.preventDefault();
  setMode("signup");
});

document.getElementById("login-signup-form")?.addEventListener("submit", (event) => {
  void handleSignUp(event);
});
document.getElementById("login-signin-form")?.addEventListener("submit", (event) => {
  void handleSignIn(event);
});
