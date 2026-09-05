# Task 1 report — transactional challenge foundation

## Scope and interfaces

- Added migration `029_verification_challenges.sql`, with historical immutable
  challenge rows and a `(purpose, subject_digest)` serialized budget. Both
  accept the five server-side purposes, including `account_email` for generic
  mailbox proof only.
- `requestChallenge` and `consumeChallenge` take a caller-owned `PoolClient`
  transaction and never commit or roll back. Rejections are non-throwing
  results so a caller commits failed-attempt accounting; infrastructure and
  invalid server-side programming inputs throw.
- Subject and OTP are separate domain-separated HMAC-SHA-256 values using the
  configured JWT secret; raw subject, OTP, password, and token are not stored.
  JWT-secret rotation intentionally invalidates outstanding challenges.

## RED / GREEN evidence

RED was observed before production implementation: `tsx --test
src/testing/postgres/challenge.integration.ts` failed with
`ERR_MODULE_NOT_FOUND` for `challenge.service.js`. This is explicitly a
new-feature missing-module failure, not a reproduction of a pre-existing
production issue.

GREEN: `npm run test:postgres` passed 14 real PostgreSQL tests. They cover
guard refusal, storage secrecy, bindings, purpose isolation, cooldown/send and
failure budgets, expiry/window reset, concurrent first request/confirm/wrong
guesses/resend-confirm, rollback-after-consume, and durable session authority
and password-reset race behavior. No session implementation flaw was found;
`session.service.ts` was not changed.

## Validation and cleanup

- `npm run type-check`: passed.
- `npm run test:postgres`: 14 passed, 0 failed, one worker, real migrations.
- `npm test`: 21 passed, 0 failed; integration files remain database-free from
  this command by their `.integration.ts` names.
- `npm run lint`: 0 errors; 37 pre-existing warnings outside owned files.
- `git diff --check`: passed.
- Runner checked 20 GiB free before fixture setup, used a synthetic
  loopback-only `awoof_test_*` instance, and final temp-directory scan found no
  `awoof-postgres-*` directory. It stops only its exact data directory and
  removes only its own scratch directory on success, failure, and signals.

## Remaining boundary

No verification/account routes or external delivery are wired here. This task
does not claim A12 is complete; a route-level transaction must consume,
validate/apply bindings, and create proof atomically.
