## Recommended Connect integration

### A. Account configuration
Accounts API: `/v2/core/accounts`
Legacy account `type`: not used for new accounts
Dashboard: Express (lightweight view for sellers)
Fee collection: your platform manages pricing
Negative balance liability: your platform

BlockBooked collects the customer payment and later sends the provider share. Providers need a lightweight dashboard, not a full independent Stripe account. The platform keeps pricing control and is liable when a connected-account balance goes negative.

Each connected account needs the recipient configuration (`configuration.recipient`) with `stripe_transfers` on `stripe_balance` requested, so the account can receive transfers from the platform. Marketplace connected accounts should NOT request merchant configuration or `card_payments` capability — this is unnecessary and causes longer onboarding.

### B. Charge pattern: separate charges and transfers
The customer pays BlockBooked. The provider is not paid at checkout. After the existing PIN check or an admin review marks the booking completed, BlockBooked creates a transfer for 92% of the amount still collected. Destination charges cannot hold funds until completion, so they do not fit this timing.

### C. Provider onboarding flow
Onboarding method: Stripe-hosted

An approved provider starts onboarding from the dashboard. BlockBooked creates the connected account, Stripe hosts identity verification, and the return page reads capability status. Payouts stay disabled until `stripe_transfers` is active. Requirements that appear later are handled by sending the provider through onboarding again. Live charges stay off; only test mode is enabled.

### D. Payments dashboard access for providers
Providers open the Express dashboard through a login link created by BlockBooked. Embedded components can show onboarding, notifications, payouts, and payments inside BlockBooked later. Providers do not receive the platform secret key.

### E. Embedded components
Recommended [Connect embedded components](https://docs.stripe.com/connect/supported-embedded-components):
- `account_onboarding`
- `notification_banner` (required; keeps connected accounts aware of new requirements so they stay enabled)
- `account_management`
- `payments`
- `payouts`

Separate charges and transfers show less payment and dispute detail inside those components than a direct charge would. The current site uses Stripe-hosted onboarding instead of embedded components.

### F. Webhook integration
Use webhooks for reliable payment confirmation, especially for async payment methods. Always verify incoming webhook signatures before processing event data ([webhook signature verification](https://stripe.com/docs/events/manage-webhook-endpoints#signature-errors)). Specific events and implementation details are covered in the build skill.

### G. Onboarding status gating
Verify capability statuses with `stripe.v2.core.accounts.retrieve(id)` before enabling payouts and transfers:
- Separate charges and transfers: `configuration.recipient.capabilities.stripe_balance.stripe_transfers.status === 'active'`
- Also check payouts capability status in the relevant subtree

The current code still reads the older Express account fields `payouts_enabled` and `transfers`. New accounts should move to the v2 capability check before live use.

### H. Fee structure
- Platform fee model: percentage
- `application_fee_amount` strategy: not used. Separate charges and transfers retain the fee by transferring less than the charge amount.
- A customer pays the agreed service amount to BlockBooked. BlockBooked keeps 8% as commission and transfers 92% to the provider after verified completion. BlockBooked pays Stripe processing fees. Pricing varies by region and payment method — check [stripe.com/pricing](https://stripe.com/pricing). An 8% commission can be thinner than the processing fee on some payment methods, so track the [margin report](https://docs.stripe.com/connect/margin-reports.md). Do not surcharge customers in this phase.
- `applicationFeeIncludes`: `platform_fee_only`. The $8 is the platform commission. It is not increased to pre-collect Stripe’s processing fee.

```
Customer pays $100
      │
      ▼
┌──────────────┐
│ BlockBooked  │ ─── keeps $8, and also pays Stripe’s processing fee
└──────┬───────┘
       │ transfer $92 after verified completion
       ▼
┌──────────────┐
│ Provider     │ ─── receives $92
└──────────────┘
```

### I. SaaS monetization
BlockBooked uses a transaction fee, not a recurring charge to providers. Do not create a separate customer object to bill providers.

### J. Implementation plan
1. Keep test mode only. Put `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`. Do not paste them into chat.
2. Run `supabase/migrations/20261110230000_stripe_payments.sql`, then `supabase/migrations/20261110240000_quotes_milestones.sql`.
3. Fixed-price checkout, custom quotes, and milestone payments all use a server-calculated amount.
4. Confirm payment with the verified webhook. Transfer the provider share only after PIN or admin completion.
5. Refunds reverse the unpaid or already transferred provider share and the commission in proportion. Do not describe a refund as complete before Stripe confirms it.
6. Before any live use, move new connected accounts to Accounts v2 recipient configuration and turn on Radar. Do not activate live payments now.

### K. Risk and liability
- Negative balance liability owner: your platform
- Risk controls owner: your platform, with Radar recommended

Because the platform is liable for negative balances, a dispute can be recovered from the provider by reversing the transfer after Stripe confirms the dispute. Radar matters because fraudulent charges reduce the platform balance directly. The platform also owns refund and dispute operations.

### L. Why this fits your business
- Customers book local providers through BlockBooked, and BlockBooked is the merchant of record.
- The provider share stays on the platform until the existing completion PIN or admin review.
- The 8% commission is calculated on the server from the catalog price, quote, or milestone amount.
- Listing stays free. Providers connect a test account only after approval.

### M. Open questions
- Embedded components are not installed yet. Stripe-hosted onboarding remains the current path.
- Existing Express accounts created with the card payments capability are left in place. Only new accounts should omit that capability.
- The recorded $8 commission is not reduced by Stripe’s processing fee. Cash left after the provider transfer is lower than $8.
