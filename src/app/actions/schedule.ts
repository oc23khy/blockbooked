"use server";

import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { parseCatalogSubmission, type CatalogFormState } from "@/lib/scheduling/catalog";
import { localInstants } from "@/lib/scheduling/rules";
import { detectProviderImage, MAX_PROVIDER_IMAGE_BYTES } from "@/lib/images/sniff";
import { customerFacingError } from "@/lib/public-error";
import { redirectIfRateLimited } from "@/lib/rate-limit";
import { requireSession } from "@/lib/session";

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

async function ownedProvider(operation: "providerSchedule" | "providerImage" = "providerSchedule") {
  const session = await requireSession("/dashboard");
  await redirectIfRateLimited(operation, session.user.id, "/dashboard");
  if (session.profile.role !== "provider" && session.profile.role !== "admin") redirect("/list-your-business");
  const { data } = await session.supabase.from("providers").select("id, timezone").eq("owner_id", session.user.id).maybeSingle();
  if (!data) redirect("/dashboard?error=Create%20your%20listing%20first");
  return { session, providerId: data.id as string, timeZone: (data.timezone as string) || "America/Chicago" };
}

function minutes(value: string) {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function back(error: string): never {
  redirect(`/dashboard?error=${encodeURIComponent(customerFacingError(error, "That change could not be saved."))}`);
}

export async function saveScheduleSettings(formData: FormData) {
  const { session, providerId } = await ownedProvider();
  const noticeHours = Number(formData.get("noticeHours"));
  const advanceDays = Number(formData.get("advanceDays"));
  const bufferMinutes = Number(formData.get("bufferMinutes"));
  if (!Number.isInteger(noticeHours) || noticeHours < 0 || noticeHours > 168) back("Minimum notice must be 0 to 168 hours.");
  if (!Number.isInteger(advanceDays) || advanceDays < 1 || advanceDays > 365) back("Booking window must be 1 to 365 days.");
  if (!Number.isInteger(bufferMinutes) || bufferMinutes < 0 || bufferMinutes > 240) back("Buffer must be 0 to 240 minutes.");
  const { error } = await session.supabase.from("provider_schedule_settings").upsert({
    provider_id: providerId,
    min_notice_minutes: noticeHours * 60,
    max_advance_days: advanceDays,
    buffer_minutes: bufferMinutes,
    updated_at: new Date().toISOString(),
  });
  if (error) back(error.message);
  revalidatePath("/dashboard");
  revalidatePath(`/providers/${providerId}`);
  redirect("/dashboard?notice=Schedule%20settings%20saved");
}

export async function saveBusinessHours(formData: FormData) {
  const { session, providerId } = await ownedProvider();
  const rows: { provider_id: string; weekday: number; opens_minute: number; closes_minute: number }[] = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const open = String(formData.get(`open-${weekday}`) ?? "");
    const close = String(formData.get(`close-${weekday}`) ?? "");
    if (!open && !close) continue;
    const opens = minutes(open);
    const closes = minutes(close);
    if (opens == null || closes == null || closes <= opens) back(`${weekdays[weekday]} needs an opening time before the closing time.`);
    const breakStart = minutes(String(formData.get(`break-start-${weekday}`) ?? ""));
    const breakEnd = minutes(String(formData.get(`break-end-${weekday}`) ?? ""));
    if ((breakStart == null) !== (breakEnd == null)) back(`${weekdays[weekday]} needs both ends of the break.`);
    if (breakStart != null && breakEnd != null) {
      if (breakEnd <= breakStart || breakStart <= opens || breakEnd >= closes) {
        back(`${weekdays[weekday]} break must sit inside the open hours.`);
      }
      rows.push({ provider_id: providerId, weekday, opens_minute: opens, closes_minute: breakStart });
      rows.push({ provider_id: providerId, weekday, opens_minute: breakEnd, closes_minute: closes });
    } else {
      rows.push({ provider_id: providerId, weekday, opens_minute: opens, closes_minute: closes });
    }
  }
  const removed = await session.supabase.from("provider_business_hours").delete().eq("provider_id", providerId);
  if (removed.error) back(removed.error.message);
  if (rows.length > 0) {
    const inserted = await session.supabase.from("provider_business_hours").insert(rows);
    if (inserted.error) back(inserted.error.message);
  }
  revalidatePath("/dashboard");
  revalidatePath(`/providers/${providerId}`);
  redirect("/dashboard?notice=Business%20hours%20saved");
}

