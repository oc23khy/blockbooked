# BlockBooked Supabase setup

The app does not include a Supabase project. Create one, then add the public URL and anon key locally. Do not put the service-role key in this app.

## 1. Create the project

1. Go to [https://supabase.com/dashboard](https://supabase.com/dashboard) and sign in.
2. Choose **New project**.
3. Pick an organization, name the project `blockbooked`, set a database password, and choose a region close to Illinois.
4. Wait until the project status is healthy.

## 2. Copy the credentials

1. Open the project.
2. Go to **Project Settings** (gear) → **API** (or **API Keys**).
3. Copy the **Project URL**. It looks like `https://abcdefghijklmnop.supabase.co`.
4. Copy the **anon public** key. It is safe to use in the browser because Row Level Security limits what it can read and write.
5. Do not copy the **service_role** key into BlockBooked. That key bypasses Row Level Security.

## 3. Add them to the app

In the project folder, create `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_ANON_KEY
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

Restart `npm run dev` after saving the file.

## 4. Run the database migration

1. In the Supabase dashboard, open **SQL Editor**.
2. Open `supabase/migrations/20261109180000_init.sql` from this project.
3. Paste the full file into a new query and run it once.

That creates `profiles`, `providers`, and `booking_requests`, the signup trigger, and the Row Level Security policies.

## 5. Allow the local login redirect

1. Open **Authentication** → **URL Configuration**.
2. Set **Site URL** to `http://localhost:3000`.
3. Add `http://localhost:3000/auth/callback` to **Redirect URLs**.

If **Confirm email** is enabled under **Authentication** → **Sign In / Providers** → **Email**, new users must open the confirmation email before they can log in. You can turn that off while testing locally.

## 6. Make your admin account

Admin cannot be chosen on the signup form.

1. Create an account on the site, using the email you want as admin.
2. In the SQL Editor, run:

```sql
update public.profiles
set role = 'admin'
where email = 'you@example.com';
```

3. Log out and log back in.
4. Open [http://localhost:3000/admin](http://localhost:3000/admin).

## 7. Booking statuses

After the first migration is already applied, run `supabase/migrations/20261110003000_booking_statuses.sql` the same way: open **SQL Editor**, paste the whole file, and run it once. Do not run the first migration again. This update keeps existing rows and turns older `requested` bookings into `pending`.

## 8. Completion PINs

After the booking status migration has succeeded, run `supabase/migrations/20261110190000_completion_pins.sql` once in the SQL Editor. Do not run the earlier migrations again. The script adds completion timestamps and a separate PIN table. It does not delete accounts, listings, or bookings.

Do not query `booking_completion_pins` from the SQL Editor while looking at results. That table holds the customer’s PIN until the booking is completed.

After that file has succeeded, run `supabase/migrations/20261110200000_pin_lockout.sql` once in the same way. It replaces the PIN check so five wrong attempts are stored on the booking and block every later PIN for 15 minutes. Do not run the earlier migrations again.

## 9. Stripe test payments

After the PIN migration, run `supabase/migrations/20261110230000_stripe_payments.sql` once. Do not rerun older files. Then add test-mode values to `.env.local`:

- `STRIPE_SECRET_KEY` must start with `sk_test_`. Live keys are rejected.
- `STRIPE_WEBHOOK_SECRET` is the signing secret for `http://localhost:3000/api/stripe/webhook`.
- `SUPABASE_SERVICE_ROLE_KEY` stays on the server. It is not a public variable. The webhook and payment records use it because customers cannot write payment amounts.

BlockBooked bears Stripe processing fees in this phase. Customers are not surcharged. A provider's gross share is the service amount minus the commission, transferred only after verified completion.

## What the policies do

- Anyone can read providers whose status is `approved`.
- A provider can read and edit only their own application. They cannot approve themselves.
- Customers can create booking requests only for approved providers, and can read only their own requests.
- Providers can read requests sent to their business.
- Admins can review every application.
- A customer can switch to a provider account. Nobody can switch themselves to admin.
