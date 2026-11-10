import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyStripeFailure,
  concurrentRefundResults,
  attemptProviderTransfer,
  exceptionShownToAdmin,
  payoutIsPaid,
  payoutLabel,
  refundClaimDecision,
  type TransferAttemptPayment,
  refundIdempotencyKey,
  reversalIdempotencyKey,
  settleRefundAmounts,
  transferClaimDecision,
} from "../src/lib/payments/guards.ts";
import { applyStripeEvent, type PaymentSnapshot, type PaymentStore } from "../src/lib/payments/events.ts";
import { feeFromStripeCharge, nextStripeFeeCents, readChargeProcessingFee } from "../src/lib/payments/stripe-fee.ts";
import {
  connectedAccountReadiness,
  evaluateConnectChargePattern,
  isAccountRequirementsEvent,
  platformCheckoutIntent,
} from "../src/lib/payments/connect.ts";
import {
  assertCanManagePayments,
  assertTestStripeKey,
  resolveSiteUrl,
  bookingStatusAfterPayment,
  paymentStatusAfterFailure,
  nextRecordedTransferAmount,
  nextRecordedTransferReversal,
  quoteFromCatalog,
  quoteServicePayment,
  refundShares,
  shouldReverseTransfer,
  validateMilestones,
} from "../src/lib/payments/money.ts";

function payment(overrides: Partial<PaymentSnapshot> = {}): PaymentSnapshot {
  return {
    id: "pay_1",
    bookingId: "book_1",
    amountCents: 10_000,
    commissionCents: 800,
    providerShareCents: 9_200,
    status: "requires_payment",
    paymentIntentId: null,
    chargeId: null,
    transferId: null,
    refundedCents: 0,
    stripeFeeCents: null,
    transferReversedCents: null,
    ...overrides,
  };
}

function memoryStore(initial?: PaymentSnapshot): PaymentStore & {
  events: Map<string, string>;
  saved: PaymentSnapshot;
  ledger: string[];
} {
  const state = { saved: initial ?? payment() };
  const events = new Map<string, string>();
  const ledger: string[] = [];
  return {
    events,
    ledger,
    get saved() {
      return state.saved;
    },
    async claimEvent(event) {
      const existing = events.get(event.id);
      if (!existing) {
        events.set(event.id, "processing");
        return "process";
      }
      if (existing === "failed") {
        events.set(event.id, "processing");
        return "retry";
      }
      return "skip";
    },
    async finishEvent(id, status) {
      events.set(id, status);
    },
    async findPayment() {
      return state.saved;
    },
    async savePayment(patch) {
      const stripeFeeCents =
        "stripeFeeCents" in patch
          ? nextStripeFeeCents(state.saved.stripeFeeCents, patch.stripeFeeCents ?? null)
          : state.saved.stripeFeeCents;
      const transferReversedCents =
        "transferReversedCents" in patch
          ? nextRecordedTransferReversal(state.saved.transferReversedCents, patch.transferReversedCents ?? null)
          : state.saved.transferReversedCents;
      state.saved = { ...state.saved, ...patch, id: state.saved.id, stripeFeeCents, transferReversedCents };
    },
    async addLedger(entry) {
      ledger.push(entry.entryType);
    },
    async saveConnectedAccount() {},
    async markRefund() {},
  };
}

describe("service payment quotes", () => {
  it("keeps $8 of a $100 payment and assigns $92 to the provider", () => {
    const quote = quoteServicePayment(10_000, 800);
    assert.deepEqual(quote, {
      amountCents: 10_000,
      commissionBps: 800,
      commissionCents: 800,
      providerShareCents: 9_200,
      feeBearer: "platform",
    });
  });

  it("ignores an amount submitted by the browser", () => {
    assert.equal(quoteFromCatalog("$100.00", 1), 10_000);
    assert.equal(quoteFromCatalog(100, "1"), 10_000);
  });

  it("rejects a price that is not a fixed dollar amount", () => {
    assert.throws(() => quoteFromCatalog("from $100"), /fixed dollar price/);
  });
});

