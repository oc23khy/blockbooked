"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { categories, isServiceTown, serviceTowns, type ServiceOffering } from "@/lib/marketplace";
import { requireSession } from "@/lib/session";

function parseServices(raw: string): ServiceOffering[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const name = String(record.name ?? "").trim();
      const detail = String(record.detail ?? "").trim();
      const price = String(record.price ?? "").trim();
      if (!name) return null;
      return { name, detail, price };
    })
    .filter((item): item is ServiceOffering => item !== null)
    .slice(0, 12);
}

function readListing(formData: FormData) {
  const businessName = String(formData.get("businessName") ?? "").trim();
  const categoryId = String(formData.get("categoryId") ?? "");
  const specialty = String(formData.get("specialty") ?? "").trim();
  const about = String(formData.get("about") ?? "").trim();
  const priceFrom = Number(formData.get("priceFrom") ?? 0);
  const priceUnit = String(formData.get("priceUnit") ?? "visit").trim() || "visit";
  const availability = String(formData.get("availability") ?? "").trim();
  const timezone = String(formData.get("timezone") ?? "America/Chicago");
  const languages = String(formData.get("languages") ?? "")
    .split(",")
    .map((language) => language.trim())
    .filter(Boolean)
    .slice(0, 8);
  const travelRaw = String(formData.get("travelRadius") ?? "").trim();
  const travelRadius = travelRaw === "" ? null : Number(travelRaw);
  const responseTime = String(formData.get("responseTime") ?? "").trim();
  const years = Number(formData.get("years") ?? 0);
  const areas = formData
    .getAll("serviceAreas")
    .map(String)
    .filter(isServiceTown);
  const namedServices = formData.getAll("serviceName");
  const services =
    namedServices.length > 0
      ? namedServices
          .map((name, index) => ({
            name: String(name).trim(),
            detail: String(formData.getAll("serviceDetail")[index] ?? "").trim(),
            price: String(formData.getAll("servicePrice")[index] ?? "").trim(),
          }))
          .filter((service) => service.name)
          .slice(0, 12)
      : parseServices(String(formData.get("services") ?? "[]"));
  const resubmit = formData.get("resubmit") === "yes";

  if (!businessName) return { error: "Add a business name." };
  if (!categories.some((category) => category.id === categoryId)) {
    return { error: "Choose a service category." };
  }
  if (!Number.isFinite(priceFrom) || priceFrom < 0) return { error: "Enter a starting price of zero or more." };
  if (!Number.isInteger(years) || years < 0 || years > 80) return { error: "Enter years of experience as a whole number." };
  if (areas.length === 0) return { error: `Choose at least one town: ${serviceTowns.join(", ")}.` };
  if (!["America/Chicago", "America/New_York", "America/Denver", "America/Los_Angeles", "America/Phoenix"].includes(timezone)) {
    return { error: "Choose a supported time zone." };
  }
  if (languages.some((language) => language.length > 40)) return { error: "Each language must be 40 characters or fewer." };
  if (travelRadius != null && (!Number.isInteger(travelRadius) || travelRadius < 0 || travelRadius > 150)) {
    return { error: "Travel radius must be a whole number from 0 to 150 miles, or blank." };
  }

  return {
    error: null,
    values: {
      business_name: businessName,
      category_id: categoryId,
      specialty,
      about,
      price_from: priceFrom,
      price_unit: priceUnit.slice(0, 40),
      availability,
      timezone,
      languages,
      travel_radius_miles: travelRadius,
      response_time: responseTime,
      years,
      service_areas: areas,
      services,
      resubmit,
    },
  };
}

export async function saveProviderListing(formData: FormData) {
  const session = await requireSession("/dashboard");
  if (session.profile.role !== "provider" && session.profile.role !== "admin") {
    redirect("/list-your-business");
  }

  const listing = readListing(formData);
  if (listing.error || !listing.values) {
    redirect(`/dashboard?error=${encodeURIComponent(listing.error ?? "Could not save.")}`);
  }

  const { resubmit, ...values } = listing.values;
  const { data: existing } = await session.supabase
    .from("providers")
    .select("id, status")
    .eq("owner_id", session.user.id)
    .maybeSingle();

  const payload = {
    ...values,
    owner_id: session.user.id,
    ...(resubmit && existing?.status === "rejected" ? { status: "pending" as const } : {}),
  };

  const query = existing
    ? session.supabase.from("providers").update(payload).eq("id", existing.id)
    : session.supabase.from("providers").insert(payload);

  const { error } = await query;
  if (error) redirect(`/dashboard?error=${encodeURIComponent(error.message)}`);

  revalidatePath("/");
  revalidatePath("/dashboard");
  revalidatePath("/admin");
  redirect("/dashboard?notice=Listing%20saved");
}

export async function reviewProvider(formData: FormData) {
  const session = await requireSession("/admin");
  if (session.profile.role !== "admin") redirect("/");

  const id = String(formData.get("providerId") ?? "");
  const decision = formData.get("decision") === "approved" ? "approved" : "rejected";
  const reviewNote = String(formData.get("reviewNote") ?? "").trim();

  const { error } = await session.supabase
    .from("providers")
    .update({ status: decision, review_note: reviewNote || null })
    .eq("id", id);

  if (error) redirect(`/admin/providers?error=${encodeURIComponent(error.message)}`);

  revalidatePath("/");
  revalidatePath("/admin");
  revalidatePath("/admin/providers");
  revalidatePath(`/providers/${id}`);
  redirect("/admin/providers?notice=Application%20updated");
}
