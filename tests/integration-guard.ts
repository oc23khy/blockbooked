const LOCAL_DATABASES = [
  { port: "54322", database: "postgres" },
  { port: "54329", database: "blockbooked_booking_integration" },
];

export const LOCAL_MIGRATION_VERSIONS = [
  "20261109180000",
  "20261110003000",
  "20261110190000",
  "20261110200000",
  "20261110230000",
  "20261110240000",
  "20261110250000",
  "20261110260000",
  "20261110270000",
  "20261110280000",
  "20261110290000",
  "20261110300000",
  "20261110310000",
  "20261110320000",
  "20261111180000",
  "20261111190000",
  "20261111200000",
  "20261111210000",
  "20261111220000",
  "20261112010000",
  "20261112020000",
  "20261112030000",
  "20261112040000",
  "20261114010000",
  "20261114020000",
  "20261114030000",
  "20261114035000",
  "20261114040000",
  "20261114050000",
];

export function assertDisposableDatabaseUrl(url: string, productionUrl?: string) {
  if (!url || /supabase\.co|pooler\.supabase\.com/i.test(url)) {
    throw new Error("Refusing a hosted Supabase database.");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Booking integration URL is not a URL.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("Booking integration URL must use postgres.");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("Refusing a booking integration database that is not on this computer.");
  }
  if (productionUrl) {
    try {
      const production = new URL(productionUrl);
      if (production.hostname === host && host !== "127.0.0.1" && host !== "localhost") {
        throw new Error("Refusing the production Supabase URL.");
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Refusing")) throw error;
    }
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const port = parsed.port || "5432";
  const allowed = LOCAL_DATABASES.some((entry) => entry.port === port && entry.database === database);
  if (!allowed) {
    throw new Error(
      "Refusing this database. Use 127.0.0.1:54322/postgres from local Supabase, or 127.0.0.1:54329/blockbooked_booking_integration.",
    );
  }
  if (process.env.BLOCKBOOKED_BOOKING_TEST_CONFIRM !== "local-disposable") {
    throw new Error("Set BLOCKBOOKED_BOOKING_TEST_CONFIRM=local-disposable before running database integration tests.");
  }
  return { host, port, database };
}

function addressClass(address: string | null) {
  if (address == null || address.trim() === "") return "absent";
  const raw = address.split("/")[0].trim().toLowerCase();
  if (raw === "::1" || raw === "0:0:0:0:0:0:0:1") return "loopback";
  const parts = raw.split(".");
  if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part))) {
    const numbers = parts.map(Number);
    if (numbers.some((number) => number > 255)) return "public";
    const [first, second] = numbers;
    if (first === 127) return "loopback";
    if (first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) return "private";
    return "public";
  }
  if (raw.startsWith("fc") || raw.startsWith("fd")) return "private";
  return "public";
}

export function assertConnectedLocalDatabase(input: {
  expectedDatabase: string;
  currentDatabase: string;
  serverAddress: string | null;
  migrations: readonly string[];
}) {
  const where = addressClass(input.serverAddress);
  if (where === "public") {
    throw new Error("Refusing a database server with a public address.");
  }
  if (input.currentDatabase !== input.expectedDatabase) {
    throw new Error("Refusing a database whose name does not match the local connection.");
  }
  const applied = [...input.migrations].sort();
  const expected = [...LOCAL_MIGRATION_VERSIONS].sort();
  if (applied.length !== expected.length || applied.some((version, index) => version !== expected[index])) {
    throw new Error("Refusing a database whose migration history is not the local Supabase history.");
  }
  return { addressClass: where };
}

export function assertStripeTestKey(key: string) {
  if (!key || key.startsWith("sk_live_") || !key.startsWith("sk_test_")) {
    throw new Error("Stripe integration tests accept only an sk_test_ key.");
  }
  if (process.env.BLOCKBOOKED_STRIPE_TEST_CONFIRM !== "test-mode-only") {
    throw new Error("Set BLOCKBOOKED_STRIPE_TEST_CONFIRM=test-mode-only before running Stripe integration tests.");
  }
}
