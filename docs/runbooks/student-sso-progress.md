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
