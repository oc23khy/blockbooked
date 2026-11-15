import { createAdminClient, isServiceRoleConfigured } from "@/lib/supabase/admin";
import { bookingCreationDecision } from "./maintenance-decision.ts";

export async function readBookingCreationDecision() {
  if (!isServiceRoleConfigured()) return "open" as const;
  const result = await createAdminClient()
    .from("platform_settings")
    .select("value")
    .eq("key", "booking_maintenance")
    .maybeSingle();
  return bookingCreationDecision({ readFailed: Boolean(result.error), value: result.data?.value });
}
