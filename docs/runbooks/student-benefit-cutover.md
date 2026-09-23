# Student benefit cutover runbook (Release A)

Enrollment-only benefit enforcement ships before any provider login is
enabled. This runbook records every benefit consumer, its email-only-fails
proof, the disposable-database rehearsal, and the deploy/rollback gates.
Production steps are recorded as NOT RUN: this task forbids production
access, merges, pushes, deploys, provider enablement, and production
credentials.

## 1. Authority rule

Only current enrollment evidence authorizes student benefits
(`getEffectiveEligibility` returns `eligible=true`). School-account
assurance — email OTP, identity-only Microsoft, Google Workspace account
control — never authorizes a discount, and the two checks stay separate in
every response, UI label, and document. JWTs carry no eligibility claims;
every benefit boundary re-reads server authority inside its commit
transaction, so expiry, denial, and revocation take effect immediately.

## 2. Benefit consumers

Each consumer below was searched from `verification_status`,
`getEffectiveEligibility`, `student_email`, `verification_tokens`, and
voucher-field references across `apps/backend/src` (source and the compiled
artifact carry the same code; `test:artifact` proves route/OpenAPI parity).
Every consumer fails closed for a student holding only a fresh mailbox
proof.

| # | Consumer | Route / entrypoint | Authority check | Email-only-fails proof |
| - | -------- | ------------------ | --------------- | ---------------------- |
| 1 | Checkout start | `POST /api/checkout` → `CheckoutController.createCheckout` (`apps/backend/src/controllers/checkout.controller.ts:64-65`) | `getEffectiveEligibility`; rejects with `Current student eligibility is required to purchase` before any reservation | `checkout-refund-regressions.integration.ts`: `email-only student cannot start checkout without current enrollment evidence`; rehearsal §4b |
| 2 | Payment fulfillment / refund | `completeMarketplaceTransactionWithClient` (`apps/backend/src/services/payment/checkout.service.ts:219,270-282`) | Rechecks eligibility, student binding, and database-time expiry at fulfillment; otherwise `requires_refund` + `payment_reconciliation_queue` row (`eligibility_not_current`) | rehearsal §4b (email-only) and §4d (lapsed after reservation) |
| 3 | Assertion issuance | `POST /api/merchant-verification/assertions` → `issueMerchantAssertion` (`apps/backend/src/services/verification/merchant-assertion.service.ts:28-31`) | `getEffectiveEligibility` with merchant disclosure; 403 `Current student eligibility and merchant consent required` | `merchant-assertion.integration.ts`: `merchant assertion issuance rejects an email-only student without current enrollment evidence`; rehearsal §4b |
| 4 | Assertion exchange | `POST /api/merchant-verification/exchange` → `exchangeMerchantAssertion` (`apps/backend/src/services/verification/merchant-assertion.service.ts:121`) | Re-reads current eligibility after sorted participant locks; same-operation receipt replay returns the committed receipt, never a fresh authorization | `merchant-benefit.integration.ts`: `product-bound exchange mints a server-quoted authorization while generic receipts stay unchanged`, `historical receipt retries mint no new authorization and generic receipts cannot report`; rehearsal §4c canary |
| 5 | Transaction reporting | `POST /api/vendors/transactions/report` → `reportMerchantBenefit` (`apps/backend/src/services/verification/merchant-benefit.service.ts:256`) | Strict `benefitAuthorizationId` schema; merchant re-authentication inside the commit transaction; enrollment, evidence, disclosure, product, price, and expiry rechecked on first use; legacy tokens fail closed (422/404) | `merchant-benefit.integration.ts`: `legacy verification tokens fail closed on the reporting route and retired entrypoints stay sealed`, `email-only students cannot mint product authorizations or report`, five `lapsed enrollment (...) cannot authorize a product report` cases (expired, denied, processing_withdrawn, disclosure_withdrawn, inactive); rehearsal §4b |
| 6 | Product claim | `POST /api/merchant-verification/product-claims` → `claimProductBenefit` (`apps/backend/src/services/verification/product-claim.service.ts:225-231`) | Session-bound vendor/product/origin from trusted records; current enrollment + disclosure rechecked at commit; 403 `Current student enrollment required for this discount` | `product-claim.http.test.ts`: `pending students cannot claim: 403 names enrollment and keeps school-account assurance separate`, `expired evidence, withdrawn consent and wrong-merchant grants fail closed without a handoff`; `product-claim.integration.ts`: `claims fail closed for pending, expired and consent-withdrawn students`; rehearsal §4b |
| 7 | Protected redemption | Claim-bound `exchangeMerchantAssertion` with merchant nonce + checkout proof | Timing-safe nonce match, checkout binding, atomic single consumption of the claim session; one redemption per merchant checkout enforced in the merchant's durable transaction; unintegrated merchants get 409 `MERCHANT_INTEGRATION_REQUIRED` | `product-claim.integration.ts`: `protected redemption flows through a durable merchant server with one redemption per checkout`, `concurrent duplicate exchanges grant a single redemption per checkout`, `exchange requires claim-session proof exactly for claim-bound codes`, `claims require a deployed merchant integration at commit time` |
| 8 | Public product projection | `GET /api/products*` → `toPublicProduct` (`apps/backend/src/services/verification/product-claim.service.ts:45-54`) | Allowlist projection: advertised prices stay visible; voucher codes, discount-bearing URL queries, and protected fulfillment fields never leave the server, including nested payloads | `product-claim.http.test.ts`: `anonymous product list strips voucher codes, protected URLs and nested fulfillment secrets`, `anonymous product detail strips protected fields and reports unknown products as 404` |
| 9 | Legacy verification tokens | `verification-token.service.ts` (issuance/validation/consumption sealed) + `tokens:retire` maintenance script | Entrypoints throw/report `retired` without touching the database; retirement sets `revoked_at` on unused rows only, never `used_at` | `verification-token.service.test.ts`: `retired verification tokens` (issue/consume/validate); `merchant-benefit.integration.ts`: `token retirement revokes only unused legacy tokens and never marks them used`; rehearsal §4e |

