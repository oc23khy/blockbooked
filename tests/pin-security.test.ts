import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const cleanup = readFileSync(
  new URL("../supabase/migrations/20261111190000_clear_terminal_pins.sql", import.meta.url),
  "utf8",
);
const lockout = readFileSync(
  new URL("../supabase/migrations/20261110200000_pin_lockout.sql", import.meta.url),
  "utf8",
);
const original = readFileSync(
  new URL("../supabase/migrations/20261110190000_completion_pins.sql", import.meta.url),
  "utf8",
);
const account = readFileSync(new URL("../src/app/account/page.tsx", import.meta.url), "utf8");
const card = readFileSync(new URL("../src/components/booking-card.tsx", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../src/app/dashboard/page.tsx", import.meta.url), "utf8");
const admin = readFileSync(new URL("../src/app/admin/page.tsx", import.meta.url), "utf8");

describe("completion PIN exposure", () => {
  it("lets only the owning customer read an active PIN", () => {
    assert.match(original, /customer_id = auth\.uid\(\)/);
    assert.match(original, /consumed_at is null/);
    assert.match(original, /revoke all on public\.booking_completion_pins from public, anon, authenticated/);
    assert.match(original, /grant select on public\.customer_completion_pins to authenticated/);
    assert.match(account, /from\("customer_completion_pins"\)/);
    assert.equal(account.includes('from("booking_completion_pins")'), false);
    assert.match(card, /audience === "customer" && booking\.completionPin/);
    assert.equal(dashboard.includes("pin_code"), false);
    assert.equal(admin.includes("pin_code"), false);
  });

  it("keeps bcrypt verification and the five-attempt lockout", () => {
    assert.match(lockout, /secret\.pin_hash = crypt\(submitted_pin, secret\.pin_hash\)/);
    assert.match(lockout, /coalesce\(pins\.failed_attempts, 0\) \+ 1 >= 5/);
    assert.match(lockout, /interval '15 minutes'/);
    assert.equal(cleanup.includes("complete_booking_with_pin"), false);
    assert.equal(cleanup.includes("pin_hash"), false);
  });
});

describe("terminal PIN cleanup", () => {
  it("clears the recoverable PIN for every closed booking status", () => {
    assert.match(cleanup, /new\.status in \('completed', 'expired', 'cancelled', 'declined'\)/);
    assert.match(cleanup, /set pin_code = null/);
    assert.match(cleanup, /booking\.status in \('completed', 'expired', 'cancelled', 'declined'\)/);
    assert.equal(cleanup.includes("status = 'accepted'"), false);
    assert.equal(cleanup.includes("```"), false);
  });

  it("does not clear a PIN while the booking remains accepted", () => {
    const trigger = cleanup.slice(0, cleanup.indexOf("update public.booking_completion_pins as pin"));
    assert.match(trigger, /old\.status is distinct from new\.status/);
    assert.equal(trigger.includes("'accepted'"), false);
  });
});
