"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/bookings", label: "Bookings" },
  { href: "/admin/providers", label: "Providers" },
  { href: "/admin/reviews", label: "Manual review" },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Admin" className="flex gap-2 overflow-x-auto lg:flex-col">
      {links.map((link) => {
        const active = link.href === "/admin" ? pathname === "/admin" : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-full px-4 py-2 text-sm font-semibold whitespace-nowrap ${
              active ? "bg-ink text-white" : "border border-line bg-card text-ink hover:border-ink"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
