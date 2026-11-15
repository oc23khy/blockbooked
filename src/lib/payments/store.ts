import { savedChargeResult } from "@/lib/payments/lifecycle";
import { createAdminClient } from "@/lib/supabase/admin";
import type { LedgerDraft, NormalizedStripeEvent, PaymentPatch, PaymentSnapshot, PaymentStore } from "@/lib/payments/events";

type PaymentRow = {
  id: string;
  booking_id: string;
  amount_cents: number;
  commission_cents: number;
  provider_share_cents: number;
  status: string;
  payment_intent_id: string | null;
  charge_id: string | null;
  transfer_id: string | null;
  refunded_cents: number;
  stripe_fee_cents: number | null;
  transfer_reversed_cents?: number | null;
};

function snapshot(row: PaymentRow): PaymentSnapshot {
  return {
    id: row.id,
    bookingId: row.booking_id,
    amountCents: row.amount_cents,
    commissionCents: row.commission_cents,
    providerShareCents: row.provider_share_cents,
    status: row.status,
    paymentIntentId: row.payment_intent_id,
    chargeId: row.charge_id,
    transferId: row.transfer_id,
    refundedCents: row.refunded_cents,
    stripeFeeCents: row.stripe_fee_cents,
    transferReversedCents: row.transfer_reversed_cents ?? null,
  };
}

