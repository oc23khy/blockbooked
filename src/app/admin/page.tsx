import type { Metadata } from "next";
import { reconcileSandboxFees } from "@/app/actions/admin-fees";
import { reconcileSandboxTransfersAction } from "@/app/actions/admin-transfers";
import { readAllPages } from "@/lib/admin/read-all";
import {
  providerTransferLabel,
  stripeFeeLabel,
  summarizeAdminMoney,
  type AdminPaymentSnapshot,
  type AdminRefundSnapshot,
} from "@/lib/admin/summary";
import { formatUsd } from "@/lib/payments/money";
import { requireAdmin } from "@/lib/session";

export const metadata: Metadata = { title: "Admin overview · BlockBooked" };

const bookingStatuses = ["pending", "accepted", "completed", "declined", "cancelled", "expired"] as const;

type PaymentRow = {
  id: string;
  status: string;
  amount_cents: number;
  commission_cents: number;
  provider_share_cents: number;
  refunded_cents: number;
  stripe_fee_cents: number | null;
  transfer_status: string;
  transfer_id: string | null;
  transfer_amount_cents: number | null;
  transfer_reversed_cents: number | null;
};

type RefundRow = {
  id: string;
  status: string;
  amount_cents: number;
  commission_reversal_cents: number;
  provider_reversal_cents: number;
  reversal_status: string | null;
  payment_id: string;
};