export async function saveCatalogServices(previous: CatalogFormState, formData: FormData): Promise<CatalogFormState> {
  const parsed = parseCatalogSubmission(formData);
  const failed = (error: string): CatalogFormState => ({
    error: customerFacingError(error, "That service could not be saved."),
    drafts: parsed.drafts,
    attempt: previous.attempt + 1,
  });
  if (parsed.error) return failed(parsed.error);

  const { session, providerId } = await ownedProvider();
  for (const row of parsed.rows) {
    const payload = {
      provider_id: providerId,
      name: row.name,
      description: row.description,
      pricing_type: row.pricing,
      price_cents: row.priceCents,
      duration_minutes: row.durationMinutes,
      sort_order: row.index,
      active: row.active,
      updated_at: new Date().toISOString(),
    };
    const saved = row.id
      ? await session.supabase.from("provider_services").update(payload).eq("id", row.id).eq("provider_id", providerId).select("id")
      : await session.supabase.from("provider_services").insert(payload).select("id");
    if (saved.error) return failed(saved.error.message);
    const returned = Array.isArray(saved.data) ? saved.data : saved.data ? [saved.data] : [];
    if (returned.length !== 1) {
      return failed("Supabase did not save that service. Refresh the dashboard and try again. Nothing was reported as saved.");
    }
    parsed.drafts[row.index].id = String(returned[0].id);
  }

  const catalog = await session.supabase
    .from("provider_services")
    .select("name, description, pricing_type, price_cents, duration_minutes, active")
    .eq("provider_id", providerId)
    .eq("active", true)
    .order("sort_order");
  if (catalog.error) return failed(catalog.error.message);
  const visible = catalog.data ?? [];
  if (parsed.rows.some((row) => row.active) && visible.length === 0) {
    return failed("The service could not be read back after saving, so it was not published. Refresh the dashboard and check this form before trying again.");
  }
  const prices = visible
    .map((service) => (service.pricing_type === "quote" || service.price_cents == null ? null : Math.round(service.price_cents / 100)))
    .filter((price): price is number => price != null && price > 0);
  const synced = await session.supabase
    .from("providers")
    .update({
      services: visible.map((service) => ({
        name: service.name,
        detail: service.description,
        price: service.pricing_type === "quote" || service.price_cents == null ? "Quote" : `$${(service.price_cents / 100).toFixed(2)}`,
      })),
      ...(prices.length > 0 ? { price_from: Math.min(...prices) } : {}),
    })
    .eq("id", providerId)
    .select("id");
  if (synced.error) return failed(synced.error.message);
  if ((synced.data ?? []).length !== 1) {
    return failed("The service was saved, but the public service list could not be updated. Refresh the dashboard.");
  }

  revalidatePath("/dashboard");
  revalidatePath(`/providers/${providerId}`);
  const bookable = visible.some((service) => service.duration_minutes != null);
  const notice = bookable
    ? "Services saved. Customers can book an exact time for every shown service that has a duration."
    : "Services saved. Add a duration of 15 to 480 minutes before customers can book an exact time.";
  redirect(`/dashboard?notice=${encodeURIComponent(notice)}`);
}

export async function addTimeOff(formData: FormData) {
  const { session, providerId, timeZone } = await ownedProvider();
  const startDate = String(formData.get("startDate") ?? "");
  const startTime = String(formData.get("startTime") ?? "");
  const endDate = String(formData.get("endDate") ?? "");
  const endTime = String(formData.get("endTime") ?? "");
  const startMinute = minutes(startTime);
  const endMinute = minutes(endTime);
  const starts = startMinute == null ? [] : localInstants(startDate, startMinute, timeZone);
  const ends = endMinute == null ? [] : localInstants(endDate, endMinute, timeZone);
  if (starts.length !== 1 || ends.length !== 1 || ends[0].getTime() <= starts[0].getTime()) {
    back("Enter a blocked range in your listing time zone. Ambiguous or missing clock times are not accepted.");
  }
  const { error } = await session.supabase.from("provider_time_off").insert({
    provider_id: providerId,
    starts_at: starts[0].toISOString(),
    ends_at: ends[0].toISOString(),
    note: String(formData.get("note") ?? "").trim().slice(0, 80),
  });
  if (error) back(error.message);
  revalidatePath("/dashboard");
  revalidatePath(`/providers/${providerId}`);
  redirect("/dashboard?notice=Blocked%20time%20saved");
}

export async function removeTimeOff(formData: FormData) {
  const { session, providerId } = await ownedProvider();
  const id = String(formData.get("timeOffId") ?? "");
  const { error } = await session.supabase.from("provider_time_off").delete().eq("id", id).eq("provider_id", providerId);
  if (error) back(error.message);
  revalidatePath("/dashboard");
  revalidatePath(`/providers/${providerId}`);
  redirect("/dashboard?notice=Blocked%20time%20removed");
}

export async function uploadProviderImage(formData: FormData) {
  try {
    const { session, providerId } = await ownedProvider("providerImage");
    const file = formData.get("image");
    if (!(file instanceof File) || file.size === 0) back("Choose an image.");
    if (file.size > MAX_PROVIDER_IMAGE_BYTES) back("Images must be 5 MB or smaller.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const image = detectProviderImage(bytes);
    if (!image) back("Use a JPEG, PNG, or WebP image.");
    const path = `${providerId}/${crypto.randomUUID()}.${image.extension}`;
    const uploaded = await session.supabase.storage.from("provider-media").upload(path, bytes, {
      contentType: image.mime,
      upsert: false,
    });
    if (uploaded.error) back(uploaded.error.message);
    const saved = await session.supabase.from("provider_images").insert({
      provider_id: providerId,
      storage_path: path,
      caption: String(formData.get("caption") ?? "").trim().slice(0, 120),
      sort_order: 0,
    });
    if (saved.error) back(saved.error.message);
    if (formData.get("cover") === "yes") {
      const cover = await session.supabase.from("providers").update({ cover_image_path: path }).eq("id", providerId);
      if (cover.error) back(cover.error.message);
    }
    revalidatePath("/dashboard");
    revalidatePath(`/providers/${providerId}`);
    redirect("/dashboard?notice=Photo%20saved");
  } catch (error) {
    unstable_rethrow(error);
    console.error("provider-image", error instanceof Error ? error.message : "upload failed");
    back("The photo could not be saved.");
  }
}