describe("refunds", () => {
  it("reverses both shares of a full $100 refund", () => {
    assert.deepEqual(
      refundShares({ refundCents: 10_000, amountCents: 10_000, providerShareCents: 9_200 }),
      { providerReversalCents: 9_200, commissionReversalCents: 800 },
    );
  });

  it("splits a partial refund in proportion and clears the remainder on the final refund", () => {
    const first = refundShares({ refundCents: 5_000, amountCents: 10_000, providerShareCents: 9_200 });
    assert.deepEqual(first, { providerReversalCents: 4_600, commissionReversalCents: 400 });
    const second = refundShares({
      refundCents: 5_000,
      amountCents: 10_000,
      providerShareCents: 9_200,
      alreadyRefundedCents: 5_000,
      alreadyProviderReversedCents: first.providerReversalCents,
    });
    assert.deepEqual(second, { providerReversalCents: 4_600, commissionReversalCents: 400 });
  });

  it("reverses a transfer only after Stripe confirms the refund and a transfer exists", () => {
    assert.equal(
      shouldReverseTransfer({
        refundStatus: "pending",
        transferId: "tr_1",
        providerReversalCents: 9_200,
        reversalStatus: null,
      }),
      false,
    );
    assert.equal(
      shouldReverseTransfer({
        refundStatus: "succeeded",
        transferId: null,
        providerReversalCents: 9_200,
        reversalStatus: null,
      }),
      false,
    );
    assert.equal(
      shouldReverseTransfer({
        refundStatus: "succeeded",
        transferId: "tr_1",
        providerReversalCents: 9_200,
        reversalStatus: null,
      }),
      true,
    );
  });
});

describe("webhook processing", () => {
  it("marks a matching checkout paid without completing the booking", () => {
    const store = memoryStore();
    return applyStripeEvent(
      {
        id: "evt_paid",
        type: "checkout.session.completed",
        livemode: false,
        object: {
          id: "cs_1",
          amount_total: 10_000,
          currency: "usd",
          payment_status: "paid",
          payment_intent: "pi_1",
          metadata: { payment_id: "pay_1" },
        },
      },
      store,
    ).then((result) => {
      assert.equal(result.status, "processed");
      assert.equal(store.saved?.status, "succeeded");
      assert.equal(bookingStatusAfterPayment("pending"), "pending");
      assert.deepEqual(store.ledger, ["payment_succeeded", "commission_earned"]);
    });
  });

  it("does not mark a mismatched checkout paid", async () => {
    const store = memoryStore();
    const result = await applyStripeEvent(
      {
        id: "evt_mismatch",
        type: "checkout.session.completed",
        livemode: false,
        object: {
          id: "cs_2",
          amount_total: 100,
          currency: "usd",
          payment_status: "paid",
          metadata: { payment_id: "pay_1" },
        },
      },
      store,
    );
    assert.equal(result.status, "processed");
    assert.equal(store.saved?.status, "requires_payment");
    assert.equal(store.ledger[0], "payment_mismatch");
  });

  it("skips a duplicate event and retries a failed one", async () => {
    const store = memoryStore();
    const event = {
      id: "evt_dup",
      type: "payment_intent.payment_failed",
      livemode: false,
      object: { id: "pi_1", object: "payment_intent", metadata: { payment_id: "pay_1" } },
    };
    await applyStripeEvent(event, store);
    const duplicate = await applyStripeEvent(event, store);
    assert.equal(duplicate.status, "duplicate");
    assert.equal(store.saved?.status, "failed");

    store.events.set("evt_dup", "failed");
    const retry = await applyStripeEvent(event, store);
    assert.equal(retry.status, "processed");
  });

  it("does not turn a collected payment into a failure", () => {
    assert.equal(paymentStatusAfterFailure("succeeded"), "succeeded");
    assert.equal(paymentStatusAfterFailure("requires_payment"), "failed");
  });

  it("ignores live-mode events", async () => {
    const store = memoryStore();
    const result = await applyStripeEvent(
      { id: "evt_live", type: "checkout.session.completed", livemode: true, object: {} },
      store,
    );
    assert.equal(result.status, "ignored");
    assert.equal(store.saved?.status, "requires_payment");
  });

  it("records a Stripe processing fee and does not replace it with a missing fee", async () => {
    const store = memoryStore();
    const paid = await applyStripeEvent(
      {
        id: "evt_fee_missing",
        type: "checkout.session.completed",
        livemode: false,
        object: {
          id: "cs_fee",
          amount_total: 10_000,
          currency: "usd",
          payment_status: "paid",
          payment_intent: "pi_fee",
          charge_id: "ch_fee",
          metadata: { payment_id: "pay_1" },
        },
      },
      store,
    );
    assert.equal(paid.status, "processed");
    assert.equal(store.saved.stripeFeeCents, null);

    const delayed = await applyStripeEvent(
      {
        id: "evt_fee_ready",
        type: "charge.updated",
        livemode: false,
        object: { id: "ch_fee", object: "charge", stripe_fee_cents: 175 },
      },
      store,
    );
    assert.equal(delayed.status, "processed");
    assert.equal(store.saved.stripeFeeCents, 175);

    const duplicate = await applyStripeEvent(
      {
        id: "evt_fee_ready",
        type: "charge.updated",
        livemode: false,
        object: { id: "ch_fee", object: "charge", stripe_fee_cents: 175 },
      },
      store,
    );
    assert.equal(duplicate.status, "duplicate");

    const blank = await applyStripeEvent(
      {
        id: "evt_fee_blank",
        type: "charge.updated",
        livemode: false,
        object: { id: "ch_fee", object: "charge" },
      },
      store,
    );
    assert.equal(blank.status, "processed");
    assert.equal(store.saved.stripeFeeCents, 175);
    assert.equal(store.saved.status, "succeeded");
  });

  it("reads the fee from a balance transaction and waits when Stripe has not posted one", async () => {
    assert.equal(feeFromStripeCharge({ balance_transaction: "txn_1" }), null);
    assert.equal(feeFromStripeCharge({ livemode: true, balance_transaction: { fee: 175 } }), null);
    assert.equal(feeFromStripeCharge({ balance_transaction: { fee: 175 } }), 175);
    assert.equal(nextStripeFeeCents(175, null), 175);
    assert.equal(nextStripeFeeCents(null, 180), 180);
    let calls = 0;
    const delayed = await readChargeProcessingFee(async () => {
      calls += 1;
      return calls === 1 ? { balance_transaction: "txn_1" } : { balance_transaction: { fee: 205 } };
    }, "ch_1");
    assert.equal(delayed, null);
    const ready = await readChargeProcessingFee(async () => ({ balance_transaction: { fee: 205 } }), "ch_1");
    assert.equal(ready, 205);
  });

  it("records a confirmed transfer reversal and does not replace it with a blank event", async () => {
    const store = memoryStore(payment({ status: "succeeded", providerShareCents: 4_600, transferId: "tr_1" }));
    const partial = await applyStripeEvent(
      {
        id: "evt_reversal",
        type: "transfer.reversed",
        livemode: false,
        object: { id: "tr_1", source_transaction: "ch_1", amount_reversed: 1_840 },
      },
      store,
    );
    assert.equal(partial.status, "processed");
    assert.equal(store.saved.transferStatus, "partially_reversed");
    assert.equal(store.saved.transferReversedCents, 1_840);
    const blank = await applyStripeEvent(
      {
        id: "evt_reversal_blank",
        type: "transfer.reversed",
        livemode: false,
        object: { id: "tr_1", source_transaction: "ch_1" },
      },
      store,
    );
    assert.equal(blank.status, "processed");
    assert.equal(store.saved.transferReversedCents, 1_840);
  });
});

