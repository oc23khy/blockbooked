import { backfillSandboxProcessingFees, type FeeBackfillPayment } from "@/lib/admin/fee-reconciliation";
import { readAllPages } from "@/lib/admin/read-all";
import { feeFromStripeCharge } from "@/lib/payments/stripe-fee";
import { getStripe } from "@/lib/payments/stripe-server";
import { createAdminClient } from "@/lib/supabase/admin";

type PaymentFeeRow = {
  id: string;
  status: string;
  charge_id: string | null;
  stripe_fee_cents: number | null;
};

export async function runSandboxFeeBackfill(role: string, stripeKey: string) {
  const admin = createAdminClient();
  const loaded = await readAllPages<PaymentFeeRow>(async (from, to) =>
    admin
      .from("payments")
      .select("id, status, charge_id, stripe_fee_cents")
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (loaded.error) throw new Error(loaded.error);

  const stripe = getStripe();
  return backfillSandboxProcessingFees({
    role,
    stripeKey,
    payments: loaded.rows.map(
      (row): FeeBackfillPayment => ({
        id: row.id,
        status: row.status,
        chargeId: row.charge_id,
        stripeFeeCents: row.stripe_fee_cents,
      }),
    ),
    readCharge: async (chargeId) => {
      const charge = await stripe.charges.retrieve(chargeId, { expand: ["balance_transaction"] });
      return { livemode: charge.livemode, feeCents: feeFromStripeCharge(charge) };
    },
    saveFee: async (paymentId, feeCents) => {
      const saved = await admin
        .from("payments")
        .update({ stripe_fee_cents: feeCents, updated_at: new Date().toISOString() })
        .eq("id", paymentId)
        .is("stripe_fee_cents", null)
        .select("id")
        .maybeSingle();
      if (saved.error) throw new Error(saved.error.message);
      return Boolean(saved.data);
    },
  });
}
