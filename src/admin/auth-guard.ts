import { isAdminPanelRole } from "../lib/auth/admin-access";
import { getAuthenticatedUser } from "../lib/auth/session";
import { getSupabaseClient } from "../lib/supabase/client";
import type { SupabaseClient, User } from "@supabase/supabase-js";

export type AdminSession = {
  supabase: SupabaseClient;
  user: User;
  role: string;
};

function redirectToLogin(error?: string) {
  const query = error ? "?error=" + encodeURIComponent(error) : "";
  window.location.replace("/admin/login/" + query);
}

export function setAdminLoading(loading: boolean) {
  document.getElementById("xa-admin-loading")?.toggleAttribute("hidden", !loading);
  document.getElementById("xa-admin-app")?.toggleAttribute("hidden", loading);
}

export async function requireAdminSession(): Promise<AdminSession | null> {
  setAdminLoading(true);

  try {
    const supabase = getSupabaseClient();
    const user = await getAuthenticatedUser(supabase);

    if (!user) {
      redirectToLogin();
      return null;
    }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();

    if (profileError) {
      throw profileError;
    }

    const role = profile?.role ?? "user";

    if (!isAdminPanelRole(role)) {
      await supabase.auth.signOut();
      redirectToLogin("This account is not authorized for the admin console");
      return null;
    }

    return { supabase, user, role };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to verify your session";
    redirectToLogin(message);
    return null;
  }
}
