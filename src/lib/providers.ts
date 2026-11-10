import type { Provider, ServiceOffering } from "@/lib/marketplace";
import { initialsFor, isServiceTown, toneFor } from "@/lib/marketplace";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export type ProviderRow = {
  id: string;
  owner_id: string;
  business_name: string;
  category_id: string;
  specialty: string;
  about: string;
  service_areas: string[];
  price_from: number;
  price_unit: string;
  services: ServiceOffering[];
  availability: string;
  response_time: string;
  years: number;
  status: "pending" | "approved" | "rejected";
  is_demo: boolean;
  review_note: string | null;
  timezone?: string;
  languages?: string[];
  travel_radius_miles?: number | null;
  cover_image_path?: string | null;
};

export type ProfileRow = {
  id: string;
  role: "customer" | "provider" | "admin";
  full_name: string;
  phone: string;
  email: string;
};

export type BookingRow = {
  id: string;
  customer_id: string;
  provider_id: string;
  preferred_date: string;
  time_window: string;
  notes: string;
  contact_phone: string;
  service_name: string;
  status: string;
  created_at: string;
};

export function toProvider(row: ProviderRow): Provider {
  const areas = row.service_areas ?? [];
  return {
    id: row.id,
    name: row.business_name,
    categoryId: row.category_id,
    specialty: row.specialty,
    neighborhood: areas[0] ?? "Illinois",
    city: "Illinois",
    demo: row.is_demo,
    rating: 0,
    reviewCount: 0,
    priceFrom: Number(row.price_from),
    priceUnit: row.price_unit,
    responseTime: row.response_time,
    years: row.years,
    about: row.about,
    services: Array.isArray(row.services) ? row.services : [],
    tags: areas,
    nextOpening: row.availability,
    initials: initialsFor(row.business_name),
    tone: toneFor(row.id),
    serviceAreas: areas,
    status: row.status,
    ownerId: row.owner_id,
  };
}

export async function getPublicProviders(): Promise<{ providers: Provider[]; error: string | null }> {
  if (!isSupabaseConfigured()) return { providers: [], error: null };

  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("providers")
      .select("*")
      .eq("status", "approved")
      .order("business_name");

    if (error) return { providers: [], error: error.message };
    return { providers: ((data ?? []) as ProviderRow[]).map(toProvider), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not reach Supabase.";
    return { providers: [], error: message };
  }
}

export async function getVisibleProvider(id: string) {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.from("providers").select("*").eq("id", id).maybeSingle();
  if (error || !data) return null;
  return toProvider(data as ProviderRow);
}
