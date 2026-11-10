import { createAdminClient } from "@/lib/supabase/admin";
import { isServiceRoleConfigured } from "@/lib/supabase/admin";
import {
  attemptProviderTransfer,
  classifyStripeFailure,
  recordedRefundCoverage,
  refundActorAllowed,
  refundIdempotencyKey,
  reversalIdempotencyKey,
  settleRefundAmounts,
} from "@/lib/payments/guards";
import {
  DEFAULT_COMMISSION_BPS,
  quoteServicePayment,
  refundShares,
  validateMilestones,
  nextRecordedTransferAmount,
  nextRecordedTransferReversal,
  remainingProviderTransferCents,
  shouldReverseTransfer,
} from "@/lib/payments/money";
import {
  checkoutIntegrationIdentifier,
  connectedAccountReadiness,
  platformCheckoutIntent,
} from "@/lib/payments/connect";
import { getStripe, siteUrl, stripeTestKeyConfigured } from "@/lib/payments/stripe-server";

type PaymentRow = {
  id: string;
  booking_id: string;
  customer_id: string;
  provider_id: string;
  checkout_session_id: string | null;
  amount_cents: number;
  commission_cents: number;
  provider_share_cents: number;
  status: string;
  payment_intent_id: string | null;
  charge_id: string | null;
  transfer_id: string | null;
  transfer_status: string;
  transfer_attempt: number;
  refunded_cents: number;
};

async function ledger(input: {
  paymentId: string | null;
  bookingId: string | null;
  entryType: string;
  amountCents: number;
  stripeObjectId?: string | null;
  note: string;
}) {
  const admin = createAdminClient();
  await admin.from("ledger_entries").insert({
    payment_id: input.paymentId,
    booking_id: input.bookingId,
    entry_type: input.entryType,
    amount_cents: input.amountCents,
    stripe_object_id: input.stripeObjectId ?? null,
    note: input.note,
  });
}

export async function readCommissionBps() {
  if (!isServiceRoleConfigured()) return DEFAULT_COMMISSION_BPS;
  const admin = createAdminClient();
  const { data } = await admin.from("platform_settings").select("value").eq("key", "commission_bps").maybeSingle();
  const value = typeof data?.value === "number" ? data.value : Number(data?.value);
  return Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : DEFAULT_COMMISSION_BPS;
}

export async function startCheckout(input: {
  bookingId: string;
  customerId: string;
  providerId: string;
  amountCents: number;
  serviceName: string;
  customerEmail: string;
  milestoneId?: string | null;
}) {
  const admin = createAdminClient();
  const stripeClient = getStripe();
  const quote = quoteServicePayment(input.amountCents, await readCommissionBps());
  const inserted = await admin
    .from("payments")
    .insert({
      booking_id: input.bookingId,
      customer_id: input.customerId,
      provider_id: input.providerId,
      amount_cents: quote.amountCents,
      commission_bps: quote.commissionBps,
      commission_cents: quote.commissionCents,
      provider_share_cents: quote.providerShareCents,
      fee_bearer: quote.feeBearer,
      status: "requires_payment",
      milestone_id: input.milestoneId ?? null,
    })
    .select("id")
    .single();
  if (inserted.error || !inserted.data) throw new Error(inserted.error?.message ?? "Could not store the payment.");

  const paymentId = inserted.data.id as string;
  // Each fixed price, accepted quote, or milestone is its own Checkout session.
  // The service name is the line item. The provider mapping stays on the payment
  // row, not on a separate Stripe Product, because quotes and milestones change
  // the amount. No destination and no application fee: the provider transfer
  // happens later, after verified completion.
  const session = await stripeClient.checkout.sessions.create(
    {
      mode: "payment",
      customer_email: input.customerEmail,
      client_reference_id: paymentId,
      integration_identifier: checkoutIntegrationIdentifier(),
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: quote.amountCents,
            product_data: { name: input.serviceName || "BlockBooked service" },
          },
        },
      ],
      success_url: `${siteUrl()}/account?checkout=submitted`,
      cancel_url: `${siteUrl()}/account?error=${encodeURIComponent("Checkout was canceled. You can pay from your account.")}`,
      metadata: { payment_id: paymentId, booking_id: input.bookingId, provider_id: input.providerId },
      payment_intent_data: platformCheckoutIntent(input.bookingId, paymentId),
    },
    { idempotencyKey: `checkout_${paymentId}` },
  );
  await admin.from("payments").update({ checkout_session_id: session.id }).eq("id", paymentId);
  await ledger({
    paymentId,
    bookingId: input.bookingId,
    entryType: "checkout_created",
    amountCents: quote.amountCents,
    stripeObjectId: session.id,
    note: "Checkout used the server-calculated catalog price.",
  });
  if (!session.url) throw new Error("Stripe did not return a Checkout URL.");
  return session.url;
}

