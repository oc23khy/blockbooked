"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  categories,
  categoryName,
  filterProviders,
  serviceAreaSummary,
  serviceTowns,
  type Provider,
} from "@/lib/marketplace";

export function MarketplaceHome({
  providers,
  loadError,
  configured,
}: {
  providers: Provider[];
  loadError: string | null;
  configured: boolean;
}) {
  const [categoryId, setCategoryId] = useState("");

  const results = useMemo(
    () => filterProviders(providers, { query: "", location: "", categoryId }),
    [providers, categoryId],
  );

  function selectCategory(id: string) {
    setCategoryId((current) => (current === id ? "" : id));
    document.getElementById("providers")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div>
      <section className="relative overflow-hidden border-b border-line">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(196,92,38,0.16),transparent_36%),radial-gradient(circle_at_left,rgba(20,32,51,0.06),transparent_32%)]" />
        <div className="relative mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-[1.15fr_0.85fr] lg:items-end">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-accent-dark">
              BlockBooked
            </p>
            <h1 className="mt-3 max-w-xl font-serif text-5xl leading-[1.05] tracking-tight text-ink sm:text-6xl">
              Find trusted local professionals.
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-8 text-ink/75">
              Discover, compare, and book approved providers in {serviceAreaSummary}.
              Customers pay securely through Stripe. BlockBooked retains an 8% commission,
              and the provider&apos;s share is transferred after the service is verified.
            </p>
          </div>

          <form
            id="search"
            action="/search"
            method="get"
            className="rounded-3xl border border-line bg-card p-3 shadow-[0_20px_50px_rgba(20,32,51,0.08)]"
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block rounded-2xl bg-sand px-4 py-3">
                <span className="text-xs font-semibold uppercase tracking-wide text-ink/50">
                  Service
                </span>
                <input
                  name="q"
                  placeholder="Cleaning, fade, movers..."
                  className="mt-1 w-full bg-transparent text-base text-ink outline-none placeholder:text-ink/35"
                />
              </label>
              <label className="block rounded-2xl bg-sand px-4 py-3">
                <span className="text-xs font-semibold uppercase tracking-wide text-ink/50">
                  City or ZIP
                </span>
                <input
                  name="location"
                  placeholder="Roselle or 60172"
                  className="mt-1 w-full bg-transparent text-base text-ink outline-none placeholder:text-ink/35"
                />
              </label>
            </div>
            <button
              type="submit"
              className="mt-2 w-full rounded-2xl bg-accent px-4 py-3 text-sm font-semibold text-white hover:bg-accent-dark"
            >
              Find a pro
            </button>
          </form>
        </div>
      </section>

      <section id="categories" className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="font-serif text-3xl tracking-tight text-ink">Browse by service</h2>
            <p className="mt-2 text-ink/70">Pick a category to narrow the list below.</p>
          </div>
          {categoryId ? (
            <button
              type="button"
              onClick={() => setCategoryId("")}
              className="text-sm font-semibold text-accent-dark hover:text-ink"
            >
              Clear filter
            </button>
          ) : null}
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          {categories.map((category) => {
            const selected = categoryId === category.id;
            return (
              <button
                key={category.id}
                type="button"
                onClick={() => selectCategory(category.id)}
                aria-pressed={selected}
                className={`rounded-2xl border px-4 py-4 text-left transition ${
                  selected
                    ? "border-ink bg-ink text-white"
                    : "border-line bg-card text-ink hover:-translate-y-0.5 hover:border-ink/30"
                }`}
              >
                <span className="block font-semibold">{category.name}</span>
                <span className={`mt-1 block text-sm leading-5 ${selected ? "text-white/75" : "text-ink/60"}`}>
                  {category.blurb}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section id="providers" className="border-y border-line bg-[#efeae2]/70">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="font-serif text-3xl tracking-tight text-ink">Nearby providers</h2>
              <p className="mt-2 text-ink/70">
                {`${results.length} approved ${results.length === 1 ? "provider" : "providers"}${
                  categoryId ? ` in ${categoryName(categoryId).toLowerCase()}` : ""
                } in the BlockBooked service area.`}
              </p>
            </div>
          </div>

          {!configured ? (
            <div className="mt-8 rounded-3xl border border-dashed border-ink/20 bg-card px-6 py-12 text-center">
              <p className="font-serif text-2xl text-ink">Supabase is not connected yet.</p>
              <p className="mx-auto mt-2 max-w-lg text-ink/70">
                Approved providers will show up here after you add your project URL and anon key.
                Setup steps are in SUPABASE_SETUP.md.
              </p>
            </div>
          ) : loadError ? (
            <div className="mt-8 rounded-3xl border border-dashed border-accent/40 bg-card px-6 py-12 text-center">
              <p className="font-serif text-2xl text-ink">Providers could not be loaded.</p>
              <p className="mx-auto mt-2 max-w-lg text-ink/70">{loadError}</p>
            </div>
          ) : results.length === 0 ? (
            <div className="mt-8 rounded-3xl border border-dashed border-ink/20 bg-card px-6 py-12 text-center">
              <p className="font-serif text-2xl text-ink">
                {providers.length === 0 ? "No approved providers yet." : "No providers match that search."}
              </p>
              <p className="mx-auto mt-2 max-w-md text-ink/70">
                {providers.length === 0
                  ? "Provider applications stay private until an admin approves them."
                  : `Try a service like “barber” or a town such as ${serviceTowns.join(", ")}.`}
              </p>
              {providers.length > 0 ? (
                <button
                  type="button"
                  className="mt-5 rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white"
                  onClick={() => {
                    setCategoryId("");
                  }}
                >
                  Show everyone
                </button>
              ) : null}
            </div>
          ) : (
            <div className="mt-8 grid gap-4 md:grid-cols-2">
              {results.map((provider) => (
                <ProviderCard key={provider.id} provider={provider} />
              ))}
            </div>
          )}
        </div>
      </section>

      <section id="how-it-works" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 className="font-serif text-3xl tracking-tight text-ink">How BlockBooked works</h2>
        <p className="mt-3 max-w-2xl text-ink/70">
          Customers book approved pros in {serviceAreaSummary}. Service providers apply,
          and an admin publishes the listing. Customers pay BlockBooked through Stripe.
        </p>
        <div className="mt-8 grid gap-4 lg:grid-cols-2">
          <div className="rounded-3xl border border-line bg-card p-6">
            <h3 className="font-serif text-2xl text-ink">For customers</h3>
            <ol className="mt-5 space-y-4">
              {[
                {
                  step: "01",
                  title: "Search your town",
                  body: `Filter by the job and one of the BlockBooked towns: ${serviceTowns.join(", ")}.`,
                },
                {
                  step: "02",
                  title: "Compare approved pros",
                  body: "Review the starting price, service area, and availability. Only providers an admin has approved are shown.",
                },
                {
                  step: "03",
                  title: "Send a request",
                  body: "Sign in and send a time and a note. Customers pay securely through Stripe. BlockBooked retains an 8% commission, and the provider's share is transferred after verified completion.",
                },
              ].map((item) => (
                <li key={item.step} className="flex gap-4">
                  <span className="font-serif text-xl text-accent">{item.step}</span>
                  <div>
                    <p className="font-semibold text-ink">{item.title}</p>
                    <p className="mt-1 text-sm leading-6 text-ink/70">{item.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
          <div className="rounded-3xl border border-line bg-card p-6">
            <h3 className="font-serif text-2xl text-ink">For service providers</h3>
            <ol className="mt-5 space-y-4">
              {[
                {
                  step: "01",
                  title: "Create a provider account",
                  body: "Add your trade, prices, towns, and availability. Listing is free.",
                },
                {
                  step: "02",
                  title: "Wait for approval",
                  body: "Your application stays off the public site until an admin approves it. You can keep editing from your dashboard.",
                },
                {
                  step: "03",
                  title: "Get paid after the service is verified",
                  body: "Customers pay BlockBooked securely through Stripe. BlockBooked retains an 8% commission. Your share is transferred after the customer verifies completion.",
                },
              ].map((item) => (
                <li key={item.step} className="flex gap-4">
                  <span className="font-serif text-xl text-accent">{item.step}</span>
                  <div>
                    <p className="font-semibold text-ink">{item.title}</p>
                    <p className="mt-1 text-sm leading-6 text-ink/70">{item.body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <Link
              href="/list-your-business"
              className="mt-6 inline-flex rounded-full bg-ink px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#24344d]"
            >
              List your business
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

function ProviderCard({ provider }: { provider: Provider }) {
  return (
    <article className="flex flex-col rounded-3xl border border-line bg-card p-5 shadow-[0_1px_0_rgba(20,32,51,0.04)]">
      <div className="flex items-start gap-4">
        <div
          className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-sm font-semibold text-white"
          style={{ backgroundColor: provider.tone }}
          aria-hidden
        >
          {provider.initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold text-ink">{provider.name}</h3>
            {provider.demo ? (
              <span className="rounded-full bg-[#f3e2d4] px-2 py-0.5 text-xs font-semibold text-accent-dark">
                Demo listing
              </span>
            ) : null}
            <span className="rounded-full bg-sand px-2 py-0.5 text-xs font-medium text-ink/70">
              {categoryName(provider.categoryId)}
            </span>
          </div>
          <p className="mt-1 text-sm text-ink/70">{provider.specialty}</p>
          {provider.demo ? (
            <p className="mt-1 text-sm text-ink/60">Sample profile. Not a real BlockBooked business.</p>
          ) : null}
          <p className="mt-2 text-sm text-ink/80">
            {provider.reviewCount > 0 ? (
              <>
                <span className="font-semibold text-ink">{provider.rating.toFixed(1)}</span>
                <span className="text-accent"> ★ </span>
                <span>{provider.reviewCount} reviews</span>
                <span className="px-1.5 text-ink/30">·</span>
              </>
            ) : (
              <span>New listing · </span>
            )}
            {provider.serviceAreas.join(", ") || provider.neighborhood}
          </p>
        </div>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-2xl bg-sand px-3 py-3">
          <dt className="text-xs uppercase tracking-wide text-ink/45">Starting at</dt>
          <dd className="mt-1 font-semibold text-ink">
            ${provider.priceFrom}
            <span className="font-normal text-ink/60"> / {provider.priceUnit}</span>
          </dd>
        </div>
        <div className="rounded-2xl bg-sand px-3 py-3">
          <dt className="text-xs uppercase tracking-wide text-ink/45">Next opening</dt>
          <dd className="mt-1 font-semibold text-ink">{provider.nextOpening}</dd>
        </div>
      </dl>

      <div className="mt-4 flex flex-wrap gap-2">
        {provider.tags.slice(0, 3).map((tag) => (
          <span key={tag} className="rounded-full border border-line px-2.5 py-1 text-xs text-ink/70">
            {tag}
          </span>
        ))}
      </div>

      <Link
        href={`/providers/${provider.id}`}
        className="mt-5 inline-flex items-center justify-center rounded-full bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent-dark"
      >
        View and request
      </Link>
    </article>
  );
}
