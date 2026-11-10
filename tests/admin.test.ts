import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { canAccessAdminCenter } from "../src/lib/admin/access.ts";
import { filterAdminBookings } from "../src/lib/admin/records.ts";
import { RetiredAdminActionError, invokeRetiredAdminAction, retiredAdminActions } from "../src/lib/admin/retired-actions.ts";
import { backfillSandboxProcessingFees, reconciliationAllowed } from "../src/lib/admin/fee-reconciliation.ts";
import { readAllPages } from "../src/lib/admin/read-all.ts";
import { providerTransferLabel, stripeFeeLabel, summarizeAdminMoney, type AdminPaymentSnapshot } from "../src/lib/admin/summary.ts";
import {
  planTransferAmountReads,
  reconcileSandboxTransfers,
  recordedTransferAmountFromStripe,
  type RetrievedTransfer,
  type StoredTransferPayment,
} from "../src/lib/admin/transfer-reconciliation.ts";
import { canChangeBookingStatus } from "../src/lib/booking-status.ts";
import { refundActorAllowed } from "../src/lib/payments/guards.ts";

const layout = readFileSync(new URL("../src/app/admin/layout.tsx", import.meta.url), "utf8");
const overview = readFileSync(new URL("../src/app/admin/page.tsx", import.meta.url), "utf8");
const feeAction = readFileSync(new URL("../src/app/actions/admin-fees.ts", import.meta.url), "utf8");
const feeRunner = readFileSync(new URL("../src/lib/admin/run-fee-backfill.ts", import.meta.url), "utf8");
const transferRunner = readFileSync(new URL("../src/lib/admin/run-transfer-reconciliation.ts", import.meta.url), "utf8");
const transferAction = readFileSync(new URL("../src/app/actions/admin-transfers.ts", import.meta.url), "utf8");
const reviews = readFileSync(new URL("../src/app/admin/reviews/page.tsx", import.meta.url), "utf8");
const bookingsPage = readFileSync(new URL("../src/app/admin/bookings/page.tsx", import.meta.url), "utf8");
const providersPage = readFileSync(new URL("../src/app/admin/providers/page.tsx", import.meta.url), "utf8");
const providers = readFileSync(new URL("../src/app/actions/providers.ts", import.meta.url), "utf8");
const bookingActions = readFileSync(new URL("../src/app/actions/bookings.ts", import.meta.url), "utf8");
const paymentActions = readFileSync(new URL("../src/app/actions/payments.ts", import.meta.url), "utf8");
const completionGuard = readFileSync(
  new URL("../supabase/migrations/20261110300000_reject_unverified_completion.sql", import.meta.url),
  "utf8",
);

function actionBody(source: string, name: string) {
  const match = source.match(new RegExp(`export async function ${name}[\\s\\S]*?\\n\\}`));
  assert.ok(match, `${name} is missing`);
  return match[0];
}

