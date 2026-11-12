import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  eligibleRecipients,
  escapeCampaignText,
  previewCampaign,
  readCampaignDraft,
  type AudienceProspect,
  type CampaignDraft,
} from "../src/lib/outreach/campaigns.ts";

const migration = readFileSync(new URL("../supabase/migrations/20261112030000_outreach_campaigns.sql", import.meta.url), "utf8");
const actions = readFileSync(new URL("../src/app/actions/outreach-campaigns.ts", import.meta.url), "utf8");
const listPage = readFileSync(new URL("../src/app/admin/outreach/campaigns/page.tsx", import.meta.url), "utf8");
const editPage = readFileSync(new URL("../src/app/admin/outreach/campaigns/[id]/page.tsx", import.meta.url), "utf8");
const outreachPage = readFileSync(new URL("../src/app/admin/outreach/page.tsx", import.meta.url), "utf8");

const prospect = (overrides: Partial<AudienceProspect> = {}): AudienceProspect => ({
  id: "00000000-0000-4000-8000-000000000001",
  businessName: "North Clean",
  category: "Cleaning",
  location: "Rockford",
  contactEmail: "owner@north.example",
  source: "chamber",
  leadStatus: "new",
  ...overrides,
});

const readyDraft = (overrides: Partial<CampaignDraft> = {}): CampaignDraft => ({
  name: "Spring introduction",
  subject: "Hello {{business_name}}",
  body: "We work with businesses in {{city}}. {{unknown_token}}",
  senderName: "BlockBooked",
  senderEmail: "notifications@blockbooked.org",
  physicalAddress: "100 State Street, Rockford, IL 61101",
  unsubscribeFooter: "Unsubscribe from these updates by replying to this email.",
  filters: { leadStatus: "", category: "", location: "", source: "" },
  ...overrides,
});

describe("campaign preview and audience", () => {
  it("personalizes a ready preview and withholds the footer until the sender details are valid", () => {
    const ready = previewCampaign(readyDraft(), prospect());
    assert.equal(ready.ready, true);
    assert.equal(ready.subject, "Hello North Clean");
    assert.match(ready.body, /Rockford/);
    assert.match(ready.body, /\{\{unknown_token\}\}/);
    assert.match(ready.footer, /100 State Street/);
    assert.match(ready.footer, /notifications@blockbooked\.org/);
    assert.match(ready.footer, /Unsubscribe/);
    const incomplete = previewCampaign(readyDraft({ unsubscribeFooter: "Thanks" }), prospect());
    assert.equal(incomplete.ready, false);
    assert.equal(incomplete.footer, "");
    assert.ok(incomplete.missing.includes("unsubscribe footer"));
    assert.match(escapeCampaignText("<script>"), /&lt;script&gt;/);
  });

  it("counts only prospects with a usable address that is not suppressed", () => {
    const people = [
      prospect(),
      prospect({ id: "00000000-0000-4000-8000-000000000002", businessName: "Opted", contactEmail: "gone@example.com", leadStatus: "contacted" }),
      prospect({ id: "00000000-0000-4000-8000-000000000003", businessName: "No Mail", contactEmail: "not-an-email", location: "Loves Park" }),
      prospect({ id: "00000000-0000-4000-8000-000000000004", businessName: "Closed", contactEmail: "closed@example.com", leadStatus: "suppressed" }),
      prospect({ id: "00000000-0000-4000-8000-000000000005", businessName: "South Clean", contactEmail: "south@example.com", location: "Machesney Park" }),
    ];
    const all = eligibleRecipients(people, { leadStatus: "", category: "Cleaning", location: "", source: "" }, ["Gone@Example.com"]);
    assert.deepEqual(all.map((item) => item.businessName), ["North Clean", "South Clean"]);
    const optedOut = eligibleRecipients(
      [prospect({ contactEmail: " Owner@North.Example " })],
      { leadStatus: "", category: "", location: "", source: "" },
      ["owner@north.example"],
    );
    assert.equal(optedOut.length, 0);
    const city = eligibleRecipients(people, { leadStatus: "new", category: "", location: "Rockford", source: "" }, []);
    assert.deepEqual(city.map((item) => item.businessName), ["North Clean"]);
    const saved = readCampaignDraft({ name: "Draft", subject: "Hi", body: "Hello", senderEmail: "bad-email" });
    assert.match(saved.error, /Sender email/);
  });
});

describe("campaign access", () => {
  it("keeps drafts admin-only and does not send mail", () => {
    assert.match(outreachPage, /\/admin\/outreach\/campaigns/);
    assert.match(listPage, /requireAdmin\("\/admin\/outreach\/campaigns"\)/);
    assert.match(editPage, /requireAdmin\(/);
    assert.match(actions, /requireAdmin\("\/admin\/outreach\/campaigns"\)/);
    assert.match(actions, /campaign_status: "draft"/);
    assert.match(actions, /\.select\("id"\)/);
    assert.doesNotMatch(actions, /resend|stripe|notifyBookingEvent|fetch\(/i);
    assert.doesNotMatch(editPage, /dangerouslySetInnerHTML|resend|stripe/i);
    assert.match(migration, /force row level security/);
    assert.match(migration, /using \(public\.is_admin\(\)\)/);
    assert.match(migration, /revoke all on table public\.outreach_campaigns from public, anon, authenticated/);
    assert.match(migration, /campaign_status = 'draft'/);
    assert.doesNotMatch(migration, /grant truncate|grant all on table public\.outreach_campaigns/i);
    assert.doesNotMatch(migration, /public\.booking_requests|public\.payments|notification_deliveries/i);
  });
});
