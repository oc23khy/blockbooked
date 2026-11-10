import type { Metadata } from "next";
import { DM_Sans, Fraunces } from "next/font/google";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { getSession } from "@/lib/session";
import "./globals.css";

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
});

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
  title: "BlockBooked — Find trusted local professionals",
  description:
    "Discover, compare, and book approved local service providers in Roselle, Bloomingdale, Schaumburg, Itasca, and Hanover Park, Illinois.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const session = await getSession();
  const user = session
    ? {
        name: session.profile.full_name || session.profile.email,
        role: session.profile.role,
      }
    : null;

  return (
    <html
      lang="en"
      className={`${dmSans.variable} ${fraunces.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <SiteHeader user={user} />
        <div className="flex-1">{children}</div>
        <SiteFooter />
      </body>
    </html>
  );
}
