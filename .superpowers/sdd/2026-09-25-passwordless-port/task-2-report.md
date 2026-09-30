# Task 2 report — canonical fresh-auth action grants

## Scope and status

Implemented the canonical action-grant storage consumer/issuer, moved the
existing password reauthentication issuance and link/unlink consumption to
`student_auth_action_grants`, and added Microsoft adapter support for a
separate fresh-auth request (`max_age=0`) with a mandatory numeric
`auth_time`. The ordinary Microsoft login scopes and login redemption result
remain unchanged.

The existing password `/reauth` response remains `{ grantId, grantSecret,
expiresAt }`. `targetIdentityId` is optional in its request to retain current
link callers; unlink consumption requires an exact target-bound grant, so an
old unbound unlink grant fails closed.

## Captured RED → GREEN

1. `npx tsx --test src/services/auth/student-action-grant.service.test.ts`
   initially failed with `ERR_MODULE_NOT_FOUND` for the missing action-grant
   service. After implementation: 5/5 pass, including consumed grant, wrong
   target, old SID, and old credential-generation rejection.
2. `npx tsx --test src/services/auth/student-microsoft-oidc.test.ts`
   initially failed because `authorizeFresh` and `redeemFresh` were absent.
   After implementation: 18/18 pass, including `max_age=0` and absent
   numeric `auth_time` rejection.
3. `npx tsx --test src/services/auth/student-reauth.service.test.ts`
   initially failed with the missing service module. After implementation:
   4/4 pass, including the exact plus/minus-60-second boundaries and the
   61-second rejection cases.

## Verification

- `npm run type-check` — pass.
- `npm test` — 358 pass, 0 fail.
- `npm run test:postgres` — exit 0.
- `git diff --check` — clean.

## Open Task-2 blocker / required continuation

`StudentReauthService.start` and `issueFreshGrant` now provide the provider
attempt/grant primitives, but the service is not yet mounted through the
canonical router callback. Completing that safely needs a dedicated branch of
the existing callback dispatcher that locks the attempt, user/session,
identity and policy rows; redeems with `redeemFresh`; checks exact returned
identity plus `auth_time`; then calls `issueFreshGrant` and redirects to the
existing completion UI without creating a login session. This is not claimed
as completed here. The required PostgreSQL interleaving coverage for policy
invalidation after a grant and concurrent last-method unlink also remains to
be added.

## Continuation: canonical callback dispatch

The reauthentication state is now dispatched inside the existing registered
`/:provider/callback` route only when it resolves to a
`student_auth_reauth_attempts` state hash. It does not create a second router
or modify ordinary-login callback behavior. The callback retains the
HttpOnly per-attempt cookie through the existing completion UI; the explicit
`/reauth/finish` POST requires that cookie plus the current authenticated
session, then consumes the attempt while issuing the grant. It never issues a
login session.

The callback verifies the returned Microsoft issuer/subject against the
stored linked identity, `auth_time` against the server-held attempt start,
and current provider/policy/session/credential state. Finish repeats the
student context, policy, provider, identity, session and credential checks
under locks before it issues the grant.

Current frontend inspection found the SSO onboarding page only sends the
existing `{ password, purpose: 'link' }` request. It has no SSO identity
unlink UI. The visible Microsoft card calls a separate legacy verification
route. Therefore no shipped SSO unlink request needed editing. An unlink
grant without `targetIdentityId` fails closed at consume time; clients must
reauthenticate with the exact target ID before removal.

Continuation verification: `npm run type-check` and focused router/adapter/
reauth tests passed; `npm test` passed 358/358. `npm run test:postgres` was
started twice; this harness emitted only its launch line during the 30-second
bounded command windows, so its final result was not independently observed
in this continuation.

## PostgreSQL evidence and regression repair

The captured first full harness run wrote stdout to
`/tmp/awoof-task2-postgres.stdout` and stderr to
`/tmp/awoof-task2-postgres.stderr`, then failed. The runtime evidence exposed
a common source regression: every existing link integration failed at
`consumeActionGrant` before link completion. The consumer had treated omitted
optional bindings as an assertion that the stored nullable column must be
present as JavaScript `null`; password/link grants deliberately carry no
identity/target/pending binding. The shared repair only skips a comparison
when that binding is absent from the consuming operation. Any supplied binding
is still compared exactly; unlink continues to pass the exact target ID.

The same failed run executed the added policy-invalidation test and showed it
as a genuine failure, so it was not counted as passing. A second, non-
overlapping full harness run is active with stdout/stderr/exit capture at
`/tmp/awoof-task2-postgres-2.{stdout,stderr,exit}`. Do not report this task
as complete until that process terminates and its exit file is present.

## Second harness result: schema transition conflict

The second captured full harness exited nonzero. The critical shared failure
is not a weak assertion: migration 069's
`student_passwordless_action_grant_transition` forbids every `secret_hash`
mutation, while `consumeActionGrant` atomically sets `consumed_at` and scrubs
that hash as required by the binding spec. PostgreSQL rejects the transition;
the existing link boundary then correctly returns its invalid-grant response.
Retaining the digest merely to satisfy the trigger would conflict with the
specified immediate scrubbing rule. An additive migration that permits only
the terminal consumed-at-plus-scrub transition is required before the action
consumer and PostgreSQL suite can be green.

