// Next.js inserts bootstrap scripts and Tailwind keeps some styles inline.
// This Next.js version does not document a nonce hook, so a per-request nonce
// would mean rewriting the document pipeline. Production script-src stays on
// this origin and omits unsafe-eval. Development keeps unsafe-eval for the
// local compiler.

export function contentSecurityPolicy(nodeEnv = process.env.NODE_ENV ?? "production") {
  const scriptSrc =
    nodeEnv === "development"
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      : "script-src 'self' 'unsafe-inline'";
  const directives = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.supabase.co",
    "font-src 'self'",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ];
  if (nodeEnv === "production") directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

export function securityHeaderList(nodeEnv = process.env.NODE_ENV ?? "production") {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(nodeEnv) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  ];
}
