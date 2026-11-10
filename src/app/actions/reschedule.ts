"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { heldVisit } from "@/lib/scheduling/booking";
import { loadPublicSchedule } from "@/lib/scheduling/public";
import { withoutOwnHold } from "@/lib/scheduling/reschedule";
import { openSlots } from "@/lib/scheduling/rules";
import { requireSession } from "@/lib/session";

export async function requestReschedule(formData: FormData) {
  const bookingId = String(formData.get("bookingId") ?? "");
  const serviceId = String(formData.get("serviceId") ?? "");
  const startsAt = String(formData.get("startsAt") ?? "");
  const session = await requireSession(`/account/reschedule/${bookingId}`);
  const booking = await session.supabase
    .from("booking_requests")
    .select("id, status, customer_id, provider_id")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking.data || booking.data.customer_id !== session.user.id || booking.data.status !== "accepted") {
    redirect("/account?error=Only%20an%20accepted%20booking%20can%20be%20rescheduled");
  }
  const appointment = await session.supabase
    .from("booking_appointments")
    .select("starts_at, blocked_until, status")
    .eq("booking_id", bookingId)
    .maybeSingle();
  if (!appointment.data || appointment.data.status !== "confirmed") {
    redirect("/account?error=This%20booking%20has%20no%20confirmed%20appointment");
  }
  const schedule = await loadPublicSchedule(booking.data.provider_id);
  const service = schedule?.services.find((item) => item.id === serviceId);
  const own =
    appointment.data.starts_at && appointment.data.blocked_until
      ? { start: Date.parse(appointment.data.starts_at), end: Date.parse(appointment.data.blocked_until) }
      : null;
  const slots =
    schedule?.settings && service?.durationMinutes
      ? openSlots({
          timeZone: schedule.timeZone,
          windows: schedule.windows,
          durationMinutes: service.durationMinutes,
          bufferMinutes: schedule.settings.bufferMinutes,
          minNoticeMinutes: schedule.settings.minNoticeMinutes,
          maxAdvanceDays: schedule.settings.maxAdvanceDays,
          busy: withoutOwnHold(schedule.busy, own),
          timeOff: schedule.timeOff,
        })
      : [];
  let visit: ReturnType<typeof heldVisit>;
  try {
    visit = heldVisit({
      serviceId,
      serviceName: service?.name ?? "",
      startsAt,
      durationMinutes: service?.durationMinutes ?? 0,
      timeZone: schedule?.timeZone || "America/Chicago",
      offeredStarts: slots.map((slot) => slot.start),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Choose one of the open appointment times.";
    redirect(`/account/reschedule/${bookingId}?error=${encodeURIComponent(message)}`);
  }
  const saved = await session.supabase.from("booking_reschedule_requests").insert({
    booking_id: bookingId,
    customer_id: session.user.id,
    service_id: serviceId,
    starts_at: visit.startsAt,
    ends_at: visit.endsAt,
    original_starts_at: appointment.data.starts_at,
  });
  if (saved.error) {
    redirect(`/account/reschedule/${bookingId}?error=${encodeURIComponent(saved.error.message)}`);
  }
  revalidatePath("/account");
  revalidatePath("/dashboard");
  redirect("/account?notice=Reschedule%20requested.%20The%20current%20appointment%20stays%20reserved%20until%20the%20provider%20approves%20the%20new%20time.");
}

export async function decideReschedule(formData: FormData) {
  const session = await requireSession("/dashboard");
  const requestId = String(formData.get("requestId") ?? "");
  const approve = formData.get("decision") === "approve";
  const { data, error } = await session.supabase.rpc("decide_reschedule", {
    request_id: requestId,
    approve,
  });
  revalidatePath("/account");
  revalidatePath("/dashboard");
  if (error) redirect(`/dashboard?error=${encodeURIComponent(error.message)}`);
  if (data === "approved") redirect("/dashboard?notice=The%20new%20appointment%20time%20is%20reserved.%20The%20original%20payment%20was%20not%20changed.");
  if (data === "declined") redirect("/dashboard?notice=Reschedule%20request%20declined.%20The%20original%20time%20is%20unchanged.");
  if (data === "conflict" || data === "rejected" || data === "unavailable") {
    redirect("/dashboard?error=The%20new%20time%20was%20not%20reserved.%20The%20original%20appointment%20is%20unchanged.");
  }
  redirect(`/dashboard?error=${encodeURIComponent("The reschedule could not be decided.")}`);
}

export async function cancelReschedule(formData: FormData) {
  const session = await requireSession("/account");
  const requestId = String(formData.get("requestId") ?? "");
  const { error } = await session.supabase
    .from("booking_reschedule_requests")
    .update({ status: "cancelled" })
    .eq("id", requestId)
    .eq("customer_id", session.user.id)
    .eq("status", "pending");
  revalidatePath("/account");
  revalidatePath("/dashboard");
  if (error) redirect(`/account?error=${encodeURIComponent(error.message)}`);
  redirect("/account?notice=Reschedule%20request%20cancelled.%20The%20original%20appointment%20is%20unchanged.");
}