Non-consumers confirmed by the same search: `users.verification_status`
reads in `auth.controller.ts` / `student.controller.ts` serve account
login and profile display only (deprecated in OpenAPI wherever it meets
student responses); `admin-vendor.controller.ts` checks vendor-owner
account flags, not student benefits; vendor analytics student counts are
transaction-derived (renamed to `purchasingStudents`, §5).

## 3. Admin visibility (new in this release)

- `GET /api/admin/students` adds a per-row `studentAssurance` projection
  (`apps/backend/src/services/verification/admin-student-assurance.service.ts`):
  bounded to 100 rows, read-only (no `FOR UPDATE`), sharing the point
  reader's `resolveStudentStatus` / `resolveSchoolAccount` / source-mapping
  rules over batched unlocked reads. It reports pending, verified,
  expired, denied, revoked, and inactive with method/expiry provenance and
  never authorizes benefits.
- Parity proof: `admin-student-assurance.integration.ts` asserts
  `deepEqual` against `readStudentAssurance` for every status, plus
  absent-profile/university pending, a boundedness/lock-freedom check, and
  an end-to-end list read.
- The admin students page shows independent `School account` and `Student
  status` columns, extended in place with existing styling.

## 4. Cutover rehearsal (disposable database only)

Rehearsed in `apps/backend/src/testing/postgres/cutover-rehearsal.integration.ts`
against a fresh upgraded disposable cluster (all migrations including 056,
same shape as the release target). No production database, credentials, or
steps were used.

- a. `cutover retains historical purchases and savings for email-only
  students`: a preexisting completed order and `savings_stats` row stay
  readable through student savings and the admin list after cutover.
- b. `email-only proofs fail every benefit consumer on the upgraded
  database`: checkout start, assertion issuance, product claim, legacy-token
  report (422) and unknown authorization (404), sealed token entrypoints,
  and fulfillment → `requires_refund` with an `eligibility_not_current`
  reconciliation row, no stock movement.
- c. `enrolled students keep issuance, exchange, and fulfillment as the
  positive canary`: enrolled issuance + product-bound exchange mint a
  `benefitAuthorizationId`; fulfillment completes and records savings.
- d. `already-paid orders that lose enrollment reconcile instead of
  completing`: consent withdrawn after reservation → `requires_refund` +
  reconciliation, no savings credited, existing `requires_refund` path
  preserved (never silent completion, never silent discount).
- e. `cutover token retirement revokes only unused legacy tokens`:
  `revokeUnusedLegacyTokens` revokes unused rows, preserves used rows and
  their `used_at`, and is idempotent.

Result: 5/5 pass (full postgres suite 273 pass, 0 fail, 1 designed skip).

## 5. Metric rename

`verified_students` (vendor analytics) counted students with a completed
order; it never measured verification. It is renamed to
`purchasing_students` / `purchasingStudents` in
`apps/backend/src/controllers/analytics.controller.ts`, the vendor
analytics page (`Purchasing Students` card), and the new
`VendorStudentAnalytics` OpenAPI schema. The old `verifiedStudents`
response field remains as an explicitly deprecated alias returning the
same value. Proof: `analytics.controller.test.ts` and
`apps/web/tests/auth/vendor-analytics.test.ts` (new-field parsing plus
deprecated-alias fallback).

## 6. Deploy gates (NOT RUN — production forbidden this task)

Run in order during the release window; each gate needs a named operator
and a recorded result before proceeding.

1. NOT RUN — Put affected benefit routes in maintenance (checkout start,
   assertion issuance/exchange, transaction reporting, product claims)
   while keeping account login, password recovery, unlink, and status
   reads accessible.
2. NOT RUN — Deploy the enrollment-only build to all API and worker
   instances; confirm every instance serves the new build before reopening
   benefits (mixed-version window stays closed).
3. NOT RUN — Caching: no action required beyond the deploy. Eligibility
   and benefit state are never cached in Redis (Redis holds only
   password-reset OTPs and rate-limit buckets) and JWTs carry no
   eligibility claims; claim/handoff responses are `no-store`.
4. NOT RUN — Run token retirement exactly once:
   `npm --prefix apps/backend run tokens:retire` (sets `revoked_at` on
   unused legacy tokens only). Verify: unused rows revoked, used rows
   untouched, second run revokes zero.
5. NOT RUN — Install, run once, and verify alerting for the recurring
   `benefits:cleanup:prod` job BEFORE reopening benefits. Exchange
   reserves stock immediately and only that job releases abandoned
   reservations; without it, ordinary abandonment exhausts sellable
   inventory. Record the schedule, the successful manual run, and the
   monitor here.
6. NOT RUN — Drain old instances, then prove canaries: one negative
   canary per consumer §2 (email-only fails) and one positive canary per
   §4c (enrolled succeeds), then reopen benefits.
7. NOT RUN — Real-partner acceptance stays outstanding: an integrated
   merchant must implement the fixed `/awoof/student-claim` callback, the
   server-side exchange with nonce/checkout binding, and one redemption
   per checkout before external enforcement is claimed live.

## 7. Rollback

Rollback means benefits stay closed until a fixed enrollment-only build
passes the §6 canaries. Never restore stale verification state, never
downgrade to an email-eligible build, and never deploy an old
email-eligible build as a rollback. Account login, recovery, owner
unlink, and valid independent enrollment stay operational throughout.
