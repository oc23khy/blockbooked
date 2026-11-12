import type { NextConfig } from "next";
import { securityHeaderList } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  experimental: {
    // The dashboard upload accepts 5 MB. Next.js otherwise rejects the Server
    // Action at 1 MB, before the action can return an error, and the dashboard crashes.
    serverActions: {
      bodySizeLimit: "6mb",
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaderList() }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
