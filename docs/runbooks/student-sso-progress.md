# Student SSO implementation progress — `codex/student-email-first-auth`

Running record of Release A/B/C1 task completion. Each entry lists the task,
commit, tests added (file + count), gate commands with results, deviations,
docs impact, and unresolved items. Baseline: `docs/runbooks/student-sso-baseline.md`.
Review disposition: `docs/runbooks/student-sso-review-disposition.md` (GO for Release A).

## Task A1: enrollment-only discount authority

- Task: A1 — make current enrollment the only discount authority
  (`docs/superpowers/plans/2026-09-20-institution-email-auth.md`, Task A1).
- Commit: `fix(eligibility): require enrollment evidence for student benefits`
  on branch `codex/student-email-first-auth` (this commit; hash in completion report).
- Source changes:
  - `apps/backend/src/services/verification/eligibility-read.service.ts`:
    removed `independentlyValidEmailEvidence` as a benefit fallback; added
    `independentlyValidEnrollmentEvidence`, which selects enrollment candidates
    by student/institution and validates each through its actual source
    authority (Microsoft via `currentMicrosoftProof`, registration via locked
    evidence row + current grant + identity/policy binding + database-time
    expiry). Validity requires method `enrollment` AND a recognized source
    (`institution-registration:v1`, `microsoft-education:v1`); the required
    `selected.method !== 'enrollment'` → `unverified` guard is in place.
    Consent lock order, authoritative-denial short-circuit, inactive handling,
    and disclosure checks are preserved.
  - `apps/backend/src/services/verification/eligibility-evidence.service.ts`:
    `recordEmailAssurance` keeps mailbox proof and immutable email evidence for
    audit, no longer replaces a live enrollment pointer
    (`current_evidence_id` conditional update), and returns
    `getEffectiveEligibility` after recording. Denial early-return preserved.
  - `apps/backend/src/services/verification/eligibility.types.ts`: added
    `MICROSOFT_ENROLLMENT_SOURCE` constant.
  - `verification-flow.service.ts` and `student-signup.service.ts`: reviewed,
    no code change required — both pass `EligibilityResult` through without
    rejecting `eligible=false` (see deviations).
- Tests added (10):
  - `apps/backend/src/testing/postgres/eligibility.integration.ts`: 7 —
    fresh email only; expired Graph plus fresh email; withdrawn Graph consent
    plus fresh email (with live-pointer preservation); expired registration
    evidence; fresh valid registration; valid independent enrollment surviving
    another source failure; denial plus fresh OTP.
  - `apps/backend/src/testing/postgres/checkout-refund-regressions.integration.ts`: 1 —
    email-only student cannot start checkout.
  - `apps/backend/src/testing/postgres/merchant-assertion.integration.ts`: 1 —
    issuance rejects an email-only student.
  - `apps/backend/src/services/verification/eligibility-read.service.test.ts`:
    rewritten for the enrollment scan (pre-filter + withdrawn-grant skip).
- Tests intentionally updated for the retired email-benefit rule (no test
  deleted or weakened; purposes preserved, fixtures moved to enrollment):
  `eligibility.integration.ts` (fallback rewrites, reason updates to
  `unverified`, enrollment fixtures for checkout/merchant cases),
  `student-signup.integration.ts` (signup yields pending enrollment),
  `microsoft-verification.integration.ts` (unlink/provider-withdrawal keep
  mailbox proof, lose benefit authority),
  `microsoft-fallback-artifact.integration.ts` (disabled-Microsoft fallback now
  selects independent enrollment),
  `verification-flow.integration.ts` (confirm-email yields pending),
  `merchant-assertion.integration.ts` and `checkout-refund-regressions.integration.ts`
  (enrollment fixtures), `auth.student-signup.http.test.ts` (contract accepts
  `eligible=false`), `checkout.service.test.ts` and `savings-reporting.integration.ts`
  (eligible mocks now use method `enrollment`).
- Gate commands and results (from worktree root):
  - `npm --prefix apps/backend test` → PASS (154 tests, 0 fail).
  - `npm --prefix apps/backend run test:postgres` → PASS (215 tests: 214 pass,
    0 fail, 1 skipped — the dedicated compiled fallback smoke, skipped by
    design in source mode).
  - `npm --prefix apps/backend run type-check` → PASS (clean).
  - Pre-change failure observation (test-first): unit suite failed only on the
    new enrollment-scan import; new postgres cases failed as designed (fresh
    email, expired Graph, withdrawn Graph, expired registration, and the
    independent-enrollment evidence binding); fresh-registration and
    denial guards passed before and after.
