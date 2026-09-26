# Task 4 recovery-code lifecycle report

## Scope delivered

- Added the canonical authenticated recovery-code status, generation,
  activation, and removal routes under `/api/auth/student/sso/recovery-code`.
- Added `StudentRecoveryCodeService` with a two-step pending/active lifecycle,
  HMAC-SHA-256 code digests, 256-bit generated values, atomic swaps, and no
  plaintext readback after generation.
- Added migration `072_recovery_code_pending_binding.sql`. Pending records are
  bound immutably to their generating session, credential generation, and (if
  provider-backed) proof identity. Pre-existing unbound pending rows are
  terminalized and scrubbed; active records are preserved.
- Recovery-code replacement and removal require the exact active-code proof;
  grants are bound to the active generation and activation grants to the exact
  pending record. Password and Microsoft reauthentication now carry those
  bindings into canonical action grants.
- A confirmed activation clears the post-recovery password-proof restriction;
  while that marker is set, a provider-backed grant cannot re-enroll a code.

## RED / GREEN evidence

- RED: `passwordless-recovery.integration.ts` was written before the service
  existed and the PostgreSQL suite was launched with the missing import.
- GREEN: backend type-check and unit suite pass after the service, migration,
  canonical routes, and grant bindings were added.
- Focused test coverage includes pending versus active state, one-time grants,
  response-loss retry/status behavior, code-digest non-disclosure, replacement
  and removal old-code gates, expiry, credential/session invalidation, and
  competing activation serialization.

## Coverage boundaries

- This task owns code enrollment lifecycle, not the separate mailbox-OTP
  account-recovery/password-setup endpoint. Pending rows therefore have no
  recovery consumer and cannot authorize recovery.
- Identity-proof revocation is checked at activation for both the generating
  proof and activation proof. Migration 072 prevents later session renewal
  from reviving a pending candidate created before invalidation.

## Documentation impact

No public help, trust, privacy, partner, or developer page was changed. These
are authenticated internal endpoints in a disabled-by-default passwordless
signup implementation; no public route, provider activation, recovery promise,
or enrollment claim is being published. The deferred public-page inventory
already assigns public trust/developer review to Task 7. OpenAPI/public copy
must be updated only when the owner approves an externally supported flow and
deployment evidence exists.

## Outstanding operational gates

- Recovery password setup plus mailbox OTP, notifications, cleanup scheduling,
  and browser UX are separate tasks/gates.
- No provider activation, production deployment, school approval, or public
  recoverability claim follows from this source change.

## Verification handoff

- Controller PostgreSQL run against the pre-amend commit `46511d8` reported
  378 pass, 2 test failures, and 1 skipped test. The failures were a
  message-text matcher and an older 069-style pending fixture missing the new
  072 binding fields; neither was a lifecycle assertion failure. Commit
  `45192b2` fixes both and adds proof-revocation and post-recovery policy
  cases.
- Because `010331d` additionally makes null active-generation binding
  explicit, the controller must run PostgreSQL against `45192b2` (not reuse
  the pre-amend result) for the authoritative final result.
- Controller PostgreSQL run against `45192b2` then reported 380 pass, one
  failure, and one skipped test. The remaining failure exposed a real
  producer/consumer defect: PostgreSQL returns `active_code_generation` as a
  string while the action-grant consumer compared it strictly to the numeric
  expected generation. Commit `8dcef0d` normalizes that numeric comparison and
  adds a RED/GREEN unit regression. PostgreSQL must now be captured against
  `8dcef0d` or later.
