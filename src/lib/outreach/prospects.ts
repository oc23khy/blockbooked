export const leadStatuses = ["new", "contacted", "interested", "not_interested", "suppressed"] as const;

export type LeadStatus = (typeof leadStatuses)[number];

export const csvHeaders = [
  "business_name",
  "category",
  "location",
  "website",
  "contact_email",
  "source",
  "lead_status",
] as const;

export const OUTREACH_CSV_LIMIT = 500;
export const OUTREACH_CSV_CHARS = 200_000;

const leadStatusSet = new Set<string>(leadStatuses);

export type ProspectDraft = {
  line: number;
  businessName: string;
  category: string;
  location: string;
  website: string;
  contactEmail: string;
  source: string;
  leadStatus: LeadStatus;
};

export type ClassifiedProspect = ProspectDraft & {
  outcome: "ready" | "duplicate" | "suppressed" | "invalid";
  reason: string;
  normalizedEmail: string;
  normalizedWebsite: string;
  duplicateKey: string;
};

export function isLeadStatus(value: string): value is LeadStatus {
  return leadStatusSet.has(value);
}

export function leadStatusLabel(status: LeadStatus) {
  if (status === "not_interested") return "Not interested";
  return status.slice(0, 1).toUpperCase() + status.slice(1);
}

export function plainField(value: string, max: number) {
  return value.replace(/^[=+\-@\t\r]+/, "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 320) return "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

export function normalizeWebsite(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200 || /[\s]/.test(trimmed)) return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.username || url.password) return "";
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!host || !/^[a-z0-9.-]+$/.test(host)) return "";
    const path = url.pathname.replace(/\/+$/, "").toLowerCase();
    if (path && !/^\/[a-z0-9._~%!$&'()*+,;=:@/-]*$/.test(path)) return "";
    return `${url.protocol}//${host}${path === "/" ? "" : path}`;
  } catch {
    return "";
  }
}

export function normalizeName(value: string) {
  return plainField(value, 120).toLowerCase();
}

export function duplicateKeys(input: { email: string; website: string; name: string; location: string }) {
  const keys: string[] = [];
  if (input.email) keys.push(`email:${input.email}`);
  if (input.website) keys.push(`site:${input.website}|${input.name}`);
  if (!input.email && !input.website && input.location) keys.push(`place:${input.name}|${input.location}`);
  if (!input.email && !input.website && !input.location) keys.push(`name:${input.name}`);
  return keys;
}

export function outreachSearchTerm(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9 @.+-]/g, "").trim().slice(0, 80);
}

export function outreachFilter(value: string) {
  const term = outreachSearchTerm(value);
  if (!term) return "";
  const pattern = `"%${term}%"`;
  return ["business_name", "category", "location", "contact_email", "source"]
    .map((column) => `${column}.ilike.${pattern}`)
    .join(",");
}

export function parseCsvTable(input: string) {
  const text = input.replace(/^\uFEFF/, "");
  if (text.length > OUTREACH_CSV_CHARS) return { error: "That CSV is too large.", rows: [] as string[][] };
  const rows: string[][] = [];
  let cell = "";
  let row: string[] = [];
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      cell = "";
      if (row.some((item) => item.trim() !== "")) rows.push(row);
      row = [];
      if (rows.length > OUTREACH_CSV_LIMIT + 1) return { error: `Import at most ${OUTREACH_CSV_LIMIT} prospects at a time.`, rows: [] as string[][] };
      continue;
    }
    cell += char;
  }
  if (quoted) return { error: "The CSV has an unfinished quoted value.", rows: [] as string[][] };
  row.push(cell);
  if (row.some((item) => item.trim() !== "")) rows.push(row);
  if (rows.length > OUTREACH_CSV_LIMIT + 1) return { error: `Import at most ${OUTREACH_CSV_LIMIT} prospects at a time.`, rows: [] as string[][] };
  return { error: "", rows };
}

