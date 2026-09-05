# Awoof operational handover

## Current release boundary

- Production is deployed to the Hostinger VPS with Docker Compose.
- Production changes are released from `main` by `.github/workflows/deploy.yml`.
- The deployment workflow must create and validate a PostgreSQL backup before
  building containers.
- The one-shot `migrate` service must finish successfully before the backend
  starts.
- Migration `028_durable_refresh_sessions.sql` must run before a backend that
  enforces durable refresh sessions starts. It intentionally does not create
  sessions for existing refresh JWTs, so users must sign in again after this
  migration is deployed.
- Migration `030_eligibility_authority.sql` adds explicit policy, consent,
  mailbox-proof and eligibility-evidence records. It intentionally backfills
  nothing: historical `verification_status='verified'` accounts must reverify.
  Operators must configure exact approved student-email domains and exact HTTPS
  widget origins; legacy directory domains and widget hostnames do not authorize
  eligibility. Duplicate student-profile and normalized-email legacy data blocks
  the migration with count-only operator diagnostics; it is never merged or
  deleted by the migration. Service transactions lock user, student,
  institution, eligibility state, consent, challenge, then proof/assertion rows
  in that order. Enrollment provider replies are single-consumption generations:
  invalid, stale, mismatched-email, or untrusted-source replies do not advance
  the marker. Routes and merchant consumers remain a separate rollout boundary.

## Owner-controlled configuration

Configure these in the VPS `.env`; never commit their values:

- `DB_PASSWORD`
- `REDIS_PASSWORD`
- `JWT_SECRET`
- `JWT_REFRESH_SECRET`
- `PAYSTACK_SECRET_KEY`
- `PAYSTACK_PUBLIC_KEY`
- `BREVO_API_KEY`

The Paystack webhook URL is `https://api.awoof.tech/api/webhooks/paystack`.
Paystack signs webhooks with `PAYSTACK_SECRET_KEY`; do not configure a separate
webhook secret.
Use test-mode Paystack credentials until the checkout acceptance test passes.

## Release checklist

1. Confirm CI, backend tests, web build, backend build, and widget build pass on
   the exact PR head.
2. Resolve every actionable review thread.
3. Confirm at least 10% free disk space on the VPS.
4. Confirm the last backup exists, is non-empty, and passes `pg_restore --list`.
5. Deploy the exact reviewed commit from `main`.
6. Confirm the migration service exits successfully and all application
   containers are healthy.
7. Smoke-test student registration, vendor approval, payout-bank setup,
   checkout, webhook replay, support replies, notifications, and email.
8. Record the deployed commit and backup filename in the release notes.

## Disposable PostgreSQL verification suite

Run `npm run test:postgres` from `apps/backend` for the real-SQL transactional
verification suite. It requires local `initdb`, `pg_ctl`, and `createdb`
binaries on `PATH` (or `POSTGRES_BIN_DIR`), and at least 3 GiB free in the OS
temporary directory. The runner creates a uniquely named loopback-only cluster
and `awoof_test_*` database, sets its own test-only database URL and guard
token, runs migrations, uses one test worker, then stops and removes only that
fixture. It refuses normal database URLs; do not run integration files directly.

The suite verifies storage and session boundaries only. Challenge routes and
external OTP delivery remain deliberately unwired until their dependent route
migration is reviewed.

## Payment reconciliation

If a verified charge cannot be fulfilled because stock is unavailable, the
transaction is set to `requires_refund` and a row is added to
`payment_reconciliation_queue`. Treat every pending row as an operator action:

1. Match `paystack_reference` and `paid_amount` against the Paystack dashboard.
2. Issue or confirm the refund in Paystack.
3. In one database transaction, change the Awoof transaction to `refunded`,
   change the queue row to `resolved`, and record a non-sensitive
   `resolution_note` and `resolved_at` timestamp.
4. Re-query both rows and retain Paystack's refund record for the audit trail.

Never mark the queue row resolved before Paystack confirms the refund. Do not
store card, bank, or customer identity data in `resolution_note`.

## Rollback boundary

Application rollback and database rollback are separate operations. Reverting
the application image does not reverse a migration. Before restoring a dump,
stop application writes and preserve the failed database for investigation.
Never restore over production without an explicit owner decision.

## Reviewer onboarding

- CodeRabbit is configured by `.coderabbit.yaml`; repositories below its
  automatic-review eligibility must trigger it manually.
- Configure Jules, Gemini, Claude, and Codex independently for this repository.
  Their Baci repository secrets cannot be read or copied through GitHub.
- Make required-review and CI checks part of `main` branch protection only
  after each reviewer has produced a valid result on a test PR.
