import type { Metadata } from "next";
import { addOutreachProspect, addOutreachSuppression, removeOutreachSuppression, updateOutreachStatus } from "@/app/actions/outreach";
import { OutreachImporter } from "@/components/outreach-importer";
import { isLeadStatus, leadStatusLabel, leadStatuses, normalizeWebsite, outreachFilter, outreachSearchTerm, type LeadStatus } from "@/lib/outreach/prospects";
import { shownError } from "@/lib/public-error";
import { requireAdmin } from "@/lib/session";

export const metadata: Metadata = { title: "Admin outreach · BlockBooked" };

const pageSize = 40;

type ProspectRow = {
  id: string;
  business_name: string;
  category: string;
  location: string;
  website: string;
  contact_email: string;
  source: string;
  lead_status: LeadStatus;
};

type SuppressionRow = {
  id: string;
  normalized_email: string;
  reason: string;
  created_at: string;
};

export default async function AdminOutreachPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string; q?: string; status?: string; page?: string }>;
}) {
  const query = await searchParams;
  const { supabase } = await requireAdmin("/admin/outreach");
  const status = query.status && isLeadStatus(query.status) ? query.status : "";
  const term = outreachSearchTerm(query.q ?? "");
  const page = Math.min(100, Math.max(1, Number(query.page) || 1));
  const from = (page - 1) * pageSize;
  let prospects = supabase
    .from("outreach_prospects")
    .select("id, business_name, category, location, website, contact_email, source, lead_status", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, from + pageSize - 1);
  if (status) prospects = prospects.eq("lead_status", status);
  const filterExpression = outreachFilter(term);
  if (filterExpression) prospects = prospects.or(filterExpression);
  const [listed, suppressed] = await Promise.all([
    prospects,
    supabase.from("outreach_suppressions").select("id, normalized_email, reason, created_at").order("created_at", { ascending: false }).limit(50),
  ]);
  const rows = ((listed.data ?? []) as ProspectRow[]).filter((row) => isLeadStatus(row.lead_status));
  const blocks = (suppressed.data ?? []) as SuppressionRow[];
  const total = listed.count ?? rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const filter = new URLSearchParams();
  if (term) filter.set("q", term);
  if (status) filter.set("status", status);
  const filterQuery = filter.toString();

  return (
    <main>
      <h1 className="font-serif text-4xl tracking-tight text-ink">Outreach</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-ink/70">
        Keep a private list of businesses to contact later. Opted-out emails stay suppressed and are not imported again. This page does not send email.
      </p>
      {query.notice ? <p className="mt-4 text-sm font-medium text-ink">{query.notice}</p> : null}
      {shownError(query.error || listed.error?.message || suppressed.error?.message) ? (
        <p className="mt-4 text-sm font-medium text-accent-dark">{shownError(query.error || listed.error?.message || suppressed.error?.message)}</p>
      ) : null}

      <form method="get" className="mt-6 flex flex-wrap gap-2">
        <input
          name="q"
          defaultValue={query.q ?? ""}
          placeholder="Name, email, city, source"
          className="min-w-48 flex-1 rounded-xl border border-line bg-sand px-3 py-2 text-sm outline-none focus:border-ink"
        />
        <select name="status" defaultValue={status} className="rounded-xl border border-line bg-sand px-3 py-2 text-sm">
          <option value="">Any status</option>
          {leadStatuses.map((item) => (
            <option key={item} value={item}>{leadStatusLabel(item)}</option>
          ))}
        </select>
        <button type="submit" className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white">Filter</button>
      </form>

      <div className="mt-4 overflow-x-auto rounded-3xl border border-line bg-card">
        <table className="w-full min-w-[52rem] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-ink/50">
            <tr>
              <th className="px-4 py-3 font-semibold">Business</th>
              <th className="px-3 py-3 font-semibold">Location</th>
              <th className="px-3 py-3 font-semibold">Contact</th>
              <th className="px-3 py-3 font-semibold">Source</th>
              <th className="px-4 py-3 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-ink/70">No prospects match.</td>
              </tr>
            ) : (
              rows.map((row) => {
                const website = normalizeWebsite(row.website);
                return (
                  <tr key={row.id} className="border-t border-line align-top">
                    <td className="px-4 py-3">
                      <p className="font-semibold text-ink">{row.business_name}</p>
                      <p className="text-ink/60">{row.category || "Uncategorized"}</p>
                    </td>
                    <td className="px-3 py-3 text-ink/75">{row.location || "—"}</td>
                    <td className="px-3 py-3 text-ink/75">
                      <p>{row.contact_email || "No email"}</p>
                      {website ? (
                        <a href={website} target="_blank" rel="noreferrer" className="text-ink underline decoration-line underline-offset-2">
                          {website.replace(/^https?:\/\//, "")}
                        </a>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 text-ink/75">{row.source || "—"}</td>
                    <td className="px-4 py-3">
                      <form action={updateOutreachStatus} className="flex gap-2">
                        <input type="hidden" name="prospectId" value={row.id} />
                        <select name="leadStatus" defaultValue={row.lead_status} className="rounded-lg border border-line bg-sand px-2 py-1 text-xs">
                          {leadStatuses.map((item) => (
                            <option key={item} value={item}>{leadStatusLabel(item)}</option>
                          ))}
                        </select>
                        <button type="submit" className="rounded-full border border-ink px-3 py-1 text-xs font-semibold text-ink">Save</button>
                      </form>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink/50">{total} prospects</p>
      {pages > 1 ? (
        <p className="mt-2 flex gap-3 text-sm">
          {page > 1 ? <a className="font-semibold text-ink underline" href={`/admin/outreach?${filterQuery}${filterQuery ? "&" : ""}page=${page - 1}`}>Previous</a> : null}
          {page < pages ? <a className="font-semibold text-ink underline" href={`/admin/outreach?${filterQuery}${filterQuery ? "&" : ""}page=${page + 1}`}>Next</a> : null}
        </p>
      ) : null}

      <div className="mt-8 grid gap-4 xl:grid-cols-2">
        <OutreachImporter />
        <form action={addOutreachProspect} className="rounded-3xl border border-line bg-card p-4">
          <h2 className="font-serif text-2xl text-ink">Add one prospect</h2>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <input name="businessName" required maxLength={120} placeholder="Business name" className="rounded-xl border border-line bg-sand px-3 py-2 text-sm outline-none focus:border-ink" />
            <input name="category" maxLength={80} placeholder="Category" className="rounded-xl border border-line bg-sand px-3 py-2 text-sm outline-none focus:border-ink" />
            <input name="location" maxLength={120} placeholder="City or area" className="rounded-xl border border-line bg-sand px-3 py-2 text-sm outline-none focus:border-ink" />
            <input name="website" maxLength={200} placeholder="Website" className="rounded-xl border border-line bg-sand px-3 py-2 text-sm outline-none focus:border-ink" />
            <input name="contactEmail" maxLength={320} placeholder="Contact email" className="rounded-xl border border-line bg-sand px-3 py-2 text-sm outline-none focus:border-ink" />
            <input name="source" maxLength={80} placeholder="Source" className="rounded-xl border border-line bg-sand px-3 py-2 text-sm outline-none focus:border-ink" />
            <select name="leadStatus" defaultValue="new" className="rounded-xl border border-line bg-sand px-3 py-2 text-sm">
              {leadStatuses.filter((item) => item !== "suppressed").map((item) => (
                <option key={item} value={item}>{leadStatusLabel(item)}</option>
              ))}
            </select>
          </div>
          <button type="submit" className="mt-3 rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white">Add prospect</button>
        </form>
      </div>

      <section className="mt-4 rounded-3xl border border-line bg-card p-4">
        <h2 className="font-serif text-2xl text-ink">Opted-out emails</h2>
        <p className="mt-1 text-sm leading-6 text-ink/70">A suppression blocks that email from future imports and marks matching prospects suppressed.</p>
        <form action={addOutreachSuppression} className="mt-3 flex flex-wrap gap-2">
          <input name="email" type="email" required maxLength={320} placeholder="name@example.com" className="min-w-52 flex-1 rounded-xl border border-line bg-sand px-3 py-2 text-sm outline-none focus:border-ink" />
          <input name="reason" maxLength={160} placeholder="Reason" className="min-w-40 flex-1 rounded-xl border border-line bg-sand px-3 py-2 text-sm outline-none focus:border-ink" />
          <button type="submit" className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white">Suppress</button>
        </form>
        <ul className="mt-4 grid gap-2">
          {blocks.length === 0 ? <li className="text-sm text-ink/70">No suppressions yet.</li> : null}
          {blocks.map((block) => (
            <li key={block.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-2 text-sm">
              <span className="text-ink">{block.normalized_email}<span className="text-ink/50"> · {block.reason}</span></span>
              <form action={removeOutreachSuppression}>
                <input type="hidden" name="suppressionId" value={block.id} />
                <button type="submit" className="rounded-full border border-ink px-3 py-1 text-xs font-semibold text-ink">Remove</button>
              </form>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
