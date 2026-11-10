import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-[#efeae2]">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:px-6 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="font-serif text-2xl text-ink">BlockBooked</p>
          <p className="mt-2 max-w-md text-sm leading-6 text-ink/70">
            BlockBooked is a local marketplace for cleaners, barbers, movers, detailers,
            and other pros in Roselle, Bloomingdale, Schaumburg, Itasca, and Hanover Park,
            Illinois. Customers pay securely through Stripe. BlockBooked retains an 8%
            commission, and provider transfers happen after verified service completion.
          </p>
        </div>
        <div className="flex flex-wrap gap-5 text-sm font-medium text-ink/80">
          <Link href="/#categories" className="hover:text-ink">
            Services
          </Link>
          <Link href="/#providers" className="hover:text-ink">
            Providers
          </Link>
          <Link href="/#how-it-works" className="hover:text-ink">
            How it works
          </Link>
          <Link href="/list-your-business" className="hover:text-ink">
            List your business
          </Link>
        </div>
      </div>
    </footer>
  );
}