describe("milestones", () => {
  it("accepts parts that add up to the agreed price and ignores a client total", () => {
    const catalog = quoteFromCatalog("$100.00", 1);
    const parts = validateMilestones(catalog, [
      { label: "Visit", amountCents: 4000 },
      { label: "Finish", amountCents: 6000 },
    ]);
    assert.deepEqual(
      parts.map((part) => part.amountCents),
      [4000, 6000],
    );
    assert.throws(() => validateMilestones(catalog, [{ label: "Only one", amountCents: catalog }]), /2 to 6/);
    assert.throws(
      () =>
        validateMilestones(catalog, [
          { label: "Visit", amountCents: 4000 },
          { label: "Finish", amountCents: 5000 },
        ]),
      /add up/,
    );
  });
});

describe("connect charge pattern", () => {
  it("keeps the provider share on the platform until verified completion", () => {
    const decision = evaluateConnectChargePattern();
    assert.equal(decision.pattern, "separate_charges_and_transfers");
    assert.equal(decision.applicationFee, false);
    assert.equal(decision.refundLiability, "platform");
    assert.equal(decision.disputeLiability, "platform");
    assert.equal(decision.payoutTiming, "after_verified_completion");
    const intent = platformCheckoutIntent("book_1", "pay_1");
    assert.equal(intent.transfer_group, "book_1");
    assert.equal("application_fee_amount" in intent, false);
    assert.equal("transfer_data" in intent, false);
  });

  it("treats an active recipient transfer capability as ready to be paid", () => {
    const ready = connectedAccountReadiness({
      configuration: {
        recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: "active" } } } },
      },
      requirements: { summary: { minimum_deadline: { status: "eventually_due" } } },
    });
    assert.equal(ready.readyToReceivePayments, true);
    assert.equal(ready.onboardingComplete, true);
    const due = connectedAccountReadiness({
      requirements: { summary: { minimum_deadline: { status: "currently_due" } } },
    });
    assert.equal(due.readyToReceivePayments, false);
    assert.equal(due.onboardingComplete, false);
    assert.equal(isAccountRequirementsEvent("v2.core.account[requirements].updated"), true);
    assert.equal(isAccountRequirementsEvent("checkout.session.completed"), false);
  });
});