## Completion: terminal scrub, password-generation compatibility, and full evidence

Migration `070_passwordless_action_grant_scrub.sql` is the narrowly approved
repair to migration 069. It drops the globally unique digest constraint because
the exact terminal sentinel is intentionally shared, then permits only a live
grant's simultaneous `consumed_at` transition with `secret_hash = 'scrubbed'`.
It retains the immutable binding checks and rejects unscrubbed consumption,
terminal secret rewrites, and every binding rewrite. The PostgreSQL regression
performs the positive consume-and-scrub transition and negative rebinding,
terminal-rewrite, and unscrubbed-consume attempts.

The policy-invalidation regression now asserts the documented public behavior:
`{ outcome: 'restart' }` and no active linked identity, rather than requiring
an exception. The existing concurrent final-two-method unlink test passes and
leaves exactly one usable identity.

During review, the current password reset and authenticated password-change
writers were found to clear refresh/session state without advancing the new
`credential_generation`. That would have weakened the prior password-grant
invalidation contract. Both writers now atomically increment it with their
password update; the controller regression asserts the SQL contains that
increment. Task 5 must preserve this invariant for any additional credential
writer. The admin-only script was deliberately not changed because students'
action grants are not reachable through it.

### RED → GREEN evidence

1. `JWT_SECRET=... JWT_REFRESH_SECRET=... npx tsx --test src/controllers/auth-session.controller.test.ts`
   initially failed 2/3 as expected: neither password writer contained
   `credential_generation = credential_generation + 1`. After the narrow
   writer changes: 3/3 pass.
2. Full PostgreSQL run after the original 070 trigger repair first failed:
   the fixed `scrubbed` sentinel collided with migration 069's unique
   `secret_hash` constraint. After the approved constraint removal and
   terminal-only transition guard, a second run exposed two fixture
   assumptions (password generation and cross-owner composite FK); both were
   corrected to model the durable contract. A later run caught misplaced test
   setup as compile-time `ReferenceError`s; this was repaired before the final
   run.
3. Final `npm run test:postgres` completed with exit 0: **367 pass, 0 fail,
   1 skipped** in 107325ms. The new transition, policy-invalidation, foreign
   unlink, password-generation, and concurrent-last-method paths all passed.

### Final checks

- `npm test` (before the final narrow writer-only change) — **358 pass,
  0 fail**. The changed writer contracts then passed their focused 3/3 test;
  no unrelated full unit rerun was needed.
- `npm run type-check` — pass (final run recorded below).
- `git diff --check` — clean (final run recorded below).

### Documentation impact

No public `/trust`, help, privacy, partner, or developer copy changed. This
is backend-only authentication hardening; it does not activate a provider,
change supported institutions, change enrollment eligibility, or create a
new user-visible commitment. Deployment and provider activation remain
separate and unclaimed. The Task 2 implementation has no pending legal or
operational approval requirement beyond those already tracked for the wider
passwordless port.

## Review fix round 1: fresh-reauth lifecycle coverage

Added direct `StudentReauthService` lifecycle coverage rather than limiting
tests to the freshness helper. The tests invoke the real callback and finish
methods with a transaction-shaped pool fixture and real encrypted verifier
handling. They prove: an exact issuer/subject and browser cookie reaches the
ready completion state without writing a login session; a wrong Microsoft
subject and a different browser cookie fail closed; and a consumed attempt
cannot issue an action grant again.

The route contract test exercises the registered Microsoft callback dispatcher
and both `/reauth/microsoft/start` and `/reauth/finish` endpoints. It verifies
the dedicated HttpOnly browser cookie is set, retained through callback,
passed to finish, cleared on finish, and that the ordinary login callback is
not invoked for a reauth state.

Verification:

- `JWT_SECRET=... JWT_REFRESH_SECRET=... npx tsx --test src/routes/student-sso.routes.test.ts src/services/auth/student-reauth.service.test.ts` — **30 pass, 0 fail**.
- `npm run type-check` — pass.
- `git diff --check` — clean.

Documentation impact remains no-change: these tests substantiate already
implemented backend controls and do not change public behavior or activation
claims.

## Review fix round 2: consumed-finish fixture fidelity

The initial consumed-finish fixture matched the callback's
`WHERE attempt.id = $1 FOR UPDATE` query but not finish's actual
`FROM student_auth_reauth_attempts WHERE id = $1 FOR UPDATE` query. The test
now returns the consumed row for the actual finish lookup and explicitly
asserts that lookup occurred before confirming no action-grant insert. This
proves terminal single-use behavior rather than an absent-attempt rejection.

Verification:

- `JWT_SECRET=... JWT_REFRESH_SECRET=... npx tsx --test src/services/auth/student-reauth.service.test.ts` — **7 pass, 0 fail**.
- `npm run type-check` — pass.
- `git diff --check` — clean.
