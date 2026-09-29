# Passwordless Signup Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Do not begin until plan review and execution-method selection.

**Goal:** Add passwordless Microsoft signup and recovery to the existing pre-login SSO system without replacing deployed login identities or policies.

**Architecture:** Extend the canonical `/api/auth/student/sso` router, `student_auth_*` storage and existing session service. Treat the older implementation as reference material, not a patch to apply wholesale. Release signup disabled until recovery, UI, migrations, and real-provider checks pass.

**Tech Stack:** Node 24, TypeScript, Express, PostgreSQL, openid-client 6.8.8, Next.js, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-25-microsoft-passwordless-signup-design.md`, revision 8; all requirements remain binding.

## Workspace and preservation

- Execute only in `/Users/mac/.codex/worktrees/awoof-passwordless-port/Awoof`, branch `codex/awoof-passwordless-port`, base `1ced2f5a1fecd28e448065918f4822334167a122` (fetched main).
- Reference-only source: `/Users/mac/Downloads/Awoof`. Its uncommitted implementation and unrelated documents remain untouched. Do not stash, reset, switch its branch or commit its files.
- Remote: `https://github.com/ogabasseyy/awoof.git`.
- Preserve Azure's existing callback and completion URLs. No production configuration changes, migrations, merge or deployment in implementation tasks.
- Setup at execution: `npm ci --prefix apps/backend` and `npm ci --prefix apps/web`; run baseline commands below before modifications. Record failures separately; do not claim the previous agent's results apply here.

## Global Constraints

- Keep `institution_login_policies`, `student_auth_identities`, `student_auth_link_handoffs`, and current identity ownership history. Never introduce the competing `sso_login_identities` model or copy old migrations 056/057.
- New migration numbers start at 069 on this baseline; recheck before committing if main advances. Existing migrations are immutable.
- Signup: original ten-minute handoff cap; six-digit OTP, five-minute expiry capped by handoff, five failed checks total, three sends total, sixty-second spacing, cross-attempt throttles.
- Fresh reauthentication: `max_age=0`; `auth_time >= attempt.started_at - 60 seconds` and `auth_time <= server_now + 60 seconds`; five-minute attempts and grants, single-use.
- Recovery: one code with at least 128 bits entropy, digests only; pending lifetime ten minutes, separate generation/activation grants; saved code plus mailbox OTP for recovery.
- School-account control is not enrollment. Preserve independent enrollment evidence through recovery; no new benefits authority or legacy verified flags.
- New signup flag defaults false; disabling it cannot disable established login or weaken recovery protections.
- Cleanup every fifteen minutes, expired secrets scrubbed within one hour, transient tombstones removed within seven days. Preserve durable identity ownership and separate legal retention.
- Do not copy secrets into docs, tests, commands or commits. Do not use real user credentials in fixtures.

## Review Focus

1. Existing production-shaped policy/identity rows survive upgrade and continue signing in: Task 1/3.
2. Signup and linking contend for one handoff without creating two owners: Task 3.
3. Provider callback races compromise recovery without leaving a usable old session: Task 4/5.
4. Microsoft redirects during recovery setup do not lose the pending flow or persist raw codes: Task 6.
5. Old frontend and backend rollout ordering cannot expose unsupported signup: Task 7.

## Task 1: Additive credential storage and upgrade fixture

**Files:** Create `apps/backend/src/database/migrations/069_passwordless_credentials.sql`, `apps/backend/src/testing/postgres/passwordless-upgrade.integration.ts`; modify migration registration only if required by the existing runner.

**Interfaces:** Add `users.password_setup_requires_recovery_code`, `users.recovery_reenrollment_requires_password` (false defaults) and `users.credential_generation` (nonnegative bigint). Add `student_auth_signup_challenges` with unique existing handoff FK; `student_auth_recovery_codes` with pending/active/consumed/revoked lifecycle; `student_auth_action_grants`, `student_auth_reauth_attempts`, `student_auth_recovery_attempts`. Use existing user/identity foreign keys. Grants bind user, sid, credential generation, operation, proof identity, pending generation and active-code generation. Define constraints for one active code, immutable ownership, terminal states and expiry.

- [ ] Write `upgradePreservesExistingLogin`: seed a current policy and identity through migrations 001–068, apply 069, assert their IDs/columns unchanged, both credential flags false, existing login still works. Write unique-handoff/code and terminal-replay constraint tests.
- [ ] Run `npm run test:postgres --prefix apps/backend`; confirm new tests fail for absent schema (ensure the harness discovers the new suite).
- [ ] Implement only additive storage. Reuse no old table-definition SQL. Document the concrete lock order alongside the migration; use the existing identity/handoff ordering, not an independently invented order.
- [ ] Repeat PostgreSQL suite; verify fresh install and upgrade path pass. Commit Task 1 files.

