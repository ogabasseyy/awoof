# Task 1 report: Microsoft verification authority foundation

## Status

DONE — foundation only. No OIDC HTTP exchange, callback/session issuance, routes, UI, eligibility issuance/read integration, live tenant access, push, or deployment was added.

## Owned files

- `apps/backend/src/database/migrations/040_microsoft_verification.sql`
- `apps/backend/src/services/verification/microsoft.types.ts`
- `apps/backend/src/services/verification/microsoft-policy.ts`
- `apps/backend/src/services/verification/microsoft-policy.test.ts`
- `apps/backend/src/services/verification/microsoft-consent.service.ts`
- `apps/backend/src/testing/postgres/microsoft-verification.integration.ts`
- `apps/backend/src/services/verification/eligibility-consent.service.ts` (minimal parent-withdrawal cancellation wiring)

## Delivered authority

- Provider policy, durable Microsoft identity links, provider consents, attempts, and minimal provider proofs are additive migration 040 objects.
- Tenant links are globally unique even after revocation; active user/institution links are singular. Provider proofs require a bound identity and are immutable except one-way revocation.
- Policy configuration owns an independent provider version. Its changes cancel pending/provider work without changing the existing university email-policy version. Graph activation requires current approval plus a term boundary; disabling an expired Graph policy remains possible.
- Acceptance validates a submitted comparison snapshot, then locks canonical user/student/institution/processing-grant/policy authority and compares server-derived mode/scopes/notice/version. Drift returns HTTP 409 with exact code `consent_notice_changed` and writes nothing.
- Provider withdrawal accepts inactive or historical owners, locks user then student then sorted current/historical institutions and states, cancels pending/processing/ready attempts, scrubs verifier/nonce/result, and revokes only dependent Microsoft proofs. Parent processing withdrawal performs the corresponding Microsoft cancellation/revocation.

## RED / GREEN evidence

- RED: `cd apps/backend && npm test` after adding `microsoft-policy.test.ts` failed exactly as intended with `ERR_MODULE_NOT_FOUND` for `microsoft-policy.js` (63 pass, 1 fail).
- RED during migration iteration: `npm run test:postgres` initially rejected the migration SQL function parameter name; fixed before implementation validation.
- GREEN: `npm run type-check` passed.
- GREEN: `./node_modules/.bin/tsx --test src/services/verification/microsoft-policy.test.ts` passed 3/3.
- GREEN: `npm test` passed 66/66.
- GREEN: `npm run test:postgres` passed 153/153; disposable PostgreSQL integration suite passed. Microsoft fixtures cover duplicate identity rejection, disabled-policy start rejection, snapshot drift, policy-change cancellation, provider withdrawal/scrubbing, and parent processing-withdrawal cancellation.

## Self-review

- `git diff --check` passed for all owned code files.
- No existing dirty `index.ts`, merchant work, web files, migration 039, scripts, plans, or specs were staged.
- The migration holds no Microsoft credential/token columns. Attempt terminal state can scrub sensitive verifier, nonce, and result data while retaining required authority identifiers and versions.

## Downstream dependencies

- Task 2 owns server-session issuance, signed state/callback handling, encrypted verifier use, OIDC HTTP, and late-completion races.
- Task 3 owns provider-proof-to-eligibility evidence writes/reads, live eligibility checks, proof expiry/fallback, and no-provider-identity-alone issuance.
- Task 4 owns route/UI notice display and mapping `consent_notice_changed` to its HTTP response. This service already exposes the exact error code and snapshot contract.

## Commit

Commit recorded after this report: see task handoff response for exact SHA.
