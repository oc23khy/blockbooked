import { createClient } from "@/lib/supabase/server";
import { supabaseEnv } from "@/lib/supabase/env";
import { openSlots, type BusinessWindow, type TimeRange } from "./rules.ts";

export type CatalogService = {
  id: string;
  name: string;
  description: string;
  pricingType: "fixed" | "starting" | "quote";
  priceCents: number | null;
  durationMinutes: number | null;
};

export type ScheduleView = {
  timeZone: string;
  languages: string[];
  travelRadiusMiles: number | null;
  coverPath: string | null;
  services: CatalogService[];
  windows: BusinessWindow[];
  settings: { minNoticeMinutes: number; maxAdvanceDays: number; bufferMinutes: number } | null;
  images: { path: string; caption: string }[];
  slotsByService: Record<string, { start: string; end: string }[]>;
  busy: TimeRange[];
  timeOff: TimeRange[];
  scheduleError: string | null;
};

export function mediaUrl(path: string | null) {
  if (!path) return null;
  const { url } = supabaseEnv();
  return `${url}/storage/v1/object/public/provider-media/${path}`;
}

function asRanges(rows: { starts_at: string; ends_at: string }[] | null): TimeRange[] {
  return (rows ?? []).map((row) => ({ start: Date.parse(row.starts_at), end: Date.parse(row.ends_at) }));
}

export async function loadPublicSchedule(providerId: string): Promise<ScheduleView | null> {
  const supabase = await createClient();
  const now = new Date();
  const horizon = new Date(now.getTime() + 120 * 86_400_000);
  const [provider, services, hours, settings, images, busy, timeOff] = await Promise.all([
    supabase.from("providers").select("timezone, languages, travel_radius_miles, cover_image_path").eq("id", providerId).maybeSingle(),
    supabase.from("provider_services").select("id, name, description, pricing_type, price_cents, duration_minutes").eq("provider_id", providerId).eq("active", true).order("sort_order"),
    supabase.from("provider_business_hours").select("weekday, opens_minute, closes_minute").eq("provider_id", providerId).order("weekday"),
    supabase.from("provider_schedule_settings").select("min_notice_minutes, max_advance_days, buffer_minutes").eq("provider_id", providerId).maybeSingle(),
    supabase.from("provider_images").select("storage_path, caption").eq("provider_id", providerId).order("sort_order"),
    supabase.rpc("provider_busy_ranges", { target: providerId, range_start: now.toISOString(), range_end: horizon.toISOString() }),
    supabase.rpc("provider_time_off_ranges", { target: providerId, range_start: now.toISOString(), range_end: horizon.toISOString() }),
  ]);

  if (provider.error || !provider.data) return null;
  const scheduleError =
    services.error?.message || hours.error?.message || settings.error?.message || busy.error?.message || timeOff.error?.message || null;
  const windows = ((hours.error ? [] : hours.data) ?? []).map((window) => ({
    weekday: window.weekday,
    opensMinute: window.opens_minute,
    closesMinute: window.closes_minute,
  }));
  const catalog = ((services.error ? [] : services.data) ?? []) as {
    id: string;
    name: string;
    description: string;
    pricing_type: "fixed" | "starting" | "quote";
    price_cents: number | null;
    duration_minutes: number | null;
  }[];
  const saved = settings.data as { min_notice_minutes: number; max_advance_days: number; buffer_minutes: number } | null;
  const busyRanges = asRanges(busy.data as { starts_at: string; ends_at: string }[] | null);
  const timeOffRanges = asRanges(timeOff.data as { starts_at: string; ends_at: string }[] | null);
  const slotsByService: Record<string, { start: string; end: string }[]> = {};
  if (!scheduleError && saved && windows.length > 0) {
    for (const service of catalog) {
      if (!service.duration_minutes) continue;
      slotsByService[service.id] = openSlots({
        timeZone: provider.data.timezone,
        windows,
        durationMinutes: service.duration_minutes,
        bufferMinutes: saved.buffer_minutes,
        minNoticeMinutes: saved.min_notice_minutes,
        maxAdvanceDays: saved.max_advance_days,
        busy: busyRanges,
        timeOff: timeOffRanges,
        now,
      });
    }
  }

  return {
    timeZone: provider.data.timezone,
    languages: provider.data.languages ?? [],
    travelRadiusMiles: provider.data.travel_radius_miles,
    coverPath: provider.data.cover_image_path,
    services: catalog.map((service) => ({
      id: service.id,
      name: service.name,
      description: service.description,
      pricingType: service.pricing_type,
      priceCents: service.price_cents,
      durationMinutes: service.duration_minutes,
    })),
    windows,
    settings: saved
      ? {
          minNoticeMinutes: saved.min_notice_minutes,
          maxAdvanceDays: saved.max_advance_days,
          bufferMinutes: saved.buffer_minutes,
        }
      : null,
    images: ((images.data ?? []) as { storage_path: string; caption: string }[]).map((image) => ({
      path: image.storage_path,
      caption: image.caption,
    })),
    slotsByService,
    busy: busyRanges,
    timeOff: timeOffRanges,
    scheduleError,
  };
}