## Task 2: Canonical fresh-auth action grants

**Files:** Create `apps/backend/src/services/auth/student-action-grant.service.ts`, `student-reauth.service.ts` and matching `.test.ts` files; modify `student-sso.types.ts`, `student-microsoft-oidc.ts`, `student-sso-link.service.ts`, `apps/backend/src/routes/student-sso.routes.ts`.

**Interfaces:** `ActionPurpose = 'link' | 'unlink' | 'recovery_code_generate' | 'recovery_code_activate' | 'recovery_code_remove'`. `consumeActionGrant(tx, {userId, sid, grantId, secret, purpose, targetIdentityId?, pendingCodeId?}): Promise<void>`. `StudentReauthService.start({userId, sid, purpose, targetIdentityId?, pendingCodeId?})` returns `{attemptId, authorizationUrl}`; callback returns to existing completion UI without issuing a login session. Extend the adapter with separate fresh-auth operations and validated numeric authTime; do not change ordinary login or post-login verification scopes.

- [ ] Add assertions that missing authTime, start minus 61 seconds, future plus 61 seconds, wrong identity, old sid, old credential generation and consumed grants reject. Boundary values within the spec pass.
- [ ] Run backend unit tests and observe intended failures.
- [ ] Implement Microsoft and password grant issuance with identical purpose/target binding. Recheck provider/policy, suspension, session, identity and credential generation under locks at action commit. Preserve current password linking clients and their response contract. No new competing router mount.
- [ ] Run backend unit/PostgreSQL tests, including concurrent last-method unlink and policy invalidation after grant issuance. Commit Task 2 files.

## Task 3: Signup through the existing unlinked handoff

**Files:** Create `apps/backend/src/services/auth/student-sso-signup.service.ts` and `.test.ts`, `apps/backend/src/testing/postgres/passwordless-signup.integration.ts`; modify canonical SSO router/types, `src/config/env.ts`, `env.example`, verification challenge service and mailbox-proof writer.

**Interfaces:** `StudentSsoSignupService.context({handoffId, handoffSecret, browserBinding})`; `sendCode(same)`; `verifyCode({...same, challengeId, code})`; `complete({...same, fullName, ageAttested, termsVersion, verificationConsent, noticeVersion})`. Expose POST `/signup/context`, `/signup/send-code`, `/signup/verify-code`, `/signup/complete` under existing SSO prefix, strict JSON/origin protection. Reuse canonical session issuance/transport rather than returning an invented token shape.

- [ ] Test that complete without OTP or current explicit assent creates zero rows; valid completion creates one user/student/identity/session and no enrollment authority. Test existing email collision, revoked identity ownership, wrong browser, disabled flag/policy and expiry after OTP.
- [ ] Run new tests RED, then implement null-password atomic completion and mailbox proof using existing lock/consent/session conventions.
- [ ] Test five failed checks persist despite rejected transactions, fourth send refused, resend before sixty seconds refused, old code refused and restarts throttled. Send mail outside locks with quota reserved first.
- [ ] Test simultaneous link/signup and commit-success/response-loss followed by ordinary Microsoft login. Run backend suites GREEN; commit.

## Task 4: Recovery-code lifecycle

**Files:** Create `apps/backend/src/services/auth/student-recovery-code.service.ts` and `.test.ts`, `apps/backend/src/testing/postgres/passwordless-recovery.integration.ts`; extend canonical router.

**Interfaces:** `generate({userId,sid,grantId,secret,oldCode?}) -> {pendingCodeId,code,expiresAt}`; `activate({userId,sid,grantId,secret,pendingCodeId,code,oldCode?}) -> {active:true}`; `remove({userId,sid,grantId,secret,oldCode})`; authenticated `status` returns status/generation only. All accept current canonical grants from Task 2.

- [ ] Add RED tests: pending code cannot recover; activation requires separate grant and possession; replacement/removal require old code; lost generation response preserves active code; expiry and obsolete-session activation fail.
- [ ] Implement keyed digests and atomic lifecycle swaps; never return plaintext except generation. Bind pending state to session and credential generation. Code loss does not enable a provider-only replacement bypass.
- [ ] Test activation-response loss, competing replacement/recovery, password change, logout and proof-identity revocation. Preserve password-only re-enrollment restriction after recovery until activation. Run unit/PostgreSQL suites and commit.

## Task 5: Independent recovery and legacy bypass protection

**Files:** Create `apps/backend/src/services/auth/student-account-recovery.service.ts` and `.test.ts`; extend Task 4 integration suite, `src/controllers/auth.controller.ts`, `src/services/auth/session.service.ts` and canonical login/link writers where generation checks are required.

