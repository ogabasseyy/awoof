# Student Email-First Authentication and Benefit Eligibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Let students sign in with school accounts, show school-account and current-enrollment assurance separately, and grant discounts only with current student enrollment evidence.

**Architecture:** Release A changes the shared eligibility authority and every benefit consumer. Release B adds domain discovery, durable provider login, explicit linking, and a guided transition into existing enrollment checks. Account authentication, mailbox proof, enrollment evidence, and merchant disclosure retain separate lifecycles.

**Tech Stack:** Existing Node.js 24, Express, PostgreSQL, TypeScript, openid-client 6.8.8, Next.js/React, Node test runner and Playwright.

**Spec:** docs/superpowers/specs/2026-09-20-student-email-first-auth.md

**Status:** Revision 4: upgraded, re-reviewed against the inspected source, and upgraded again. Implementation and runtime verification remain outstanding. Supersedes the previous ten-task draft and its R1–R7 addendum. All execution examples start from the repository root unless stated otherwise.

## Global Constraints

- Only current enrollment evidence authorizes student benefits. Email OTP, identity-only Microsoft, and Google Workspace account control establish school-account assurance.
- Preserve account access when enrollment is pending, unavailable, expired or revoked. Preserve a valid independent enrollment result when an optional check fails.
- Do not authorize from users.verification_status, a client-supplied status, or a JWT eligibility claim.
- Recheck consent, actor status, evidence, institution policy, identity version and expiry at each new benefit authorization.
- Public advertised prices and ordinary merchant links may remain visible. Redeemable codes and protected URLs must not appear in public APIs.
- No email-based account merging. Link ownership requires recent independent account authentication plus a browser-bound provider handoff.
- Keep historical evidence and transactions. Email-only students lose discount access under the new policy, but retain login and school-account evidence.
- No production domain approval is inferred from legacy seed rows. Verify actual runtime database identity and approved policies before enabling a pilot.
- Existing manual document review is absent. Its implementation is a separate project; do not show a manual-upload button in this release.
- Existing signup retains its password and mailbox OTP once at first use. Returning linked users get SSO. Passwordless first-time provisioning is outside this release.
- No secrets, OTPs, authorization codes, tokens, raw claims or full mailboxes in logs. Store only necessary identity attributes and expire transient state.
- Do not deploy an old email-eligible build as rollback. Disable benefits and retain account access if the new authorization release fails.

## Review Focus

1. Fresh school email proof cannot unlock discounts or overwrite valid enrollment evidence — Tasks A1, A2.
2. A direct HTTP request, stale receipt, shared URL or concurrent report cannot bypass student status — Tasks A3, A4.
3. Provider email changes, missing Microsoft email and guest identities cannot transfer account ownership or assert unsupported school membership — Tasks B2, B4.
4. Callback theft/replay, policy changes, lost responses and concurrent logout cannot create or replace another user's session — Tasks B1, B3.
5. Unintegrated schools, empty policy tables and expired consent produce usable pending/recovery states — Tasks A2, B5, C1.

## Scope and execution order

Read the spec and repository AGENTS.md first. Create an isolated branch from fresh origin/main; the inspected baseline was 4e47ea0, with migrations through 055. Never implement against the older working checkout.

1. Task 0: baseline.
2. Release A: A1 → A2 → A3 → A4 → A5. This must pass and deploy before provider login is enabled.
3. Release B: B1 → B2 → B3 → B4 → B5.
4. C1: source/artifact/browser gates, staged pilot, rollback rehearsal.

Schema names reserved here: 056_student_benefit_authorizations.sql, 057_student_sso_auth.sql. Check for filename collisions at execution and update all references before writing migrations. Do not edit previously deployed seed migrations.

No sweeping refactor of Microsoft verification is required. The current Microsoft routes still require an authenticated durable session, processing grant, provider consent and mailbox evidence. A second authorization may be needed for enrollment scopes; one guided journey is the promise, not a guaranteed single redirect.

## Shared contracts

Define the backend DTO in apps/backend/src/services/verification/student-assurance.types.ts and its browser parser in apps/web/src/lib/student-assurance.ts:

~~~ts
export type StudentStatus = 'pending' | 'verified' | 'expired' | 'denied' | 'revoked' | 'inactive';
export type StudentAssurance = {
  schoolAccountStatus: 'unverified' | 'verified' | 'expired';
  schoolAccountMethod: 'email_otp' | 'google_workspace' | 'microsoft_school' | null;
  schoolAccountValidUntil: string | null;
  studentStatus: StudentStatus;
  enrollmentMethod: 'registration' | 'microsoft_graph' | null;
  studentValidUntil: string | null;
  reason: 'awaiting_enrollment' | 'evidence_expired' | 'enrollment_denied'
    | 'consent_withdrawn' | 'identity_changed' | 'policy_changed'
    | 'inactive' | 'provider_unavailable' | null;
};
~~~

