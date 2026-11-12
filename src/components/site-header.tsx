"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { signOut } from "@/app/actions/auth";
import { calendarNavHref } from "@/lib/calendar";

const links = [
  { href: "/#categories", label: "Services" },
  { href: "/#providers", label: "Providers" },
  { href: "/#how-it-works", label: "How it works" },
];

export function SiteHeader({
  user,
}: {
  user: { name: string; role: "customer" | "provider" | "admin" } | null;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const calendarHref = user ? calendarNavHref(user.role) : null;
  const calendarActive = calendarHref ? pathname === calendarHref || pathname.startsWith(`${calendarHref}/`) : false;

  return (
    <header className="sticky top-0 z-20 border-b border-line/80 bg-[#f7f4ee]/90 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5" onClick={() => setOpen(false)}>
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-ink text-[13px] font-semibold tracking-tight text-white">
            Bb
          </span>
          <span className="font-serif text-xl tracking-tight text-ink">BlockBooked</span>
        </Link>

        <nav className="hidden items-center gap-6 text-sm font-medium text-ink/80 lg:flex">
          {links.map((link) => (
            <Link key={link.href} href={link.href} className="hover:text-ink">
              {link.label}
            </Link>
          ))}
          {user ? (
            <Link href="/account" className="hover:text-ink">
              Account
            </Link>
          ) : null}
          {user?.role === "provider" || user?.role === "admin" ? (
            <Link href="/dashboard" className="hover:text-ink">
              Dashboard
            </Link>
          ) : null}
          {user?.role === "admin" ? (
            <Link href="/admin" className="hover:text-ink">
              Admin
            </Link>
          ) : null}
          {calendarHref ? (
            <Link
              href={calendarHref}
              aria-current={calendarActive ? "page" : undefined}
              className={`inline-flex items-center gap-1.5 ${calendarActive ? "font-semibold text-ink underline decoration-2 underline-offset-4" : "hover:text-ink"}`}
            >
              <CalendarIcon />
              Calendar
            </Link>
          ) : null}
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          {user ? (
            <form action={signOut}>
              <button type="submit" className="px-2 text-sm font-semibold text-ink/80 hover:text-ink">
                Log out
              </button>
            </form>
          ) : (
            <Link href="/login" className="px-2 text-sm font-semibold text-ink/80 hover:text-ink">
              Log in
            </Link>
          )}
          <Link
            href="/list-your-business"
            className="rounded-full border border-ink px-4 py-2 text-sm font-semibold text-ink hover:bg-ink hover:text-white"
          >
            List your business
          </Link>
          <Link
            href="/search"
            className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-dark"
          >
            Find a pro
          </Link>
        </div>

        <button
          type="button"
          className="inline-flex h-10 items-center rounded-full border border-line px-3 text-sm font-medium text-ink md:hidden"
          aria-expanded={open}
          aria-controls="mobile-nav"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Close" : "Menu"}
        </button>
      </div>

      {open ? (
        <nav id="mobile-nav" className="border-t border-line px-4 py-3 md:hidden">
          <div className="flex flex-col gap-1">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="rounded-lg px-2 py-2 text-sm font-medium text-ink"
                onClick={() => setOpen(false)}
              >
                {link.label}
              </Link>
            ))}
            {user ? (
              <Link href="/account" className="rounded-lg px-2 py-2 text-sm font-medium text-ink" onClick={() => setOpen(false)}>
                Account
              </Link>
            ) : (
              <Link href="/login" className="rounded-lg px-2 py-2 text-sm font-medium text-ink" onClick={() => setOpen(false)}>
                Log in
              </Link>
            )}
            {user?.role === "provider" || user?.role === "admin" ? (
              <Link href="/dashboard" className="rounded-lg px-2 py-2 text-sm font-medium text-ink" onClick={() => setOpen(false)}>
                Dashboard
              </Link>
            ) : null}
            {user?.role === "admin" ? (
              <Link href="/admin" className="rounded-lg px-2 py-2 text-sm font-medium text-ink" onClick={() => setOpen(false)}>
                Admin
              </Link>
            ) : null}
            {calendarHref ? (
              <Link
                href={calendarHref}
                aria-current={calendarActive ? "page" : undefined}
                className={`inline-flex items-center gap-2 rounded-lg px-2 py-2 text-sm font-medium ${calendarActive ? "bg-sand font-semibold text-ink" : "text-ink"}`}
                onClick={() => setOpen(false)}
              >
                <CalendarIcon />
                Calendar
              </Link>
            ) : null}
            {user ? (
              <form action={signOut}>
                <button type="submit" className="rounded-lg px-2 py-2 text-left text-sm font-medium text-ink">
                  Log out
                </button>
              </form>
            ) : null}
            <Link
              href="/list-your-business"
              className="mt-1 rounded-full border border-ink px-3 py-2 text-center text-sm font-semibold text-ink"
              onClick={() => setOpen(false)}
            >
              List your business
            </Link>
            <Link
              href="/search"
              className="rounded-full bg-accent px-3 py-2 text-center text-sm font-semibold text-white"
              onClick={() => setOpen(false)}
            >
              Find a pro
            </Link>
          </div>
        </nav>
      ) : null}
    </header>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
      <rect x="2" y="3" width="12" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2 6.5h12M5 2v2.5M11 2v2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