**Interfaces:** `start({email,purpose:'lost_access'|'compromise'})`, `verify({attemptId,secret,code,otp})`, `complete({attemptId,secret,password})`. Purpose is fixed at start. Require saved code plus bound mailbox OTP within ten minutes. Generic unauthenticated responses; no account-existence leakage.

- [ ] Add RED tests for mailbox-only legacy reset before/after password creation, suspended users, reused proof, substituted purpose and simultaneous recovery attempts.
- [ ] Implement password establishment, code consumption, credential-generation increment, session/grant invalidation and post-recovery re-enrollment restriction atomically. Use current password policy/hashing. Require normal password login after completion.
- [ ] For compromise revoke canonical login identities and derived school assertions; preserve independent enrollment rows. Retain owner tombstones. Do not port the old broad verification-revocation function without tracing each evidence source.
- [ ] Test callback before/after recovery interleavings, rollback on failure, and unrelated enrollment surviving. Test Microsoft disabled and expired policy recovery using mock IdP plus real database. Run suites and commit.

## Task 6: Browser journey and disclosures

**Files:** Modify `apps/web/src/app/auth/student/sso/onboarding/page.tsx`, `complete/page.tsx`, existing API transport/parser and auth shell; create `apps/web/src/app/student/security/page.tsx`, `apps/web/src/app/auth/student/recovery/page.tsx`, `apps/web/tests/browser/passwordless-signup.spec.ts`, `passwordless-recovery.spec.ts`. Inspect existing routes before creating; extend a matching route instead if one has appeared.

**Interfaces:** Use Task 3–5 transport contracts; no frontend-supplied university, issuer or assurance. Preserve existing safe claim-return handling. Security setup is optional after signup/continuation.

- [ ] Add failing browser tests for Microsoft handoff -> OTP -> unchecked assent -> account creation -> reload; existing linked login remains unchanged. Assert no password required and benefits remain denied.
- [ ] Implement accessible form, stale-notice renewal, expired-flow restart, duplicate-submit protection, session-switch cleanup and honest pending enrollment labels.
- [ ] Implement two-step fresh-auth recovery-code setup with plaintext kept only for the current display, explicit save/re-enter instructions, and server-bound pending IDs across redirects. Test cancellation, expiry, lost responses and code never stored in local/session storage or URLs.
- [ ] Add recovery purposes, warnings, password re-enrollment and unavailable-school-login guidance. Run `npm run test:auth --prefix apps/web`, `npm run test:browser --prefix apps/web` and browser typecheck; commit.

## Task 7: Retention, documentation and release evidence

**Files:** Extend `apps/backend/scripts/cleanup-student-sso.ts`, its compiled-artifact coverage, OpenAPI descriptions for new endpoints, `docs/public-trust-pages.md`, affected `/help`, `/trust`, `/privacy`, `/developers` source pages; create `docs/passwordless-release-checklist.md`.

- [ ] Add failing cleanup tests for immediate digest removal, one-hour/seven-day limits, active recovery codes surviving cleanup, and replay after tombstone deletion. Extend the existing cleanup mechanism, not a competing dispatcher.
- [ ] Implement cleanup and alertable overdue/failure metrics. Run backend scripts/artifact tests. Record live alert delivery as pending until demonstrated.
- [ ] Update substantiated disclosures and the repository's five-part documentation-impact checklist. New legal commitments still need review. Do not claim university partnership, enrollment proof, MFA or universal recovery.
- [ ] Validate `npm run test --prefix apps/backend`, `npm run test:postgres --prefix apps/backend`, `npm run type-check --prefix apps/backend`, `npm run lint --prefix apps/backend`, `npm run test:artifact --prefix apps/backend`, web auth/browser/typecheck/lint/build. Record actual counts/skips and baseline failures, not inherited claims.
- [ ] Test old frontend against new backend and backend-first rollout with signup disabled. Rollback must retain credential protections; reverting to a legacy email-only recovery binary is prohibited once accounts exist.
- [ ] Before activation: owner accepts mailbox availability limitation; securely inspect existing Azure configuration; run user-operated Microsoft/MFA/assent test, confirm auth_time, signup/session persistence/subsequent login and denied benefits. Demonstrate cleanup alert delivery. Missing evidence keeps signup disabled.
- [ ] Commit documentation/tests. Review whole branch against main, then prepare PR only when authorized. No production deployment from this plan without release authorization.

## Self-review and execution gate

Tasks 1–7 cover storage, fresh auth, signup, recovery lifecycle, compromise handling, frontend, retention, disclosure and release gates. Reference code is reusable only after adapting it to canonical identity/session contracts. Baseline tests have not yet run in the new workspace; dependency setup and baseline are the first execution steps. This plan does not certify the older implementation or authorize production activation.

Please review this plan and choose native execution or subagent-driven execution before product-code changes.
