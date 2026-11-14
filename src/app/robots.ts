import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const site = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/search", "/providers/"],
      disallow: ["/account", "/dashboard", "/admin", "/login", "/signup", "/auth/", "/api/", "/outreach/unsubscribe"],
    },
    sitemap: `${site}/sitemap.xml`,
  };
}