describe("transfer and refund guards", () => {
  it("keeps a rejected transfer failed and does not label it paid", () => {
    const rejected = transferClaimDecision({
      paymentId: "pay_1",
      transferId: null,
      transferStatus: "failed",
      attempt: 1,
    });
    assert.equal(rejected.action, "claim");
    assert.equal(classifyStripeFailure({ type: "StripeInvalidRequestError", statusCode: 400 }), "rejected");
    assert.equal(payoutLabel("failed"), "payout failed");
    assert.notEqual(payoutLabel("failed"), "payout paid");
    assert.equal(payoutLabel("paid"), "payout paid");
  });

  it("replays an uncertain transfer with the same idempotency key", () => {
    const first = transferClaimDecision({
      paymentId: "pay_1",
      transferId: null,
      transferStatus: "not_ready",
      attempt: 0,
    });
    assert.equal(first.action, "claim");
    const replay = transferClaimDecision({
      paymentId: "pay_1",
      transferId: null,
      transferStatus: "pending",
      attempt: first.action === "claim" ? first.attempt : 0,
    });
    assert.equal(replay.action, "replay");
    assert.equal(first.action === "claim" && replay.action === "replay" && first.idempotencyKey === replay.idempotencyKey, true);
    assert.equal(classifyStripeFailure({ type: "StripeConnectionError", message: "timeout" }), "uncertain");
    assert.equal(payoutLabel("pending"), "payout pending confirmation");
    const done = transferClaimDecision({
      paymentId: "pay_1",
      transferId: "tr_123",
      transferStatus: "paid",
      attempt: 1,
    });
    assert.equal(done.action, "skip");
  });

  it("lets only one simultaneous refund proceed and blocks a second full refund", () => {
    const results = concurrentRefundResults({
      amountCents: 10_000,
      providerShareCents: 9_200,
      refundedCents: 0,
      requests: [10_000, 10_000],
      shares: (refundCents, alreadyRefundedCents) => {
        refundShares({
          refundCents,
          amountCents: 10_000,
          providerShareCents: 9_200,
          alreadyRefundedCents,
        });
      },
    });
    assert.deepEqual(
      results.map((result) => result.accepted),
      [true, false],
    );
    assert.equal(results[1] && "reason" in results[1] ? results[1].reason : "", "pending");
    assert.throws(
      () =>
        refundShares({
          refundCents: 10_000,
          amountCents: 10_000,
          providerShareCents: 9_200,
          alreadyRefundedCents: 10_000,
        }),
      /remaining balance/,
    );
  });

  it("reuses one refund and one reversal key after an uncertain Stripe response", () => {
    const open = refundClaimDecision({ openRefundId: "re_row_1" });
    assert.equal(open.action, "replay");
    assert.equal(open.action === "replay" ? open.idempotencyKey : "", refundIdempotencyKey("re_row_1"));
    assert.equal(reversalIdempotencyKey("re_row_1"), reversalIdempotencyKey("re_row_1"));
    assert.notEqual(reversalIdempotencyKey("re_row_1"), reversalIdempotencyKey("re_row_2"));
    const first = settleRefundAmounts({
      priorStatus: "pending",
      stripeStatus: "succeeded",
      refundedCents: 0,
      refundCents: 5_000,
      amountCents: 10_000,
    });
    const repeat = settleRefundAmounts({
      priorStatus: "succeeded",
      stripeStatus: "succeeded",
      refundedCents: first.refundedCents,
      refundCents: 5_000,
      amountCents: 10_000,
    });
    assert.equal(first.countRefund, true);
    assert.equal(repeat.countRefund, false);
    assert.equal(repeat.refundedCents, 5_000);
    assert.equal(classifyStripeFailure({ statusCode: 504, message: "timeout" }), "uncertain");
  });
});

