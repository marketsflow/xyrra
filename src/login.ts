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
const modeParam = params.get("mode");

type Screen = AuthMode | "forgot" | "reset";

function requestedScreen(): Screen {
  if (modeParam === "signin" || modeParam === "signup" || modeParam === "forgot" || modeParam === "reset") {
    return modeParam;
  }
  if (nextKey === "pre-order" || nextKey === "agent") return "signup";
  return "signin";
}

let customDestination = false;
let passwordReset = requestedScreen() === "reset";

function statusEl() {
  return document.getElementById("login-form-status");
}

function showError(message: string) {
  const el = statusEl();
  if (!el) return;
  el.hidden = false;
  el.className = "auth-status auth-status--error";
  el.textContent = message;
}

function showSuccess(message: string) {
  const el = statusEl();
  if (!el) return;
  el.hidden = false;
  el.className = "auth-status auth-status--success";
  el.textContent = message;
}

function clearStatus() {
  const el = statusEl();
  if (!el) return;
  el.hidden = true;
  el.textContent = "";
  el.className = "auth-status";
}

function goToContinue() {
  window.location.replace(continuePath);
}

function setMode(mode: Screen) {
  const forms: Record<Screen, string> = {
    signin: "login-signin-form",
    signup: "login-signup-form",
    forgot: "login-forgot-form",
    reset: "login-reset-form",
  };

  (Object.keys(forms) as Screen[]).forEach((key) => {
    document.getElementById(forms[key])?.toggleAttribute("hidden", key !== mode);
  });

  const legal = document.getElementById("login-legal");
  const disclaimer = document.getElementById("login-disclaimer");
  const switchRow = document.getElementById("login-switch");
  const accountFlow = mode === "signin" || mode === "signup";
  disclaimer?.toggleAttribute("hidden", !accountFlow);
  legal?.toggleAttribute("hidden", mode !== "signup");
  switchRow?.toggleAttribute("hidden", false);

  const switchLabel = document.getElementById("login-switch-label");
  const switchAction = document.getElementById("login-switch-action");
  if (mode === "signin") {
    if (switchLabel) switchLabel.textContent = "Don't have an account? ";
    if (switchAction) switchAction.textContent = "Sign Up";
    switchAction?.setAttribute("data-mode", "signup");
  } else if (mode === "signup") {
    if (switchLabel) switchLabel.textContent = "Already have an account? ";
    if (switchAction) switchAction.textContent = "Log In";
    switchAction?.setAttribute("data-mode", "signin");
  } else {
    if (switchLabel) switchLabel.textContent = "";
    if (switchAction) switchAction.textContent = "Back to sign in";
    switchAction?.setAttribute("data-mode", "signin");
  }

  const title = document.getElementById("login-title");
  const lede = document.getElementById("login-lede");
  if (title && !(customDestination && accountFlow)) {
    if (mode === "signup") title.textContent = "Sign up to use AI for Trading & Investing decisions";
    else if (mode === "forgot") title.textContent = "Forgot Password";
    else if (mode === "reset") title.textContent = "Choose a new password";
    else title.textContent = "Sign in to use AI for Trading & Investing decisions";
  }
  if (lede) {
    if (mode === "forgot") {
      lede.hidden = false;
      lede.textContent = "Enter your email address and we'll send you a link to reset your password";
    } else if (mode === "reset") {
      lede.hidden = false;
      lede.textContent = "Enter a new password for your Xyrra account.";
    } else if (!customDestination) {
      lede.hidden = true;
      lede.textContent = "";
    }
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

function showOAuthError() {
  const message = params.get("error_description") || params.get("error");
  if (message) showError(message);
}

async function redirectIfSignedIn() {
  try {
    const supabase = getSupabaseClient();
    supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") passwordReset = true;
    });

    const user = await getAuthenticatedUser(supabase);
    if (passwordReset && user) {
      setMode("reset");
      document.body.classList.remove("auth-checking");
      return true;
    }
    if (passwordReset && !user) {
      setMode("forgot");
      showError("That reset link is invalid or has expired. Request a new one.");
      document.body.classList.remove("auth-checking");
      return true;
    }
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

  if (password.length < 6) {
    showError("Password must be at least 6 characters.");
    return;
  }

  clearStatus();
  setBusy(form, true, "Create Account");

  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}${continuePath}`,
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
    setBusy(form, false, "Create Account");
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

async function handleForgot(event: SubmitEvent) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const email = (form.elements.namedItem("email") as HTMLInputElement).value.trim();
  clearStatus();
  setBusy(form, true, "Send Reset Link");

  try {
    const supabase = getSupabaseClient();
    const redirectTo = new URL("/login/", window.location.origin);
    redirectTo.searchParams.set("mode", "reset");
    if (nextKey) redirectTo.searchParams.set("next", nextKey);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: redirectTo.toString(),
    });
    if (error) {
      showError(error.message);
      return;
    }
    showSuccess("Check your email. If that email exists, we sent a password reset link.");
    form.setAttribute("hidden", "");
  } catch (error) {
    showError(error instanceof Error ? error.message : "Unable to send a reset link.");
  } finally {
    setBusy(form, false, "Send Reset Link");
  }
}

async function handleReset(event: SubmitEvent) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const password = (form.elements.namedItem("password") as HTMLInputElement).value;
  const confirm = (form.elements.namedItem("confirm") as HTMLInputElement).value;
  if (password.length < 6) {
    showError("Password must be at least 6 characters.");
    return;
  }
  if (password !== confirm) {
    showError("Passwords do not match.");
    return;
  }

  clearStatus();
  setBusy(form, true, "Update password");

  try {
    const supabase = getSupabaseClient();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      showError(error.message);
      return;
    }
    passwordReset = false;
    goToContinue();
  } catch (error) {
    showError(error instanceof Error ? error.message : "Unable to update your password.");
  } finally {
    setBusy(form, false, "Update password");
  }
}

function applyDestinationCopy() {
  const title = document.getElementById("login-title");
  const lede = document.getElementById("login-lede");
  if (!title || !lede) return;

  if (nextKey === "agent") {
    customDestination = true;
    title.textContent = "Try Xyrra Agent";
    lede.hidden = false;
    lede.textContent = "Create a free account to download Xyrra Agent for your machine.";
    return;
  }

  if (nextKey === "pre-order") {
    customDestination = true;
    const system = pcSystemFromSearch(params);
    title.textContent = system ? `Pre-order the ${system.name}` : "Pre-order the Xyrra PC";
    lede.hidden = false;
    lede.textContent = system
      ? `Create an account to reserve the ${system.name}. No payment today.`
      : "Create an account to reserve your Xyrra PC. No payment today.";
  }
}

function bindMenu() {
  const menu = document.getElementById("mh-menu");
  const nav = document.getElementById("mh-nav");
  menu?.addEventListener("click", () => {
    const open = nav?.getAttribute("data-open") === "true";
    nav?.setAttribute("data-open", open ? "false" : "true");
    menu.setAttribute("aria-expanded", open ? "false" : "true");
    menu.setAttribute("aria-label", open ? "Open menu" : "Close menu");
  });
  nav?.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      nav.setAttribute("data-open", "false");
      menu?.setAttribute("aria-expanded", "false");
      menu?.setAttribute("aria-label", "Open menu");
    });
  });
}

applyDestinationCopy();
setMode(requestedScreen());
showOAuthError();
bindMenu();

const year = document.getElementById("mh-year");
if (year) year.textContent = String(new Date().getFullYear());

document.body.classList.add("auth-checking");
void redirectIfSignedIn().then((redirecting) => {
  if (!redirecting) document.body.classList.remove("auth-checking");
});

document.getElementById("login-switch-action")?.addEventListener("click", (event) => {
  event.preventDefault();
  const mode = (event.currentTarget as HTMLElement).getAttribute("data-mode");
  if (mode === "signup" || mode === "signin") setMode(mode);
});

document.getElementById("login-forgot")?.addEventListener("click", (event) => {
  event.preventDefault();
  setMode("forgot");
});

document.getElementById("login-signup-form")?.addEventListener("submit", (event) => {
  void handleSignUp(event);
});
document.getElementById("login-signin-form")?.addEventListener("submit", (event) => {
  void handleSignIn(event);
});
document.getElementById("login-forgot-form")?.addEventListener("submit", (event) => {
  void handleForgot(event);
});
document.getElementById("login-reset-form")?.addEventListener("submit", (event) => {
  void handleReset(event);
});
