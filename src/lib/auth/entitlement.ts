import type { SupabaseClient } from "@supabase/supabase-js";

type SubscriptionRow = {
  status: string | null;
  current_period_end: string | null;
};

export function subscriptionIsActive(row: SubscriptionRow | null): boolean {
  if (!row) return false;
  if (row.status !== "active" && row.status !== "trialing") return false;
  if (!row.current_period_end) return true;
  const end = Date.parse(row.current_period_end);
  return Number.isFinite(end) && end > Date.now();
}

/** True when this signed-in user has a current Pro subscription. */
export async function hasActiveSubscription(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("subscriptions")
    .select("status, current_period_end")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return subscriptionIsActive(data);
}
