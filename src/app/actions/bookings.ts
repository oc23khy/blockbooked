"use server";

import { revalidatePath } from "next/cache";
import { readBookingCreationDecision } from "@/lib/bookings/maintenance";
import { bookingCreationBlock } from "@/lib/bookings/maintenance-decision";
import { bookingCreationPlan, heldVisit, reservationOutcome } from "@/lib/scheduling/booking";
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
import { notifyBookingEvent } from "@/lib/notifications/dispatch";
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
  const maintenance = bookingCreationBlock(await readBookingCreationDecision());
  if (maintenance) {
    redirect(`${providerId ? `/providers/${providerId}` : "/account"}?error=${encodeURIComponent(maintenance)}`);
  }
  let preferredDate = String(formData.get("date") ?? "");
  let timeWindow = String(formData.get("window") ?? "");
  const notes = String(formData.get("notes") ?? "").trim();
  let serviceName = String(formData.get("serviceName") ?? "").trim().slice(0, 120);
  const serviceId = String(formData.get("serviceId") ?? "");
  const startsAtRaw = String(formData.get("startsAt") ?? "");
  const phone = String(formData.get("phone") ?? "").trim() || session.profile.phone;
  const returnPath = `/providers/${providerId}`;
  const paymentPlan = String(formData.get("paymentPlan") ?? "single");
  const schedule = providerId ? await loadPublicSchedule(providerId) : null;
  const service = schedule?.services.find((item) => item.id === serviceId) ?? null;
  const offeredStarts = service ? (schedule?.slotsByService[service.id] ?? []).map((slot) => slot.start) : [];
  const plan = bookingCreationPlan({
    startsAt: startsAtRaw,
    paymentPlan,
    pricingType: service?.pricingType ?? null,
    durationMinutes: service?.durationMinutes ?? null,
    offeredStarts,
  });
  if (plan.action === "reject") {
    redirect(`${returnPath}?error=${encodeURIComponent(plan.message)}`);
  }

  let scheduledService: { id: string; durationMinutes: number; priceCents: number | null } | null = null;
  if (plan.action === "reserve") {
    try {
      const visit = heldVisit({
        serviceId,
        serviceName: service?.name ?? "",
        startsAt: startsAtRaw,
        durationMinutes: service?.durationMinutes ?? 0,
        timeZone: schedule?.timeZone || "America/Chicago",
        offeredStarts,
      });
      preferredDate = visit.preferredDate;
      timeWindow = visit.timeWindow;
      serviceName = visit.serviceName;
      scheduledService = {
        id: service?.id ?? serviceId,
        durationMinutes: service?.durationMinutes ?? 0,
        priceCents: service?.priceCents ?? null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Choose one of the open appointment times.";
      redirect(`${returnPath}?error=${encodeURIComponent(customerFacingError(message, "Choose one of the open appointment times."))}`);
    }
  }

  if (!providerId || !preferredDate || !windows.has(timeWindow)) {
    redirect(`${returnPath}?error=${encodeURIComponent(plan.action === "quote-request" ? "Add a preferred date and time of day. This does not reserve an appointment." : "Choose an open appointment time.")}`);
  }
  if (!phone) {
    redirect(`${returnPath}?error=${encodeURIComponent("Add a phone number on your profile or in this request.")}`);
  }

  const paymentsReady = stripeTestKeyConfigured() && isServiceRoleConfigured();
  const amountCents = plan.action === "reserve" && plan.charge ? scheduledService?.priceCents ?? null : null;
  if (plan.action === "reserve" && plan.charge && amountCents == null) {
    redirect(`${returnPath}?error=${encodeURIComponent("This service does not have a fixed dollar price.")}`);
  }

  const bookingReceipt = await reserveBookingRateLimit("createBooking", session.user.id, returnPath);

  let bookingId = "";
  if (plan.action === "reserve" && scheduledService && startsAtRaw) {
    const reserved = await session.supabase.rpc("create_reserved_booking", {
      target_provider: providerId,
      preferred_day: preferredDate,
      requested_window: timeWindow,
      request_notes: notes,
      request_phone: phone,
      request_service: serviceName,
      request_receipt: bookingReceipt,
      target_service: scheduledService.id,
      visit_start: new Date(startsAtRaw).toISOString(),
      visit_end: new Date(new Date(startsAtRaw).getTime() + scheduledService.durationMinutes * 60_000).toISOString(),
    });
    if (reservationOutcome(!reserved.error && typeof reserved.data === "string") === "cancel-without-charge") {
      redirect(`${returnPath}?error=${encodeURIComponent(customerFacingError(reserved.error?.message, "That appointment time is no longer open. You were not charged."))}`);
    }
    bookingId = reserved.data as string;
  } else {
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
    bookingId = inserted.data.id;
  }

  await notifyBookingEvent("booking_requested", bookingId);

  revalidatePath(returnPath);
  revalidatePath("/account");
  revalidatePath("/dashboard");

  if (paymentsReady && (plan.action === "quote-request" || paymentPlan === "quote" || paymentPlan === "milestones")) {
    const admin = (await import("@/lib/supabase/admin")).createAdminClient();
    await admin.from("booking_payment_plans").insert({
      booking_id: bookingId,
      plan: paymentPlan === "milestones" ? "milestones" : "quote",
      agreed_amount_cents: paymentPlan === "milestones" ? amountCents : null,
    });
  }
  if (plan.action === "quote-request") {
    redirect(`${returnPath}?notice=${encodeURIComponent("Quote requested. This does not reserve an appointment.")}`);
  }
  if (paymentPlan === "quote") {
    redirect(`${returnPath}?notice=${encodeURIComponent("The appointment is held. The provider will send a quote. You were not charged.")}`);
  }
  if (paymentPlan === "milestones") {
    redirect(`${returnPath}?notice=${encodeURIComponent("The appointment is held. The provider will split the price into milestones.")}`);
  }

  if (!paymentsReady || plan.action !== "reserve" || !plan.charge || amountCents == null) {
    redirect(`${returnPath}?notice=${encodeURIComponent("The appointment is held. No payment was collected.")}`);
  }

  await redirectIfRateLimited("checkout", session.user.id, "/account");
  let checkoutUrl: string;
  try {
    checkoutUrl = await startCheckout({
      bookingId,
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

export async function reserveBookingAppointment(formData: FormData) {
  const bookingId = String(formData.get("bookingId") ?? "");
  const serviceId = String(formData.get("serviceId") ?? "");
  const startsAt = String(formData.get("startsAt") ?? "");
  const session = await requireSession(`/account`);
  const maintenance = bookingCreationBlock(await readBookingCreationDecision());
  if (maintenance) redirect(`/account?error=${encodeURIComponent(maintenance)}`);
  await redirectIfRateLimited("createBooking", session.user.id, "/account");
  const booking = await session.supabase
    .from("booking_requests")
    .select("id, status, customer_id, provider_id")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking.data || booking.data.customer_id !== session.user.id || booking.data.status !== "pending") {
    redirect("/account?error=Only%20a%20pending%20quote%20can%20reserve%20an%20appointment.");
  }
  const existing = await session.supabase
    .from("booking_appointments")
    .select("id")
    .eq("booking_id", bookingId)
    .in("status", ["held", "confirmed"])
    .maybeSingle();
  if (existing.data) redirect("/account?notice=This%20request%20already%20holds%20an%20appointment.");
  const schedule = await loadPublicSchedule(booking.data.provider_id);
  const service = schedule?.services.find((item) => item.id === serviceId);
  const offeredStarts = service ? (schedule?.slotsByService[service.id] ?? []).map((slot) => slot.start) : [];
  const plan = bookingCreationPlan({
    startsAt,
    paymentPlan: "quote",
    pricingType: service?.pricingType ?? "quote",
    durationMinutes: service?.durationMinutes ?? null,
    offeredStarts,
  });
  if (plan.action !== "reserve") {
    redirect("/account?error=Choose%20one%20of%20the%20open%20appointment%20times.%20You%20were%20not%20charged.");
  }
  const visit = heldVisit({
    serviceId,
    serviceName: service?.name ?? "",
    startsAt,
    durationMinutes: service?.durationMinutes ?? 0,
    timeZone: schedule?.timeZone || "America/Chicago",
    offeredStarts,
  });
  const reserved = await session.supabase.rpc("attach_booking_appointment", {
    target_booking: bookingId,
    target_service: serviceId,
    visit_start: visit.startsAt,
    visit_end: visit.endsAt,
  });
  if (reservationOutcome(!reserved.error) === "cancel-without-charge") {
    redirect("/account?error=That%20appointment%20time%20is%20no%20longer%20open.%20The%20quote%20was%20not%20charged%20or%20accepted.");
  }
  revalidatePath("/account");
  revalidatePath("/dashboard");
  revalidatePath(`/providers/${booking.data.provider_id}`);
  redirect("/account?notice=Appointment%20held%20for%20this%20quote.%20You%20were%20not%20charged.");
}

export async function updateBookingStatus(formData: FormData) {
  const session = await requireSession("/account");
  const bookingId = String(formData.get("bookingId") ?? "");
  const nextStatus = String(formData.get("status") ?? "") as BookingStatus;
  const returnTo = safeNextPath(String(formData.get("returnTo") ?? "/account"));

  const { data: booking } = await session.supabase
    .from("booking_requests")
    .select("id, status, customer_id, provider_id, appointment_required")
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

  if (nextStatus === "accepted" && booking.appointment_required !== false) {
    const reserved = await session.supabase
      .from("booking_appointments")
      .select("id")
      .eq("booking_id", bookingId)
      .eq("status", "held")
      .maybeSingle();
    if (reserved.error || !reserved.data) {
      redirect(`${returnTo}?error=${encodeURIComponent("Accepting requires a reserved appointment. A time of day is not an appointment.")}`);
    }
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

  if (nextStatus === "accepted") await notifyBookingEvent("booking_accepted", bookingId);
  if (nextStatus === "cancelled" || nextStatus === "declined") await notifyBookingEvent("booking_cancelled", bookingId);

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
    await notifyBookingEvent("booking_completed", bookingId);
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
