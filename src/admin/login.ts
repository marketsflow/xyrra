import { isAdminPanelRole } from "../lib/auth/admin-access";
import { getAuthenticatedUser } from "../lib/auth/session";
import { getSupabaseClient } from "../lib/supabase/client";

function pickError(): string | null {
  const value = new URLSearchParams(window.location.search).get("error");
  return value ? decodeURIComponent(value.replace(/\+/g, " ")) : null;
}

function showError(message: string) {
  const el = document.getElementById("xa-login-error");
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

async function redirectIfAlreadySignedIn() {
  try {
    const supabase = getSupabaseClient();
    const user = await getAuthenticatedUser(supabase);

    if (!user) return;

    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();

    if (isAdminPanelRole(profile?.role)) {
      window.location.replace("/admin/");
    }
  } catch {
    // Stay on the login form if session lookup fails.
  }
}

async function handleSubmit(event: SubmitEvent) {
  event.preventDefault();

  const form = event.currentTarget as HTMLFormElement;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const email = (form.elements.namedItem("email") as HTMLInputElement).value.trim();
  const password = (form.elements.namedItem("password") as HTMLInputElement).value;

  if (!email || !password) {
    showError("Missing email or password");
    return;
  }

  if (submit) submit.disabled = true;

  try {
    const supabase = getSupabaseClient();

    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      showError(signInError.message);
      return;
    }

    const user = data.user;

    if (!user) {
      showError("Sign-in failed");
      return;
    }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();

    if (profileError) {
      showError(profileError.message);
      return;
    }

    if (!isAdminPanelRole(profile?.role)) {
      await supabase.auth.signOut();
      showError("This account is not authorized for the admin console");
      return;
    }

    window.location.replace("/admin/");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to sign in";
    showError(message);
  } finally {
    if (submit) submit.disabled = false;
  }
}

const initialError = pickError();
if (initialError) {
  showError(initialError);
}

void redirectIfAlreadySignedIn();

const form = document.getElementById("xa-login-form");
form?.addEventListener("submit", (event) => {
  void handleSubmit(event);
});