export default async function AdminOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const query = await searchParams;
  const { supabase } = await requireAdmin("/admin");
  const [bookingTotal, ...statusCounts] = await Promise.all([
    supabase.from("booking_requests").select("id", { count: "exact", head: true }),
    ...bookingStatuses.map((status) =>
      supabase.from("booking_requests").select("id", { count: "exact", head: true }).eq("status", status),
    ),
  ]);
  const [payments, refunds, pendingApplications, reviews] = await Promise.all([
    readAllPages<PaymentRow>((from, to) =>
      supabase
        .from("payments")
        .select(
          "id, status, amount_cents, commission_cents, provider_share_cents, refunded_cents, stripe_fee_cents, transfer_status, transfer_id, transfer_amount_cents, transfer_reversed_cents",
        )
        .order("id", { ascending: true })
        .range(from, to),
    ),
    readAllPages<RefundRow>((from, to) =>
      supabase
        .from("refunds")
        .select("id, payment_id, status, amount_cents, commission_reversal_cents, provider_reversal_cents, reversal_status")
        .order("id", { ascending: true })
        .range(from, to),
    ),
    supabase.from("providers").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase
      .from("booking_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "accepted")
      .not("review_requested_at", "is", null),
  ]);
  const countError =
    bookingTotal.error?.message ||
    statusCounts.find((result) => result.error)?.error?.message ||
    pendingApplications.error?.message ||
    reviews.error?.message ||
    null;
  const moneyError = payments.error || refunds.error;
  const counts = Object.fromEntries(bookingStatuses.map((status, index) => [status, statusCounts[index]?.count ?? 0])) as Record<
    (typeof bookingStatuses)[number],
    number
  >;
  const money = moneyError
    ? null
    : summarizeAdminMoney(
        payments.rows.map(
          (row): AdminPaymentSnapshot => ({
            status: row.status,
            amountCents: row.amount_cents,
            commissionCents: row.commission_cents,
            providerShareCents: row.provider_share_cents,
            refundedCents: row.refunded_cents,
            stripeFeeCents: row.stripe_fee_cents,
            transferStatus: row.transfer_status,
            transferId: row.transfer_id,
            transferAmountCents: row.transfer_amount_cents,
            transferReversedCents: row.transfer_reversed_cents,
            id: row.id,
          }),
        ),
        refunds.rows.map(
          (row): AdminRefundSnapshot => ({
            status: row.status,
            amountCents: row.amount_cents,
            commissionReversalCents: row.commission_reversal_cents,
            providerReversalCents: row.provider_reversal_cents,
            reversalStatus: row.reversal_status,
            paymentId: row.payment_id,
          }),
        ),
      );
  const figures = [
    ["Bookings", String(bookingTotal.count ?? 0)],
    ["Completed bookings", String(counts.completed)],
    ["Pending applications", String(pendingApplications.count ?? 0)],
    ["Manual reviews", String(reviews.count ?? 0)],
    ["Gross customer payments", money ? formatUsd(money.grossCustomerPaymentsCents) : "Not calculated"],
    ["Refunds", money ? formatUsd(money.refundsCents) : "Not calculated"],
    ["Stripe fees", money ? stripeFeeLabel(money, formatUsd) : "Not calculated"],
    ["Gross provider transfers", money ? providerTransferLabel(money, formatUsd) : "Not calculated"],
    ["Transfer reversals", money ? formatUsd(money.transferReversalsCents) : "Not calculated"],
    [
      "Net provider transfers",
      money
        ? money.netProviderTransfersCents == null
          ? "Unavailable until every created transfer has a recorded amount"
          : formatUsd(money.netProviderTransfersCents)
        : "Not calculated",
    ],
    ["Gross commission", money ? formatUsd(money.grossCommissionCents) : "Not calculated"],
    ["Commission reductions", money ? formatUsd(money.commissionReductionCents) : "Not calculated"],
    ["Net commission retained", money ? formatUsd(money.netCommissionCents) : "Not calculated"],
    [
      "Estimated contribution margin",
      money
        ? money.contributionMarginCents == null
          ? "Unavailable until every collected payment has a Stripe fee"
          : formatUsd(money.contributionMarginCents)
        : "Not calculated",
    ],
  ];

  return (
    <main>
      <h1 className="font-serif text-5xl tracking-tight text-ink">Admin Center</h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-ink/70">
        Gross customer payments are the amounts customers paid BlockBooked. Gross commission is the 8% platform share of
        those payments. Commission reductions are the platform share of succeeded refunds, and net commission is what
        remains. Net commission is not profit. Estimated contribution margin is net commission minus recorded Stripe
        processing fees, and it appears only when every collected payment has a fee. BlockBooked bears those fees.
        Gross provider transfers add the cents Stripe actually transferred, including transfers that were later reversed.
        A missing historical amount stays blank and is not replaced with 92% of the charge. Net provider transfers are
        shown only when every created transfer has that recorded amount. Transfer reversals include only amounts Stripe
        confirmed. A refund of a provider share that was never transferred is not a reversal.
      </p>
      {query.notice ? <p className="mt-4 text-sm font-medium text-ink">{query.notice}</p> : null}
      {query.error || countError || moneyError ? (
        <p className="mt-4 text-sm font-medium text-accent-dark">{query.error || countError || moneyError}</p>
      ) : null}
      <ul className="mt-8 grid gap-3 sm:grid-cols-2">
        {figures.map(([label, value]) => (
          <li key={label} className="rounded-3xl border border-line bg-card px-5 py-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink/50">{label}</p>
            <p className="mt-2 text-2xl font-semibold text-ink">{value}</p>
          </li>
        ))}
      </ul>
      <p className="mt-6 text-sm text-ink/70">
        Pending {counts.pending} · accepted {counts.accepted} · declined {counts.declined} · cancelled {counts.cancelled} ·
        expired {counts.expired}
      </p>
      <form action={reconcileSandboxFees} className="mt-8 max-w-2xl rounded-3xl border border-line bg-card px-5 py-4">
        <h2 className="font-serif text-2xl text-ink">Record missing Stripe fees</h2>
        <p className="mt-2 text-sm leading-6 text-ink/70">
          This reads each collected test-mode charge and stores the fee from its Stripe balance transaction. It does not
          run by itself, and it does not create charges, refunds, transfers, or reversals. A fee that Stripe has not
          posted yet stays blank.
        </p>
        <button type="submit" className="mt-4 rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white">
          Record missing Stripe fees
        </button>
      </form>
      <form action={reconcileSandboxTransfersAction} className="mt-4 max-w-2xl rounded-3xl border border-line bg-card px-5 py-4">
        <h2 className="font-serif text-2xl text-ink">Record transfer amounts</h2>
        <p className="mt-2 text-sm leading-6 text-ink/70">
          This reads each stored Stripe test transfer and saves its actual amount and reversed amount. It fills an amount
          only when that field is still blank, and it never lowers a reversal that was already recorded. It does not run
          by itself, and it does not create charges, refunds, transfers, or reversals.
        </p>
        <button type="submit" className="mt-4 rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white">
          Record transfer amounts
        </button>
      </form>
    </main>
  );
}
