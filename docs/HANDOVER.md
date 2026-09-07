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
  deleted by the migration. Standard student transactions lock user, student,
  institution (UUID order when more than one is relevant), eligibility state,
  consent, challenge, then proof/assertion rows in that order. Withdrawal uses
  that same order without requiring an active subject: it locks both the
  current and historical grant institutions before the consent so historical
  evidence can still be revoked. Enrollment reads a configured method without
  locking that method after its university; a concurrent method mutation is
  serialized by the institution policy generation instead.

  Qualified merchant disclosure is a distinct transaction-entry contract. It
  first resolves the candidate merchant without a lock, then locks the student
  and candidate merchant-owner user rows in UUID order, followed by vendor,
  exact-origin active widget, student context/state, and disclosure consent.
  Do not call `grantMerchantDisclosure` or
  `getEffectiveEligibility(..., disclosure)` after `lockStudentContext`,
  `recordEmailAssurance`, a plain eligibility read, or another merchant
  disclosure in the same transaction unless all participant users were
  predeclared and locked in that one sorted entry phase. Future route
  entrypoints must invoke each operation in a fresh transaction; route wiring
  is not part of this authority change. A merchant must stay
  active and undeleted, with a non-deleted vendor owner and active exact-origin
  widget; changed ownership fails closed. Institution-specific approved domains
  and verification methods cannot be reparented—remove and add configuration
  under the target institution instead. Enrollment provider replies are
  single-consumption generations; snapshot and generation revalidation remain
  authoritative. Merchant consumers remain a separate rollout boundary.

- Student signup is now proof-bound and must use only the dedicated public
  endpoints: `POST /auth/student/register-request` followed by
  `POST /auth/student/register-confirm`. The request stores no password and
  only returns a challenge receipt after email delivery; its challenge is
  bounded to a 10-minute code, five failed guesses, and a 60-second resend
  cooldown. Confirmation repeats the immutable identity and current
  processing-notice action, creates the new student account/proof/processing
  grant/evidence in one transaction, and returns authoritative eligibility.
  Never infer merchant disclosure consent or eligibility from the legacy
  `verification_status` field.
- `POST /auth/verify-student-email` is a public domain-support preflight, not
  mailbox proof. Its successful response always includes the current
  `verificationNotice` version and text; clients must display it before asking
  for the literal affirmative processing action. A supported domain is not an
  account lookup, enrollment result, or `verified` claim. Generic
  `POST /auth/register` with `role: student` returns 410 and vendors keep the
  established registration path.
- A failure after signup proof commits but before session issuance leaves the
  new account intact. Tell the user to sign in normally with the same email and
  password; do not retry proof consumption or roll back committed identity
  rows. Frontend enrollment UX and the separate authenticated verification and
  widget routes remain follow-on rollout work.
- Authenticated student verification is now a separate signed-in flow:
  `POST /verification/initiate`, `POST /verification/email/request`,
  `POST /verification/email/confirm`, `GET /verification/status`,
  `POST /verification/disclosures`, and `DELETE /verification/consents/:id`.
  Bodies never select an account; identity comes only from the access JWT and
  current locked database authority. Email request stores a bounded OTP
  challenge and sends its code only after the challenge transaction commits;
  email confirmation consumes that challenge, then records mailbox proof and
  eligibility evidence atomically. Clients must
  display the returned current verification/disclosure notices and provide the
  literal affirmative action before a new processing or merchant grant.
- `POST /verification/email`, `GET /verification/email/verify`, both WhatsApp
  verification routes, and `GET /verification/status/:studentId` are retired
  with 410 upgrade guidance. `POST /verification/registration` is authenticated
  and accepts only `{ registrationNumber, processingGrantId }`; it cannot select
  a user, university, mailbox, or name. It returns effective eligibility plus
  only `provider_unknown` or `provider_unavailable` when applicable. It does
  not create accounts, issue sessions, expose provider data, or substitute
  legacy flags. `POST /verification/widget/token` remains unavailable pending
  the separate merchant-assertion task.

## Enrollment-provider v1 configuration

The only implemented enrollment adapter contract is `awoof.enrollment.v1`.
An institution must have exactly one active `registration` method row, an HTTPS
hostname endpoint without URL userinfo or a fragment, an explicit non-null
`registration_normalization` policy (`exact` or `trim_upper`), and exactly this
server-side `api_config` shape:

```json
{"schemaVersion":"awoof.enrollment.v1"}
```

Generic `database_api_url` values, an endpoint alone, inactive rows, unknown
versions, and extra configuration keys are unavailable; they must never be
treated as a compatible school integration. The public methods endpoint uses
the same parser and does not return `api_config` or endpoint details.

The configured provider receives only the authenticated proven mailbox and the
requested registration identifier. Its response must be exactly one of:

```json
{"schemaVersion":"awoof.enrollment.v1","outcome":"unknown"}
{"schemaVersion":"awoof.enrollment.v1","outcome":"denied","email":"student@school.example"}
{"schemaVersion":"awoof.enrollment.v1","outcome":"verified","email":"student@school.example","registrationNumber":"REG-1","validUntil":"2027-01-01T00:00:00.000Z"}
```

The adapter rejects non-200 responses, malformed JSON, unrecognized or extra
fields, missing/mismatched mailbox, wrong version, non-future timestamps,
unmatched registration identifiers, inferred names/student data, and caller
mailbox fallbacks as unknown. It supplies the fixed internal
`institution-registration:v1` source; provider-controlled source metadata is
never trusted. A verified identifier must match under the institution's
explicit normalization before a new application transaction can record it.

Transport runs only after the snapshot transaction commits and is bounded to a
five-second HTTPS request, 2 KiB request, 16 KiB response, no redirects or
proxy, disabled decompression, explicit abort signal, a fresh TLS-verifying
agent, and a socket lookup pinned to a just-validated public DNS address. No
private, loopback, link-local, documentation, multicast, or unique-local
destination is allowed. A private-network exception, provider authentication
format, live endpoint allowlist, and proof of a university's interoperability
all require a future owner operating decision; synthetic fixtures are not live
provider assurance.

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

The suite verifies storage, session, and synthetic authenticated verification
flows. It never delivers a real email or contacts a university; transport and
provider production assurance remain separate release gates.

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
