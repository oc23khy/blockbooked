"use server";

import { revalidatePath } from "next/cache";
import { heldVisit } from "@/lib/scheduling/booking";
import { loadPublicSchedule } from "@/lib/scheduling/public";
import { redirect } from "next/navigation";
import { invokeRetiredAdminAction } from "@/lib/admin/retired-actions";
import {
  bookingStatuses,
  canChangeBookingStatus,
  normalizeBookingStatus,
  paidAcceptanceAllowed,
  pinAttemptMessage,
  type BookingStatus,
} from "@/lib/booking-status";
import { quoteFromCatalog } from "@/lib/payments/money";
import { releaseProviderTransfer, requestRefund, startCheckout } from "@/lib/payments/service";
import { stripeTestKeyConfigured } from "@/lib/payments/stripe-server";
import { createAdminClient, isServiceRoleConfigured } from "@/lib/supabase/admin";
import { customerFacingError } from "@/lib/public-error";
import { redirectIfRateLimited, reserveBookingRateLimit } from "@/lib/rate-limit";
import { requireSession, safeNextPath } from "@/lib/session";

const windows = new Set(["Morning", "Afternoon", "Evening"]);

export async function createBooking(formData: FormData) {
  const providerId = String(formData.get("providerId") ?? "");
  const session = await requireSession(providerId ? `/providers/${providerId}` : "/account");
  let preferredDate = String(formData.get("date") ?? "");
  let timeWindow = String(formData.get("window") ?? "");
  const notes = String(formData.get("notes") ?? "").trim();
  let serviceName = String(formData.get("serviceName") ?? "").trim().slice(0, 120);
  const serviceId = String(formData.get("serviceId") ?? "");
  const startsAtRaw = String(formData.get("startsAt") ?? "");
  const phone = String(formData.get("phone") ?? "").trim() || session.profile.phone;
  const returnPath = `/providers/${providerId}`;

  let scheduledService: { id: string; duration_minutes: number; price_cents: number | null; pricing_type: string } | null = null;
  if (startsAtRaw || serviceId) {
    const schedule = await loadPublicSchedule(providerId);
    const service = schedule?.services.find((item) => item.id === serviceId);
    try {
      const visit = heldVisit({
        serviceId,
        serviceName: service?.name ?? "",
        startsAt: startsAtRaw,
        durationMinutes: service?.durationMinutes ?? 0,
        timeZone: schedule?.timeZone || "America/Chicago",
        offeredStarts: service ? (schedule?.slotsByService[service.id] ?? []).map((slot) => slot.start) : [],
      });
      preferredDate = visit.preferredDate;
      timeWindow = visit.timeWindow;
      serviceName = visit.serviceName;
      scheduledService = {
        id: service?.id ?? serviceId,
        duration_minutes: service?.durationMinutes ?? 0,
        price_cents: service?.priceCents ?? null,
        pricing_type: service?.pricingType ?? "quote",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Choose one of the open appointment times.";
      redirect(`${returnPath}?error=${encodeURIComponent(customerFacingError(message, "Choose one of the open appointment times."))}`);
    }
  }

  if (!providerId || !preferredDate || !windows.has(timeWindow)) {
    redirect(`${returnPath}?error=${encodeURIComponent("Add a date and a time of day.")}`);
  }
  if (!phone) {
    redirect(`${returnPath}?error=${encodeURIComponent("Add a phone number on your profile or in this request.")}`);
  }

  const paymentsReady = stripeTestKeyConfigured() && isServiceRoleConfigured();
  const paymentPlan = String(formData.get("paymentPlan") ?? "single");
  let amountCents: number | null = null;
  if (scheduledService?.pricing_type === "fixed" || scheduledService?.pricing_type === "starting") {
    amountCents = scheduledService.price_cents;
  } else if (paymentsReady && paymentPlan !== "quote" && !startsAtRaw) {
    const { data: provider } = await session.supabase
      .from("providers")
      .select("services, price_from")
      .eq("id", providerId)
      .maybeSingle();
    const services = Array.isArray(provider?.services)
      ? (provider.services as { name?: string; price?: string }[])
      : [];
    const selected = services.find((service) => service.name === serviceName);
    const catalogPrice = selected?.price || provider?.price_from;
    try {
      amountCents = quoteFromCatalog(catalogPrice);
    } catch (error) {
      const message = error instanceof Error ? error.message : "This service does not have a fixed dollar price.";
      redirect(`${returnPath}?error=${encodeURIComponent(customerFacingError(message, "This service does not have a fixed dollar price."))}`);
    }
  }

  const bookingReceipt = await reserveBookingRateLimit("createBooking", session.user.id, returnPath);

  const inserted = await session.supabase
    .from("booking_requests")
    .insert({
      customer_id: session.user.id,
      provider_id: providerId,
      preferred_date: preferredDate,
      time_window: timeWindow,
      notes,
      contact_phone: phone,
      service_name: serviceName,
      status: "pending",
      rate_limit_receipt: bookingReceipt,
    })
    .select("id")
    .single();

  if (inserted.error || !inserted.data) {
    redirect(`${returnPath}?error=${encodeURIComponent(customerFacingError(inserted.error?.message, "The booking could not be saved."))}`);
  }

  if (scheduledService && startsAtRaw) {
    const reserved = await session.supabase.from("booking_appointments").insert({
      booking_id: inserted.data.id,
      provider_id: providerId,
      service_id: scheduledService.id,
      starts_at: new Date(startsAtRaw).toISOString(),
      ends_at: new Date(new Date(startsAtRaw).getTime() + scheduledService.duration_minutes * 60_000).toISOString(),
    });
    if (reserved.error) {
      const cleanup = isServiceRoleConfigured() ? createAdminClient() : session.supabase;
      await cleanup
        .from("booking_requests")
        .update({ status: "cancelled" })
        .eq("id", inserted.data.id)
        .eq("customer_id", session.user.id);
      redirect(`${returnPath}?error=${encodeURIComponent(customerFacingError(reserved.error.message, "That appointment time is no longer open."))}`);
    }
  }

  revalidatePath(returnPath);
  revalidatePath("/account");
  revalidatePath("/dashboard");

  if (paymentsReady && (paymentPlan === "quote" || paymentPlan === "milestones")) {
    const admin = (await import("@/lib/supabase/admin")).createAdminClient();
    await admin.from("booking_payment_plans").insert({
      booking_id: inserted.data.id,
      plan: paymentPlan,
      agreed_amount_cents: paymentPlan === "milestones" ? amountCents : null,
    });
    redirect(`${returnPath}?notice=${encodeURIComponent(paymentPlan === "quote" ? "Quote requested. The provider will set the price." : "Request sent. The provider will split the price into milestones.")}`);
  }

  if (!paymentsReady || amountCents == null) {
    redirect(`${returnPath}?notice=Request%20sent`);
  }

  await redirectIfRateLimited("checkout", session.user.id, "/account");
  let checkoutUrl: string;
  try {
    checkoutUrl = await startCheckout({
      bookingId: inserted.data.id,
      customerId: session.user.id,
      providerId,
      amountCents,
      serviceName,
      customerEmail: session.profile.email,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Checkout could not be started.";
    const safe = customerFacingError(message, "Checkout could not be started.");
    redirect(`/account?error=${encodeURIComponent(`${safe} You can pay or cancel the request from your account.`)}`);
  }
  redirect(checkoutUrl);
}

export async function updateBookingStatus(formData: FormData) {
  const session = await requireSession("/account");
  const bookingId = String(formData.get("bookingId") ?? "");
  const nextStatus = String(formData.get("status") ?? "") as BookingStatus;
  const returnTo = safeNextPath(String(formData.get("returnTo") ?? "/account"));

  const { data: booking } = await session.supabase
    .from("booking_requests")
    .select("id, status, customer_id, provider_id")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking) redirect(`${returnTo}?error=${encodeURIComponent("That booking could not be found.")}`);

  const { data: listing } = await session.supabase
    .from("providers")
    .select("owner_id")
    .eq("id", booking.provider_id)
    .maybeSingle();

  if (!bookingStatuses.includes(nextStatus)) {
    redirect(`${returnTo}?error=${encodeURIComponent("Choose a valid booking status.")}`);
  }

  const isCustomer = booking.customer_id === session.user.id;
  const isProvider = listing?.owner_id === session.user.id;
  const allowed = canChangeBookingStatus({
    isCustomer,
    isProvider,
    currentStatus: normalizeBookingStatus(booking.status),
    nextStatus,
  });

  if (!allowed) {
    redirect(`${returnTo}?error=${encodeURIComponent("You cannot change this booking to that status.")}`);
  }

  if (nextStatus === "accepted") {
    const payment = await session.supabase
      .from("payments")
      .select("status, amount_cents, refunded_cents")
      .eq("booking_id", bookingId);
    const rows = payment.error
      ? []
      : ((payment.data ?? []) as { status: string; amount_cents: number; refunded_cents: number }[]);
    if (
      payment.error ||
      !paidAcceptanceAllowed(
        rows.map((row) => ({
          status: row.status,
          amountCents: row.amount_cents,
          refundedCents: row.refunded_cents,
        })),
      )
    ) {
      redirect(`${returnTo}?error=${encodeURIComponent("Wait until Stripe confirms the customer's payment before accepting.")}`);
    }
  }

  const statusReceipt = await reserveBookingRateLimit("bookingStatus", session.user.id, returnTo);

  const updated = await session.supabase
    .from("booking_requests")
    .update({ status: nextStatus, rate_limit_receipt: statusReceipt })
    .eq("id", bookingId)
    .select("status")
    .maybeSingle();

  if (updated.error) redirect(`${returnTo}?error=${encodeURIComponent(customerFacingError(updated.error.message, "That booking could not be updated."))}`);
  if (updated.data?.status !== nextStatus) {
    redirect(`${returnTo}?error=${encodeURIComponent("That booking changed before this update was saved. Refresh and check its status.")}`);
  }

  revalidatePath("/account");
  revalidatePath("/dashboard");
  revalidatePath(`/providers/${booking.provider_id}`);

  if ((nextStatus === "declined" || nextStatus === "cancelled") && stripeTestKeyConfigured() && isServiceRoleConfigured()) {
    const listed = await createAdminClient().from("payments").select("id, status").eq("booking_id", bookingId);
    const targets = ((listed.data ?? []) as { id: string; status: string }[]).filter(
      (row) => row.status === "succeeded" || row.status === "partially_refunded",
    );
    for (const target of targets) {
      const refund = await requestRefund({
        bookingId,
        paymentId: target.id,
        actorId: session.user.id,
        actorRole: session.profile.role,
        reason: nextStatus === "declined" ? "provider_declined" : "customer_cancelled",
        automatic: true,
      });
      if (!refund.ok && refund.message !== "There is no confirmed Stripe payment to refund.") {
        redirect(`${returnTo}?error=${encodeURIComponent(`The booking was updated, but the refund was not confirmed. ${customerFacingError(refund.message, "Try again from your account.")}`)}`);
      }
      if (refund.ok && refund.stripeStatus !== "succeeded") {
        redirect(`${returnTo}?notice=${encodeURIComponent("Booking updated. Stripe has not confirmed the refund yet.")}`);
      }
    }
    if (targets.length > 0) {
      redirect(`${returnTo}?notice=${encodeURIComponent("Booking updated. Stripe confirmed the refund.")}`);
    }
  }
  redirect(`${returnTo}?notice=Booking%20updated`);
}

export async function submitCompletionPin(formData: FormData) {
  const session = await requireSession("/dashboard");
  const bookingId = String(formData.get("bookingId") ?? "");
  const pin = String(formData.get("pin") ?? "").trim();

  if (!/^[0-9]{6}$/.test(pin)) {
    redirect(`/dashboard?error=${encodeURIComponent(pinAttemptMessage("invalid_format"))}`);
  }

  const { data, error } = await session.supabase.rpc("complete_booking_with_pin", {
    target_booking: bookingId,
    submitted_pin: pin,
  });

  revalidatePath("/account");
  revalidatePath("/dashboard");

  if (error) redirect(`/dashboard?error=${encodeURIComponent("The PIN could not be checked.")}`);
  if (data === "completed") {
    await releaseProviderTransfer(bookingId);
    redirect("/dashboard?notice=Booking%20completed");
  }

  const code = typeof data === "string" ? data : "unavailable";
  redirect(`/dashboard?error=${encodeURIComponent(pinAttemptMessage(code))}`);
}

export async function requestCompletionReview(formData: FormData) {
  const session = await requireSession("/dashboard");
  await redirectIfRateLimited("completionReview", session.user.id, "/dashboard");
  const bookingId = String(formData.get("bookingId") ?? "");
  const note = String(formData.get("note") ?? "").trim().slice(0, 500);
  const { data, error } = await session.supabase.rpc("request_completion_review", {
    target_booking: bookingId,
    note,
  });

  revalidatePath("/dashboard");
  revalidatePath("/admin");

  if (error || data !== "requested") {
    redirect(`/dashboard?error=${encodeURIComponent("The review request could not be saved.")}`);
  }
  redirect("/dashboard?notice=Manual%20review%20requested");
}

export async function retryExpirationRefund(_formData: FormData): Promise<never> {
  invokeRetiredAdminAction("retryExpirationRefund", "admin");
}

export async function resolveCompletionReview(_formData: FormData): Promise<never> {
  invokeRetiredAdminAction("resolveCompletionReview", "admin");
}
