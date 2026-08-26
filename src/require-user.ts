import type { User } from "@supabase/supabase-js";
import { loginHrefForCurrentPage } from "./lib/auth/continue";
import { getAuthenticatedUser } from "./lib/auth/session";
import { getSupabaseClient } from "./lib/supabase/client";

function prefillFromUser(user: User) {
  const meta = user.user_metadata ?? {};
  const name =
    (typeof meta.full_name === "string" && meta.full_name.trim()) ||
    (typeof meta.name === "string" && meta.name.trim()) ||
    "";
  const email = user.email?.trim() ?? "";

  const nameInput = document.querySelector<HTMLInputElement>("#preorder-name, #agent-dl-name");
  const emailInput = document.querySelector<HTMLInputElement>("#preorder-email, #agent-dl-email");

  if (nameInput && !nameInput.value && name) {
    nameInput.value = name;
  }
  if (emailInput && !emailInput.value && email) {
    emailInput.value = email;
  }
}

async function requireUserSession() {
  document.body.classList.add("auth-checking");

  try {
    const supabase = getSupabaseClient();
    const user = await getAuthenticatedUser(supabase);

    if (!user) {
      window.location.replace(loginHrefForCurrentPage());
      return;
    }

    prefillFromUser(user);
    document.body.classList.remove("auth-checking");
  } catch {
    window.location.replace(loginHrefForCurrentPage());
  }
}

void requireUserSession();
