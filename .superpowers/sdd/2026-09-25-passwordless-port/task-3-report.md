# Task 3 report — passwordless signup handoff

## Scope and documentation impact

Implemented the backend signup-handoff slice only: the default-off flag, canonical
`/api/auth/student/sso/signup/*` routes, service/types, challenge policy and
mailbox-proof writer. Public `/developers`, partner content and public trust pages
were reviewed but deliberately not edited: this is disabled by default and has no
deployed/provider activation evidence. Task 7 owns the public-page implementation;
that task must record the pending page and link/accessibility review before any
enablement claim.

## TDD record

RED: `NODE_ENV=test JWT_SECRET=... JWT_REFRESH_SECRET=... npx tsx --test
src/services/auth/student-sso-signup.service.test.ts` initially failed with
`ERR_MODULE_NOT_FOUND` for `student-sso-signup.service.js`.

GREEN: the same focused test passed after the minimal default-disabled gate was
implemented. The test proves no database connection is made while the feature flag
is false.

## Changes

- Added a handoff-bound signup service. It authenticates the handoff secret and
  browser cookie, rechecks the live provider/policy and exact observed mailbox,
  refuses active or revoked identity ownership, and keeps the original ten-minute
  cap.
- Added mailbox OTP delivery/verification, using a five-minute OTP capped by the
  handoff, three sends, five shared failed checks, 60-second resend cooldown, and
  latest-generation semantics. Delivery runs after the quota/challenge transaction.
- Completion writes a null-password student, Terms age attestation, processing
  consent, immutable mailbox proof, provider identity and the normal session in one
  transaction, then consumes the handoff. It never writes `eligibility_evidence`,
  enrollment evidence, or a legacy verified shortcut.
- Added `recordPasswordlessSignupMailboxProof` to reuse the existing immutable
  mailbox-proof table and consumed-challenge checks without the legacy
  OTP-to-eligibility writer.
- Added `PASSWORDLESS_STUDENT_SIGNUP_ENABLED=false` and strict same-origin JSON
  endpoints under the existing canonical SSO router.

## Verification executed

- Focused service/route/challenge test command: exit 0, 27 passing, 0 failing.
- `npx tsc --noEmit`: exit 0.
- `git diff --check`: exit 0.

## Acceptance coverage added after the first implementation commit

`passwordless-signup.integration.ts` now creates a real canonical policy,
browser-bound handoff and OTP delivery fixture. It proves the complete path
creates exactly one user, identity, active session and mailbox proof while
creating zero `eligibility_evidence` rows; it also proves wrong-browser and
expired-handoff requests fail closed before signup.

It additionally covers the three-send budget (including persisted quota after
each request and fourth-send refusal), existing-email collision with no second
account, policy disablement after handoff creation, and replay after a committed
completion. The replay check retains the durable linked provider identity for a
fresh ordinary SSO login to find, while refusing a second session from
the consumed handoff.

The current response-loss check is deliberately narrower than a full ordinary
provider-login test: it proves the consumed handoff cannot mint another session
and that the linked identity remains queryable by provider/subject. It does not
invoke `StudentSsoFlowService.finish` on a fresh attempt, so it is not evidence
of a complete ordinary relogin round trip.

## Remaining concerns / follow-up

- Extend the PostgreSQL harness before enablement with atomic rollback,
  simultaneous link/signup, post-commit response loss then ordinary Microsoft
  login, and budget/restart interleavings.
- OpenAPI/public documentation has not been expanded because runtime signup remains
  disabled. Task 7 must state this pending status and add truthful help/trust copy
  only after evidence review.
