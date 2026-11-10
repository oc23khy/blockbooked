export type CatalogDraft = {
  id: string;
  name: string;
  pricing: string;
  price: string;
  duration: string;
  active: string;
  detail: string;
};

export type CatalogFormState = {
  error: string | null;
  drafts: CatalogDraft[];
  attempt: number;
};

export type CatalogRow = {
  index: number;
  id: string | null;
  name: string;
  description: string;
  pricing: "fixed" | "starting" | "quote";
  priceCents: number | null;
  durationMinutes: number | null;
  active: boolean;
};

const serviceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function emptyCatalogDraft(): CatalogDraft {
  return { id: "", name: "", pricing: "fixed", price: "", duration: "", active: "yes", detail: "" };
}

export function catalogDraftsFromServices(
  services: {
    id: string;
    name: string;
    description: string;
    pricing_type: string;
    price_cents: number | null;
    duration_minutes: number | null;
    active: boolean;
  }[],
): CatalogDraft[] {
  const drafts = services.slice(0, 8).map((service) => ({
    id: service.id,
    name: service.name,
    pricing: service.pricing_type,
    price: service.price_cents == null ? "" : (service.price_cents / 100).toFixed(2),
    duration: service.duration_minutes == null ? "" : String(service.duration_minutes),
    active: service.active ? "yes" : "no",
    detail: service.description,
  }));
  while (drafts.length < 4) drafts.push(emptyCatalogDraft());
  return drafts;
}

function dollarsToCents(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const amount = Number(cleaned);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

function durationMinutes(raw: string): number | null {
  if (!raw) return null;
  const match = raw.match(/^(\d+)\s*(?:minutes|minute|mins|min)?$/i);
  if (!match) return null;
  return Number(match[1]);
}

export function parseCatalogSubmission(formData: FormData): {
  error: string | null;
  rows: CatalogRow[];
  drafts: CatalogDraft[];
} {
  const drafts: CatalogDraft[] = [];
  for (let index = 0; index < 8; index += 1) {
    drafts.push({
      id: String(formData.get(`id-${index}`) ?? "").trim(),
      name: String(formData.get(`name-${index}`) ?? "").trim(),
      pricing: String(formData.get(`pricing-${index}`) ?? "fixed").trim(),
      price: String(formData.get(`price-${index}`) ?? "").trim(),
      duration: String(formData.get(`duration-${index}`) ?? "").trim(),
      active: String(formData.get(`active-${index}`) ?? "yes").trim() || "yes",
      detail: String(formData.get(`detail-${index}`) ?? "").trim(),
    });
  }

  const touched = drafts.filter((draft) => draft.id || draft.name || draft.price || draft.duration || draft.detail);
  if (touched.length === 0) {
    return {
      error:
        "No service was saved. Enter a service name, price, and duration in this form, then click Save services. The business profile starting price does not create a bookable service.",
      rows: [],
      drafts,
    };
  }

  const rows: CatalogRow[] = [];
  for (const [index, draft] of drafts.entries()) {
    const used = draft.id || draft.name || draft.price || draft.duration || draft.detail;
    if (!used) continue;
    if (!draft.name) {
      return {
        error: "A saved service needs a name. Choose Hidden to stop offering it, instead of erasing the name.",
        rows: [],
        drafts,
      };
    }
    if (draft.id && !serviceIdPattern.test(draft.id)) {
      return { error: "This service form is out of date. Refresh the dashboard and enter the service again.", rows: [], drafts };
    }
    if (draft.pricing !== "fixed" && draft.pricing !== "starting" && draft.pricing !== "quote") {
      return { error: `${draft.name} needs fixed, starting, or quote pricing.`, rows: [], drafts };
    }
    const cents = dollarsToCents(draft.price);
    if (draft.pricing === "quote" && draft.price) {
      return { error: `${draft.name} is quote-only, so leave the price empty.`, rows: [], drafts };
    }
    if (draft.pricing !== "quote" && (cents == null || cents <= 0)) {
      return { error: `${draft.name} needs a price greater than zero.`, rows: [], drafts };
    }
    const duration = durationMinutes(draft.duration);
    if (draft.duration && (duration == null || !Number.isInteger(duration) || duration < 15 || duration > 480)) {
      return { error: `${draft.name} duration must be 15 to 480 minutes.`, rows: [], drafts };
    }
    rows.push({
      index,
      id: draft.id || null,
      name: draft.name.slice(0, 80),
      description: draft.detail.slice(0, 1000),
      pricing: draft.pricing,
      priceCents: draft.pricing === "quote" ? null : cents,
      durationMinutes: duration,
      active: draft.active !== "no",
    });
  }

  return { error: null, rows, drafts };
}
