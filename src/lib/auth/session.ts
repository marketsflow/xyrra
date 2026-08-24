import type { SupabaseClient, User } from "@supabase/supabase-js";

/** Read the signed-in user from the local session (avoids /auth/v1/user round-trips). */
export async function getAuthenticatedUser(
  supabase: SupabaseClient,
): Promise<User | null> {
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();

  if (error) {
    throw error;
  }

  return session?.user ?? null;
}
