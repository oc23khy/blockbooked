import type { Metadata } from "next";
import Link from "next/link";
import { becomeProvider } from "@/app/actions/auth";
import { serviceAreaSummary } from "@/lib/marketplace";
import { getSession } from "@/lib/session";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "List your business · BlockBooked",
  description:
    "Apply to list your service business on BlockBooked in Roselle, Bloomingdale, Schaumburg, Itasca, or Hanover Park.",
};

export default async function ListYourBusinessPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const query = await searchParams;
  const session = await getSession();
  if (session?.profile.role === "provider" || session?.profile.role === "admin") {
    redirect("/dashboard");
  }

  return (
    <main className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:px-6 lg:grid-cols-[1.1fr_0.9fr]">
      <article>
        <Link href="/" className="text-sm font-semibold text-accent-dark hover:text-ink">
          Back to BlockBooked
        </Link>
        <p className="mt-4 text-sm font-semibold uppercase tracking-[0.16em] text-accent-dark">
          For service providers
        </p>
        <h1 className="mt-3 font-serif text-5xl tracking-tight text-ink">List your business</h1>
        <p className="mt-4 max-w-xl text-lg leading-8 text-ink/75">
          BlockBooked lists approved pros who work in {serviceAreaSummary}. Create a provider
          account, add your services, and wait for an admin to approve the listing. Listing is free.
          Customers pay fixed prices through Stripe test checkout.
        </p>
        <ul className="mt-8 space-y-3 text-sm leading-6 text-ink/80">
          <li className="rounded-2xl border border-line bg-card px-4 py-3">
            Applications are free. After approval, connect Stripe before payouts can be sent.
          </li>
          <li className="rounded-2xl border border-line bg-card px-4 py-3">
            Pending and rejected businesses do not appear in public search.
          </li>
          <li className="rounded-2xl border border-line bg-card px-4 py-3">
            After approval, edit prices, categories, availability, and service areas from your dashboard.
          </li>
        </ul>
      </article>
      <section className="rounded-3xl border border-line bg-card p-6">
        {!isSupabaseConfigured() ? (
          <p className="text-sm leading-6 text-ink/75">
            Connect Supabase before creating a provider account. The steps are in SUPABASE_SETUP.md.
          </p>
        ) : session?.profile.role === "customer" ? (
          <>
            <h2 className="font-serif text-3xl text-ink">Use this account</h2>
            <p className="mt-2 text-sm leading-6 text-ink/70">
              You are logged in as a customer. Switch this account to a provider account to apply.
              This does not make you an admin.
            </p>
            {query.error ? <p className="mt-3 text-sm font-medium text-accent-dark">{query.error}</p> : null}
            <form action={becomeProvider}>
              <button
                type="submit"
                className="mt-5 rounded-full bg-accent px-4 py-3 text-sm font-semibold text-white hover:bg-accent-dark"
              >
                Continue as a provider
              </button>
            </form>
          </>
        ) : (
          <>
            <h2 className="font-serif text-3xl text-ink">Create a provider account</h2>
            <p className="mt-2 text-sm leading-6 text-ink/70">
              You will add the business details after the account is created.
            </p>
            <div className="mt-5 flex flex-col gap-3">
              <Link
                href="/signup?account=provider"
                className="rounded-full bg-accent px-4 py-3 text-center text-sm font-semibold text-white hover:bg-accent-dark"
              >
                Sign up as a provider
              </Link>
              <Link
                href="/login?next=/list-your-business"
                className="rounded-full border border-ink px-4 py-3 text-center text-sm font-semibold text-ink"
              >
                Log in
              </Link>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
