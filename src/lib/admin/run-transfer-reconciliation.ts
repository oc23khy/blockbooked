import { readAllPages } from "@/lib/admin/read-all";
import { reconcileSandboxTransfers, type RetrievedTransfer, type StoredTransferPayment } from "@/lib/admin/transfer-reconciliation";
import { getStripe } from "@/lib/payments/stripe-server";
import { createAdminClient } from "@/lib/supabase/admin";

type PaymentTransferRow = {
  id: string;
  transfer_id: string | null;
  charge_id: string | null;
  transfer_amount_cents: number | null;
  transfer_reversed_cents: number | null;
};

function text(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function cents(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export async function runSandboxTransferReconciliation(role: string, stripeKey: string) {
  const admin = createAdminClient();
  const loaded = await readAllPages<PaymentTransferRow>(async (from, to) =>
    admin
      .from("payments")
      .select("id, transfer_id, charge_id, transfer_amount_cents, transfer_reversed_cents")
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (loaded.error) throw new Error(loaded.error);

  const stripe = getStripe();
  const account = await stripe.accounts.retrieve(null);
  if (!account.id.startsWith("acct_")) {
    return { ok: false as const, reason: "test_mode_required" as const, reconciled: 0, skipped: 0, failed: 0 };
  }
  const payments = loaded.rows
    .filter((row): row is PaymentTransferRow & { transfer_id: string } => Boolean(row.transfer_id))
    .map(
      (row): StoredTransferPayment => ({
        id: row.id,
        transferId: row.transfer_id,
        chargeId: row.charge_id,
        transferAmountCents: row.transfer_amount_cents,
        transferReversedCents: row.transfer_reversed_cents,
      }),
    );

  return reconcileSandboxTransfers({
    role,
    stripeKey,
    platformAccountId: account.id,
    payments,
    readTransfer: async (transferId) => {
      try {
        const transfer = await stripe.transfers.retrieve(transferId);
        const source = transfer.source_transaction;
        const destination = transfer.destination;
        const retrieved: RetrievedTransfer = {
          id: transfer.id,
          livemode: transfer.livemode,
          amount: cents(transfer.amount),
          amountReversed: cents(transfer.amount_reversed),
          currency: transfer.currency,
          metadataPaymentId: text(transfer.metadata?.payment_id),
          sourceTransactionId: typeof source === "string" ? source : text(source?.id),
          destinationId: typeof destination === "string" ? destination : text(destination?.id),
        };
        return retrieved;
      } catch {
        return null;
      }
    },
    saveTransfer: async (paymentId, update) => {
      const payment = payments.find((row) => row.id === paymentId);
      if (!payment) return { amountWritten: false, reversalWritten: false };
      let amountWritten = false;
      let reversalWritten = false;
      if (update.amountCents != null) {
        const saved = await admin
          .from("payments")
          .update({ transfer_amount_cents: update.amountCents, updated_at: new Date().toISOString() })
          .eq("id", paymentId)
          .eq("transfer_id", payment.transferId)
          .is("transfer_amount_cents", null)
          .select("id")
          .maybeSingle();
        if (saved.error) throw new Error(saved.error.message);
        amountWritten = Boolean(saved.data);
      }
      if (update.reversalCents != null) {
        const saved = await admin
          .from("payments")
          .update({ transfer_reversed_cents: update.reversalCents, updated_at: new Date().toISOString() })
          .eq("id", paymentId)
          .eq("transfer_id", payment.transferId)
          .or(`transfer_reversed_cents.is.null,transfer_reversed_cents.lt.${update.reversalCents}`)
          .select("id")
          .maybeSingle();
        if (saved.error) throw new Error(saved.error.message);
        reversalWritten = Boolean(saved.data);
      }
      return { amountWritten, reversalWritten };
    },
  });
}