export async function resumeCheckout(bookingId: string, customerId: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("payments")
    .select("*")
    .eq("booking_id", bookingId)
    .in("status", ["requires_payment", "failed", "canceled"])
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const payment = data as PaymentRow | null;
  if (!payment || payment.status === "succeeded") return null;
  if (payment.customer_id !== customerId) {
    throw new Error("unauthorized");
  }
  const stripeClient = getStripe();
  const session = await stripeClient.checkout.sessions.create(
    {
      mode: "payment",
      client_reference_id: payment.id,
      integration_identifier: checkoutIntegrationIdentifier(),
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: payment.amount_cents,
            product_data: { name: "BlockBooked service" },
          },
        },
      ],
      success_url: `${siteUrl()}/account?checkout=submitted`,
      cancel_url: `${siteUrl()}/account?error=${encodeURIComponent("Checkout was canceled. You can pay from your account.")}`,
      metadata: { payment_id: payment.id, booking_id: bookingId },
      payment_intent_data: platformCheckoutIntent(bookingId, payment.id),
    },
    { idempotencyKey: `checkout_retry_${payment.id}_${payment.checkout_session_id ?? "new"}` },
  );
  await admin.from("payments").update({ checkout_session_id: session.id, status: "requires_payment" }).eq("id", payment.id);
  return session.url;
}

export async function startProviderOnboarding(providerId: string, email: string) {
  const stripeClient = getStripe();
  const admin = createAdminClient();
  const existing = await admin
    .from("provider_stripe_accounts")
    .select("stripe_account_id")
    .eq("provider_id", providerId)
    .maybeSingle();
  let accountId = existing.data?.stripe_account_id as string | null;
  if (!accountId) {
    const listing = await admin.from("providers").select("business_name").eq("id", providerId).maybeSingle();
    // New accounts use Accounts v2. There is no top-level type. The platform
    // prices the service, collects the fee, and owns negative balances.
    // Recipient transfers are the only capability, because the provider does
    // not charge the customer directly.
    const account = await stripeClient.v2.core.accounts.create({
      display_name: listing.data?.business_name || email,
      contact_email: email,
      identity: { country: "us" },
      dashboard: "express",
      defaults: {
        responsibilities: {
          fees_collector: "application",
          losses_collector: "application",
        },
      },
      configuration: {
        recipient: {
          capabilities: {
            stripe_balance: {
              stripe_transfers: { requested: true },
            },
          },
        },
      },
    });
    accountId = account.id;
    await admin.from("provider_stripe_accounts").upsert({
      provider_id: providerId,
      stripe_account_id: accountId,
    });
  }
  const link = await stripeClient.v2.core.accountLinks.create({
    account: accountId,
    use_case: {
      type: "account_onboarding",
      account_onboarding: {
        // The account already requests the recipient configuration. stripe-node 23
        // collects that configuration from the account instead of a configurations list.
        refresh_url: `${siteUrl()}/dashboard?stripe=refresh`,
        return_url: `${siteUrl()}/dashboard?stripe=return&accountId=${accountId}`,
      },
    },
  });
  return link.url;
}

