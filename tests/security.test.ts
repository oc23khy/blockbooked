import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { detectProviderImage, MAX_PROVIDER_IMAGE_BYTES } from "../src/lib/images/sniff.ts";
import { customerFacingError, shownError } from "../src/lib/public-error.ts";
import { contentSecurityPolicy, securityHeaderList } from "../src/lib/security-headers.ts";

const scheduleAction = readFileSync(new URL("../src/app/actions/schedule.ts", import.meta.url), "utf8");
const nextConfig = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
const storageMigration = readFileSync(
  new URL("../supabase/migrations/20261110260000_provider_schedules.sql", import.meta.url),
  "utf8",
);

describe("security headers", () => {
  it("sets a production policy that blocks framing and sniffing without unsafe-eval", () => {
    const policy = contentSecurityPolicy("production");
    const headers = Object.fromEntries(securityHeaderList("production").map((header) => [header.key, header.value]));
    assert.equal(headers["Content-Security-Policy"], policy);
    assert.equal(headers["X-Content-Type-Options"], "nosniff");
    assert.equal(headers["Referrer-Policy"], "strict-origin-when-cross-origin");
    assert.equal(headers["X-Frame-Options"], "DENY");
    assert.match(policy, /frame-ancestors 'none'/);
    assert.match(policy, /object-src 'none'/);
    assert.match(policy, /https:\/\/\*\.supabase\.co/);
    assert.match(policy, /form-action 'self'/);
    assert.doesNotMatch(policy, /unsafe-eval/);
    assert.match(nextConfig, /securityHeaderList/);
    assert.match(nextConfig, /bodySizeLimit:\s*"6mb"/);
  });

  it("allows the local compiler to use unsafe-eval only in development", () => {
    assert.match(contentSecurityPolicy("development"), /unsafe-eval/);
    assert.doesNotMatch(contentSecurityPolicy("development"), /upgrade-insecure-requests/);
  });
});

describe("customer-facing errors", () => {
  it("keeps validation and rate-limit messages", () => {
    assert.equal(
      customerFacingError("Too many attempts. Wait a few minutes and try again.", "Try again."),
      "Too many attempts. Wait a few minutes and try again.",
    );
    assert.equal(customerFacingError("Images must be 5 MB or smaller.", "Try again."), "Images must be 5 MB or smaller.");
    assert.equal(shownError("Add a date and a time of day."), "Add a date and a time of day.");
  });

  it("replaces database, stack, and secret text", () => {
    assert.equal(
      customerFacingError('duplicate key value violates unique constraint "booking_requests_pkey"', "The booking could not be saved."),
      "The booking could not be saved.",
    );
    assert.equal(shownError("SQLSTATE 42702 column reference is ambiguous"), "Something went wrong. Try again.");
    assert.equal(customerFacingError("permission denied for table payments", "Try again."), "Try again.");
    assert.equal(customerFacingError("using sk_test_secretvalue", "Try again."), "Try again.");
    assert.doesNotMatch(customerFacingError("Error at /app/src/lib/payments/service.ts:102", "Try again."), /service\.ts/);
  });
});

describe("provider image contents", () => {
  it("accepts JPEG, PNG, and WebP from their file signatures", () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const webp = Uint8Array.from([
      ..."RIFF".split("").map((char) => char.charCodeAt(0)),
      0, 0, 0, 0,
      ..."WEBP".split("").map((char) => char.charCodeAt(0)),
    ]);
    assert.deepEqual(detectProviderImage(jpeg), { mime: "image/jpeg", extension: "jpg" });
    assert.deepEqual(detectProviderImage(png), { mime: "image/png", extension: "png" });
    assert.deepEqual(detectProviderImage(webp), { mime: "image/webp", extension: "webp" });
  });

  it("rejects a renamed executable, HTML, SVG, and an oversized file", () => {
    const executable = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00]);
    const html = Uint8Array.from("<html><script>alert(1)</script></html>".split("").map((char) => char.charCodeAt(0)));
    const svg = Uint8Array.from("<svg onload=alert(1)></svg>".split("").map((char) => char.charCodeAt(0)));
    assert.equal(detectProviderImage(executable), null);
    assert.equal(detectProviderImage(html), null);
    assert.equal(detectProviderImage(svg), null);
    assert.equal(detectProviderImage(new Uint8Array(MAX_PROVIDER_IMAGE_BYTES + 1)), null);
    assert.match(scheduleAction, /detectProviderImage/);
    assert.doesNotMatch(scheduleAction, /contentType: file\.type/);
    assert.match(scheduleAction, /unstable_rethrow/);
    assert.match(scheduleAction, /The photo could not be saved/);
  });
});

describe("provider media storage", () => {
  it("keeps the public gallery limited to owner uploads of jpeg, png, and webp", () => {
    assert.match(storageMigration, /'provider-media'/);
    assert.match(storageMigration, /5242880/);
    assert.match(storageMigration, /image\/jpeg', 'image\/png', 'image\/webp'/);
    assert.doesNotMatch(storageMigration, /image\/svg/);
    assert.match(storageMigration, /provider_media_public_read/);
    assert.match(storageMigration, /for select/);
    assert.match(storageMigration, /provider_media_owner_insert/);
    assert.match(storageMigration, /provider_media_owner\(name\)/);
    assert.match(storageMigration, /to authenticated/);
    assert.doesNotMatch(storageMigration, /provider_media_owner_insert[\s\S]{0,180}to anon/);
  });
});
