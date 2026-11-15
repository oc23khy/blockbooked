# Booking and payment integration tests

These tests are separate from `npm test`. They do not run unless you point them at a database and a Stripe account that are both local or test-mode, and you set the confirmation variables below.

Do not use the production Supabase URL, the production database password, or an `sk_live_` key. Do not put the test URL or the test key in source control. `.env*` files are gitignored except `.env.example`.

## Database

Docker is installed on this machine, but the Docker engine was not running when this setup was prepared. The Supabase CLI is not installed globally. `npx supabase` can download it. Either local target is accepted:

- Local Supabase: `127.0.0.1:54322`, database `postgres`
- Existing disposable Postgres: `127.0.0.1:54329`, database `blockbooked_booking_integration`

Any `supabase.co` host, any other port, any other database name, and any connection whose host is not `127.0.0.1` or `localhost` is refused. After connecting, the database name must match that URL and `supabase_migrations.schema_migrations` must contain exactly the local migration versions, including `20261114035000` before `20261114040000` and `20261114050000`. Docker may report an internal address such as `172.19.0.2`; that address is not accepted by itself. A public server address is refused even when the migration list matches.

### Local Supabase

1. Start Docker Desktop and wait until `docker ps` works.
2. From the repository root, run `npx supabase init` if `supabase/config.toml` does not exist. This writes local configuration only.
3. Run `npx supabase start`. The first run downloads images.
4. Run `npx supabase db reset`. This applies every file in `supabase/migrations`, including the unapplied booking migrations, to the local database only.
5. Copy the local database URL from the command output. It normally looks like `postgresql://postgres:postgres@127.0.0.1:54322/postgres`.

### Environment

Set these in the shell for one run. Do not commit them.

- `BLOCKBOOKED_BOOKING_TEST_URL` is the local URL from the previous step.
- `BLOCKBOOKED_BOOKING_TEST_CONFIRM` must be exactly `local-disposable`.

Run:

`npm run test:booking-db`

The test inserts only rows owned by two fixed example.com users, then deletes those rows. It checks a third unpaid hold, two simultaneous holds, an overlapping time, a reservation whose appointment is rejected, an older booking that does not require an appointment, paid holds, the 30-minute unpaid expiration, release of that hold, and a customer insert rejected by row security.

A passing run prints the test name and a pass count. A refusal before connecting names the guard that stopped it. A missing function means the local reset did not apply `20261114050000`.

`npx supabase stop` removes the local stack. It does not affect production.

## Stripe test mode

Set these in the shell, not in a committed file.

- `BLOCKBOOKED_STRIPE_TEST_KEY` must start with `sk_test_`. Use a test key from the Stripe test-mode Dashboard. An `sk_live_` key is refused.
- `BLOCKBOOKED_STRIPE_TEST_CONFIRM` must be exactly `test-mode-only`.

Run:

`npm run test:booking-stripe`

The test creates two 50-cent succeeded test charges, refunds the second one twice with the same idempotency key, and checks that only one refund exists. It then refunds any remaining test charge. It does not call the production webhook or the production database.

The same run checks the retry decision for a timeout and the review decision for a permanent card failure. Stripe does not provide a reliable test card that makes a successful charge's refund fail temporarily, so those two outcomes are not created through the Dashboard. No manual Dashboard steps are required for the automated run.

To watch the result, open the Stripe Dashboard, switch to test mode, and search the metadata `blockbooked_integration`. Those charges should be refunded after the test.

Checkout session reuse, an HTTP webhook delivery, and a late payment after cancellation still need the local database and the running app together. Those paths are covered by the in-memory unit tests, not by this Stripe script. No Dashboard click is required.

## What `npm test` covers

`npm test` includes the guard checks and the in-memory booking and payment tests. It does not connect to Postgres or Stripe.