describe("mocked Stripe transfers", () => {
  function stripeError(type: string, message: string, statusCode?: number) {
    const error = new Error(message) as Error & { type: string; statusCode?: number };
    error.type = type;
    error.statusCode = statusCode;
    return error;
  }

  function payment(overrides: Partial<TransferAttemptPayment> = {}): TransferAttemptPayment {
    return {
      id: "pay_1",
      transferId: null,
      transferStatus: "not_ready",
      transferAttempt: 0,
      chargeId: "ch_1",
      ...overrides,
    };
  }

  function mockStripe(mode: "reject" | "timeout" | "lose" | "succeed") {
    const transfers = new Map<string, { id: string }>();
    let sequence = 0;
    return {
      transfers,
      async create(idempotencyKey: string) {
        const existing = transfers.get(idempotencyKey);
        if (existing) return existing;
        if (mode === "reject") throw stripeError("StripeInvalidRequestError", "Account cannot receive transfers", 400);
        if (mode === "timeout") throw stripeError("StripeConnectionError", "timeout");
        sequence += 1;
        const created = { id: `tr_${sequence}` };
        transfers.set(idempotencyKey, created);
        if (mode === "lose") throw stripeError("StripeConnectionError", "response lost after Stripe created the transfer");
        return created;
      },
    };
  }

  function runner(row: TransferAttemptPayment, stripe: ReturnType<typeof mockStripe>, amount = 9_200) {
    const ledger: { entryType: string; amountCents: number; note: string; stripeObjectId?: string | null }[] = [];
    let recordedAmount: number | null = null;
    return {
      ledger,
      recordedAmount: () => recordedAmount,
      run: () =>
        attemptProviderTransfer({
          payment: row,
          bookingId: "book_1",
          amount,
          destination: async () => ({ accountId: "acct_test", eligible: true }),
          claim: async (attempt) => {
            if (row.transferId || (row.transferStatus !== "not_ready" && row.transferStatus !== "failed")) {
              return { ok: false as const };
            }
            row.transferStatus = "pending";
            row.transferAttempt = attempt;
            return { ok: true as const, attempt };
          },
          mark: async (patch) => {
            if (row.transferId) return false;
            row.transferStatus = patch.transferStatus;
            if (patch.transferId) row.transferId = patch.transferId;
            recordedAmount = patch.transferAmountCents ?? null;
            return true;
          },
          ledger: async (entry) => {
            ledger.push(entry);
          },
          createTransfer: (request) => stripe.create(request.idempotencyKey),
        }),
    };
  }

  it("records a rejected transfer as failed and shows it in admin exceptions", async () => {
    const row = payment();
    const stripe = mockStripe("reject");
    const harness = runner(row, stripe);
    const status = await harness.run();
    assert.equal(status, "failed");
    assert.equal(row.transferStatus, "failed");
    assert.equal(row.transferId, null);
    assert.equal(stripe.transfers.size, 0);
    assert.equal(payoutLabel(row.transferStatus), "payout failed");
    assert.equal(payoutIsPaid(row.transferStatus), false);
    assert.equal(harness.ledger.some((entry) => entry.entryType === "transfer_failed"), true);
    assert.equal(exceptionShownToAdmin("transfer_failed"), true);
    assert.equal(exceptionShownToAdmin("transfer_created"), false);
  });

  it("keeps a timed-out transfer pending instead of failed", async () => {
    const row = payment();
    const stripe = mockStripe("timeout");
    const harness = runner(row, stripe);
    const status = await harness.run();
    assert.equal(status, "uncertain");
    assert.equal(row.transferStatus, "pending");
    assert.notEqual(row.transferStatus, "failed");
    assert.equal(row.transferId, null);
    assert.equal(payoutLabel(row.transferStatus), "payout pending confirmation");
    assert.equal(payoutIsPaid(row.transferStatus), false);
    assert.equal(harness.ledger.some((entry) => entry.entryType === "transfer_uncertain"), true);
    assert.equal(exceptionShownToAdmin("transfer_uncertain"), true);
    assert.equal(harness.ledger.some((entry) => entry.entryType === "transfer_failed"), false);
  });

  it("lets an admin retry a failed transfer once", async () => {
    const row = payment({ transferStatus: "failed", transferAttempt: 1 });
    const stripe = mockStripe("succeed");
    const harness = runner(row, stripe);
    const status = await harness.run();
    assert.equal(status, "transferred");
    assert.equal(row.transferId, "tr_1");
    assert.equal(row.transferStatus, "paid");
    assert.equal(stripe.transfers.size, 1);
    assert.equal(harness.recordedAmount(), 9_200);
    assert.equal(nextRecordedTransferAmount(9_200, 1_000), 9_200);
    assert.equal(payoutLabel(row.transferStatus), "payout paid");
    const again = await harness.run();
    assert.equal(again, "already_transferred");
    assert.equal(stripe.transfers.size, 1);
    assert.equal(row.transferId, "tr_1");
  });

  it("stores the reduced amount when a transfer follows a partial refund", async () => {
    const row = payment();
    const stripe = mockStripe("succeed");
    const harness = runner(row, stripe, 2_760);
    const status = await harness.run();
    assert.equal(status, "transferred");
    assert.equal(harness.recordedAmount(), 2_760);
    assert.notEqual(harness.recordedAmount(), 4_600);
    assert.equal(stripe.transfers.size, 1);
  });

  it("does not create a second transfer when the same retry is submitted twice", async () => {
    const row = payment({ transferStatus: "failed", transferAttempt: 1 });
    const stripe = mockStripe("succeed");
    const ledger: { entryType: string }[] = [];
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let claims = 0;
    const run = () =>
      attemptProviderTransfer({
        payment: row,
        bookingId: "book_1",
        amount: 9_200,
        destination: async () => ({ accountId: "acct_test", eligible: true }),
        claim: async (attempt) => {
          claims += 1;
          if (claims === 1) await gate;
          if (row.transferId || (row.transferStatus !== "not_ready" && row.transferStatus !== "failed")) {
            return { ok: false as const };
          }
          row.transferStatus = "pending";
          row.transferAttempt = attempt;
          return { ok: true as const, attempt };
        },
        mark: async (patch) => {
          if (row.transferId) return false;
          row.transferStatus = patch.transferStatus;
          if (patch.transferId) row.transferId = patch.transferId;
          return true;
        },
        ledger: async (entry) => {
          ledger.push(entry);
        },
        createTransfer: (request) => stripe.create(request.idempotencyKey),
      });
    const pending = Promise.all([run(), run()]);
    await Promise.resolve();
    releaseGate();
    const outcomes = (await pending).slice().sort();
    assert.deepEqual(outcomes, ["in_progress", "transferred"]);
    assert.equal(stripe.transfers.size, 1);
    assert.equal(row.transferId, "tr_1");
    assert.equal(row.transferStatus, "paid");
    assert.equal(ledger.filter((entry) => entry.entryType === "transfer_created").length, 1);
  });

  it("recovers the one transfer Stripe created when the response was lost", async () => {
    const row = payment();
    const stripe = mockStripe("lose");
    const harness = runner(row, stripe);
    const lost = await harness.run();
    assert.equal(lost, "uncertain");
    assert.equal(row.transferStatus, "pending");
    assert.notEqual(row.transferStatus, "failed");
    assert.equal(row.transferId, null);
    assert.equal(stripe.transfers.size, 1);
    assert.equal(exceptionShownToAdmin(harness.ledger[0]?.entryType ?? ""), true);
    assert.equal(harness.ledger[0]?.entryType, "transfer_uncertain");
    const recovered = await harness.run();
    assert.equal(recovered, "transferred");
    assert.equal(row.transferId, "tr_1");
    assert.equal(stripe.transfers.size, 1);
    assert.equal(payoutLabel(row.transferStatus), "payout paid");
    const third = await harness.run();
    assert.equal(third, "already_transferred");
    assert.equal(stripe.transfers.size, 1);
  });
});

describe("access", () => {
  it("rejects payment-management access for every role, including an administrator", () => {
    assert.equal(assertCanManagePayments("customer").ok, false);
    assert.equal(assertCanManagePayments("provider").ok, false);
    assert.equal(assertCanManagePayments("admin").ok, false);
  });

  it("keeps a deployed site off localhost", () => {
    assert.equal(resolveSiteUrl("http://localhost:3000", "development"), "http://localhost:3000");
    assert.equal(resolveSiteUrl("https://blockbooked.vercel.app", "production"), "https://blockbooked.vercel.app");
    assert.throws(() => resolveSiteUrl("http://localhost:3000", "production"), /deployed https URL/);
    assert.throws(() => resolveSiteUrl(undefined, "production"), /deployed https URL/);
  });

  it("rejects a live Stripe secret", () => {
    assert.throws(() => assertTestStripeKey("sk_live_example"), /test mode/);
    assert.doesNotThrow(() => assertTestStripeKey("sk_test_example"));
  });
});