Status is a projection of current evidence, not an independently editable flag. Enrollment verification methods not implemented here must not be advertised. School-account assertion lifetime is 90 days maximum, capped by the approved institution policy and its approval end. Enrollment retains existing source-specific expiry limits (including Microsoft's shorter evidence cap); never extend it to 90 days because login succeeded.

Status precedence: inactive actor → inactive; authoritative denial → denied; otherwise any fully valid enrollment candidate → verified; otherwise current-subject revoked/withdrawn enrollment → revoked; otherwise expired enrollment → expired; otherwise pending with precise reason. Policy/identity changes invalidate old evidence rather than making it current through a different display label. An enrollment reader failure returns a retryable status error, never a fabricated positive result.

School-account membership can be demonstrated by a live approved school mailbox proof, Google verified hosted-domain evidence with approved mapping, or a configured institution membership attestation. Microsoft tenant ID alone does not exclude guests. Unattested tenant login can authenticate a previously linked identity but cannot set schoolAccountStatus to verified.

## Task 0: Establish the execution baseline

**Files:** existing package-lock files, apps/backend/package.json, apps/web/package.json, apps/backend/src/testing/postgres/test-database.ts; the two planning documents.

**Consumes:** current origin/main. **Produces:** isolated branch, installed locked dependencies and recorded baseline.

- [ ] Read applicable repository instructions and use the worktree skill. Copy these untracked planning documents explicitly into the execution worktree; they are not present in origin/main.
- [ ] Run:
~~~bash
git fetch origin
git worktree add ../awoof-student-email-first-auth -b codex/student-email-first-auth origin/main
~~~
- [ ] In that worktree install with npm ci in each application, then run:
~~~bash
npm --prefix apps/backend test
npm --prefix apps/backend run type-check
npm --prefix apps/web run test:auth
npm --prefix apps/web run test:browser:typecheck
~~~
- [ ] Record failures before editing. PostgreSQL tests use only the existing disposable runner, which checks loopback database identity and free disk. Never use production credentials for fixtures.
- [ ] Commit the spec and plan as the first scoped commit.

## Task A1: Make current enrollment the only discount authority

**Modify:** apps/backend/src/services/verification/eligibility-read.service.ts, eligibility-evidence.service.ts, eligibility.types.ts, verification-flow.service.ts; apps/backend/src/services/auth/student-signup.service.ts.
**Tests:** apps/backend/src/testing/postgres/eligibility.integration.ts, student-signup.integration.ts, microsoft-verification.integration.ts, checkout-refund-regressions.integration.ts; existing service unit tests.

**Consumes:** existing immutable email and enrollment evidence. **Produces:** unchanged getEffectiveEligibility API semantics except that eligible=true requires current enrollment.

- [ ] Extend existing fixtures in eligibility.integration.ts (Fixture, FixtureOptions and its transaction helpers already exist). Add assertions immediately after their real recordEmailAssurance call:
~~~ts
const actual = await getEffectiveEligibility(client, fixture.userId);
assert.equal(actual.eligible, false);
~~~
Here client is that integration test's transaction client and fixture is its existing populated Fixture; do not introduce an unimplemented helper.
- [ ] Add cases for: fresh email only; expired Graph plus fresh email; withdrawn Graph consent plus fresh email; expired registration evidence; fresh valid registration; valid independent enrollment when another source fails; denial plus fresh OTP. Run npm --prefix apps/backend run test:postgres and confirm the email-positive cases fail against baseline.
- [ ] Remove independentlyValidEmailEvidence as a benefit fallback. Select enrollment candidates from existing eligibility_evidence by student/institution; validate every candidate through its actual source authority. Validity requires method=enrollment AND a recognized source, not just method text.
~~~ts
// Required invariant after complete source/consent/context validation:
if (selected.method !== 'enrollment') return { eligible: false, reason: 'unverified' };
~~~
The guard is necessary but insufficient by itself: source validation, identity/policy binding and final database-time expiry checks remain mandatory.
- [ ] Keep recordEmailAssurance's mailbox proof and immutable email evidence for audit. Stop its update of current_evidence_id from replacing a live enrollment pointer; return getEffectiveEligibility after recording. Email proof still supplies enrollment prerequisites and can be used to begin a registration lookup.
- [ ] Change signup/email-confirmation UI contracts to accept successful account creation with eligible=false. Do not reject signup or label enrollment verified merely because the OTP was accepted. Do not copy legacy verified flags into enrollment evidence.
- [ ] Preserve current consent lock order and authoritative denial behavior. Explicit denial cannot be cleared by a transient unknown result or mailbox re-verification.
- [ ] Run backend unit/PostgreSQL tests; update tests intentionally tied to the retired email-benefit rule and add regression coverage in every consumer. Commit: fix(eligibility): require enrollment evidence for student benefits.

## Task A2: Expose truthful school-account and student status

**Create:** apps/backend/src/services/verification/student-assurance.types.ts, student-assurance.service.ts, student-assurance.service.test.ts; apps/web/src/lib/student-assurance.ts; apps/web/tests/auth/student-assurance.test.ts.
**Modify:** apps/backend/src/controllers/verification.controller.ts, student.controller.ts, auth.controller.ts; apps/backend/src/routes/verification.routes.swagger.ts, students.routes.swagger.ts, auth.routes.swagger.ts; apps/backend/src/config/swagger.ts; apps/web/src/app/student/verification/page.tsx, student/profile/page.tsx; apps/web/tsconfig.auth-tests.json.

**Consumes:** A1 evidence authority. **Produces:** readStudentAssurance(tx: PoolClient, userId: string): Promise<StudentAssurance> and validated display data.

- [ ] Write unit tests for the shared precedence table, including denied/withdrawn/expired and a still-valid independent source. Add HTTP tests to apps/backend/src/controllers/verification.routes.http.test.ts for a logged-in mailbox-confirmed student receiving school-account verified/student pending.
- [ ] Prove direct expiry/revocation is visible on the next read without token refresh. Keep JWT claims unchanged.
- [ ] Implement the status reader from evidence provenance; do not infer revoked solely from the current generic consent_required reason. School-email assurance requires an active approved domain, matching identity/policy versions, valid processing consent and unexpired proof/evidence.
- [ ] Release A reads existing mailbox/evidence tables only; it must not depend on migration 057. B4 subsequently adds the SSO assertion reader behind the provider feature flags. Test both migration-056-only and fully upgraded databases. Do not extend old proof expiry when projecting or migrating it.
- [ ] Add a separate studentAssurance field to student-facing responses while retaining legacy verificationStatus only for compatibility, marked deprecated in OpenAPI. No vendor/admin account verification semantics change. Route absent institution/profile to pending with guidance.
- [ ] Use independent labels and expiry fields in the profile/verification page. On transient status fetch failure, clear positive benefit state and show retry; the account remains signed in.
- [ ] Run backend tests/type-check and web test:auth, then commit: feat(verification): expose independent school and enrollment status.

## Task A3: Retire legacy tokens and authorize merchant transaction reporting

**Create:** apps/backend/src/database/migrations/056_student_benefit_authorizations.sql; apps/backend/src/services/verification/merchant-benefit.service.ts; apps/backend/src/testing/postgres/merchant-benefit.integration.ts.
**Modify:** apps/backend/src/services/verification/merchant-assertion.service.ts, verification-token.service.ts; apps/backend/src/controllers/payment.controller.ts; apps/backend/src/routes/merchant-verification.routes.ts, vendors.routes.ts and vendor reporting Swagger definitions found by git grep '/transactions/report'; merchant integration documentation.

**Consumes:** existing assertions and A1 authority. **Produces:** explicit product-bound, single-transaction benefit authorizations; legacy token attempts fail closed.

Schema is additive; do not add a NOT NULL column to the existing receipt writer. Use a new table:
~~~sql
ALTER TABLE verification_tokens ADD COLUMN revoked_at timestamptz;
CREATE TABLE merchant_benefit_authorizations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  assertion_id uuid NOT NULL UNIQUE REFERENCES merchant_assertions(id),
  vendor_id uuid NOT NULL REFERENCES vendors(id),
  user_id uuid NOT NULL REFERENCES users(id),
  product_id uuid NOT NULL REFERENCES products(id),
  evidence_id uuid NOT NULL REFERENCES eligibility_evidence(id),
  processing_grant_id uuid NOT NULL REFERENCES verification_consents(id),
  disclosure_grant_id uuid NOT NULL REFERENCES verification_consents(id),
  list_price_snapshot numeric NOT NULL CHECK (list_price_snapshot >= 0),
  student_price_snapshot numeric NOT NULL CHECK (student_price_snapshot >= 0),
  currency text NOT NULL,
  pricing_version text NOT NULL,
  expires_at timestamptz NOT NULL,
  transaction_id uuid UNIQUE REFERENCES transactions(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
~~~
Add product_id nullable to merchant_assertions and persist it when issuing product claims. Generic campaigns remain independent of product IDs. A product-bound exchange adds benefitAuthorizationId to its receipt; ordinary campaign receipt shape is unchanged. Old receipts have no benefit authorization and cannot authorize a new product report.

Use existing product/transaction money units consistently and convert provider minor units explicitly at the boundary; tests must detect a factor-of-100 error. pricing_version is a server-computed digest of product ID, currency and quoted prices, not a client input or an assumed existing product column. Add the A4 claim-session table and nullable FKs to this same migration before release. Resolve declaration order and circular transaction references in a migration test against existing rows.

- [ ] Write HTTP/PostgreSQL failing tests that call the real reporting route with vendor JWT and API key, a legacy token, a new product authorization, and each ineligible status. Assert no transaction, savings or stock change on refusal.
- [ ] Test concurrent reports using the same authorization and same/different payment references. Expected: one transaction; exact retry returns original result; changed amount/product/gateway/reference conflicts. A retry after expiry returns the original committed result only after current merchant authentication; it creates no benefit.
- [ ] Apply the additive migration and populate product bindings server-side after validating active product/vendor. On exchange create authorization in the same transaction as receipt storage, capped at min(evidence expiry, now + 2 minutes). Historical receipt retries must not mint new authorizations.
- [ ] Replace verificationToken with benefitAuthorizationId in the strict report schema. Read untrusted candidate IDs without locks, lock participant users in sorted order using the existing merchant context, then student/university/state/consent/provider/evidence, then assertion/authorization and product/transaction. Use existing canonical helpers; do not reverse the merchant-assertion lock order.
- [ ] Authenticate the merchant again inside the commit transaction. Check first-use authority, product binding, disclosure, current evidence ID, price and authorization expiry after all blocking locks. Verify external payment outside DB locks, then validate immutable amount/reference/product binding inside the transaction.
- [ ] Store the quoted list price, student price, currency and pricing version on each product authorization; reject a report whose payment amount/currency/product differs. Never reconstruct historical savings from a subsequently edited product. An exact committed retry is historical bookkeeping, not renewed eligibility. The merchant must enforce eligibility before granting a discount: a payment report alone cannot enforce an external checkout. Late/expired first reports require explicit reconciliation and must not silently issue a new authorization or discard evidence that money was paid.
- [ ] Insert transaction, decrement stock, record savings and attach transaction_id atomically. Catch unique conflicts by rolling back and re-reading the merchant's prior committed transaction with an exact request match. Treat other conflicts as 409. Do not promise financial payment verification for arbitrary gateways already outside this task.
- [ ] Preserve old token records; implement an explicit maintenance script that sets revoked_at on unused legacy tokens during cutover, never used_at. Disable token issuance/validation/consumption in source and compiled artifacts. A migration-time insert blocker is unnecessary once retired entrypoints are sealed and tested.
- [ ] Add lifecycle cleanup for unused authorization rows only according to retention policy; never delete rows referenced by receipts/transactions. Update OpenAPI, examples and consumers of reportTransaction together.
- [ ] Run backend test, test:postgres, type-check, test:artifact. Commit: fix(merchants): bind discount reports to current enrollment.

## Task A4: Protect voucher and external-deal claims at the server

**Modify:** apps/backend/src/routes/products.routes.ts (its inline public queries), apps/backend/src/routes/merchant-verification.routes.ts; apps/web/src/app/marketplace/[id]/page.tsx and marketplace/page.tsx.
**Create:** apps/backend/src/services/verification/product-claim.service.ts; apps/backend/src/controllers/product-claim.http.test.ts; apps/web/tests/browser/student-benefit-claims.spec.ts.

**Consumes:** A1 eligibility and A3 product assertions. **Produces:** POST /api/merchant-verification/product-claims with { merchantClaimSessionId, disclosureGrantId }, returning a short-lived assertion and a validated merchant handoff destination. The claim session supplies the immutable product/vendor/checkout binding.

- [ ] Write failing direct HTTP tests for anonymous list/detail responses, client-supplied vendor/origin, pending student claim, wrong merchant, expired evidence, withdrawn disclosure and disclosure immediately before commit.
- [ ] Create separate public and owner product projections. Public responses must not contain reusable voucher codes, discount-bearing URL queries or protected fulfillment fields anywhere in nested data. A frontend hide is not authorization. Public advertised prices remain allowed.
- [ ] Resolve vendor, registered merchant origin, product and campaign from trusted records. Require exact registered HTTPS handoff origin and a fixed merchant callback path; do not accept arbitrary redirects from request input or product text.
- [ ] Add POST /api/merchant-verification/claim-sessions, authenticated by the merchant server key, with {productId, merchantCheckoutId, browserNonceHash}. Persist merchant_claim_sessions in migration 056: id, vendor_id, product_id, checkout_id, browser_nonce_hash, expires_at, consumed_at; unique (vendor_id, checkout_id), immutable request binding, maximum ten-minute expiry. Add a nullable claim_session_id FK to product assertions and authorizations; require it in the protected external-claim path. Exact creation retries return the same session, changed bindings conflict. A public merchant bootstrap endpoint first sets its own Secure HttpOnly browser nonce cookie, creates this session server-to-server, then navigates to Awoof's claim page. Never put the nonce in URLs. Exchange must supply the merchant's cookie-derived nonce over its authenticated server connection and match its hash and checkout binding. Consume once atomically; same-operation receipt replay cannot authorize a different order. The merchant must enforce this binding and one redemption per checkout in its own durable transaction. Without that integration, keep protected claims disabled.
- [ ] If the merchant lacks a deployed assertion-exchange/redemption integration, return 409 with code MERCHANT_INTEGRATION_REQUIRED for protected claims. Ordinary public merchant navigation remains distinct and conveys no verified-discount promise.
- [ ] Hand over only an opaque short-lived assertion. The merchant must exchange it from its backend and authorize redemption. No global student identifiers, email or bearer API keys go into the URL. Add no-store/referrer-policy protection and redact handoff query strings in logs.
- [ ] Show Verify student status for pending users with an allowlisted relative return path. After verification, explicitly retry claim against fresh authority; never automatically submit a purchase.
- [ ] Add merchant-stub E2E tests: direct/shared link cannot redeem; wrong campaign/vendor fails; concurrent duplicate exchange grants one redemption. Require partner validation before claiming external enforcement is live.
- [ ] Run backend tests and web test:browser -- student-benefit-claims.spec.ts, then commit: fix(vouchers): enforce student claims server-side.

## Task A5: Audit every consumer and release enrollment-only benefits

**Modify:** apps/backend/src/controllers/admin-student.controller.ts, analytics.controller.ts, admin-analytics.controller.ts; apps/web/src/app/admin/students/page.tsx; related Swagger schemas.
**Create:** docs/runbooks/student-benefit-cutover.md.

**Consumes:** A1–A4. **Produces:** admin visibility and a safe release-A cutover.

- [ ] Add admin API/UI tests for provenance, pending/current/expired/denied/revoked/inactive, scoped pagination and authorization. Do not call every lock-heavy student reader in an unbounded reporting query; implement a bounded read-only projection with shared validity rules, tested against authoritative point reads.
- [ ] Rename transaction-derived verified_students metric to purchasing_students; update all clients and deprecate the old field explicitly. It is not a count of current student verification.
- [ ] Search all source/compiled consumers of verification_status, getEffectiveEligibility, student_email, verification_tokens and voucher fields. Record each benefit consumer in the runbook: checkout start, payment fulfillment/refund, assertion issuance/exchange, report, product claim, protected redemption. Existing users with email-only proofs must fail each.
- [ ] Rehearse release against an upgraded disposable database with preexisting email proofs, enrollment proofs, orders, tokens and receipts. Retain historical purchases/savings. For already-paid unfulfilled orders that lose eligibility, preserve the existing requires_refund path and reconciliation rather than silently completing a discount.
- [ ] Deploy with affected benefit routes in maintenance until all API and worker instances run the enrollment-only build; keep account login accessible. Run token retirement, drain old instances, prove negative and positive canaries, then reopen benefits. Shared Redis/cache keys must be versioned or invalidated.
- [ ] Rollback means benefits stay closed until a fixed enrollment-only build passes canaries. No restore of stale verification state or downgrade to email-eligible code.
- [ ] Commit: feat(admin): report enrollment assurance and document cutover.

## Task B1: Define durable login policy, identities and attempts

**Create:** apps/backend/src/database/migrations/057_student_sso_auth.sql; apps/backend/src/services/auth/student-sso.types.ts; apps/backend/src/testing/postgres/student-sso.integration.ts.

**Consumes:** active universities; independent login approval. **Produces:** exact login storage contract below.

Tables/constraints (all IDs uuid; all dates timestamptz):
- institution_login_policies: id PK, university_id FK, provider (google|microsoft), issuer, provider_realm, version>=1, enabled default false, approved_until, approved_by FK users, school_assertion_days between 1 and 90; UNIQUE(university_id,provider).
- institution_login_domains: domain lower-case PK, university_id FK, is_active; UNIQUE(domain,university_id). One domain maps to one university.
- institution_login_domain_providers: domain, university_id, provider, policy_id; PRIMARY KEY(domain,provider), composite FK(domain,university_id) to institution_login_domains and FK(policy_id,university_id,provider) to a matching UNIQUE constraint on institution_login_policies. Multiple providers may serve the same approved domain without ambiguous university ownership.
- student_auth_identities: id PK, user_id FK, university_id FK, provider, issuer, subject, observed_email nullable, revoked_at nullable, linked_at; UNIQUE(provider,issuer,subject), UNIQUE(id,user_id). One identity cannot transfer to another owner after revocation. Do not prohibit another institution identity simply because the provider is the same.
- student_school_assertions: id PK, user_id/university_id FKs, source (email_otp|google_workspace|microsoft_school), email_proof_id nullable, auth_identity_id nullable, login_policy_id nullable, policy_version, identity_version, verified_at, expires_at, revoked_at. CHECK exactly one evidence FK: email_otp requires email_proof_id and no auth_identity_id/login_policy_id; SSO requires auth_identity_id/login_policy_id and no email_proof_id. Composite owner FKs reference UNIQUE(id,user_id) on each source table; add that constraint to user_email_proofs if absent. SSO identity/policy university and provider must match under the canonical locked writer; approved email-domain membership is checked there too. No free-text evidence reference is authority. Immutable except one-way revocation.
- student_auth_attempts: id PK, policy_id FK, policy_version, provider, requested_email, state_hash UNIQUE, callback_cookie_hash, finish_secret_hash, encrypted_verifier nullable, nonce nullable, encrypted_observation nullable, status (pending|processing|ready|consumed|failed), expires_at, remember_me, return_path, created_at.
- student_auth_link_handoffs: id PK, attempt_id FK UNIQUE, secret_hash UNIQUE, encrypted_observation, policy_id/version, browser_binding_hash, target_user_id and target_sid nullable together, expires_at, consumed_at, created_at.
- student_auth_reauth_grants: id PK, user_id FK, sid, purpose (link|unlink), secret_hash UNIQUE, expires_at, consumed_at. Five-minute expiry; one action per grant.
- users.active_session_auth_identity_id: nullable FK student_auth_identities. Preserve the existing single-active-session model: password sessions write NULL; SSO sessions write the exact linked identity in the session transaction. Existing sessions remain password/legacy provenance until reauthentication; do not backfill from email matches.

- [ ] Write disposable PostgreSQL tests for uniqueness/owner immutability, invalid status transitions, source FK mismatch, ambiguous domains, handoff replay and expiry. Follow createTestPool/assertFixtureDatabase from the existing harness.
- [ ] Define policy trust edits to increment version under policy lock. Terminal attempt states cannot transition back; pending/processing require verifier+nonce; ready requires observation; consumed/failed requires secret-bearing payloads scrubbed. Store secrets hashed except encrypted fields.
- [ ] Create indexes on expiry/status and owner history lookups. Cleanup scrubs expired attempt/handoff ciphertext within one scheduled hour and deletes non-audit transient records after seven days. Retain owner linkage/revocation records under account retention rules.
- [ ] Define transport types separately from persistence:
~~~ts
export type LoginProvider = 'google' | 'microsoft';
export type ProviderObservation = {
  provider: LoginProvider; issuer: string; subject: string;
  email: string | null; mailboxVerified: boolean;
  realm: string; schoolMembershipAttested: boolean;
};
export type LoginOptions = {
  password: true; providers: LoginProvider[]; registration: true; recovery: true;
};
~~~
- [ ] Run backend test:postgres and type-check. Commit: feat(auth): persist student login authority and attempts.

## Task B2: Discover login methods and validate provider claims

**Create:** apps/backend/src/services/auth/student-login-options.service.ts and .test.ts; student-google-oidc.ts and .test.ts; student-microsoft-oidc.ts and .test.ts; student-oidc.config.ts and .test.ts.
**Modify:** apps/backend/src/routes/auth.routes.ts, auth.routes.swagger.ts; apps/backend/src/config/env.ts; apps/backend/env.example.

**Consumes:** B1 policy/domain map. **Produces:** POST /api/auth/student/login-options and StudentOidcAdapter.
~~~ts
export interface StudentOidcAdapter {
  authorize(input: { state: string; nonce: string; verifier: string; loginHint: string }): Promise<URL>;
  redeem(input: { callback: URL; state: string; nonce: string; verifier: string }): Promise<ProviderObservation>;
}
~~~

- [ ] Test normalizeMailbox-compatible trim/lowercase, exact domain matching, unknown/malformed domains, multiple approved methods and dormant flags. Preserve plus suffixes and never strip dots. Discovery does not query users, students or linked identities. Unknown valid domains return password with no providers; malformed input is 400.
- [ ] Implement discovery as strict POST JSON {email}, <=254 characters, no request-body logging, Cache-Control no-store. Join active approved login policies, unexpired approval and deployment readiness. Do not join legacy university email arrays or student-benefit evidence.
- [ ] Set discovery quota to 60 requests/IP/10 minutes; SSO start to 10/IP and 5/HMAC(mailbox)/10 minutes, with bounded expiring storage and proxy-aware keys. Handle Redis outage by returning retryable unavailability, not unlimited access.
- [ ] Test Google with fixed discovery URL https://accounts.google.com/.well-known/openid-configuration, authorization origin accounts.google.com, token origin oauth2.googleapis.com and JWKS origin www.googleapis.com. Validate returned metadata against explicit HTTPS endpoint paths, no credentials/fragments/redirects, 5-second total network deadline and 256-KiB response cap. Reverify official metadata before implementation; deliberate reviewed allowlist changes are required if it changes.
- [ ] Validate signature, audience/azp, issuer, expiry, nonce, state, PKCE, email_verified and approved hd mapping. Configured email domain and returned hd may differ only through explicit approved mapping. Personal Gmail never gets school assurance. No tokeninfo call in production.
- [ ] For Microsoft, use exact approved tenant issuer, tid/oid/sub checks and openid profile email scopes. Email may be null; email and preferred_username never authorize linking. Reject an unapproved tenant. A tenant member/guest decision requires trusted membership evidence; if unavailable, leave school assurance unverified and offer approved-mailbox OTP.
- [ ] Preserve transport/consent separation from existing Microsoft verification; reuse cryptography through shared tested primitives only. Google cannot inherit Microsoft's same-origin restriction unchanged.
- [ ] Add opt-in GOOGLE_LOGIN_ENABLED, GOOGLE_LOGIN_CLIENT_ID/SECRET/CALLBACK_URL; MICROSOFT_LOGIN_ENABLED, MICROSOFT_LOGIN_CLIENT_ID/SECRET/CALLBACK_URL; STUDENT_SSO_COMPLETION_URL and STUDENT_SSO_ATTEMPT_KEY (32-byte decoded key). URLs must match fixed same-site HTTPS paths. Disabled providers require no credentials.
- [ ] Run backend tests/type-check and commit: feat(auth): add institution discovery and OIDC login adapters.

## Task B3: Bind login to the browser and commit sessions atomically

**Create:** apps/backend/src/services/auth/student-sso-flow.service.ts and .test.ts; apps/backend/src/routes/student-sso.routes.ts and .test.ts; apps/backend/src/scripts/cleanup-student-sso.ts and .test.ts.
**Modify:** apps/backend/src/services/auth/session.service.ts and .test.ts; apps/backend/src/index.ts; apps/backend/package.json; config/swagger.ts.

**Consumes:** B1/B2, existing session authority. **Produces:**
- POST /api/auth/student/sso/:provider/start {email, rememberMe, returnPath} → {attemptId, finishSecret, authorizationUrl, expiresAt, serverNow}; sets a per-attempt Secure HttpOnly SameSite=Lax host-only callback cookie.
- GET callback at /api/auth/student/sso/:provider/callback → fixed /auth/student/sso/complete?attempt=...&outcome=...; no token or secret in URL.
- POST finish {attemptId, finishSecret} → authenticated response with studentAssurance, or {outcome:'link_required', handoffId, handoffSecret, expiresAt}.
- issueSessionInTransaction(tx: PoolClient, payload: TokenPayload, rememberMe: boolean, expectedPasswordHash?: string): Promise<TokenPair>.

- [ ] Add tests proving callback from a different browser cannot redeem/replace an attempt, two concurrent callbacks redeem once, two finishes issue one session, provider denial cannot skip state/browser checks, and logout/session change cannot commit stale completion.
- [ ] Extract the existing issueSession SQL into the transaction-scoped writer; password wrapper opens/commits its transaction. Update no other password behavior. A test with held user lock must show no global-pool self-block.
- [ ] Start generates cryptographic state, nonce, PKCE verifier, distinct callback-cookie and finish secrets. Persist hashes/encrypted verifier. Keep all expiry calculations server-side, capped at ten minutes. Validate allowed relative return path with existing student-return rules. Bind provider and approved policy version.
- [ ] Set per-attempt cookie Path=/api/auth/student/sso, so callback, finish and link receive it. Retain the binding through an unlinked handoff, then clear it on successful link, cancellation or expiry; do not clear it when consuming the attempt before linking. Cross-origin same-site web/API requests use credentials and exact allowed Origin, never wildcard credentialed CORS. Bound cleanup prevents accumulation of per-attempt cookies.
- [ ] Callback checks state/cookie/provider and atomically changes pending to processing before external redemption. Release locks before network calls; finish failure scrubs secrets and marks terminal. Re-lock policy and attempt to store ready observation only if still current and unexpired.
- [ ] Finish proves tab secret and cookie, locks user then policy/identity/attempt in a single documented order, revalidates ownership, and uses issueSessionInTransaction for existing active student owners. Commit issuance and consumed state together; send tokens only after commit. No automatic email matching.
- [ ] Unlinked finish atomically creates a single handoff and consumes the attempt. A duplicate/lost-response finish returns a controlled restart response with no new session; restart invalidates any abandoned pending flow. Do not persist session bearer tokens for replay. Tests must cover response loss after commit.
- [ ] Keep login successful when assurance fetch fails: the authenticated response has studentAssurance: StudentAssurance | null and assuranceStatus: 'available' | 'unavailable'; null is permitted only with unavailable. Refresh status independently; never set student verified on error. Publish/test this union in OpenAPI and browser parsing. Inactive/deleted actors fail login.
- [ ] Callback errors use no raw upstream strings; dedicated failed-callback limit, no-store, no-referrer, exact POST Origin, application/json and body schemas. Limit concurrent open attempts to three per browser binding.
- [ ] Add the cleanup command to source and compiled artifact scripts. Test encrypted verifier/nonce/observation are erased on success, denial, timeout and expiry. Run backend unit/PostgreSQL/artifact suites. Commit: feat(auth): add browser-bound atomic SSO login.

## Task B4: Complete first-use linking, recovery and unlink

**Create:** apps/backend/src/services/auth/student-sso-link.service.ts and .test.ts; apps/backend/src/services/auth/student-sso-onboarding.service.ts and .test.ts.
**Modify:** student-sso.routes.ts/.test.ts, auth.controller.ts; apps/web/src/contexts/AuthContext.tsx; apps/web/src/app/auth/student/register/page.tsx; apps/web/src/app/student/profile/page.tsx.
**Create UI:** apps/web/src/app/auth/student/sso/onboarding/page.tsx; apps/web/tests/browser/student-sso-linking.spec.ts.

**Consumes:** B3 handoff plus independent existing account proof or current signup. **Produces:**
- POST /api/auth/student/sso/reauth {password,purpose} → five-minute one-use grant bound to current user/sid.
- POST /api/auth/student/sso/link {handoffId,handoffSecret,reauthGrant} → linked owner-safe identity.
- GET /api/auth/student/sso/identities and POST /api/auth/student/sso/identities/:id/unlink {reauthGrant}.

- [ ] Test wrong owner, old session, stale grant, duplicate handoff, provider subject reused across accounts, password change during reauth and concurrent last-method unlink. Require an active usable password in this release; independent recent provider reauthentication for passwordless accounts is not implemented.
- [ ] Check the password hash outside the user lock, then re-read and compare that exact hash plus current sid/active student role under the grant-creation transaction. Bind purpose and five-minute expiry; consume the grant in the same transaction as link/unlink. A password reset or session replacement invalidates the grant.
- [ ] The unlinked provider page offers Sign into existing account or Create account without revealing a match. Existing users prove password (or recover password first). Preserve the handoff only in tab storage while logging in; no URL secret.
- [ ] New users complete the existing real signup form with name, university, required consent, recovery password and school-email OTP. This supplies the existing mailbox-proof FK that enrollment checks require; account creation yields student pending. Then authenticate freshly and link, validating handoff still live.
- [ ] Do not wrap current signup in a second unimplemented atomic account creator. If handoff expires during signup, keep the successfully created account and restart provider linking. Account creation and link are separately recoverable transactions, with no orphan account rollback.
- [ ] Google verified mailbox must match the target mailbox at initial link. For Microsoft lacking reliable email, require the independently proven target school mailbox and approved university binding; email claim equality alone never links. A different returned Google account is an explicit mismatch that requires restarting.
- [ ] Store owner immutable subject key; revoked identities may be reactivated only by the original owner after fresh proof, with append-only audit event. Returned provider email changes do not transfer ownership or silently rewrite the Awoof email.
- [ ] Unlink revokes login identity and associated school assertions. In that transaction, clear active_session_id and refresh credentials only if active_session_auth_identity_id matches the removed identity; do not revoke an unrelated password/provider session. Do not mutate independent enrollment consents. Verification unlink likewise cannot revoke login identity. Require another usable login method; parallel removals serialize on user.
- [ ] Extend student-assurance.service.ts to project current SSO assertions after migration 057, with immutable owner/university/source binding and capped expiry. Write assertions through student-sso-link.service.ts and the existing-identity finish transaction only when membership evidence is sufficient. Missing Microsoft membership evidence may permit linked login but produces no positive school assertion. Never overwrite valid enrollment evidence during this write.
- [ ] Add owner UI listing provider, institution, linked time and removal action; do not expose subject IDs. Complete browser tests through real routes, then commit: feat(auth): add explicit SSO onboarding and recovery.

## Task B5: Deliver the email-first page and enrollment continuation

**Create:** apps/web/src/lib/student-login-flow.ts; apps/web/tests/auth/student-login-flow.test.ts; apps/web/src/app/auth/student/sso/complete/page.tsx; apps/web/tests/browser/student-email-first-login.spec.ts.
**Modify:** apps/web/src/app/auth/student/login/page.tsx; contexts/AuthContext.tsx; tsconfig.auth-tests.json; apps/web/src/app/student/verification/page.tsx.

**Consumes:** discovery, B3 authentication/handoff union, A2 assurance. **Produces:** email-first flow with existing password fallback and school/student labels.

~~~ts
export type LoginStep = 'email' | 'loading_methods' | 'methods' | 'password'
  | 'redirecting' | 'link_required' | 'complete' | 'error';
export type LoginState = { step: LoginStep; email: string; requestId: number };
export function submitEmail(state: LoginState, email: string): LoginState {
  return { step: 'loading_methods', email, requestId: state.requestId + 1 };
}
~~~
Own all other state transitions in that module, returning immutable states. Unit tests import the real exported functions; stale discovery response IDs are ignored.

- [ ] Add Node auth tests for request supersession, back/change email, malformed responses, no-provider password fallback, expired attempt, browser storage unavailable and callback URL validation.
- [ ] Add Playwright tests for one initial email field, accessible error focus, keyboard navigation, password manager autocomplete=username/current-password, remembered email, mobile width, denied provider recovery and cross-tab session replacement.
- [ ] Use explicit Continue with Microsoft/Google buttons after discovery; no redirect just from typing. Store only tab attempt ID, finish secret, local expiry and session generation. Never store provider bearer tokens. Clear state after completion/cancel/expiry.
- [ ] Before accepting tokens, compare captured browser session generation; discard obsolete results. If callback completes after another user signed in, do not replace them. Retain typed email without putting it into Awoof query strings.
- [ ] Show school/student status independently. If enrollment is already current, continue to the validated requested page. Otherwise present the approved institution method and its current consent notice; proceed only when consent is accepted.
- [ ] Reuse existing Microsoft notice/consent/start/finish and registration API prerequisites. Provider login tokens cannot be replayed as enrollment proof. One click may lead through additional provider authorization; show understandable Checking student status progress without promising a second prompt never appears.
- [ ] If no integration exists, show Student status pending and explain that the school connection is not yet available. Email OTP can prove the school mailbox but cannot unlock discounts. Do not advertise manual review until implemented.
- [ ] Run web test:auth, test:browser:typecheck, test:browser -- student-email-first-login.spec.ts, lint/build. Commit: feat(web): add email-first school account login.

## Task C1: Validate and deploy with measured gates

**Create:** docs/runbooks/student-sso-onboarding.md, student-sso-rollout.md.
**Modify:** docker-compose.hostinger.yml, .github/workflows/deploy.yml; backend OpenAPI and environment examples.

- [ ] Run all suites from a clean execution worktree:
~~~bash
npm --prefix apps/backend test
npm --prefix apps/backend run test:postgres
npm --prefix apps/backend run type-check
npm --prefix apps/backend run test:artifact
npm --prefix apps/web run test:auth
npm --prefix apps/web run test:browser:typecheck
npm --prefix apps/web run test:browser
npm --prefix apps/web run test:browser:microsoft
npm --prefix apps/web run lint
npm --prefix apps/web run build
~~~
- [ ] Verify fixture coverage: known linked student; new student; existing email conflict; missing Microsoft email; guest; wrong hd/tenant; pending/denied/expired/revoked/inactive; consent withdrawal; lost callback response; simultaneous report; no university integration; status-server failure.
- [ ] Compare source and compiled artifact routes, migrations, OpenAPI schemas, cleanup scripts and disabled-feature behavior. Use synthetic local HTTPS providers for callback integration; real-provider acceptance is a separate recorded gate.
- [ ] Verify the deployed backend's actual database destination using non-secret connection metadata and a read-only query executed from its runtime. Check migration list, approved mailbox domains, login domain mappings, enrollment policies and registered merchant origins. Empty policies must remain disabled; do not silently approve seeded university domains.
- [ ] Wire optional provider variables into compose/workflow and confirm disabled builds start without secrets. Set exact callbacks /api/auth/student/sso/google/callback, /api/auth/student/sso/microsoft/callback and completion /auth/student/sso/complete. Configure log redaction at reverse proxy as well as app.
- [ ] Rehearse A5 cutover before enabling B. Enable email-first password UI, then one Microsoft policy with proven membership/mailbox rules, then one Google Workspace pilot. Approve exact UI domain/hd mapping using observed claims and institution confirmation, never a guessed hd.
- [ ] Prove real login with a user-controlled test account and merchant redemption against an integrated merchant. Unsupported universities remain pending. Record checks completed, blocked partner actions and measured errors separately.
- [ ] Monitor 24 hours with explicit rollback triggers: any unauthorized discount or cross-account session is immediate disable; provider-only failure disables that provider; login fallback remains reachable. Monitoring requires a product automation if work extends beyond the interactive run.
- [ ] Rollback provider flags disables new SSO attempts and cancels outstanding ones, keeps passwords, owner unlink and valid independent enrollment operational. Release-A enrollment-only discount enforcement stays active.
- [ ] Commit scoped runbooks/wiring after verification and create the release PRs with actual test results.

## Review record and deferred scope

Revision 3 integrated R1–R7 into A1–C1. The subsequent source-grounded re-review found remaining gaps; revision 4 addresses them in the actual tasks:

| Re-review finding | Revision 4 correction | Execution proof required |
| --- | --- | --- |
| Domain schema ambiguous for two providers | Separate domain ownership and provider mappings, composite FKs | Conflicting-university insert rejected |
| School evidence source/owner insufficiently specified | Source-specific FKs, canonical locked assertion writer | Wrong-source/owner tests |
| Release A could depend on later SSO schema | Explicit pre-057 reader and post-057 extension | Both database versions tested |
| Handoff cookie could disappear before linking | Shared scoped path and handoff lifetime | Callback → signup/login → link browser test |
| Unlink/session provenance unclear | Exact active identity field and transactional revocation | Matching versus unrelated session tests |
| Shared bearer link could be redeemed by another browser | Merchant nonce/checkout-bound claim session | Stolen URL and different-order replay denied |
| Reporting could imply external checkout enforcement | Explicit partner enforcement and late-payment reconciliation boundary | Merchant stub plus real-partner acceptance |
| Spec promised automatic school assurance for every tenant login | Conditional school membership and honest first-use signup | Guest/missing membership stays unverified |

There is no separate contradictory correction appendix. Manual review and Google enrollment integrations remain deferred; neither has a runtime claim in this release. Microsoft/registration enrollment uses existing implementations under approved policies. Pricing snapshots and claim-session schema are part of 056, before A3/A4 deployment; they are not later retrofit migrations.

Review this plan for two independent outcomes: enrollment-only discount enforcement can ship on its own; the login release depends on that enforcement. Completion requires implementation/test evidence, partner activation where applicable and a working end-to-end flow; a plan check is not a deployed result.
