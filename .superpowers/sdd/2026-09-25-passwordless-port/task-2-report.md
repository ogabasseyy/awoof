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
