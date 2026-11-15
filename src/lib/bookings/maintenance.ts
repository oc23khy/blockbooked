import { createAdminClient, isServiceRoleConfigured } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { bookingCreationDecision } from "./maintenance-decision.ts";

// The signed-in user comes from the verified session cookie. Callers cannot pass a customer id.
async function authenticatedUserId() {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return null;
    return data.user.id;
  } catch {
    return null;
  }
}

export async function readBookingCreationDecision() {
  if (!isServiceRoleConfigured()) return "open" as const;
  const actorId = await authenticatedUserId();
  const result = await createAdminClient()
    .from("platform_settings")
    .select("key, value")
    .in("key", ["booking_maintenance", "booking_maintenance_allowlist"]);
  if (result.error) {
    return bookingCreationDecision({ readFailed: true, maintenance: null, allowlist: null, actorId });
  }
  const rows = result.data ?? [];
  const maintenance = rows.find((row) => row.key === "booking_maintenance")?.value;
  const allowlist = rows.find((row) => row.key === "booking_maintenance_allowlist")?.value;
  return bookingCreationDecision({
    readFailed: false,
    maintenance,
    allowlist,
    actorId,
  });
}
