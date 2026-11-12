import type { Metadata } from "next";
import Link from "next/link";
import { signUp } from "@/app/actions/auth";
import { shownError } from "@/lib/public-error";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export const metadata: Metadata = { title: "Create account · BlockBooked" };

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; account?: string }>;
}) {
  const query = await searchParams;
  const formError = shownError(query.error);
  const providerAccount = query.account === "provider";

  return (
    <main className="mx-auto max-w-lg px-4 py-14 sm:px-6">
      <h1 className="font-serif text-5xl tracking-tight text-ink">Create an account</h1>
      <p className="mt-3 text-ink/70">
        Customers book approved providers. Businesses apply to be listed. No payment is collected.
      </p>
      {!isSupabaseConfigured() ? (
        <p className="mt-6 rounded-2xl border border-accent/30 bg-[#f8efe6] px-4 py-3 text-sm text-ink">
          Supabase is not configured yet, so accounts cannot be created.
        </p>
      ) : null}
      {formError ? <p className="mt-4 text-sm font-medium text-accent-dark">{formError}</p> : null}
      <form action={signUp} className="mt-6 grid gap-3 rounded-3xl border border-line bg-card p-6">
        <fieldset className="grid gap-2 text-sm">
          <legend className="font-medium text-ink">Account type</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="accountType" value="customer" defaultChecked={!providerAccount} />
            Customer
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="accountType" value="provider" defaultChecked={providerAccount} />
            Service provider
          </label>
        </fieldset>
        <label className="block text-sm font-medium text-ink">
          Full name
          <input
            name="fullName"
            required
            className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5 outline-none focus:border-ink"
          />
        </label>
        <label className="block text-sm font-medium text-ink">
          Phone
          <input
            name="phone"
            type="tel"
            className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5 outline-none focus:border-ink"
          />
        </label>
        <label className="block text-sm font-medium text-ink">
          Email
          <input
            name="email"
            type="email"
            required
            className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5 outline-none focus:border-ink"
          />
        </label>
        <label className="block text-sm font-medium text-ink">
          Password
          <input
            name="password"
            type="password"
            required
            minLength={8}
            className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5 outline-none focus:border-ink"
          />
        </label>
        <button
          type="submit"
          className="mt-2 rounded-full bg-accent px-4 py-3 text-sm font-semibold text-white hover:bg-accent-dark"
        >
          Create account
        </button>
      </form>
      <p className="mt-4 text-sm text-ink/70">
        Already have an account?{" "}
        <Link href="/login" className="font-semibold text-accent-dark">
          Log in
        </Link>
      </p>
    </main>
  );
}
