import type { MetadataRoute } from "next";
import { categories } from "@/lib/marketplace";
import { getPublicProviders } from "@/lib/providers";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const site = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  const loaded = await getPublicProviders();
  const now = new Date();
  return [
    { url: site, lastModified: now, changeFrequency: "daily", priority: 1 },
    { url: `${site}/search`, lastModified: now, changeFrequency: "daily", priority: 0.8 },
    ...categories.map((category) => ({
      url: `${site}/search?category=${category.id}`,
      lastModified: now,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    })),
    ...loaded.providers.map((provider) => ({
      url: `${site}/providers/${provider.id}`,
      lastModified: now,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
  ];
}
