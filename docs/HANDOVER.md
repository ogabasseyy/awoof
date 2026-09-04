# Awoof operational handover

## Current release boundary

- Production is deployed to the Hostinger VPS with Docker Compose.
- Production changes are released from `main` by `.github/workflows/deploy.yml`.
- The deployment workflow must create and validate a PostgreSQL backup before
  building containers.
- The one-shot `migrate` service must finish successfully before the backend
  starts.

## Owner-controlled configuration

Configure these in the VPS `.env`; never commit their values:

- `DB_PASSWORD`
- `REDIS_PASSWORD`
- `JWT_SECRET`
- `JWT_REFRESH_SECRET`
- `PAYSTACK_SECRET_KEY`
- `PAYSTACK_PUBLIC_KEY`
- `PAYSTACK_WEBHOOK_SECRET`
- `BREVO_API_KEY`
- `SENTRY_DSN`

The Paystack webhook URL is `https://api.awoof.tech/api/webhooks/paystack`.
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
