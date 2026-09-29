# Residual passwordless retention fix report

## Scope

This follow-up fixes terminal-secret retention in the account-recovery and
reauthentication paths only. It does not alter recovery-code enrollment,
durable identities, active recovery credentials, or browser UI behavior.

## Changes

- Recovery start now marks an earlier pending or verified recovery attempt as
  failed and clears `secret_hash` in the same transaction.
- Rejected recovery-code verification clears the failed attempt's
  `secret_hash` in the same transaction. A wrong mailbox OTP remains a
  nonterminal challenge-budget event under its existing five-guess contract;
  it is not relabelled as a terminal failure by this change.
- Successful recovery invalidates sibling recovery attempts with
  `secret_hash = NULL` and sibling pending/ready reauthentication attempts
  with `state_hash`, `callback_cookie_hash`, `encrypted_verifier`, and `nonce`
  cleared. Their terminal state and timestamps remain intact.
- Scheduled SSO cleanup now catches up already-terminal recovery and reauth
  tombstones, preserving status, terminal timestamps, immutable bindings, and
  the existing seven-day deletion rule. It reports both scrub count and any
  remaining terminal secret columns; the cleanup CLI fails when either the
  existing expired-state metric or the new terminal-secret metric is overdue.
- The reauthentication service was audited for corresponding failure writers:
  its terminal path already clears all four sensitive fields on successful
  consumption; no additional failure-state writer exists there. Recovery's
  reauth sibling invalidation is the remaining writer corrected here.

## TDD evidence

The test-only cleanup catch-up contract was added before production changes.
The valid behavioral red run is captured at
`/private/tmp/awoof-residual-retention-behavior-red.log`: 394 tests, 391 pass,
2 fail, 1 skip, 222450.838 ms. The requested red assertion was
`terminalSecretsScrubbed: undefined !== 2` in the cleanup regression. The
same run also exposed `link and signup completion racing for one verified
handoff leave only the existing owner` (`0 !== 1`); this report makes no
baseline claim about that concurrent failure. The shell pipeline itself
returned 0 because `tee` masked the child exit, while the captured test runner
output explicitly ends `Integration tests failed: non-zero exit`. Later
verification uses `set -o pipefail`.

Real PostgreSQL coverage now proves:

- actual recovery-start supersession (with only the fixture's cooldown clock
  advanced) immediately clears the first secret;
- actual rejected recovery-code verification immediately clears its secret;
- actual successful recovery immediately clears sibling recovery and ready
  reauth secrets;
- trigger-blocked terminal reauth scrubbing leaves one observed overdue row,
  commits the other cleanup work, and a later idempotent pass repairs it;
- terminal rows retain failed status while secret columns are null; aged
  tombstones still delete after seven days; active recovery-code digests stay
  intact.

## Validation

| Command | Result | Evidence |
| --- | --- | --- |
| `npm run type-check` (backend) | exit 0 | TypeScript check passed before full PG run. |
| `npm run test:postgres` (backend, `set -o pipefail`) | exit 0; 396 tests, 395 pass, 0 fail, 1 skip | `/private/tmp/awoof-residual-retention-green.log`, 230367.351958 ms. |
| `npm test` (backend) | exit 0; 377 pass, 0 fail | `/private/tmp/awoof-residual-retention-unit.log`, 10105.930625 ms. |
| `npm run test:artifact` (backend) | exit 0 | Compiled cleanup probe and source/artifact parity passed; 75 migrations and 724 hashed files packaged. |
| `npm run lint` (backend) | exit 0; 47 warnings, 0 errors | `/private/tmp/awoof-residual-retention-lint.log`; warnings predate this scoped change. |

The repository root has no `lint` script; the backend package owns this
changed code and supplied the successful lint command above.

## Documentation impact

No public documentation changed. This is an internal retention hardening
change: it does not add a user-visible flow, institution/enrollment claim,
integration contract, contact point, or deployment assertion. Existing public
claims are therefore neither expanded nor contradicted. No live-provider,
merchant, legal, or operational approval is required for this source-only
fix.
