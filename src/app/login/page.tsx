import type { Metadata } from "next";
import Link from "next/link";
import { signIn } from "@/app/actions/auth";
import { safeNextPath } from "@/lib/session";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export const metadata: Metadata = { title: "Log in · BlockBooked" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string; next?: string }>;
}) {
  const query = await searchParams;
  const next = safeNextPath(query.next);
  const configured = isSupabaseConfigured();

  return (
    <main className="mx-auto max-w-lg px-4 py-14 sm:px-6">
      <h1 className="font-serif text-5xl tracking-tight text-ink">Log in</h1>
      <p className="mt-3 text-ink/70">Use the email and password on your BlockBooked account.</p>
      {!configured ? (
        <p className="mt-6 rounded-2xl border border-accent/30 bg-[#f8efe6] px-4 py-3 text-sm text-ink">
          Supabase is not configured. Add the project URL and anon key from the setup instructions,
          then restart the dev server.
        </p>
      ) : null}
      {query.notice ? <p className="mt-4 text-sm font-medium text-ink">{query.notice}</p> : null}
      {query.error ? <p className="mt-4 text-sm font-medium text-accent-dark">{query.error}</p> : null}
      <form action={signIn} className="mt-6 grid gap-3 rounded-3xl border border-line bg-card p-6">
        <input type="hidden" name="next" value={next} />
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
            className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5 outline-none focus:border-ink"
          />
        </label>
        <button
          type="submit"
          className="mt-2 rounded-full bg-accent px-4 py-3 text-sm font-semibold text-white hover:bg-accent-dark"
        >
          Log in
        </button>
      </form>
      <p className="mt-4 text-sm text-ink/70">
        New to BlockBooked?{" "}
        <Link href="/signup" className="font-semibold text-accent-dark">
          Create an account
        </Link>
      </p>
    </main>
  );
}
