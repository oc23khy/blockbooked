"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { canMessageBooking, isUuid, messagePath, prepareMessage } from "@/lib/messages";
import { customerFacingError } from "@/lib/public-error";
import { requireSession } from "@/lib/session";

async function participantBooking(bookingId: string) {
  const session = await requireSession(`/account/messages/${bookingId}`);
  const booking = await session.supabase
    .from("booking_requests")
    .select("id, status, customer_id, provider_id")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking.data) return null;
  const audience = booking.data.customer_id === session.user.id ? "customer" : "provider";
  return { session, booking: booking.data, audience: audience as "customer" | "provider" };
}

export async function sendMessage(formData: FormData) {
  const bookingId = String(formData.get("bookingId") ?? "");
  if (!isUuid(bookingId)) redirect("/account/messages?error=" + encodeURIComponent("That conversation could not be found."));
  const access = await participantBooking(bookingId);
  const fallback = bookingId ? `/account/messages/${bookingId}` : "/account/messages";
  if (!access) redirect(`${fallback}?error=${encodeURIComponent("That conversation could not be found.")}`);
  const path = messagePath(access.audience, bookingId);
  const prepared = prepareMessage(String(formData.get("body") ?? ""));
  if (!prepared.ok) redirect(`${path}?error=${encodeURIComponent(prepared.error)}`);
  if (!canMessageBooking(access.booking.status)) {
    redirect(`${path}?error=${encodeURIComponent("This conversation is closed.")}`);
  }
  const supplied = String(formData.get("clientId") ?? "");
  const clientId = isUuid(supplied)
    ? supplied
    : crypto.randomUUID();
  const inserted = await access.session.supabase.from("booking_messages").insert({
    booking_id: bookingId,
    sender_id: access.session.user.id,
    body: prepared.text,
    client_id: clientId,
  });
  if (inserted.error && inserted.error.code !== "23505") {
    redirect(`${path}?error=${encodeURIComponent(customerFacingError(inserted.error.message, "The message could not be sent."))}`);
  }
  revalidatePath(path);
  revalidatePath(access.audience === "customer" ? "/account/messages" : "/dashboard/messages");
  redirect(path);
}

export async function markMessagesRead(bookingId: string) {
  const access = await participantBooking(bookingId);
  if (!access) return;
  await access.session.supabase.from("booking_message_reads").upsert({
    booking_id: bookingId,
    reader_id: access.session.user.id,
    read_at: new Date().toISOString(),
  });
}
