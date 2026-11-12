import type { Metadata } from "next";
import { reviewProvider } from "@/app/actions/providers";
import { categoryName } from "@/lib/marketplace";
import type { ProviderRow } from "@/lib/providers";
import { shownError } from "@/lib/public-error";
import { requireAdmin } from "@/lib/session";

export const metadata: Metadata = { title: "Admin providers · BlockBooked" };

export default async function AdminProvidersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string; q?: string; status?: string }>;
}) {
  const query = await searchParams;
  const { supabase } = await requireAdmin("/admin/providers");
  const { data, error } = await supabase.from("providers").select("*").order("created_at", { ascending: false });
  const needle = query.q?.trim().toLowerCase() ?? "";
  const listings = ((data ?? []) as ProviderRow[]).filter((listing) => {
    if (query.status && listing.status !== query.status) return false;
    if (!needle) return true;
    return [listing.business_name, listing.specialty, listing.category_id].join(" ").toLowerCase().includes(needle);
  });

  return (
    <main>
      <h1 className="font-serif text-4xl tracking-tight text-ink">Providers</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-ink/70">
        Pending applications can be approved or rejected. Approved listings are published. There is no separate suspended
        status, so this page does not invent one.
      </p>
      {query.notice ? <p className="mt-4 text-sm font-medium text-ink">{query.notice}</p> : null}
      {shownError(query.error || error?.message) ? <p className="mt-4 text-sm font-medium text-accent-dark">{shownError(query.error || error?.message)}</p> : null}
      <form method="get" className="mt-6 flex flex-wrap gap-3">
        <input
          name="q"
          defaultValue={query.q ?? ""}
          placeholder="Business or specialty"
          className="rounded-xl border border-line bg-sand px-3 py-2 text-sm outline-none focus:border-ink"
        />
        <select name="status" defaultValue={query.status ?? ""} className="rounded-xl border border-line bg-sand px-3 py-2 text-sm">
          <option value="">Any listing status</option>
          <option value="pending">pending</option>
          <option value="approved">approved</option>
          <option value="rejected">rejected</option>
        </select>
        <button type="submit" className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white">Filter</button>
      </form>
      <ul className="mt-6 grid gap-4">
        {listings.length === 0 ? (
          <li className="rounded-3xl border border-dashed border-line bg-card px-5 py-8 text-sm text-ink/70">No listings match.</li>
        ) : (
          listings.map((listing) => (
            <li key={listing.id} className="rounded-3xl border border-line bg-card p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink/50">
                {listing.status} · {categoryName(listing.category_id)}
              </p>
              <h2 className="mt-1 text-xl font-semibold text-ink">{listing.business_name}</h2>
              <p className="mt-1 text-sm text-ink/70">{listing.specialty}</p>
              <p className="mt-2 text-sm text-ink/75">
                ${Number(listing.price_from)} / {listing.price_unit} · {listing.service_areas.join(", ")}
              </p>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-ink/75">{listing.about}</p>
              {listing.review_note ? <p className="mt-2 text-sm text-ink/70">Note: {listing.review_note}</p> : null}
              {listing.status === "pending" ? (
                <form action={reviewProvider} className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto_auto]">
                  <input type="hidden" name="providerId" value={listing.id} />
                  <input
                    name="reviewNote"
                    placeholder="Optional note to the provider"
                    className="rounded-xl border border-line bg-sand px-3 py-2 text-sm outline-none focus:border-ink"
                  />
                  <button name="decision" value="approved" className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white">
                    Approve
                  </button>
                  <button name="decision" value="rejected" className="rounded-full border border-ink px-4 py-2 text-sm font-semibold text-ink">
                    Reject
                  </button>
                </form>
              ) : null}
            </li>
          ))
        )}
      </ul>
    </main>
  );
}
