import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  classifyProspectCsv,
  duplicateKeys,
  normalizeWebsite,
  outreachFilter,
  outreachSearchTerm,
} from "../src/lib/outreach/prospects.ts";

const header = "business_name,category,location,website,contact_email,source,lead_status";
const migration = readFileSync(new URL("../supabase/migrations/20261112020000_outreach_prospects.sql", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/app/admin/outreach/page.tsx", import.meta.url), "utf8");
const actions = readFileSync(new URL("../src/app/actions/outreach.ts", import.meta.url), "utf8");
const nav = readFileSync(new URL("../src/components/admin-nav.tsx", import.meta.url), "utf8");

function row(values: string[]) {
  return values.map((value) => `"${value.replaceAll('"', '""')}"`).join(",");
}

describe("outreach csv import", () => {
  it("previews a new prospect and rejects a duplicate, an opted-out email, and a bad website", () => {
    const csv = [
      header,
      row(["North Clean", "Cleaning", "Rockford", "https://www.north.example/about/?utm=1", "Owner@North.Example", "chamber", "new"]),
      row(["North Clean", "Cleaning", "Rockford", "north.example/about", "other@north.example", "web", "new"]),
      row(["Opted Shop", "Plumbing", "Loves Park", "", "gone@example.com", "list", "new"]),
      row(["", "Cleaning", "Rockford", "", "bad-email", "list", "later"]),
      row(["=Unsafe Name", "Cleaning", "Rockford", "javascript:alert(1)", "", "list", "new"]),
    ].join("\n");
    const existing = duplicateKeys({
      email: "owner@north.example",
      website: "https://north.example/about",
      name: "north clean",
      location: "rockford",
    });
    const result = classifyProspectCsv({ csv, existingKeys: existing, suppressedEmails: ["Gone@Example.com"] });
    assert.equal(result.error, "");
    assert.deepEqual(result.rows.map((item) => item.outcome), ["duplicate", "duplicate", "suppressed", "invalid", "invalid"]);
    assert.equal(normalizeWebsite("https://www.north.example/about/?utm=1"), "https://north.example/about");
    assert.equal(normalizeWebsite("https://WWW.Example.com:443/About/"), "https://example.com/about");
    assert.equal(normalizeWebsite("https://user:pass@example.com"), "");
    assert.equal(result.rows[4]?.businessName.startsWith("="), false);
    assert.match(result.rows[3]?.reason ?? "", /Business name/);
    assert.match(result.rows[4]?.reason ?? "", /Website/);
  });

  it("imports the first copy in a file and keeps a second business with the same name in another city", () => {
    const csv = [
      header,
      row(["River Glass", "Windows", "Rockford", "", "", "fair", ""]),
      row(["River Glass", "Windows", "Rockford", "", "", "fair", "contacted"]),
      row(["River Glass", "Windows", "Machesney Park", "", "", "fair", "interested"]),
    ].join("\n");
    const result = classifyProspectCsv({ csv, existingKeys: [], suppressedEmails: [] });
    assert.deepEqual(result.rows.map((item) => item.outcome), ["ready", "duplicate", "ready"]);
    assert.equal(result.rows[1]?.leadStatus, "contacted");
    assert.equal(result.rows[2]?.leadStatus, "interested");
  });

  it("keeps the search filter quoted so punctuation cannot add a clause", () => {
    assert.equal(outreachSearchTerm("a,b.or.role.eq.admin%"), "ab.or.role.eq.admin");
    const filter = outreachFilter("Owner@North.Example");
    assert.match(filter, /business_name\.ilike\."%owner@north\.example%"/);
    assert.equal(filter.includes(",or."), false);
  });
});

describe("outreach access", () => {
  it("keeps prospects admin-only and separate from bookings, payments, and mail", () => {
    assert.match(page, /requireAdmin\("\/admin\/outreach"\)/);
    assert.match(actions, /requireAdmin\("\/admin\/outreach"\)/);
    assert.match(nav, /href: "\/admin\/outreach"/);
    assert.match(migration, /force row level security/);
    assert.match(migration, /using \(public\.is_admin\(\)\)/);
    assert.match(migration, /revoke all on table public\.outreach_prospects from public, anon, authenticated/);
    assert.match(migration, /revoke all on table public\.outreach_suppressions from public, anon, authenticated/);
    assert.doesNotMatch(migration, /grant truncate|grant all on table public\.outreach/i);
    assert.match(migration, /new\.lead_status := 'suppressed'/);
    assert.match(migration, /to authenticated/);
    assert.doesNotMatch(migration, /for select to anon|for all to public|to public/);
    assert.match(migration, /outreach_suppressions/);
    assert.doesNotMatch(migration, /public\.booking_requests|public\.payments|notification_deliveries|stripe/i);
    assert.doesNotMatch(actions, /stripe|resend|notifyBookingEvent|notifications/i);
    assert.doesNotMatch(page, /stripe|resend|notifyBookingEvent/i);
    assert.match(actions, /redirectIfRateLimited\("outreachWrite"/);
  });
});
