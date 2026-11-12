"use server";

import { redirect } from "next/navigation";
import { canAccessAdminCenter } from "@/lib/admin/access";
import { runSandboxTransferReconciliation } from "@/lib/admin/run-transfer-reconciliation";
import { redirectIfRateLimited } from "@/lib/rate-limit";
import { requireSession } from "@/lib/session";

export async function reconcileSandboxTransfersAction() {
  const session = await requireSession("/admin");
  if (!canAccessAdminCenter(session.profile.role)) redirect("/");
  await redirectIfRateLimited("adminReconcile", session.user.id, "/admin");
  const stripeKey = process.env.STRIPE_SECRET_KEY ?? "";
  if (!stripeKey.startsWith("sk_test_")) {
    redirect("/admin?error=Stripe%20test%20mode%20is%20required%20before%20recording%20transfer%20amounts.");
  }

  let result: Awaited<ReturnType<typeof runSandboxTransferReconciliation>>;
  try {
    result = await runSandboxTransferReconciliation(session.profile.role, stripeKey);
  } catch {
    redirect(
      "/admin?error=Stripe%20transfers%20could%20not%20be%20read.%20No%20charges%2C%20refunds%2C%20transfers%2C%20or%20reversals%20were%20created.",
    );
  }
  if (!result.ok) {
    redirect(
      result.reason === "unauthorized"
        ? "/admin?error=Only%20an%20administrator%20can%20record%20Stripe%20transfer%20amounts."
        : "/admin?error=Stripe%20test%20mode%20is%20required%20before%20recording%20transfer%20amounts.",
    );
  }
  redirect(
    `/admin?notice=${encodeURIComponent(
      `Reconciled ${result.reconciled} transfers. Skipped ${result.skipped}. Failed ${result.failed}. No charges, refunds, transfers, or reversals were created.`,
    )}`,
  );
}
