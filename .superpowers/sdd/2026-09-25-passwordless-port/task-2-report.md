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
