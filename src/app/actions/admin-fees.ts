"use server";

import { redirect } from "next/navigation";
import { canAccessAdminCenter } from "@/lib/admin/access";
import { runSandboxFeeBackfill } from "@/lib/admin/run-fee-backfill";
import { requireSession } from "@/lib/session";

export async function reconcileSandboxFees() {
  const session = await requireSession("/admin");
  if (!canAccessAdminCenter(session.profile.role)) redirect("/");
  const stripeKey = process.env.STRIPE_SECRET_KEY ?? "";
  if (!stripeKey.startsWith("sk_test_")) {
    redirect("/admin?error=Stripe%20test%20mode%20is%20required%20before%20recording%20fees.");
  }

  let result: Awaited<ReturnType<typeof runSandboxFeeBackfill>>;
  try {
    result = await runSandboxFeeBackfill(session.profile.role, stripeKey);
  } catch {
    redirect("/admin?error=Stripe%20fees%20could%20not%20be%20recorded.%20No%20charges%2C%20refunds%2C%20or%20transfers%20were%20created.");
  }
  if (!result.ok) redirect("/admin?error=Only%20an%20administrator%20can%20record%20Stripe%20fees.");
  redirect(
    `/admin?notice=${encodeURIComponent(
      `Recorded Stripe fees on ${result.updated} test payments. ${result.skipped} payments still have no fee in Stripe.`,
    )}`,
  );
}