describe("admin access", () => {
  it("allows only an administrator", () => {
    assert.equal(canAccessAdminCenter("admin"), true);
    assert.equal(canAccessAdminCenter("customer"), false);
    assert.equal(canAccessAdminCenter("provider"), false);
    assert.equal(canAccessAdminCenter(null), false);
  });

  it("checks the administrator role on the server before rendering admin pages", () => {
    assert.match(layout, /requireAdmin\(/);
    assert.match(overview, /requireAdmin\(/);
    assert.match(bookingsPage, /requireAdmin\(/);
    assert.match(providersPage, /requireAdmin\(/);
    assert.match(reviews, /requireAdmin\(/);
    assert.match(providers, /session\.profile\.role !== "admin"/);
    assert.equal(reviews.includes("resolveCompletionReview"), false);
    assert.equal(reviews.includes("releaseProviderTransfer"), false);
    assert.equal(layout.includes("SUPABASE_SERVICE_ROLE_KEY"), false);
  });
});

describe("admin money", () => {
  it("keeps gross customer payments separate from commission, fees, refunds, and transfers", () => {
    const summary = summarizeAdminMoney(
      [
        {
          status: "succeeded",
          amountCents: 5000,
          commissionCents: 400,
          providerShareCents: 4600,
          refundedCents: 0,
          stripeFeeCents: 175,
          transferStatus: "paid",
          transferId: "tr_full",
          transferAmountCents: 4600,
        },
      ],
      [],
    );
    assert.equal(summary.grossCustomerPaymentsCents, 5000);
    assert.equal(summary.recordedCommissionCents, 400);
    assert.equal(summary.grossCommissionCents, 400);
    assert.equal(summary.stripeFeesCents, 175);
    assert.equal(summary.contributionMarginCents, 225);
    assert.notEqual(summary.contributionMarginCents, summary.grossCommissionCents);
    assert.equal(summary.providerTransfersCents, 4600);
    assert.notEqual(summary.recordedCommissionCents, summary.grossCustomerPaymentsCents);
  });

  it("reduces recorded commission by a succeeded refund and does not treat a missing fee as profit", () => {
    const summary = summarizeAdminMoney(
      [
        {
          status: "refunded",
          amountCents: 5000,
          commissionCents: 400,
          providerShareCents: 4600,
          refundedCents: 5000,
          stripeFeeCents: null,
          transferStatus: "not_ready",
        },
      ],
      [{ status: "succeeded", amountCents: 5000, commissionReversalCents: 400, providerReversalCents: 4600 }],
    );
    assert.equal(summary.grossCustomerPaymentsCents, 5000);
    assert.equal(summary.refundsCents, 5000);
    assert.equal(summary.recordedCommissionCents, 0);
    assert.equal(summary.grossCommissionCents, 400);
    assert.equal(summary.commissionReductionCents, 400);
    assert.equal(summary.netCommissionCents, 0);
    assert.equal(summary.stripeFeesComplete, false);
    assert.equal(summary.contributionMarginCents, null);
    assert.equal(summary.providerTransfersCents, 0);
    assert.equal(summary.transferReversalsCents, 0);
    assert.match(stripeFeeLabel(summary, (cents) => `$${cents}`), /recorded on 0 of 1/);
  });

  it("counts a reversed transfer as sent and excludes a refund that never transferred", () => {
    const summary = summarizeAdminMoney(
      [
        payment({ transferStatus: "paid", transferId: "tr_paid", transferAmountCents: 4600 }),
        payment({
          status: "refunded",
          refundedCents: 5000,
          transferStatus: "reversed",
          transferId: "tr_full",
          transferAmountCents: 4600,
        }),
        payment({
          status: "partially_refunded",
          refundedCents: 2000,
          transferStatus: "partially_reversed",
          transferId: "tr_partial",
          transferAmountCents: 4600,
        }),
        payment({ status: "refunded", refundedCents: 5000, transferStatus: "reversed", transferId: null }),
        payment({ transferStatus: "not_ready", transferId: null }),
      ],
      [
        refund({ providerReversalCents: 4600, commissionReversalCents: 400, reversalStatus: "succeeded" }),
        refund({
          amountCents: 2000,
          providerReversalCents: 1840,
          commissionReversalCents: 160,
          reversalStatus: "succeeded",
        }),
        refund({ providerReversalCents: 4600, commissionReversalCents: 400, reversalStatus: "not_required" }),
      ],
    );
    assert.equal(summary.providerTransfersCents, 13_800);
    assert.equal(summary.transferReversalsCents, 6440);
    assert.equal(summary.netProviderTransfersCents, 7360);
    assert.equal(summary.grossCommissionCents, 2000);
    assert.equal(summary.commissionReductionCents, 960);
    assert.equal(summary.netCommissionCents, 1040);
    assert.equal(summary.contributionMarginCents, null);
  });

  it("sums financial totals past 1,000 payments", async () => {
    const payments = Array.from({ length: 1001 }, (_, index) =>
        payment({
        transferStatus: "paid",
        transferId: `tr_${index}`,
        transferAmountCents: 4600,
        stripeFeeCents: 30,
      }),
    );
    const summary = summarizeAdminMoney(payments, []);
    assert.equal(summary.collectedCount, 1001);
    assert.equal(summary.grossCustomerPaymentsCents, 5_005_000);
    assert.equal(summary.stripeFeesCents, 30_030);
    assert.equal(summary.providerTransfersCents, 4_604_600);
    assert.equal(summary.contributionMarginCents, 400 * 1001 - 30_030);

    const rows = payments.map((row, index) => ({ id: String(index), amountCents: row.amountCents }));
    const read = await readAllPages(async (from, to) => ({ data: rows.slice(from, to + 1), error: null }), 1000);
    assert.equal(read.truncated, false);
    assert.equal(read.rows.length, 1001);
    assert.equal(
      read.rows.reduce((sum, row) => sum + row.amountCents, 0),
      summary.grossCustomerPaymentsCents,
    );
    const repeated = await readAllPages(async () => ({ data: rows.slice(0, 1000), error: null }), 1000);
    assert.equal(repeated.truncated, true);
    assert.equal(repeated.rows.length, 0);
  });
});

function payment(overrides: Partial<AdminPaymentSnapshot> = {}): AdminPaymentSnapshot {
  return {
    status: "succeeded",
    amountCents: 5000,
    commissionCents: 400,
    providerShareCents: 4600,
    refundedCents: 0,
    stripeFeeCents: null,
    transferStatus: "not_ready",
    transferId: null,
    transferAmountCents: null,
    ...overrides,
  };
}

function refund(overrides: {
  paymentId?: string;
  amountCents?: number;
  providerReversalCents: number;
  commissionReversalCents: number;
  reversalStatus: string;
}) {
  return {
    status: "succeeded",
    paymentId: overrides.paymentId ?? null,
    amountCents: overrides.amountCents ?? 5000,
    commissionReversalCents: overrides.commissionReversalCents,
    providerReversalCents: overrides.providerReversalCents,
    reversalStatus: overrides.reversalStatus,
  };
}

describe("recorded transfer amounts", () => {
  it("uses the actual transfer amount, including a reduced transfer and both reversal kinds", () => {
    const summary = summarizeAdminMoney(
      [
        payment({ id: "full", transferStatus: "paid", transferId: "tr_full", transferAmountCents: 4600 }),
        payment({
          id: "reduced",
          status: "partially_refunded",
          refundedCents: 2000,
          transferStatus: "paid",
          transferId: "tr_reduced",
          transferAmountCents: 2760,
        }),
        payment({
          id: "partial",
          status: "partially_refunded",
          refundedCents: 2000,
          transferStatus: "partially_reversed",
          transferId: "tr_partial",
          transferAmountCents: 4600,
          transferReversedCents: 1840,
        }),
        payment({
          id: "reversed",
          status: "refunded",
          refundedCents: 5000,
          transferStatus: "reversed",
          transferId: "tr_reversed",
          transferAmountCents: 4600,
          transferReversedCents: 4600,
        }),
        payment({ id: "none", status: "refunded", refundedCents: 5000, transferStatus: "not_ready" }),
      ],
      [
        refund({ paymentId: "partial", amountCents: 2000, providerReversalCents: 1840, commissionReversalCents: 160, reversalStatus: "succeeded" }),
        refund({ paymentId: "reversed", providerReversalCents: 4600, commissionReversalCents: 400, reversalStatus: "succeeded" }),
        refund({ paymentId: "none", providerReversalCents: 4600, commissionReversalCents: 400, reversalStatus: "not_required" }),
      ],
    );
    assert.equal(summary.providerTransfersCents, 16_560);
    assert.equal(summary.transferReversalsCents, 6_440);
    assert.equal(summary.netProviderTransfersCents, 10_120);
    assert.notEqual(summary.providerTransfersCents, 4600 * 4);
  });

  it("does not treat a missing historical transfer amount as 92 percent", () => {
    const legacy = payment({
      id: "legacy",
      transferStatus: "paid",
      transferId: "tr_legacy",
      transferAmountCents: null,
    });
    const summary = summarizeAdminMoney([legacy], []);
    assert.equal(summary.providerTransfersCents, 0);
    assert.equal(summary.providerTransfersComplete, false);
    assert.equal(summary.netProviderTransfersCents, null);
    assert.match(providerTransferLabel(summary, (cents) => `$${cents}`), /recorded on 0 of 1/);
    assert.deepEqual(planTransferAmountReads([legacy, payment({ id: "known", transferId: "tr_known", transferAmountCents: 2760, transferStatus: "paid" })]), [
      { paymentId: "legacy", transferId: "tr_legacy" },
    ]);
    assert.equal(recordedTransferAmountFromStripe(null, 2760), 2760);
    assert.equal(recordedTransferAmountFromStripe(4600, 100), 4600);
    assert.equal(recordedTransferAmountFromStripe(null, null), null);
  });
});

function storedTransfer(overrides: Partial<StoredTransferPayment> = {}): StoredTransferPayment {
  return {
    id: "pay_1",
    transferId: "tr_1",
    chargeId: "ch_1",
    transferAmountCents: null,
    transferReversedCents: null,
    ...overrides,
  };
}

function retrievedTransfer(overrides: Partial<RetrievedTransfer> = {}): RetrievedTransfer {
  return {
    id: "tr_1",
    livemode: false,
    amount: 2760,
    amountReversed: 0,
    currency: "usd",
    metadataPaymentId: "pay_1",
    sourceTransactionId: "ch_1",
    destinationId: "acct_provider",
    ...overrides,
  };
}

describe("sandbox transfer reconciliation", () => {
  it("refuses a non-admin and a live key before reading Stripe", async () => {
    let reads = 0;
    const readTransfer = async () => {
      reads += 1;
      return retrievedTransfer();
    };
    const customer = await reconcileSandboxTransfers({
      role: "customer",
      stripeKey: "sk_test_example",
      platformAccountId: "acct_platform",
      payments: [storedTransfer()],
      readTransfer,
      saveTransfer: async () => ({ amountWritten: true, reversalWritten: true }),
    });
    const live = await reconcileSandboxTransfers({
      role: "admin",
      stripeKey: "sk_live_example",
      platformAccountId: "acct_platform",
      payments: [storedTransfer()],
      readTransfer,
      saveTransfer: async () => ({ amountWritten: true, reversalWritten: true }),
    });
    assert.equal(customer.ok, false);
    assert.equal(live.ok, false);
    assert.equal(reads, 0);
    assert.match(transferAction, /canAccessAdminCenter/);
    assert.equal(transferRunner.includes("transfers.create"), false);
    assert.equal(transferRunner.includes("refunds.create"), false);
    assert.equal(transferRunner.includes("charges.create"), false);
    assert.equal(transferRunner.includes("createReversal"), false);
  });

  it("rejects a missing transfer and a transfer that does not belong to the payment", async () => {
    const writes: string[] = [];
    const missing = await reconcileSandboxTransfers({
      role: "admin",
      stripeKey: "sk_test_example",
      platformAccountId: "acct_platform",
      payments: [storedTransfer()],
      readTransfer: async () => null,
      saveTransfer: async (paymentId) => {
        writes.push(paymentId);
        return { amountWritten: true, reversalWritten: false };
      },
    });
    const mismatched = await reconcileSandboxTransfers({
      role: "admin",
      stripeKey: "sk_test_example",
      platformAccountId: "acct_platform",
      payments: [
        storedTransfer(),
        storedTransfer({ id: "pay_2", transferId: "tr_2" }),
        storedTransfer({ id: "pay_3", transferId: "tr_3", chargeId: "ch_3" }),
      ],
      readTransfer: async (transferId) => {
        if (transferId === "tr_1") return retrievedTransfer({ id: "tr_other" });
        if (transferId === "tr_2") {
          return retrievedTransfer({ id: "tr_2", metadataPaymentId: "pay_other", sourceTransactionId: "ch_other" });
        }
        return retrievedTransfer({
          id: "tr_3",
          metadataPaymentId: "pay_3",
          sourceTransactionId: "ch_3",
          destinationId: "acct_platform",
        });
      },
      saveTransfer: async (paymentId) => {
        writes.push(paymentId);
        return { amountWritten: true, reversalWritten: false };
      },
    });
    assert.equal(missing.ok, true);
    if (missing.ok) assert.equal(missing.failed, 1);
    assert.equal(mismatched.ok, true);
    if (mismatched.ok) assert.equal(mismatched.failed, 3);
    assert.deepEqual(writes, []);
  });

  it("records partial and full reversals without using the provider share, and a retry does not lower them", async () => {
    const rows = [
      storedTransfer({ id: "pay_partial", transferId: "tr_partial", chargeId: "ch_partial" }),
      storedTransfer({ id: "pay_full", transferId: "tr_full", chargeId: "ch_full" }),
      storedTransfer({ id: "pay_reduced", transferId: "tr_reduced", chargeId: "ch_reduced" }),
    ];
    const readTransfer = async (transferId: string) => {
      if (transferId === "tr_partial") {
        return retrievedTransfer({
          id: "tr_partial",
          metadataPaymentId: "pay_partial",
          sourceTransactionId: "ch_partial",
          amount: 4600,
          amountReversed: 1840,
        });
      }
      if (transferId === "tr_reduced") {
        return retrievedTransfer({
          id: "tr_reduced",
          metadataPaymentId: "pay_reduced",
          sourceTransactionId: "ch_reduced",
          amount: 2760,
          amountReversed: 0,
        });
      }
      return retrievedTransfer({
        id: "tr_full",
        metadataPaymentId: "pay_full",
        sourceTransactionId: "ch_full",
        amount: 4600,
        amountReversed: 4600,
      });
    };
    const save = async (paymentId: string, update: { amountCents: number | null; reversalCents: number | null }) => {
      const row = rows.find((item) => item.id === paymentId);
      if (!row) return { amountWritten: false, reversalWritten: false };
      let amountWritten = false;
      let reversalWritten = false;
      if (update.amountCents != null && row.transferAmountCents == null) {
        row.transferAmountCents = update.amountCents;
        amountWritten = true;
      }
      if (
        update.reversalCents != null &&
        (row.transferReversedCents == null || update.reversalCents > row.transferReversedCents)
      ) {
        row.transferReversedCents = update.reversalCents;
        reversalWritten = true;
      }
      return { amountWritten, reversalWritten };
    };
    const first = await reconcileSandboxTransfers({
      role: "admin",
      stripeKey: "sk_test_example",
      platformAccountId: "acct_platform",
      payments: rows.map((row) => ({ ...row })),
      readTransfer,
      saveTransfer: save,
    });
    assert.equal(first.ok, true);
    if (first.ok) assert.equal(first.reconciled, 3);
    assert.equal(rows[0]?.transferAmountCents, 4600);
    assert.equal(rows[0]?.transferReversedCents, 1840);
    assert.equal(rows[1]?.transferReversedCents, 4600);
    assert.equal(rows[2]?.transferAmountCents, 2760);
    assert.notEqual(rows[2]?.transferAmountCents, 4600);

    const second = await reconcileSandboxTransfers({
      role: "admin",
      stripeKey: "sk_test_example",
      platformAccountId: "acct_platform",
      payments: rows.map((row) => ({ ...row })),
      readTransfer: async (transferId) => {
        const transfer = await readTransfer(transferId);
        return transfer ? { ...transfer, amountReversed: 0 } : null;
      },
      saveTransfer: save,
    });
    assert.equal(second.ok, true);
    if (second.ok) {
      assert.equal(second.reconciled, 0);
      assert.equal(second.skipped, 3);
    }
    assert.equal(rows[0]?.transferReversedCents, 1840);
    assert.equal(rows[1]?.transferReversedCents, 4600);
    assert.notEqual(rows[0]?.transferAmountCents, 9200);
  });
});

describe("sandbox fee reconciliation", () => {
  it("refuses a non-admin before reading Stripe", async () => {
    let reads = 0;
    const result = await backfillSandboxProcessingFees({
      role: "customer",
      stripeKey: "sk_test_example",
      payments: [{ id: "pay_1", status: "succeeded", chargeId: "ch_1", stripeFeeCents: null }],
      readCharge: async () => {
        reads += 1;
        return { livemode: false, feeCents: 175 };
      },
      saveFee: async () => true,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "unauthorized");
    assert.equal(reads, 0);
    assert.equal(reconciliationAllowed("provider", "sk_test_example").ok, false);
    assert.equal(reconciliationAllowed("admin", "sk_live_example").ok, false);
  });

  it("stores a test-mode fee once and leaves a missing balance transaction blank", async () => {
    const saved: number[] = [];
    const result = await backfillSandboxProcessingFees({
      role: "admin",
      stripeKey: "sk_test_example",
      payments: [
        { id: "pay_missing", status: "succeeded", chargeId: "ch_missing", stripeFeeCents: null },
        { id: "pay_ready", status: "succeeded", chargeId: "ch_ready", stripeFeeCents: null },
        { id: "pay_live", status: "succeeded", chargeId: "ch_live", stripeFeeCents: null },
        { id: "pay_recorded", status: "succeeded", chargeId: "ch_old", stripeFeeCents: 150 },
      ],
      readCharge: async (chargeId) => {
        if (chargeId === "ch_missing") return { livemode: false, feeCents: null };
        if (chargeId === "ch_live") return { livemode: true, feeCents: 999 };
        return { livemode: false, feeCents: 175 };
      },
      saveFee: async (_paymentId, feeCents) => {
        saved.push(feeCents);
        return true;
      },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.updated, 1);
      assert.equal(result.skipped, 2);
    }
    assert.deepEqual(saved, [175]);
    assert.match(feeAction, /canAccessAdminCenter/);
    assert.match(overview, /readAllPages/);
    assert.equal(feeRunner.includes("refunds.create"), false);
    assert.equal(feeRunner.includes("transfers.create"), false);
    assert.equal(feeRunner.includes("charges.create"), false);
    assert.equal(feeRunner.includes("paymentIntents.create"), false);
    assert.equal(feeRunner.includes("createReversal"), false);
  });
});

describe("retired administrator actions", () => {
  it("rejects every retired action when the caller is an administrator", () => {
    for (const action of retiredAdminActions) {
      assert.throws(() => invokeRetiredAdminAction(action, "admin"), RetiredAdminActionError);
      assert.throws(() => invokeRetiredAdminAction(action, "customer"), RetiredAdminActionError);
    }
  });

  it("keeps the retired server actions from refunding, transferring, or completing a booking", () => {
    const bodies = [
      actionBody(paymentActions, "adminRefund"),
      actionBody(paymentActions, "retryProviderTransfer"),
      actionBody(paymentActions, "updateCommission"),
      actionBody(bookingActions, "retryExpirationRefund"),
      actionBody(bookingActions, "resolveCompletionReview"),
    ];
    for (const body of bodies) {
      assert.match(body, /invokeRetiredAdminAction\(/);
      assert.equal(body.includes("requestRefund"), false);
      assert.equal(body.includes("releaseProviderTransfer"), false);
      assert.equal(body.includes("createAdminClient"), false);
      assert.equal(body.includes("platform_settings"), false);
      assert.equal(body.includes("status: \"completed\""), false);
    }
    assert.equal(bookingActions.includes("isAdmin"), false);
  });

  it("does not let an administrator change someone else's booking or skip the PIN", () => {
    assert.equal(
      canChangeBookingStatus({
        isCustomer: false,
        isProvider: false,
        currentStatus: "accepted",
        nextStatus: "cancelled",
      }),
      false,
    );
    assert.equal(
      canChangeBookingStatus({
        isCustomer: false,
        isProvider: false,
        currentStatus: "accepted",
        nextStatus: "completed",
      }),
      false,
    );
    assert.equal(
      canChangeBookingStatus({
        isCustomer: true,
        isProvider: false,
        currentStatus: "pending",
        nextStatus: "cancelled",
      }),
      true,
    );
    assert.match(completionGuard, /blockbooked\.pin_verified/);
    assert.equal(completionGuard.includes("is_admin()"), false);
    assert.match(completionGuard, /before insert or update/i);
    assert.equal(refundActorAllowed({ automatic: false, actorRole: "admin" }), false);
    assert.equal(refundActorAllowed({ automatic: true, actorRole: "customer" }), true);
  });
});

describe("admin booking filters", () => {
  it("filters by customer text and payment status", () => {
    const rows = [
      {
        id: "1",
        status: "accepted",
        serviceName: "Standard House Cleaning",
        preferredDate: "2026-11-13",
        timeWindow: "Morning",
        appointment: "Nov 13, 9:00 AM",
        customerName: "gordan",
        providerName: "BlockBooked Test Cleaning",
        paymentStatus: "succeeded",
        payoutStatus: "paid",
      },
      {
        id: "2",
        status: "pending",
        serviceName: "Standard House Cleaning",
        preferredDate: "2026-11-16",
        timeWindow: "Morning",
        appointment: "Nov 16, 9:00 AM",
        customerName: "gordan",
        providerName: "BlockBooked Test Cleaning",
        paymentStatus: "refunded",
        payoutStatus: "not_ready",
      },
    ];
    assert.equal(filterAdminBookings(rows, { query: "gordan", payment: "succeeded" }).length, 1);
    assert.equal(filterAdminBookings(rows, { status: "pending" })[0]?.id, "2");
  });
});
