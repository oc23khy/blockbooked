const STALE_CHECKOUT_NOTICE =
  "Payment submitted. Stripe still has to confirm it before the provider can accept.";

export function accountPaymentNotice(input: {
  notice?: string | null;
  checkout?: string | null;
  bookings: { status: string; paymentStatus: string | null }[];
}) {
  const stale = input.notice === STALE_CHECKOUT_NOTICE || input.checkout === "submitted";
  if (!stale) return input.notice || null;
  const paid =
    input.bookings.find(
      (booking) => booking.paymentStatus === "succeeded" || booking.paymentStatus === "partially_refunded",
    ) ?? input.bookings.find((booking) => booking.paymentStatus === "refunded");
  if (!paid) return STALE_CHECKOUT_NOTICE;
  if (paid.paymentStatus === "refunded") return "The payment was refunded.";
  if (paid.status === "completed") return "Payment confirmed. This appointment is complete.";
  if (paid.status === "accepted") return "Payment confirmed. The provider accepted this appointment.";
  if (paid.status === "pending") {
    return "Payment confirmed. The provider still needs to accept it. Payment alone does not confirm the appointment.";
  }
  if (paid.status === "expired") return "Payment confirmed. The request expired, and the refund follows the payment record.";
  if (paid.status === "declined" || paid.status === "cancelled") {
    return "Payment confirmed. This booking is no longer active.";
  }
  return "Payment confirmed.";
}
