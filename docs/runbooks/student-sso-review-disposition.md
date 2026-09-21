# Student SSO review disposition (pre-coding, 2026-09-21)

Adjudicated all 13 plan review items against HEAD `804c453` before Release A.
Verdict scale: GO (specified correctly), ADAPT (correction required),
BLOCKED (reason). Overall: **GO for Release A coding. Zero BLOCKED, zero ADAPT.**

## Review Focus

1. Email proof cannot unlock discounts / overwrite enrollment (A1, A2): **GO**.
   `eligibility-read.service.ts:180` exports `independentlyValidEmailEvidence`,
   used as fallback at :308/:337; `getEffectiveEligibility` at :239;
   `recordEmailAssurance` at `eligibility-evidence.service.ts:297`, called from
   signup at `student-signup.service.ts:257`. Fixtures (`FixtureOptions`,
   `createFixture`, real `recordEmailAssurance` calls) exist in
   `testing/postgres/eligibility.integration.ts`.
   Pre-coding check: read `eligibility-read.service.ts:239-355` fully before
   placing the enrollment guard; preserve consent lock order and denial behavior.
2. No HTTP/receipt/URL/concurrency bypass of student status (A3, A4): **GO**.
   `merchant-assertion.service.ts`, `verification-token.service.ts` exist;
   `/transactions/report` lives in `vendors.routes.ts`;
   `products.routes.ts` has 3 GET routes (inline public queries).
   Pre-coding check: read the vendors report handler and merchant-context lock
   helpers end to end before writing A3 tests.
3. Provider email/guest safety (B2, B4): **GO**.
   `microsoft-verification.routes.ts` enforces `requireMicrosoftSession` plus
   consent guards; `microsoft-*.service.ts` set exists.
   Pre-coding check: read `microsoft-consent.service.ts` + identity service;
   reuse membership logic, do not duplicate it.
4. Session creation/replacement safety (B1, B3): **GO**. Session writers:
   `session.service.ts` (144 lines), `jwt.service.ts`, `auth.controller.ts`.
   Pre-coding check: during B3, list every session-mutating call site in
   `auth.controller.ts` before extracting `issueSessionInTransaction`.
5. Pending/recovery states (A2, B5, C1): **GO**. Pending/error/consent UI and
   status readers exist on student verification/profile pages.
   Pre-coding check: read current verification page states before extending.

## Revision-4 rows

- R1 domain schema (composite FKs): **GO** (greenfield 057; `universities`
  exists in `001_initial_schema.sql`).
- R2 source-specific FKs: **GO, conditional confirmed** — `user_email_proofs`
  (`030_eligibility_authority.sql:81`) has PK(id) only, no UNIQUE(id,user_id).
  Migration 057 MUST add it, exactly as the plan's "if absent" clause states.
  Pre-coding check: B1 adds the constraint plus a mismatched-owner rejection test.
- R3 Release A independent of 057: **GO**. Migrations end at 055; no 056/057
  files. Pre-coding check: A2 writes the 056-only vs fully-upgraded DB matrix first.
- R4 handoff cookie lifetime: **GO** (greenfield; no `sso` dir, no cookie collision).
  Pre-coding check: B3 names exact cookie + Path in tests first.
- R5 unlink/session provenance: **GO**. No `active_session_auth_identity_id`
  column yet (057 adds it); single-active-session model confirmed.
  Pre-coding check: B4 reads `session.service.ts` + password-reset flow first.
- R6 claim session binding: **GO**. `merchant_assertions` exists (`039`);
  claim session is new in 056.
  Pre-coding check: A4 reads assertion columns + current URL shapes first.
- R7 reporting boundary: **GO**. `reportTransaction` in `vendors.routes.ts`;
  merchant-enforces-checkout + reconciliation boundary is implementable as specified.
  Pre-coding check: A3 reads the full report path including `requires_refund`.
- R8 conditional membership + signup shape: **GO**. Signup is password +
  6-digit OTP (`student-signup.service.ts:28,33,79-80,148-151`); no student
  manual-upload button (only unrelated vendor file upload).
  Pre-coding check: B4 verifies what membership evidence exists today before
  writing stays-unverified tests.

## Prior design review (already resolved at baseline)

Responsive widths/keyboard, robots/SEO, fresh CWV audit, marketplace LCP and
contrast were resolved on the design branch (`ddca74b`, `0dd4111`, `fdad422`,
`4a5e7fb` ancestors) and are contained in this baseline. Coding starts clean.