export function createPaymentStore(): PaymentStore {
  const admin = createAdminClient();
  return {
    async claimEvent(event: NormalizedStripeEvent) {
      const inserted = await admin
        .from("stripe_events")
        .insert({
          event_id: event.id,
          event_type: event.type,
          livemode: event.livemode,
          status: "processing",
        })
        .select("event_id")
        .maybeSingle();
      if (!inserted.error && inserted.data) return "process";

      const existing = await admin
        .from("stripe_events")
        .select("status, created_at")
        .eq("event_id", event.id)
        .maybeSingle();
      const status = existing.data?.status;
      if (status === "failed") {
        await admin.from("stripe_events").update({ status: "processing", error: null }).eq("event_id", event.id);
        return "retry";
      }
      if (status === "processing" && existing.data?.created_at) {
        const age = Date.now() - new Date(existing.data.created_at).getTime();
        if (age > 2 * 60 * 1000) return "retry";
      }
      return "skip";
    },
    async finishEvent(id, status, error) {
      await admin
        .from("stripe_events")
        .update({
          status,
          error: error ?? null,
          processed_at: status === "processing" ? null : new Date().toISOString(),
        })
        .eq("event_id", id);
    },
    async findPayment(query) {
      let request = admin.from("payments").select("*");
      if (query.paymentId) request = request.eq("id", query.paymentId);
      else if (query.checkoutSessionId) request = request.eq("checkout_session_id", query.checkoutSessionId);
      else if (query.paymentIntentId) request = request.eq("payment_intent_id", query.paymentIntentId);
      else if (query.chargeId) request = request.eq("charge_id", query.chargeId);
      else return null;
      const { data } = await request.maybeSingle();
      return data ? snapshot(data as PaymentRow) : null;
    },
    async savePayment(patch: PaymentPatch) {
      const { id, ...rest } = patch;
      const current = await admin.from("payments").select("payment_intent_id").eq("id", id).maybeSingle();
      const storedIntent = (current.data?.payment_intent_id as string | null) ?? null;
      const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (rest.status) update.status = rest.status;
      if (rest.paymentIntentId !== undefined && (!storedIntent || storedIntent === rest.paymentIntentId)) {
        update.payment_intent_id = rest.paymentIntentId;
      }
      if (rest.chargeId !== undefined) update.charge_id = rest.chargeId;
      if (rest.transferId !== undefined) update.transfer_id = rest.transferId;
      if ("transferStatus" in rest && rest.transferStatus) update.transfer_status = rest.transferStatus;
      if (typeof rest.refundedCents === "number") update.refunded_cents = rest.refundedCents;
      if (typeof rest.stripeFeeCents === "number" && Number.isInteger(rest.stripeFeeCents) && rest.stripeFeeCents >= 0) {
        update.stripe_fee_cents = rest.stripeFeeCents;
      }
      await admin.from("payments").update(update).eq("id", id);
      if (typeof rest.transferReversedCents === "number" && Number.isInteger(rest.transferReversedCents) && rest.transferReversedCents >= 0) {
        const reversal = await admin
          .from("payments")
          .update({ transfer_reversed_cents: rest.transferReversedCents })
          .eq("id", id)
          .or(`transfer_reversed_cents.is.null,transfer_reversed_cents.lte.${rest.transferReversedCents}`);
        if (reversal.error && !reversal.error.message.includes("transfer_reversed_cents")) {
          throw new Error(reversal.error.message);
        }
      }
    },
    async addLedger(entry: LedgerDraft) {
      await admin.from("ledger_entries").insert({
        payment_id: entry.paymentId,
        booking_id: entry.bookingId,
        entry_type: entry.entryType,
        amount_cents: entry.amountCents,
        stripe_object_id: entry.stripeObjectId,
        note: entry.note,
      });
    },
    async saveConnectedAccount(input) {
      if (!input.stripeAccountId) return;
      await admin
        .from("provider_stripe_accounts")
        .update({
          details_submitted: input.detailsSubmitted,
          charges_enabled: input.chargesEnabled,
          payouts_enabled: input.payoutsEnabled,
          transfers_enabled: input.transfersEnabled,
          disabled_reason: input.disabledReason,
          updated_at: new Date().toISOString(),
        })
        .eq("stripe_account_id", input.stripeAccountId);
    },
    async claimFirstCharge(input) {
      const claim = await admin
        .from("payments")
        .update({
          status: "succeeded",
          payment_intent_id: input.paymentIntentId,
          ...(input.chargeId ? { charge_id: input.chargeId } : {}),
          ...(typeof input.stripeFeeCents === "number" ? { stripe_fee_cents: input.stripeFeeCents } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq("id", input.paymentId)
        .is("payment_intent_id", null)
        .select("id");
      if (claim.error) throw new Error(claim.error.message);
      if (claim.data && claim.data.length > 0) return "recorded" as const;
      const current = await admin.from("payments").select("payment_intent_id").eq("id", input.paymentId).maybeSingle();
      if (!input.paymentIntentId || current.data?.payment_intent_id === input.paymentIntentId) {
        if (typeof input.stripeFeeCents === "number") {
          await admin.from("payments").update({ stripe_fee_cents: input.stripeFeeCents }).eq("id", input.paymentId);
        }
        return "recorded" as const;
      }
      return "duplicate" as const;
    },
    async noteDuplicateCharge(input) {
      const saved = await admin.from("payment_extra_charges").upsert(
        {
          payment_id: input.paymentId,
          booking_id: input.bookingId,
          checkout_session_id: input.checkoutSessionId,
          payment_intent_id: input.paymentIntentId,
          charge_id: input.chargeId,
          amount_cents: input.amountCents,
          status: "refund_pending",
        },
        { onConflict: "payment_intent_id", ignoreDuplicates: true },
      ).select("id");
      const existing = saved.data && saved.data.length > 0
        ? { data: saved.data[0], error: null }
        : await admin.from("payment_extra_charges").select("id").eq("payment_intent_id", input.paymentIntentId).maybeSingle();
      const result = savedChargeResult({
        error: saved.error?.message ?? existing.error?.message ?? null,
        savedId: saved.data?.[0]?.id ?? null,
        existingId: existing.data?.id ?? null,
      });
      if (!result.ok) throw new Error(result.message);
    },
    async markRefund(stripeRefundId, status) {
      await admin
        .from("refunds")
        .update({
          status,
          confirmed_at: status === "succeeded" ? new Date().toISOString() : null,
        })
        .eq("stripe_refund_id", stripeRefundId);
    },
  };
}