async function readRecipientAccount(stripeAccountId: string) {
  const stripeClient = getStripe();
  try {
    const account = await stripeClient.v2.core.accounts.retrieve(stripeAccountId, {
      include: ["configuration.recipient", "requirements"],
    });
    const readiness = connectedAccountReadiness(account);
    return {
      details_submitted: readiness.onboardingComplete,
      charges_enabled: false,
      payouts_enabled: readiness.readyToReceivePayments,
      transfers_enabled: readiness.readyToReceivePayments,
      disabled_reason: readiness.requirementsStatus,
      readyToReceivePayments: readiness.readyToReceivePayments,
      onboardingComplete: readiness.onboardingComplete,
      requirementsStatus: readiness.requirementsStatus,
    };
  } catch {
    // Accounts created before the v2 switch still expose the transfers capability.
    const account = await stripeClient.accounts.retrieve(stripeAccountId);
    const transfers = account.capabilities?.transfers === "active";
    return {
      details_submitted: account.details_submitted ?? false,
      charges_enabled: account.charges_enabled ?? false,
      payouts_enabled: account.payouts_enabled ?? false,
      transfers_enabled: transfers,
      disabled_reason: account.requirements?.disabled_reason ?? null,
      readyToReceivePayments: transfers && (account.payouts_enabled ?? false),
      onboardingComplete: account.details_submitted ?? false,
      requirementsStatus: account.requirements?.disabled_reason ?? null,
    };
  }
}

export async function refreshConnectedAccount(providerId: string) {
  if (!stripeTestKeyConfigured() || !isServiceRoleConfigured()) return null;
  const admin = createAdminClient();
  const { data } = await admin
    .from("provider_stripe_accounts")
    .select("*")
    .eq("provider_id", providerId)
    .maybeSingle();
  if (!data?.stripe_account_id) return data;
  const next = await readRecipientAccount(data.stripe_account_id);
  await admin
    .from("provider_stripe_accounts")
    .update({
      details_submitted: next.details_submitted,
      charges_enabled: next.charges_enabled,
      payouts_enabled: next.payouts_enabled,
      transfers_enabled: next.transfers_enabled,
      disabled_reason: next.disabled_reason,
      updated_at: new Date().toISOString(),
    })
    .eq("provider_id", providerId);
  return { ...data, ...next };
}