- Migration check: no `056`/`057` files present; A1 adds no migration.
- Deviations:
  - `verification-flow.service.ts` / `student-signup.service.ts` needed no
    edits: neither rejects `eligible=false` nor labels OTP acceptance as
    enrollment; signup creates no enrollment evidence and copies no legacy
    flags. Covered by updated contract tests instead.
  - Email-only reads now return `unverified` per the plan guard (prior
    email-derived `expired`/`identity_changed`/`policy_changed`/`consent_required`
    reasons only arise from enrollment evidence now).
  - Mailbox-changed Microsoft pointer now yields `identity_changed` instead of
    `unverified` (more precise; no test covered the old combination).
  - Withdrawn merchant disclosure returns `consent_required` before enrollment
    reason selection (preserves existing disclosure tests; A3 owns disclosure).
  - Commit recorded by message + branch because this entry ships in the commit
    itself; the hash is in the task completion report and `git log`.
- Docs impact (AGENTS.md checklist): no trust/help/partner/developers changes.
  Verified existing copy already separates mailbox vs enrollment checks and
  makes no email-benefit claims (`trust.ts` “Two checks, not one”,
  `partners.ts` “never treated as student proof”, `help.ts` codes/recovery
  only). In-app verification page label “Confirm your school email to renew
  your verification” becomes stale under A1; it is owned by Task A2’s label
  rework (web is outside A1 file scope) and recorded as a follow-up.
- Unresolved: none for A1. Follow-up for A2: verification/profile page labels
  and the `StudentAssurance` reader.

## Task A2: truthful school-account and student status

- Task: A2 — expose truthful school-account and student status
  (`docs/superpowers/plans/2026-09-20-institution-email-auth.md`, Task A2).
- Commit: `feat(verification): expose independent school and enrollment status`
  on branch `codex/student-email-first-auth` (this commit; hash in completion
  report).
- Source changes:
  - `apps/backend/src/services/verification/student-assurance.types.ts` (new):
    exact plan DTO (`StudentStatus`, `StudentAssurance`, school/enrollment
    method and reason unions).
  - `apps/backend/src/services/verification/student-assurance.service.ts`
    (new): `readStudentAssurance(tx, userId)` plus pure, unit-tested
    `resolveStudentStatus` / `resolveSchoolAccount` precedence. Enrollment
    reuses the locked `getEffectiveEligibility` authority for the verified
    path; revocation comes from explicit revoked/withdrawn enrollment
    evidence, never from the generic `consent_required` reason. School
    assurance (Release A: mailbox proof only) requires an active approved
    domain, matching identity/policy versions, a current processing grant,
    and unexpired evidence, capped at 90 days from proof without extending
    old expiry. Absent profile/institution routes to pending; inactive actor
    to inactive; reader failure throws retryable 503, never a fabricated
    positive. Release A reads existing mailbox/evidence tables only — no
    migration-057 dependency. `readStudentAssuranceOrNull` best-effort
    sibling keeps account surfaces available on transient failure.
  - `verification-flow.service.ts`: `VerificationStatus` gains
    `studentAssurance`; both the context and incomplete-profile paths
    populate it.
  - `student.controller.ts`: profile GET/PUT responses gain
    `studentAssurance` (null when temporarily unavailable). Added optional
    constructor DI for the reader.
  - `auth.controller.ts`: login, `/auth/me`, and student register-confirm
    gain `studentAssurance` for student roles only; vendor/admin responses
    unchanged. Added matching optional DI. JWT claims untouched.
  - OpenAPI: new `StudentAssurance` component schema in `config/swagger.ts`;
    `verificationStatus` marked `deprecated` on `User` and the student
    profile response; new authenticated `GET /api/verification/status` doc
    (the retired `/status/{studentId}` doc is untouched).
  - `apps/web/src/lib/student-assurance.ts` (new): strict browser parser
    plus `isStudentVerified` and independent school/student label helpers.
  - Verification page (extended in place): status overview shows separate
    `School account` / `Student status` rows with method and expiry;
    stale "renew your verification" label now separates mailbox proof from
    the enrollment check (A1 follow-up closed); page-level and
    details-level Retry buttons clear positive state on fetch failure while
    staying signed in.
  - Profile page (extended in place, Remix styling kept): badge follows
    `studentStatus` (Verified/Unverified/`Verification unavailable`);
    account card shows both independent labels with expiry plus a retry
    control on failure. Legacy `eligibility.eligible` fallback retained for
    mixed-version responses.
