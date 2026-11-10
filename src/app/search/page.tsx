import type { Metadata } from "next";
import Link from "next/link";
import { categories, categoryName } from "@/lib/marketplace";
import { getPublicProviders } from "@/lib/providers";
import { comparablePrice, parseSearchQuery, providerPricing, searchProviders, searchRadii } from "@/lib/search";

export const metadata: Metadata = {
  title: "Find a pro · BlockBooked",
  description: "Search approved local service providers on BlockBooked.",
  robots: { index: true, follow: true },
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = parseSearchQuery(params);
  const loaded = await getPublicProviders();
  const results = searchProviders(loaded.providers, query);
  const queryString = new URLSearchParams();
  if (query.q) queryString.set("q", query.q);
  if (query.location) queryString.set("location", query.location);
  if (query.category) queryString.set("category", query.category);
  if (query.minPrice != null) queryString.set("min", String(query.minPrice));
  if (query.maxPrice != null) queryString.set("max", String(query.maxPrice));
  if (query.minRating != null) queryString.set("rating", String(query.minRating));
  if (query.pricing !== "any") queryString.set("pricing", query.pricing);
  if (query.sort !== "match") queryString.set("sort", query.sort);
  if (query.radius != null) queryString.set("radius", String(query.radius));

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="font-serif text-4xl tracking-tight text-ink sm:text-5xl">Find a pro</h1>
      <p className="mt-3 max-w-2xl text-ink/70">
        These results are approved BlockBooked listings. Ratings appear only after verified reviews, and distance is not calculated until provider coordinates are stored.
      </p>
      <form action="/search" className="mt-6 grid gap-3 rounded-3xl border border-line bg-card p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-sm font-medium text-ink">
            Service
            <input name="q" defaultValue={query.q} className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2 outline-none focus:border-ink" />
          </label>
          <label className="text-sm font-medium text-ink">
            City or ZIP
            <input name="location" defaultValue={query.location} className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2 outline-none focus:border-ink" />
          </label>
          <label className="text-sm font-medium text-ink">
            Category
            <select name="category" defaultValue={query.category} className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2 outline-none focus:border-ink">
              <option value="">Any</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>{category.name}</option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium text-ink">
            Sort
            <select name="sort" defaultValue={query.sort} className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2 outline-none focus:border-ink">
              <option value="match">Best match</option>
              <option value="rating">Highest rated</option>
              <option value="reviews">Most reviewed</option>
              <option value="price_asc">Price: low to high</option>
              <option value="price_desc">Price: high to low</option>
              <option value="nearest">Nearest listed town</option>
              <option value="soonest">Has availability note</option>
            </select>
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="text-sm font-medium text-ink">
            Minimum price
            <input name="min" inputMode="decimal" defaultValue={query.minPrice ?? ""} className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2 outline-none focus:border-ink" />
          </label>
          <label className="text-sm font-medium text-ink">
            Maximum price
            <input name="max" inputMode="decimal" defaultValue={query.maxPrice ?? ""} className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2 outline-none focus:border-ink" />
          </label>
          <label className="text-sm font-medium text-ink">
            Minimum rating
            <input name="rating" inputMode="decimal" defaultValue={query.minRating ?? ""} className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2 outline-none focus:border-ink" />
          </label>
          <label className="text-sm font-medium text-ink">
            Pricing
            <select name="pricing" defaultValue={query.pricing} className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2 outline-none focus:border-ink">
              <option value="any">Any</option>
              <option value="fixed">Fixed or starting price</option>
              <option value="quote">Quote only</option>
            </select>
          </label>
          <label className="text-sm font-medium text-ink">
            Radius
            <select name="radius" defaultValue={query.radius ?? ""} className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2 outline-none focus:border-ink">
              <option value="">Town match only</option>
              {searchRadii.map((miles) => (
                <option key={miles} value={miles}>{miles} miles</option>
              ))}
            </select>
          </label>
        </div>
        <button type="submit" className="w-fit rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent-dark">
          Find a pro
        </button>
      </form>
      {query.radius != null ? (
        <p className="mt-4 text-sm text-ink/70">Mile radius is saved in the link, but listings do not have coordinates yet, so results use the city or ZIP instead of miles.</p>
      ) : null}
      {query.minRating != null && query.minRating > 0 && !results.reviewsAvailable ? (
        <p className="mt-4 text-sm text-ink/70">No listing has a verified review yet, so a minimum rating returns no one.</p>
      ) : null}
      {loaded.error ? <p className="mt-6 text-sm font-medium text-accent-dark">{loaded.error}</p> : null}
      <p className="mt-6 text-sm text-ink/60">{results.total} approved {results.total === 1 ? "provider" : "providers"}</p>
      {results.providers.length === 0 ? (
        <p className="mt-4 rounded-3xl border border-dashed border-line bg-card px-5 py-8 text-sm text-ink/70">No approved providers match this search.</p>
      ) : (
        <ul className="mt-4 grid gap-4 sm:grid-cols-2">
          {results.providers.map((provider) => {
            const price = comparablePrice(provider);
            const pricing = providerPricing(provider);
            return (
              <li key={provider.id} className="rounded-3xl border border-line bg-card p-5">
                <div className="flex items-start gap-3">
                  <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl text-sm font-semibold text-white" style={{ backgroundColor: provider.tone }} aria-hidden>
                    {provider.initials}
                  </span>
                  <div>
                    <h2 className="font-serif text-2xl text-ink">{provider.name}</h2>
                    <p className="text-sm text-ink/60">{categoryName(provider.categoryId)} · {provider.serviceAreas.join(", ") || "Illinois"}</p>
                  </div>
                </div>
                <p className="mt-3 line-clamp-3 text-sm leading-6 text-ink/75">{provider.about || provider.specialty}</p>
                <p className="mt-3 text-sm font-semibold text-ink">
                  {pricing === "quote" || price == null ? "Request a quote" : pricing === "fixed" ? `From $${price}` : `Starting at $${price}`}
                </p>
                <p className="mt-1 text-sm text-ink/60">
                  {provider.reviewCount > 0 ? `${provider.rating.toFixed(1)} from ${provider.reviewCount} verified reviews` : "No verified reviews yet"}
                </p>
                {provider.nextOpening ? <p className="mt-1 text-sm text-ink/60">Availability note: {provider.nextOpening}</p> : null}
                <Link href={`/providers/${provider.id}`} className="mt-4 inline-flex rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white">
                  View profile
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {results.pages > 1 ? (
        <nav className="mt-6 flex gap-3 text-sm font-semibold" aria-label="Search pages">
          {query.page > 1 ? <Link href={`/search?${queryString.toString()}&page=${query.page - 1}`}>Previous</Link> : null}
          <span>Page {query.page} of {results.pages}</span>
          {query.page < results.pages ? <Link href={`/search?${queryString.toString()}&page=${query.page + 1}`}>Next</Link> : null}
        </nav>
      ) : null}
    </main>
  );
}
