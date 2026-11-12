const internalError =
  /sqlstate|syntax error|\bviolat|\bconstraint\b|\brelation\b|\bduplicate key\b|row-level security|permission denied|\bPGRST\d+\b|\bJWT\b|service_role|sk_(?:live|test)_|whsec_|eyJ[A-Za-z0-9_-]{20,}|node_modules|\bpostgres\b|stack trace|\.tsx?:\d+|\/src\/|password authentication|\bsecret\b/i;

function redact(text: string) {
  return text
    .replace(/sk_(?:live|test)_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/whsec_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{20,}/g, "[redacted]");
}

export function customerFacingError(message: string | null | undefined, fallback: string) {
  const text = (message ?? "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 200 || internalError.test(text)) {
    if (text) console.error("customer-error", redact(text).slice(0, 500));
    return fallback;
  }
  return text;
}

export function shownError(message: string | null | undefined, fallback = "Something went wrong. Try again.") {
  if (!message) return null;
  return customerFacingError(message, fallback);
}
