import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { normalizeEmail } from "./prospects.ts";

export const UNSUBSCRIBE_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export type UnsubscribeOutcome = "invalid" | "expired" | "unsubscribed" | "repeated" | "limited" | "unavailable";

export type UnsubscribeRecord = {
  tokenHash: string;
  normalizedEmail: string;
  expiresAtMs: number;
  usedAtMs: number | null;
};

export function isUnsubscribeToken(value: string) {
  return tokenPattern.test(value);
}

export function hashUnsubscribeToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createUnsubscribeSecret() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashUnsubscribeToken(token) };
}

export function canonicalUnsubscribeEmail(value: string) {
  return normalizeEmail(value);
}

export function unsubscribeExpiry(nowMs: number) {
  return new Date(nowMs + UNSUBSCRIBE_TOKEN_TTL_MS).toISOString();
}

export function unsubscribeRateSubject(tokenHash: string) {
  return `token:${tokenHash.slice(0, 32)}`;
}

export function outreachOrigin(value: string) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return "";
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return url.origin;
  } catch {
    return "";
  }
}

export function outreachUnsubscribePageUrl(origin: string, token: string) {
  const base = outreachOrigin(origin);
  if (!base || !isUnsubscribeToken(token)) return "";
  return `${base}/outreach/unsubscribe/${token}`;
}

export function outreachListUnsubscribeHeaders(origin: string, token: string) {
  const base = outreachOrigin(origin);
  if (!base || !isUnsubscribeToken(token)) return null;
  const oneClick = `${base}/api/outreach/unsubscribe/${token}`;
  return {
    "List-Unsubscribe": `<${oneClick}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

function formEntries(body: string) {
  return [...new URLSearchParams(body).entries()];
}

export function isOneClickUnsubscribe(contentType: string, body: string) {
  if (body.length > 2048 || !contentType.toLowerCase().includes("application/x-www-form-urlencoded")) return false;
  const entries = formEntries(body);
  return entries.length === 1 && entries[0][0].toLowerCase() === "list-unsubscribe" && entries[0][1] === "One-Click";
}

export function confirmUnsubscribeToken(contentType: string, body: string) {
  if (body.length > 2048 || !contentType.toLowerCase().includes("application/x-www-form-urlencoded")) return "";
  const entries = formEntries(body);
  if (entries.some(([key]) => key.toLowerCase() === "email")) return "";
  if (entries.length !== 2) return "";
  const confirm = entries.find(([key]) => key.toLowerCase() === "confirm");
  const token = entries.find(([key]) => key.toLowerCase() === "token");
  if (!confirm || confirm[1] !== "1" || !token || !isUnsubscribeToken(token[1])) return "";
  return token[1];
}

export function planUnsubscribe(input: { token: string; nowMs: number; records: UnsubscribeRecord[] }) {
  if (!isUnsubscribeToken(input.token)) return { outcome: "invalid" as const, suppressEmail: "" };
  const tokenHash = hashUnsubscribeToken(input.token);
  const record = input.records.find((item) => item.tokenHash === tokenHash);
  if (!record) return { outcome: "invalid" as const, suppressEmail: "" };
  const suppressEmail = canonicalUnsubscribeEmail(record.normalizedEmail);
  if (!suppressEmail) return { outcome: "invalid" as const, suppressEmail: "" };
  if (record.expiresAtMs <= input.nowMs) return { outcome: "expired" as const, suppressEmail: "" };
  return {
    outcome: record.usedAtMs == null ? ("unsubscribed" as const) : ("repeated" as const),
    suppressEmail,
  };
}

const resultOutcomes = ["done", "limited", "unavailable", "invalid"] as const;
export type PublicUnsubscribeOutcome = (typeof resultOutcomes)[number];

export function unsubscribeResultProof(outcome: PublicUnsubscribeOutcome, secret: string, nowMs: number) {
  if (!secret) return "";
  const exp = nowMs + 2 * 60 * 1000;
  const body = `${outcome}.${exp}`;
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function readUnsubscribeResultProof(proof: string, secret: string, nowMs: number): PublicUnsubscribeOutcome | "" {
  if (!secret || !proof || proof.length > 200) return "";
  const parts = proof.split(".");
  if (parts.length !== 3) return "";
  const [outcome, expText, sig] = parts;
  if (!resultOutcomes.includes(outcome as PublicUnsubscribeOutcome)) return "";
  const expected = createHmac("sha256", secret).update(`${outcome}.${expText}`).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return "";
  const exp = Number(expText);
  if (!Number.isSafeInteger(exp) || exp < nowMs) return "";
  return outcome as PublicUnsubscribeOutcome;
}

export function publicUnsubscribeOutcome(outcome: UnsubscribeOutcome): PublicUnsubscribeOutcome {
  if (outcome === "unsubscribed" || outcome === "repeated") return "done";
  if (outcome === "limited") return "limited";
  if (outcome === "unavailable") return "unavailable";
  return "invalid";
}

export function unsubscribePageCopy(outcome: UnsubscribeOutcome | "ready") {
  if (outcome === "unsubscribed" || outcome === "repeated") {
    return {
      title: "You are unsubscribed",
      body: "You will not receive BlockBooked outreach emails from this link. Booking and account messages are unchanged.",
    };
  }
  if (outcome === "limited") {
    return { title: "Try again later", body: "Too many attempts. Wait a few minutes and try again." };
  }
  if (outcome === "unavailable") {
    return { title: "Try again", body: "We could not confirm this request. Try again in a minute." };
  }
  if (outcome === "ready") {
    return {
      title: "Unsubscribe",
      body: "Confirm to stop BlockBooked outreach emails for this link. This does not affect booking or account messages.",
    };
  }
  return { title: "This link is not valid", body: "This unsubscribe link is not valid or has expired." };
}