- Tests added (43):
  - `student-assurance.service.test.ts`: 15 — full precedence table
    (verified registration/Microsoft, independent-source win, denied,
    inactive, expired passthrough, revoked-beats-expired,
    consent_required alone stays pending, pending refinements,
    school verified/expired/unverified).
  - `testing/postgres/student-assurance.integration.ts`: 13 — R3 matrix
    first (identical projection pre-057 vs with stub SSO tables, rolled
    back), mailbox-confirmed pending, email/enrollment expiry visible on
    next read without token refresh, 90-day cap, registration verified,
    withdrawn/revoked consent, denial, inactive, independent source
    survival, provider_unavailable, absent profile.
  - `verification.routes.http.test.ts`: 2 — mailbox-confirmed student
    receives school verified/student pending; JWT carries no
    eligibility/assurance claims.
  - `apps/web/tests/auth/student-assurance.test.ts`: 9 — parser
    valid/invalid/malformed cases, school-never-implies-student, label
    separation/expiry/denial/revocation.
  - `apps/web/tests/browser/student-design-regressions.spec.ts`: 4 (one file
    also listed below as intentionally extended) — independent labels on
    verification and profile pages, load-failure retry recovery on both.
  - `tsconfig.auth-tests.json`: includes the new web lib.
- Tests intentionally extended (no test deleted or weakened):
  `verification.routes.http.test.ts` status mock now returns the full
  `VerificationStatus` shape; `auth.student-signup.http.test.ts` injects a
  stub assurance reader (DB-backed default would open the real pool in unit
  tests) and asserts the new confirm-response field;
  `student-design-regressions.spec.ts` gains the 4 A2 cases.
- Gate commands and results (from worktree root):
  - `npm --prefix apps/backend test` → PASS (171 tests, 0 fail; baseline
    154 + 15 unit + 2 HTTP).
  - `npm --prefix apps/backend run type-check` → PASS (clean).
  - `npm --prefix apps/web run test:auth` → PASS (65 tests, 0 fail).
  - `npm --prefix apps/web run test:browser:typecheck` → PASS (clean).
  - Browser (isolated temp 3117 config + `AWOOF_APP_ORIGIN`, deleted
    after): `student-design-regressions.spec.ts` 10/10 pass;
    `student-verification.spec.ts` + `student-verification-privacy.spec.ts`
    28/28 pass (38 total, 0 fail). Protected 127.0.0.1:3107 preview
    untouched (HTTP 200 before and after).
  - Pre-change failure observation (test-first): new backend unit test
    failed (missing module), `type-check` failed on the new integration
    imports, `test:auth` failed on the missing web lib; label tests failed
    before the label helpers existed.
- Migration check: no `056`/`057` files present before or after; A2 adds no
  migration (rechecked at commit time).
- Deviations:
  - `auth.routes.swagger.ts` needed no edit: login and `/auth/me`
    responses reference the central `User` schema, which now documents
    `studentAssurance` and the `verificationStatus` deprecation.
  - Controllers take the assurance reader via optional DI (same pattern as
    the existing signup/preflight/session injections) because the
    application pool's error handler exits the process when unit tests
    would otherwise open it.
  - Profile/verification pages fall back to `eligibility.eligible` when a
    response predates `studentAssurance`, keeping mixed-version reads and
    the existing effective-eligibility browser tests truthful.
  - `test:postgres` could not run: the disposable runner requires 3 GiB
    free in the OS temp dir and the volume holds 2.2–2.3 GiB; the only
    large reclaimable stores belong to other tools/sessions, and the
    roomy external volume is ExFAT (PostgreSQL `initdb` refuses it). The
    check was not bypassed. The 13 new integration tests are committed
    unrun — see Unresolved.
- Docs impact (AGENTS.md checklist): no trust/help/partner/developers
  changes. Verified existing copy already separates mailbox vs enrollment
  checks (`trust.ts` "Two checks, not one", `partners.ts` "never treated
  as student proof"); merchant/developer integration semantics are
  unchanged. User-visible changes are the in-app independent labels (with
  method/expiry), the corrected mailbox-prerequisite wording, and retry
  controls — all covered by the browser tests above; no new public claims,
  contacts, or commitments.
- Unresolved: run `npm --prefix apps/backend run test:postgres` from a
  volume with ≥3 GiB free at the next opportunity; the 13-test
  `student-assurance.integration.ts` suite (including the R3 matrix) is
  written test-first and type-checks but has never executed. Fixture
  assumptions were verified by inspection against the passing A1 suite's
  helpers and migration schema.