export function parseProspectCsv(input: string): { error: string; drafts: (ProspectDraft & { invalidStatus?: boolean })[] } {
  const table = parseCsvTable(input);
  if (table.error) return { error: table.error, drafts: [] };
  if (table.rows.length < 2) return { error: "Add a header row and at least one prospect.", drafts: [] };
  const headers = table.rows[0]?.map((header) => header.trim().toLowerCase()) ?? [];
  if (csvHeaders.some((header) => !headers.includes(header))) {
    return { error: `Use these columns: ${csvHeaders.join(", ")}.`, drafts: [] };
  }
  const index = Object.fromEntries(csvHeaders.map((header) => [header, headers.indexOf(header)])) as Record<(typeof csvHeaders)[number], number>;
  const drafts: (ProspectDraft & { invalidStatus?: boolean })[] = [];
  for (let line = 1; line < table.rows.length; line += 1) {
    const cells = table.rows[line] ?? [];
    const requested = plainField(cells[index.lead_status] ?? "", 40).toLowerCase().replaceAll(" ", "_");
    drafts.push({
      line: line + 1,
      businessName: plainField(cells[index.business_name] ?? "", 120),
      category: plainField(cells[index.category] ?? "", 80),
      location: plainField(cells[index.location] ?? "", 120),
      website: plainField(cells[index.website] ?? "", 200),
      contactEmail: plainField(cells[index.contact_email] ?? "", 320),
      source: plainField(cells[index.source] ?? "", 80),
      leadStatus: isLeadStatus(requested) ? requested : "new",
      invalidStatus: Boolean(requested) && !isLeadStatus(requested),
    });
  }
  return { error: "", drafts };
}

export function classifyProspects(input: {
  drafts: (ProspectDraft & { invalidStatus?: boolean })[];
  existingKeys: string[];
  suppressedEmails: string[];
}): ClassifiedProspect[] {
  const seen = new Set(input.existingKeys);
  const suppressed = new Set(input.suppressedEmails.map((email) => normalizeEmail(email)).filter(Boolean));
  return input.drafts.map((draft) => {
    const email = normalizeEmail(draft.contactEmail);
    const website = normalizeWebsite(draft.website);
    const name = normalizeName(draft.businessName);
    const location = plainField(draft.location, 120).toLowerCase();
    const keys = duplicateKeys({ email, website, name, location });
    const key = keys[0] ?? `name:${name}`;
    const base = {
      ...draft,
      contactEmail: email || plainField(draft.contactEmail, 320),
      website: website || plainField(draft.website, 200),
      normalizedEmail: email,
      normalizedWebsite: website,
      duplicateKey: key,
    };
    if (!name) return { ...base, outcome: "invalid" as const, reason: "Business name is required." };
    if (draft.contactEmail.trim() && !email) return { ...base, outcome: "invalid" as const, reason: "Contact email is not valid." };
    if (draft.website.trim() && !website) return { ...base, outcome: "invalid" as const, reason: "Website must be an http or https address." };
    if (draft.invalidStatus) return { ...base, outcome: "invalid" as const, reason: "Lead status is not recognized." };
    if (email && suppressed.has(email)) return { ...base, outcome: "suppressed" as const, reason: "This email is opted out." };
    if (keys.some((item) => seen.has(item))) return { ...base, outcome: "duplicate" as const, reason: "This matches a prospect already in the list or in this file." };
    for (const item of keys) seen.add(item);
    return { ...base, outcome: "ready" as const, reason: "Ready to import." };
  });
}

export function classifyProspectCsv(input: { csv: string; existingKeys: string[]; suppressedEmails: string[] }) {
  const parsed = parseProspectCsv(input.csv);
  if (parsed.error) return { error: parsed.error, rows: [] as ClassifiedProspect[] };
  return { error: "", rows: classifyProspects({ drafts: parsed.drafts, existingKeys: input.existingKeys, suppressedEmails: input.suppressedEmails }) };
}
