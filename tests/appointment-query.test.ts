import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const migration = readFileSync(new URL("../supabase/migrations/20261110260000_provider_schedules.sql", import.meta.url), "utf8");
const table = migration.slice(
  migration.indexOf("create table if not exists public.booking_appointments ("),
  migration.indexOf(");", migration.indexOf("create table if not exists public.booking_appointments (")),
);
const columns = new Set(
  [...table.matchAll(/\n\s{2}([a-z_]+) /g)].map((match) => match[1]).filter((name) => name !== "constraint"),
);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (entry === "node_modules" || entry === ".next") return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return entry.endsWith(".ts") || entry.endsWith(".tsx") ? [path] : [];
  });
}

function appointmentSelects(source: string) {
  const selects: string[] = [];
  const pattern = /from\("booking_appointments"\)\s*\.select\("([^"]+)"\)/g;
  for (const match of source.matchAll(pattern)) selects.push(match[1]);
  return selects;
}

describe("booking appointment queries", () => {
  it("selects only columns that exist on booking_appointments", () => {
    assert.ok(columns.has("booking_id"));
    assert.equal(columns.has("id"), false);
    const offenders: string[] = [];
    for (const file of sourceFiles(fileURLToPath(new URL("../src", import.meta.url)))) {
      const source = readFileSync(file, "utf8");
      for (const selected of appointmentSelects(source)) {
        for (const column of selected.split(",").map((name) => name.trim()).filter(Boolean)) {
          if (!columns.has(column)) offenders.push(`${file}: ${column}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("requires a held appointment for acceptance and hides query failures", () => {
    const action = readFileSync(new URL("../src/app/actions/bookings.ts", import.meta.url), "utf8");
    const acceptance = action.slice(action.indexOf("export async function updateBookingStatus"), action.indexOf("export async function submitCompletionPin"));
    const lookup = acceptance.slice(acceptance.indexOf('from("booking_appointments")'), acceptance.indexOf("const payment"));
    assert.match(lookup, /\.select\("booking_id"\)/);
    assert.match(lookup, /\.eq\("booking_id", bookingId\)/);
    assert.match(lookup, /\.eq\("status", "held"\)/);
    assert.equal(lookup.includes('.select("id")'), false);
    assert.ok(lookup.indexOf("reserved.error") < lookup.indexOf("!reserved.data"));
    assert.match(lookup, /The appointment could not be checked\. Try again\./);
    assert.match(lookup, /Accepting requires a reserved appointment\. A time of day is not an appointment\./);
    assert.doesNotMatch(lookup, /reserved\.error\.message/);
  });
});
