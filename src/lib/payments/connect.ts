// BlockBooked customers pay the platform, and the provider is paid only after
// the customer PIN or an admin marks the booking complete. That timing decides
// the charge pattern.

export type ChargePattern = "separate_charges_and_transfers" | "destination_charge";

export function evaluateConnectChargePattern() {
  // Destination charges set transfer_data.destination and application_fee_amount.
  // Stripe moves the provider share when the charge succeeds, so a later PIN
  // cannot decide whether that payout happens. Refunds and disputes also stay
  // with the platform unless on_behalf_of shifts liability to the provider.
  // Separate charges leave the full payment on the platform balance. After
  // verified completion, a transfer sends 92%. The unsent 8% is the commission.
  // The platform remains liable for refunds, disputes, and negative balances.
  return {
    pattern: "separate_charges_and_transfers" as ChargePattern,
    merchantOfRecord: "platform" as const,
    feeCollection: "transfer_less_than_charge" as const,
    applicationFee: false,
    refundLiability: "platform" as const,
    disputeLiability: "platform" as const,
    negativeBalanceLiability: "platform" as const,
    payoutTiming: "after_verified_completion" as const,
  };
}

export function platformCheckoutIntent(bookingId: string, paymentId: string) {
  const decision = evaluateConnectChargePattern();
  if (decision.pattern !== "separate_charges_and_transfers" || decision.applicationFee) {
    throw new Error("Destination charges pay the provider before verified completion.");
  }
  return {
    transfer_group: bookingId,
    metadata: { payment_id: paymentId, booking_id: bookingId },
  };
}

export function checkoutIntegrationIdentifier() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  let suffix = "";
  for (let index = 0; index < 8; index += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `blockbooked_${suffix}`;
}

type RecipientAccount = {
  configuration?: {
    recipient?: {
      capabilities?: {
        stripe_balance?: {
          stripe_transfers?: { status?: string };
        };
      };
    };
  };
  requirements?: {
    summary?: {
      minimum_deadline?: { status?: string } | null;
    } | null;
  } | null;
};

export function connectedAccountReadiness(account: RecipientAccount) {
  const readyToReceivePayments =
    account.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status === "active";
  const requirementsStatus = account.requirements?.summary?.minimum_deadline?.status ?? null;
  const onboardingComplete = requirementsStatus !== "currently_due" && requirementsStatus !== "past_due";
  return { readyToReceivePayments, requirementsStatus, onboardingComplete };
}

export function isAccountRequirementsEvent(type: string) {
  return (
    type === "v2.core.account[requirements].updated" ||
    type === "v2.core.account[configuration.recipient].capability_status_updated"
  );
}
