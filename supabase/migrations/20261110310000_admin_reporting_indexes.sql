-- Indexes for admin overview filters. Additive only. Do not rewrite older migrations.
-- booking status counts and the open manual-review queue filter on these columns.

create index if not exists booking_requests_status_idx
  on public.booking_requests (status);

create index if not exists booking_requests_open_reviews_idx
  on public.booking_requests (review_requested_at)
  where status = 'accepted' and review_requested_at is not null;