export async function refreshConnectedAccountByStripeId(stripeAccountId: string) {
  if (!stripeTestKeyConfigured() || !isServiceRoleConfigured() || !stripeAccountId) return;
  const admin = createAdminClient();
  const next = await readRecipientAccount(stripeAccountId);
  await admin
    .from("provider_stripe_accounts")
    .update({
      details_submitted: next.details_submitted,
      charges_enabled: next.charges_enabled,
      payouts_enabled: next.payouts_enabled,
      transfers_enabled: next.transfers_enabled,
      disabled_reason: next.disabled_reason,
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_account_id", stripeAccountId);
}

export async function releaseProviderTransfer(bookingId: string) {
  if (!stripeTestKeyConfigured() || !isServiceRoleConfigured()) return { status: "skipped" as const };
  const admin = createAdminClient();
  const booking = await admin.from("booking_requests").select("id, status, provider_id").eq("id", bookingId).maybeSingle();
  if (booking.data?.status !== "completed") return { status: "not_completed" as const };
  const paymentResult = await admin.from("payments").select("*").eq("booking_id", bookingId);
  const payments = ((paymentResult.data ?? []) as PaymentRow[]).filter(
    (row) => !row.transfer_id && (row.status === "succeeded" || row.status === "partially_refunded"),
  );
  if (payments.length === 0) {
    const any = await admin.from("payments").select("transfer_id").eq("booking_id", bookingId);
    if ((any.data ?? []).some((row) => row.transfer_id)) return { status: "already_transferred" as const };
    return { status: (any.data ?? []).length ? ("unpaid" as const) : ("no_payment" as const) };
  }
  let lastStatus: "transferred" | "refund_pending" | "nothing_to_transfer" | "provider_not_eligible" | "failed" | "uncertain" | "already_transferred" | "in_progress" | "stop" = "nothing_to_transfer";
  for (const payment of payments) {

  const pending = await admin.from("refunds").select("id").eq("payment_id", payment.id).eq("status", "pending").maybeSingle();
  if (pending.data) {
    await ledger({
      paymentId: payment.id,
      bookingId,
      entryType: "transfer_blocked",
      amountCents: 0,
      note: "Provider transfer is waiting because a refund is still unconfirmed.",
    });
    lastStatus = "refund_pending";
    continue;
  }

  const amount = remainingProviderTransferCents({
    providerShareCents: payment.provider_share_cents,
    amountCents: payment.amount_cents,
    refundedCents: payment.refunded_cents,
  });
  if (amount <= 0) {
    await admin.from("payments").update({ transfer_status: "reversed" }).eq("id", payment.id).is("transfer_id", null);
    lastStatus = "nothing_to_transfer";
    continue;
  }

  lastStatus = await attemptProviderTransfer({
    payment: {
      id: payment.id,
      transferId: payment.transfer_id,
      transferStatus: payment.transfer_status,
      transferAttempt: payment.transfer_attempt ?? 0,
      chargeId: payment.charge_id,
    },
    bookingId,
    amount,
    destination: async () => {
      const connected = await refreshConnectedAccount(booking.data?.provider_id ?? "");
      return {
        accountId: connected?.stripe_account_id ?? null,
        eligible: Boolean(connected?.stripe_account_id && connected.readyToReceivePayments),
      };
    },
    claim: async (attempt) => {
      const claimed = await admin
        .from("payments")
        .update({ transfer_status: "pending", transfer_attempt: attempt })
        .eq("id", payment.id)
        .is("transfer_id", null)
        .in("transfer_status", ["not_ready", "failed"])
        .select("transfer_attempt")
        .maybeSingle();
      if (claimed.error) {
        throw new Error(
          claimed.error.message.includes("transfer_attempt")
            ? "Apply supabase/migrations/20261110250000_transfer_refund_guards.sql before transferring provider funds."
            : claimed.error.message,
        );
      }
      if (!claimed.data) return { ok: false as const };
      payment.transfer_status = "pending";
      payment.transfer_attempt = claimed.data.transfer_attempt as number;
      return { ok: true as const, attempt: payment.transfer_attempt };
    },
    mark: async (patch) => {
      const update: { transfer_status: string; transfer_id?: string } = { transfer_status: patch.transferStatus };
      if (patch.transferId) update.transfer_id = patch.transferId;
      const saved = await admin
        .from("payments")
        .update(update)
        .eq("id", payment.id)
        .is("transfer_id", null)
        .select("id")
        .maybeSingle();
      if (saved.data) {
        payment.transfer_status = patch.transferStatus;
        if (patch.transferId) payment.transfer_id = patch.transferId;
        await rememberTransferAmount(payment.id, patch.transferAmountCents);
      }
      return Boolean(saved.data);
    },
    ledger: async (entry) => {
      await ledger({
        paymentId: payment.id,
        bookingId,
        entryType: entry.entryType,
        amountCents: entry.amountCents,
        stripeObjectId: entry.stripeObjectId,
        note: entry.note,
      });
    },
    createTransfer: async (request) => {
      const transfer = await getStripe().transfers.create(
        {
          amount: request.amount,
          currency: "usd",
          destination: request.destination,
          transfer_group: request.transferGroup,
          source_transaction: request.sourceTransaction,
          metadata: { payment_id: payment.id, booking_id: bookingId },
        },
        { idempotencyKey: request.idempotencyKey },
      );
      return { id: transfer.id };
    },
  });
  }
  return { status: lastStatus };
}

export async function requestRefund(input: {
  bookingId: string;
  actorId: string;
  actorRole: string;
  reason: string;
  amountCents?: number;
  automatic?: boolean;
  paymentId?: string;
}) {
  if (!refundActorAllowed(input)) {
    return { ok: false as const, message: "unauthorized" };
  }
  if (!stripeTestKeyConfigured() || !isServiceRoleConfigured()) {
    return { ok: false as const, message: "Payments are not configured." };
  }
  const admin = createAdminClient();
  const booking = await admin.from("booking_requests").select("id, status").eq("id", input.bookingId).maybeSingle();
  if (!booking.data) return { ok: false as const, message: "Booking not found." };
  if (
    input.automatic &&
    booking.data.status !== "cancelled" &&
    booking.data.status !== "declined" &&
    booking.data.status !== "expired"
  ) {
    return { ok: false as const, message: "unauthorized" };
  }
  let paymentQuery = admin.from("payments").select("*").eq("booking_id", input.bookingId);
  if (input.paymentId) paymentQuery = paymentQuery.eq("id", input.paymentId);
  const paymentResult = await paymentQuery;
  const payment = ((paymentResult.data ?? []) as PaymentRow[]).find((row) =>
    input.automatic ? row.status === "succeeded" || row.status === "partially_refunded" : true,
  ) ?? null;
  if (!payment || !payment.payment_intent_id) return { ok: false as const, message: "There is no confirmed Stripe payment to refund." };
  if (payment.status !== "succeeded" && payment.status !== "partially_refunded") {
    return { ok: false as const, message: "This payment cannot be refunded yet." };
  }
  const pending = await admin.from("refunds").select("id, status, amount_cents, provider_reversal_cents").eq("payment_id", payment.id).eq("status", "pending").maybeSingle();
  const prior = await admin
    .from("refunds")
    .select("amount_cents, provider_reversal_cents")
    .eq("payment_id", payment.id)
    .eq("status", "succeeded");
  const succeeded = (prior.data ?? []) as { amount_cents: number; provider_reversal_cents: number }[];
  const coverage = recordedRefundCoverage({
    amountCents: payment.amount_cents,
    refundedCents: payment.refunded_cents,
    succeededRefundCents: succeeded.reduce((sum, row) => sum + row.amount_cents, 0),
    openRefundId: pending.data?.id ?? null,
  });
  if (coverage.action === "replay") {
    return replayRefund({
      refundId: pending.data?.id as string,
      payment,
      bookingId: input.bookingId,
      refundCents: pending.data?.amount_cents as number,
      providerReversalCents: pending.data?.provider_reversal_cents as number,
    });
  }
  if (coverage.needsRepair) {
    const repaired = await admin
      .from("payments")
      .update({
        refunded_cents: coverage.action === "settled" ? coverage.refundedCents : coverage.alreadyRefundedCents,
        status: coverage.action === "settled" ? "refunded" : "partially_refunded",
      })
      .eq("id", payment.id)
      .eq("refunded_cents", payment.refunded_cents)
      .select("refunded_cents, status")
      .maybeSingle();
    if (repaired.data) {
      payment.refunded_cents = repaired.data.refunded_cents as number;
      payment.status = repaired.data.status as PaymentRow["status"];
    }
  }
  if (coverage.action === "settled" || payment.refunded_cents >= payment.amount_cents) {
    return { ok: true as const, stripeStatus: "succeeded" };
  }
  const alreadyProvider = succeeded.reduce((sum, row) => sum + row.provider_reversal_cents, 0);

  const refundCents = input.amountCents ?? payment.amount_cents - payment.refunded_cents;
  let shares: { providerReversalCents: number; commissionReversalCents: number };
  try {
    shares = refundShares({
      refundCents,
      amountCents: payment.amount_cents,
      providerShareCents: payment.provider_share_cents,
      alreadyRefundedCents: payment.refunded_cents,
      alreadyProviderReversedCents: alreadyProvider,
    });
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : "Invalid refund." };
  }

  const created = await admin
    .from("refunds")
    .insert({
      payment_id: payment.id,
      booking_id: input.bookingId,
      amount_cents: refundCents,
      commission_reversal_cents: shares.commissionReversalCents,
      provider_reversal_cents: shares.providerReversalCents,
      status: "pending",
      reason: input.reason.slice(0, 200),
      requested_by: input.actorId,
    })
    .select("id")
    .single();
  if (created.error || !created.data) {
    const message = created.error?.message ?? "";
    if (message.includes("refunds_one_open_payment_uidx") || message.includes("duplicate key")) {
      const open = await admin
        .from("refunds")
        .select("id, amount_cents, provider_reversal_cents")
        .eq("payment_id", payment.id)
        .eq("status", "pending")
        .maybeSingle();
      if (open.data) {
        return replayRefund({
          refundId: open.data.id as string,
          payment,
          bookingId: input.bookingId,
          refundCents: open.data.amount_cents as number,
          providerReversalCents: open.data.provider_reversal_cents as number,
        });
      }
      return { ok: false as const, message: "A refund is already waiting for Stripe." };
    }
    if (message.includes("remaining balance")) {
      return { ok: false as const, message: "Refund amount is outside the remaining balance." };
    }
    return { ok: false as const, message: "The refund record could not be saved." };
  }

  return submitRefund({
    refundId: created.data.id as string,
    payment,
    bookingId: input.bookingId,
    refundCents,
    providerReversalCents: shares.providerReversalCents,
  });
}

function stripeFailure(error: unknown) {
  if (!error || typeof error !== "object") return { message: "Stripe request failed." };
  const typed = error as { type?: string; statusCode?: number; message?: string };
  return { type: typed.type, statusCode: typed.statusCode, message: typed.message };
}

async function submitRefund(input: {
  refundId: string;
  payment: PaymentRow;
  bookingId: string;
  refundCents: number;
  providerReversalCents: number;
}) {
  const admin = createAdminClient();
  try {
    const refund = await getStripe().refunds.create(
      {
        payment_intent: input.payment.payment_intent_id ?? undefined,
        amount: input.refundCents,
        metadata: { payment_id: input.payment.id, booking_id: input.bookingId, refund_id: input.refundId },
      },
      { idempotencyKey: refundIdempotencyKey(input.refundId) },
    );
    const stripeStatus = refund.status ?? "pending";
    const recorded = await admin
      .from("refunds")
      .update({
        stripe_refund_id: refund.id,
        status: stripeStatus === "succeeded" || stripeStatus === "failed" || stripeStatus === "canceled" ? stripeStatus : "pending",
        confirmed_at: stripeStatus === "succeeded" ? new Date().toISOString() : null,
        failure_reason: refund.failure_reason,
      })
      .eq("id", input.refundId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (recorded.data) {
      await ledger({
        paymentId: input.payment.id,
        bookingId: input.bookingId,
        entryType: "refund_requested",
        amountCents: input.refundCents,
        stripeObjectId: refund.id,
        note: `Stripe refund status: ${stripeStatus}.`,
      });
    }
    if (stripeStatus === "succeeded" && recorded.data) {
      const settlement = settleRefundAmounts({
        priorStatus: "pending",
        stripeStatus,
        refundedCents: input.payment.refunded_cents,
        refundCents: input.refundCents,
        amountCents: input.payment.amount_cents,
      });
      await admin
        .from("payments")
        .update({ refunded_cents: settlement.refundedCents, status: settlement.paymentStatus })
        .eq("id", input.payment.id)
        .eq("refunded_cents", input.payment.refunded_cents);
      await settleReversal({
        refundRowId: input.refundId,
        payment: input.payment,
        providerReversalCents: input.providerReversalCents,
      });
    }
    return { ok: true as const, stripeStatus };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stripe could not create the refund.";
    const kind = classifyStripeFailure(stripeFailure(error));
    if (kind === "uncertain") {
      await ledger({
        paymentId: input.payment.id,
        bookingId: input.bookingId,
        entryType: "refund_uncertain",
        amountCents: input.refundCents,
        note: `Stripe did not confirm the refund. The same refund will be retried. ${message}`.slice(0, 500),
      });
      return {
        ok: false as const,
        message: "Stripe did not confirm the refund. It stays pending and will not be sent again.",
      };
    }
    await admin
      .from("refunds")
      .update({ status: "failed", failure_reason: message.slice(0, 500) })
      .eq("id", input.refundId)
      .eq("status", "pending");
    await ledger({
      paymentId: input.payment.id,
      bookingId: input.bookingId,
      entryType: "refund_failed",
      amountCents: input.refundCents,
      note: message.slice(0, 500),
    });
    return { ok: false as const, message };
  }
}

async function replayRefund(input: {
  refundId: string;
  payment: PaymentRow;
  bookingId: string;
  refundCents: number;
  providerReversalCents: number;
}) {
  return submitRefund(input);
}

function integerAmount(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

async function rememberTransferAmount(paymentId: string, amountCents: number | undefined) {
  const amount = integerAmount(amountCents);
  if (amount == null) return;
  const admin = createAdminClient();
  const current = await admin.from("payments").select("transfer_amount_cents").eq("id", paymentId).maybeSingle();
  if (current.error) return;
  const next = nextRecordedTransferAmount(current.data?.transfer_amount_cents ?? null, amount);
  if (next == null || next === current.data?.transfer_amount_cents) return;
  await admin.from("payments").update({ transfer_amount_cents: next }).eq("id", paymentId).is("transfer_amount_cents", null);
}

async function rememberTransferReversal(paymentId: string, amountCents: number) {
  const admin = createAdminClient();
  const current = await admin.from("payments").select("transfer_reversed_cents").eq("id", paymentId).maybeSingle();
  if (current.error) return;
  const next = nextRecordedTransferReversal(current.data?.transfer_reversed_cents ?? null, amountCents);
  if (next == null || next === current.data?.transfer_reversed_cents) return;
  await admin
    .from("payments")
    .update({ transfer_reversed_cents: next })
    .eq("id", paymentId)
    .or(`transfer_reversed_cents.is.null,transfer_reversed_cents.lte.${next}`);
}

async function settleReversal(input: { refundRowId: string; payment: PaymentRow; providerReversalCents: number }) {
  const admin = createAdminClient();
  if (
    !shouldReverseTransfer({
      refundStatus: "succeeded",
      transferId: input.payment.transfer_id,
      providerReversalCents: input.providerReversalCents,
      reversalStatus: null,
    })
  ) {
    await admin.from("refunds").update({ reversal_status: "not_required" }).eq("id", input.refundRowId);
    await ledger({
      paymentId: input.payment.id,
      bookingId: input.payment.booking_id,
      entryType: "refund_without_transfer",
      amountCents: input.providerReversalCents,
      note: "The provider share had not been transferred, so there was no transfer to reverse.",
    });
    return;
  }
  try {
    const reversal = await getStripe().transfers.createReversal(
      input.payment.transfer_id!,
      { amount: input.providerReversalCents },
      { idempotencyKey: reversalIdempotencyKey(input.refundRowId) },
    );
    const recorded = await admin
      .from("refunds")
      .update({ stripe_reversal_id: reversal.id, reversal_status: "succeeded" })
      .eq("id", input.refundRowId)
      .is("stripe_reversal_id", null)
      .select("id")
      .maybeSingle();
    if (!recorded.data) return;
    await admin
      .from("payments")
      .update({
        transfer_status:
          input.providerReversalCents >= input.payment.provider_share_cents ? "reversed" : "partially_reversed",
      })
      .eq("id", input.payment.id);
    const confirmed = await admin
      .from("refunds")
      .select("provider_reversal_cents")
      .eq("payment_id", input.payment.id)
      .eq("reversal_status", "succeeded");
    const confirmedCents = ((confirmed.data ?? []) as { provider_reversal_cents: number }[]).reduce(
      (sum, row) => sum + row.provider_reversal_cents,
      0,
    );
    const stripeAmount = integerAmount(reversal.amount);
    await rememberTransferReversal(input.payment.id, Math.max(confirmedCents, stripeAmount ?? 0));
    await ledger({
      paymentId: input.payment.id,
      bookingId: input.payment.booking_id,
      entryType: "transfer_reversed",
      amountCents: input.providerReversalCents,
      stripeObjectId: reversal.id,
      note: "Stripe confirmed the transfer reversal.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Transfer reversal failed.";
    const kind = classifyStripeFailure(stripeFailure(error));
    if (kind === "uncertain") {
      await admin
        .from("refunds")
        .update({ reversal_status: "pending", failure_reason: message.slice(0, 500) })
        .eq("id", input.refundRowId)
        .neq("reversal_status", "succeeded");
      await ledger({
        paymentId: input.payment.id,
        bookingId: input.payment.booking_id,
        entryType: "transfer_reversal_uncertain",
        amountCents: input.providerReversalCents,
        note: `Stripe did not confirm the reversal. Retry uses the same reversal. ${message}`.slice(0, 500),
      });
      return;
    }
    await admin.from("refunds").update({ reversal_status: "failed", failure_reason: message.slice(0, 500) }).eq("id", input.refundRowId).neq("reversal_status", "succeeded");
    await ledger({
      paymentId: input.payment.id,
      bookingId: input.payment.booking_id,
      entryType: "transfer_reversal_failed",
      amountCents: input.providerReversalCents,
      note: message.slice(0, 500),
    });
  }
}

export async function settleRefundFromStripe(stripeRefundId: string) {
  if (!stripeTestKeyConfigured() || !isServiceRoleConfigured()) return;
  const admin = createAdminClient();
  const refund = await admin.from("refunds").select("*").eq("stripe_refund_id", stripeRefundId).maybeSingle();
  if (!refund.data || refund.data.status !== "succeeded" || refund.data.reversal_status === "succeeded") return;
  const payment = await admin.from("payments").select("*").eq("id", refund.data.payment_id).maybeSingle();
  if (!payment.data) return;
  await settleReversal({
    refundRowId: refund.data.id,
    payment: payment.data as PaymentRow,
    providerReversalCents: refund.data.provider_reversal_cents,
  });
}

async function assertProvider(bookingId: string, ownerId: string) {
  const admin = createAdminClient();
  const booking = await admin.from("booking_requests").select("id, provider_id, status").eq("id", bookingId).maybeSingle();
  if (!booking.data) throw new Error("Booking not found.");
  const provider = await admin.from("providers").select("owner_id").eq("id", booking.data.provider_id).maybeSingle();
  if (provider.data?.owner_id !== ownerId) throw new Error("unauthorized");
  return booking.data;
}

export async function offerQuote(input: { bookingId: string; providerOwnerId: string; amountCents: number; note: string }) {
  const booking = await assertProvider(input.bookingId, input.providerOwnerId);
  if (booking.status !== "pending" && booking.status !== "accepted") {
    throw new Error("This booking cannot be quoted.");
  }
  const admin = createAdminClient();
  const collected = await admin
    .from("payments")
    .select("id")
    .eq("booking_id", input.bookingId)
    .in("status", ["succeeded", "partially_refunded", "refunded"]);
  if ((collected.data ?? []).length > 0) throw new Error("This booking already has a collected payment.");
  const quote = quoteServicePayment(input.amountCents, await readCommissionBps());
  const saved = await admin.from("booking_quotes").upsert(
    {
      booking_id: input.bookingId,
      amount_cents: quote.amountCents,
      note: input.note.slice(0, 500),
      status: "offered",
    },
    { onConflict: "booking_id" },
  );
  if (saved.error) throw new Error(saved.error.message);
  await admin.from("booking_payment_plans").upsert(
    { booking_id: input.bookingId, plan: "quote", agreed_amount_cents: quote.amountCents },
    { onConflict: "booking_id" },
  );
}

export async function proposeMilestones(input: {
  bookingId: string;
  providerOwnerId: string;
  parts: { label: string; amountCents: number }[];
}) {
  await assertProvider(input.bookingId, input.providerOwnerId);
  const admin = createAdminClient();
  const plan = await admin.from("booking_payment_plans").select("agreed_amount_cents").eq("booking_id", input.bookingId).maybeSingle();
  const milestones = validateMilestones(plan.data?.agreed_amount_cents ?? 0, input.parts);
  const existing = await admin.from("payments").select("id").eq("booking_id", input.bookingId);
  if ((existing.data ?? []).length > 0) throw new Error("Milestones cannot change after checkout starts.");
  await admin.from("booking_milestones").delete().eq("booking_id", input.bookingId);
  const inserted = await admin.from("booking_milestones").insert(
    milestones.map((part, index) => ({
      booking_id: input.bookingId,
      label: part.label,
      amount_cents: part.amountCents,
      position: index + 1,
    })),
  );
  if (inserted.error) throw new Error(inserted.error.message);
}

export async function payOutstanding(bookingId: string, customerId: string, email: string) {
  const admin = createAdminClient();
  const booking = await admin
    .from("booking_requests")
    .select("id, customer_id, provider_id, service_name")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking.data || booking.data.customer_id !== customerId) throw new Error("unauthorized");
  const payments = await admin.from("payments").select("id, status, milestone_id").eq("booking_id", bookingId);
  const rows = payments.data ?? [];
  if (rows.some((row) => row.status === "requires_payment" || row.status === "failed" || row.status === "canceled")) {
    return resumeCheckout(bookingId, customerId);
  }
  const milestones = await admin
    .from("booking_milestones")
    .select("id, label, amount_cents, position")
    .eq("booking_id", bookingId)
    .order("position", { ascending: true });
  const next = (milestones.data ?? []).find((milestone) => !rows.some((row) => row.milestone_id === milestone.id));
  if (next) {
    return startCheckout({
      bookingId,
      customerId,
      providerId: booking.data.provider_id,
      amountCents: next.amount_cents,
      serviceName: next.label,
      customerEmail: email,
      milestoneId: next.id,
    });
  }
  if (rows.length === 0) {
    const quote = await admin.from("booking_quotes").select("amount_cents, status").eq("booking_id", bookingId).maybeSingle();
    if (quote.data?.status === "offered" || quote.data?.status === "accepted") {
      if (quote.data.status === "offered") {
        await admin.from("booking_quotes").update({ status: "accepted" }).eq("booking_id", bookingId);
      }
      return startCheckout({
        bookingId,
        customerId,
        providerId: booking.data.provider_id,
        amountCents: quote.data.amount_cents,
        serviceName: booking.data.service_name || "Quoted service",
        customerEmail: email,
      });
    }
  }
  return null;
}
