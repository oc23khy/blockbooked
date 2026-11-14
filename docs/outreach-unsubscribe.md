# Outreach unsubscribe links

Phase 3A does not send email. When a future campaign sends one message, create a new token for that recipient and put it only in that message.

1. On the server, call `issueOutreachUnsubscribeToken(recipientEmail)` from `src/lib/outreach/unsubscribe-store.ts`. The service role stays on the server. The database stores a SHA-256 hash, not the token.
2. Use the returned token once. Do not reuse it for another person, and do not put the email address in the link.
3. Footer link: `outreachUnsubscribePageUrl(siteOrigin, token)`. That page only asks the person to confirm. A GET never unsubscribes, so a link scanner that only fetches the page cannot opt the person out.
4. Mail headers, from `outreachListUnsubscribeHeaders(siteOrigin, token)`:
   - `List-Unsubscribe: <https://site/api/outreach/unsubscribe/TOKEN>`
   - `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
5. A mail client completes RFC 8058 by POSTing `List-Unsubscribe=One-Click` with content type `application/x-www-form-urlencoded` to that API URL. No login or cookie is required. The confirmation button POSTs `confirm=1` and the token to `https://site/api/outreach/unsubscribe`, so that POST URL does not contain the token. The one-click URL has to contain it.
6. Either request adds the normalized address to `outreach_suppressions` and marks matching prospects suppressed. A second request for the same token does that again and still succeeds. Addresses are matched in lowercase.
7. Tokens expire 180 days after they are issued. An unknown or expired token gets the same public response and does not reveal whether an address is on the list.
8. Apply `supabase/migrations/20261112040000_outreach_unsubscribe.sql` before these routes are used. Booking notifications do not use this token or these headers.
