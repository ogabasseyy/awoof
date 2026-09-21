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

## Task A3: retire legacy tokens, authorize merchant transaction reporting

- Task: A3 — retire legacy tokens and authorize merchant transaction
  reporting (`docs/superpowers/plans/2026-09-20-institution-email-auth.md`,
  Task A3).
- Commit: `fix(merchants): bind discount reports to current enrollment`
  on branch `codex/student-email-first-auth` (this commit; hash in completion
  report).
- Source changes:
  - `database/migrations/056_student_benefit_authorizations.sql` (new):
    additive only — `revoked_at` on `verification_tokens`, new
    `merchant_benefit_authorizations` (assertion UNIQUE, vendor/user/
    product/evidence/processing/disclosure FKs, list+student price
    snapshots, currency, server pricing digest, expiry, nullable UNIQUE
    `transaction_id`), nullable `product_id` on `merchant_assertions`,
    plus the A4 `merchant_claim_sessions` table and nullable
    `claim_session_id` FKs on assertions/authorizations per the plan's
    no-retrofit rule. No `transactions` change, so the existing receipt
    writer gains no `NOT NULL` column.
  - `services/verification/merchant-benefit.service.ts` (new):
    `reportMerchantBenefit` settles one discounted transaction per
    product-bound authorization. Boundary kobo→naira conversion, Paystack
    verification outside DB locks on first use only, unlocked candidate
    read, participant users sorted via `prepareMerchantDisclosure`,
    merchant re-authentication inside the commit transaction (API-key row
    recheck; vendor active/ownership recheck for JWT), canonical
    `getEffectiveEligibility` authority, then assertion/authorization and
    product/transaction locks. First use rechecks enrollment, current
    evidence/processing IDs, disclosure, product/currency/price bindings,
    pricing digest, and authorization expiry after all blocking locks;
    exact committed retries return the original result as historical
    bookkeeping; changed bindings conflict; late/expired/stock-out first
    reports fail with explicit `reconciliation: required` details echoing
    the payment reference instead of settling or minting. Unique
    conflicts roll back and re-read the merchant's committed transaction
    with an exact match, else 409. Also exports the `NGN` catalog
    currency, pricing digest, money-boundary helpers, and unused-only
    authorization cleanup.
  - `merchant-assertion.service.ts`: optional server-validated `productId`
    on issuance (active product of the vendor); product-bound exchange
    mints the authorization with quoted snapshots in the same transaction
    as receipt storage, capped at min(evidence expiry, now + 2 minutes),
    and adds `benefitAuthorizationId` to the receipt. Generic campaign
    receipt shape is unchanged; historical receipt retries mint nothing.
  - `verification-token.service.ts`: issuance/validation/consumption fail
    closed with a retirement message (no DB touch); rows preserved;
    `revokeUnusedLegacyTokens` sets `revoked_at` on unused rows only,
    never `used_at`.
  - `payment.controller.ts`: strict report schema replaces
    `verificationToken` with `benefitAuthorizationId` (UUID, kobo-integer
    amount, `.strict()`); delegates to the service; 201 first use, 200
    exact retry; notifications only on first commit.
  - `reporting-key.service.ts`: new `recheckReportingKeyInTransaction`
    helper (exchange flow untouched).
  - `merchant-verification.routes.ts`: optional `productId` on issuance;
    receipt Swagger gains optional `benefitAuthorizationId`.
    `vendors.routes.ts`: new Swagger block for
    `POST /api/vendors/transactions/report` (no prior definition existed).
  - `src/scripts/retire-verification-tokens.ts` and
    `src/scripts/cleanup-benefit-authorizations.ts` (new, with
    `scripts/*.ts` compat entries and `tokens:retire`/`benefits:cleanup`
    package pairs): redacted cutover/recurring CLIs following the
    Microsoft cleanup pattern.
- Tests added (30):
  - `testing/postgres/merchant-benefit.integration.ts`: 23 — legacy
    token fail-closed (422/404) + strict-schema rejection, retirement
    revokes unused only, product-bound minting with server quotes
    (generic unchanged), JWT settle (201 + full ledger assertions), API
    key settle, factor-of-100 rejections (80/800000 kobo) with no
    writes, Paystack minor-unit boundary (mocked provider kobo, mismatch
    and denial cases), 5 lapsed-enrollment refusals (expired, denied,
    processing-withdrawn, disclosure-withdrawn, inactive), email-only
    issuance/report refusal, concurrent identical reports (one
    transaction, 201+200 same payload), concurrent different references
    (201+409), exact retry vs changed amount/product/gateway/reference
    (200 vs 409s), retry after authorization+evidence expiry with current
    merchant auth only (revoked key 401, no renewed benefit), late first
    report reconciliation without new authorization, stock-out
    reconciliation, receipt-replay mints nothing + generic receipts
    cannot report, edited catalog prices never rewrite quoted savings
    (+refund), migration-056 additivity incl. claim-session uniqueness,
    cleanup deletes only expired-unused past retention.
  - `services/verification/merchant-benefit.service.test.ts`: 4 —
    NGN/kobo boundary, minor-unit rejections, pricing-digest
    sensitivity, invalid-price rejections.
  - `services/verification/verification-token.service.test.ts`: 3 —
    issuance/consumption throw, validation reports invalid.
- Tests intentionally updated (none deleted or weakened):
  `checkout-refund-regressions.integration.ts` external-reporting test
  now runs the authorization flow (enrolled fixture, disclosure,
  product assertion, exchange, `benefitAuthorizationId` report) with
  identical savings/stock/refund assertions.
- Tests repaired (A2 follow-up, assertions unchanged): two
  `student-assurance.integration.ts` expiry tests used a direct
  `eligibility_evidence.expires_at` UPDATE that the pre-existing
  immutability trigger forbids (they were committed unrun). Email expiry
  now revokes the live mailbox row and records a historical expired row
  through a second mailbox proof; enrollment expiry uses a single
  short-lived enrollment plus a bounded 11 s wait, since revocation
  outranks expiry in the specified precedence.
- Gate commands and results (from worktree root):
  - `npm --prefix apps/backend test` → PASS (178 tests, 0 fail).
  - `npm --prefix apps/backend run type-check` → PASS (clean).
  - `npm --prefix apps/backend run test:artifact` → PASS (20
    integration tests incl. the new file, 57 staged migrations incl.
    056, 602 hashed files; OpenAPI parity; source-absent probes). Both
    new scripts also executed in source and compiled form.
  - `npm --prefix apps/backend run test:postgres` → BLOCKED (exit 1):
    the runner's disk guard requires 3 GiB free in the OS temp dir and
    the volume holds ~660 MB (same environmental block as A2; only
    session-owned scratch may be cleaned). Equivalent evidence instead:
    the full 21-file integration suite executed on a manually-managed
    disposable loopback cluster (fresh `awoof_test_*` database, same
    guard env shape, destroyed after): 251 tests, 250 pass, 0 fail, 1
    skipped (the dedicated compiled fallback smoke, skipped by design
    in source mode).
  - Pre-change failure observation (test-first): new unit suites failed
    (missing `merchant-benefit` module; legacy token entrypoints hit the
    live code path), and the new integration file failed to load
    (`ERR_MODULE_NOT_FOUND`).
  - Extra: web app `tsc --noEmit` clean; `apps/web run lint` remains
    broken repo-wide (missing `react-hooks` plugin config),
    pre-existing and untouched.
- Migration check: no `056`/`057` files before; `056` added, `057`
  still absent (B1 owns it). Claim-session schema ships inside `056`
  per the plan; its `claim_session_id` bindings stay null until A4.
- Deviations:
  - Snapshot columns use `NUMERIC(10, 2)` rather than the plan's bare
    `numeric`, matching the existing product/transaction money units the
    plan requires for consistency.
  - Product-unavailable and stock-out first reports return 409 with
    `reconciliation: required` (like late/expired reports) instead of
    the old 400, since the merchant may already have charged; nothing
    is written and no new authorization is minted.
  - Exact committed retries skip renewed Paystack verification: a set
    `transaction_id` never unsets, so retries are pure historical
    bookkeeping (this also yields the specified 409 for a
    gateway-changed retry).
  - Retention for unused authorizations is 7 days past expiry, mirroring
    the existing transient-record rule; used rows and all receipts are
    never deleted.
  - JWT merchant re-authentication inside the transaction rechecks
    vendor active/ownership under lock; only API-key callers get the
    additional key-row recheck (JWTs are stateless 15-minute tokens).
- Docs impact (AGENTS.md checklist): behavior changed, so merchant
  integration copy changed with it — vendor integration/payment pages
  now document `benefitAuthorizationId` (assertion → exchange → report,
  current enrollment required, legacy tokens retired), the public
  developer guide gains the `productId`/authorization notes plus a
  synthetic transaction-report example, and OpenAPI covers the new
  report contract. No new public claims, coverage, contacts, or
  commitments; school-account and enrollment stays separated in every
  message and label. Trust/help/partner pages needed no other edits.
- Unresolved: run the official `npm --prefix apps/backend run
  test:postgres` from a volume with ≥3 GiB free; scheduling for the
  recurring authorization-cleanup CLI is operator-owned. This closes
  A2's unresolved item subject to that same official rerun.

## Task A4: protect voucher and external-deal claims at the server

- Task: A4 — protect voucher and external-deal claims at the server
  (`docs/superpowers/plans/2026-09-20-institution-email-auth.md`,
  Task A4).
- Commit: `fix(vouchers): enforce student claims server-side`
  on branch `codex/student-email-first-auth` (this commit; hash in completion
  report).
- Source changes:
  - `services/verification/product-claim.service.ts` (new):
    `toPublicProduct` allowlist projection (advertised prices stay,
    voucher codes/discount URLs/fulfillment fields never leave, including
    nested); `createMerchantClaimSession` (merchant-key bootstrap binding
    one checkout to one product, ten-minute expiry, exact-retry returns the
    same session, changed bindings conflict); `readMerchantClaimSession`
    (public review projection: vendor/product/prices/registered handoff
    origin — no hashes, codes, or handoff URLs);
    `claimProductBenefit` (student claim resolving vendor/product/origin/
    campaign from the session plus the disclosure grant — no
    client-supplied vendor/origin/product — with current enrollment and
    current disclosure rechecked at commit, returning an opaque assertion
    plus `origin + /awoof/student-claim?assertion=…`). Unintegrated
    merchants get 409 `MERCHANT_INTEGRATION_REQUIRED`; nothing claim-
    related is logged.
  - `merchant-assertion.service.ts`: claim-bound exchanges require the
    merchant's cookie-derived nonce plus checkout binding over the
    authenticated server connection (timing-safe hash match), consume the
    session once atomically with the assertion, and propagate
    `claim_session_id` to the benefit authorization. Same-operation
    receipt replay still returns the committed receipt; a different order
    conflicts. Lock order merchant → session → eligibility → product is
    shared by claim and exchange.
  - `merchant-verification.routes.ts`: new `POST /claim-sessions`
    (merchant key, 201 new / 200 exact retry), `GET /claim-sessions/:id`
    (student, no-store), `POST /product-claims` (student, strict
    two-field schema, no-store + no-referrer), extended exchange schema
    (optional nonce/checkout proof), full OpenAPI docs. Converted to a
    `createMerchantVerificationRouter` factory with lazy default pool;
    default export behavior unchanged.
  - `routes/products.routes.ts`: converted to a `createProductsRouter`
    factory; list/detail rows pass through `toPublicProduct`. Queries,
    filters, and listing scope are unchanged.
  - `apps/web/src/lib/student-benefit-claim.ts` (new): `ClaimStep`
    union (`idle`/`loading`/`ready`/`claiming`/`verify_required`/
    `redirecting`/`error`) with pure immutable transitions and a strict
    handoff-URL validator (fixed path, single opaque assertion, HTTPS
    except loopback).
  - `marketplace/[id]/page.tsx` (extended in place): protected claim
    card when `?claimSession=` is present (review summary, explicit
    merchant-disclosure consent, claim, `Verify student status` with an
    allowlisted relative return path, explicit retry — never auto-submit;
    works from session introspection even where the public deal detail is
    unavailable) plus distinct ordinary `Visit partner site` navigation
    for external deals that conveys no verified-discount promise.
  - `marketplace/page.tsx`: featured-card external-deal label
    `Unavailable` → `Partner site` to match the distinct ordinary path.
- Tests added (34):
  - `controllers/product-claim.http.test.ts`: 13 — anonymous
    list/detail hostile-field stripping (incl. nested), unknown product
    404, merchant-key requirement, strict-schema rejection of
    client vendor/origin/product, 201-vs-200 session semantics, student
    auth, pending 403 naming enrollment (never school account),
    expired/withdrawn/wrong-merchant fail-closed, 409
    `MERCHANT_INTEGRATION_REQUIRED` code passthrough, no-store opaque
    handoff shape, introspection auth/leak checks, exchange proof shape
    validation.
  - `testing/postgres/product-claim.integration.ts`: 8 — session
    lifecycle/exact-retry/conflicts; full protected redemption through
    a durable real-HTTP merchant stub (nonce cookies, append-only file
    ledger, direct-link 403, replay 409, campaign mismatch, same-order
    receipt equality); pending/expired/withdrawn fail-closed with no
    assertion minted and session live; disclosure withdrawn immediately
    before commit; revoked-key and suspended-widget 409s with code
    assertion; introspection key-exactness; concurrent duplicate
    exchange granting one redemption; proof required exactly for
    claim-bound codes.
  - `tests/auth/student-benefit-claim.test.ts`: 8 — ClaimStep
    transitions (no claim without review, no auto-submit, retry returns
    to ready) and handoff-URL validation incl. origin pinning.
  - `tests/browser/student-benefit-claims.spec.ts`: 5 — end-to-end
    claim handing only an opaque assertion to a real stub merchant;
    pending → verify link with return path and zero auto-submit;
    unintegrated → ordinary partner navigation; direct/shared handoff
    links cannot redeem (403/409 stub-side); anonymous sign-in with the
    claim preserved.
- Tests intentionally updated: none. No existing test was modified,
  weakened, or deleted.
- Gate commands and results (from worktree root):
  - `npm --prefix apps/backend test` → PASS (191 tests, 0 fail;
    baseline 178 + 13 new).
  - `npm --prefix apps/backend run type-check` → PASS (clean).
  - `npm --prefix apps/backend run test:postgres` → PASS via the
    official runner (259 tests: 258 pass, 0 fail, 1 skipped — the
    dedicated compiled fallback smoke, skipped by design in source
    mode). Volume space recovered to 6.7 GiB, so no manual-cluster
    workaround was needed; an earlier identical manual run also passed.
  - `npm --prefix apps/backend run test:artifact` → PASS (21
    integration files incl. the new file, 57 staged migrations,
    610 hashed files; OpenAPI parity; source-absent probes).
  - `npm --prefix apps/web run test:auth` → PASS (73 tests, 0 fail).
  - `npm --prefix apps/web run test:browser:typecheck` → PASS (clean).
  - Browser (isolated temp 3117 config + `AWOOF_APP_ORIGIN`, deleted
    after): `student-benefit-claims.spec.ts` 5/5 pass;
    `student-design-regressions.spec.ts` + `savings-reporting.spec.ts`
    15/15 pass (20 total, 0 fail). Protected 127.0.0.1:3107 preview
    untouched (HTTP 200 before and after).
  - Pre-change failure observation (test-first): new backend HTTP
    suite failed to load (missing router factories), `test:auth`
    failed on the missing web lib; integration failures observed and
    fixed during development (immutable-evidence expiry now uses the
    short-lived wait pattern; claim-load effect race fixed with a
    cleanup-cleared ref).
- Migration check: `056_student_benefit_authorizations.sql` present
  (claim-session table and nullable FKs shipped there by A3, as the
  plan requires); `057` still absent (B1 owns it). A4 adds no
  migration.
- Deviations:
  - The accessible plan/spec text defines no `ClaimStep` union, so it
    was defined in `student-benefit-claim.ts` mirroring the B5
    `LoginStep` pattern (7 states, pure transitions, unit-tested).
  - `merchant-assertion.service.ts` is extended (exchange nonce/
    checkout proof, atomic session consumption, authorization
    binding) although outside A4's Modify list: the plan's exchange
    binding has no other home, and the change is additive.
  - `testing/postgres/product-claim.integration.ts` is added beyond
    the plan's file list as the durable-behavior proof (real DB plus
    a real HTTP merchant stub); the plan's HTTP suite covers
    routing/mapping only.
  - Protected-claim campaign is the merchant checkout ID (resolved
    from the session, matched at exchange): the merchant knows its
    own checkout at callback time, so no new trusted campaign source
    was needed.
  - Claim-session introspection (`GET /claim-sessions/:id`) is added
    so the claim page can review vendor/product/origin and grant
    disclosure for the exact registered origin; it carries no
    secrets.
  - Public listing scope is unchanged (vouchers stay unlisted while
    vendor voucher publishing is suspended); the claim page reads
    session introspection instead of the public detail endpoint.
  - The test merchant stub uses HttpOnly (non-Secure) loopback
    cookies because Secure cookies are not sent over the stub's HTTP
    origin; production merchants use Secure HttpOnly cookies per the
    documented flow.
- Docs impact (AGENTS.md checklist): behavior changed, so merchant
  integration copy changed with it — the public developer guide gains
  the claim-session example, the exchange nonce/checkout note, and
  the claim-link separation; no new public claims, coverage, contacts,
  or commitments. School-account assurance and enrollment eligibility
  stay separated in every response, UI label, and doc touched here.
  Trust/help/partner pages needed no other edits.
- Unresolved: real-partner acceptance is still outstanding — an
  integrated merchant must implement the fixed `/awoof/student-claim`
  callback, the server-side exchange with nonce/checkout binding, and
  one redemption per checkout in its own durable transaction before
  any external enforcement is claimed live. This closes the A2/A3
  unresolved item (official `test:postgres` now runs green).

## Task A5: audit every consumer and release enrollment-only benefits

- Task: A5 — audit every consumer and release enrollment-only benefits
  (`docs/superpowers/plans/2026-09-20-institution-email-auth.md`,
  Task A5).
- Commit: `feat(admin): report enrollment assurance and document cutover`
  on branch `codex/student-email-first-auth` (this commit; hash in completion
  report).
- Source changes:
  - `services/verification/admin-student-assurance.service.ts` (new):
    `readAdminStudentAssurance(store, userIds)` — a bounded (100/page),
    read-only (no `FOR UPDATE`) batch projection of `StudentAssurance`
    for admin reporting. It shares the point reader's validity rules
    (`resolveStudentStatus`, `resolveSchoolAccount`,
    `enrollmentMethodFromSource`, now exported from
    `student-assurance.service.ts`) over batched unlocked reads keyed by
    a JSONB context join: current-evidence pointer + processing-grant
    currency, an independent-enrollment scan in locked order with full
    Microsoft source authority, revocation/expiry/drift flags,
    provider-availability, and 90-day-capped mailbox evidence. Missing
    profiles/universities route to pending; inactive actors to inactive.
    Labels may lag a concurrent write but can never authorize.
  - `controllers/admin-student.controller.ts`: optional constructor DI
    for the projection (A2 pattern); each list row gains
    `studentAssurance` for the exact page of user IDs. Pagination stays
    scoped (limit clamped to 100).
  - `controllers/analytics.controller.ts`: transaction-derived
    `verified_students` renamed to `purchasing_students` /
    `purchasingStudents` (SQL alias + response); the old
    `verifiedStudents` field remains as an explicitly deprecated alias
    returning the same value. `admin-analytics.controller.ts` reviewed:
    no verification-flavored metric, no change needed.
  - OpenAPI: new `VendorStudentAnalytics` schema (`verifiedStudents`
    marked `deprecated`) plus `GET /api/vendors/analytics` path doc in
    `routes/vendors.routes.ts`; new `GET /api/admin/students` path doc
    (page/limit/search, `StudentAssurance` items) in
    `routes/admin.routes.ts`.
  - `apps/web/src/lib/vendor-analytics.ts` (new): strict
    `parseVendorStudentAnalytics` (new field primary, deprecated alias
    as mixed-version fallback).
  - `apps/web/src/app/vendor/analytics/page.tsx` (extended in place):
    `Verified Students` card → `Purchasing Students` via the parser.
  - `apps/web/src/app/admin/students/page.tsx` (extended in place):
    new `School account` / `Student status` columns reusing the A2
    label helpers; legacy rows without assurance render `—`.
  - `docs/runbooks/student-benefit-cutover.md` (new): every benefit
    consumer (checkout start, fulfillment/refund, issuance, exchange,
    report, product claim, protected redemption, public projection,
    retired tokens) with its authority check and email-only-fails proof;
    admin visibility; the disposable-database rehearsal; the metric
    rename; deploy gates recorded NOT RUN; rollback (benefits stay
    closed, no downgrade to email-eligible code).
- Tests added (32):
  - `controllers/admin-student.http.test.ts`: 6 — 401 without token,
    401 wrong role, 403 demoted admin, per-row assurance provenance,
    all six statuses pass through, scoped pagination/search params plus
    projection called with exactly the page's user IDs.
  - `controllers/analytics.controller.test.ts`: 2 — purchasing count
    reported, deprecated alias stays equal.
  - `testing/postgres/admin-student-assurance.integration.ts`: 10 —
    parity (`deepEqual`) against `readStudentAssurance` for
    pending/verified/expired-pointer/denied/revoked/inactive (plus a
    revoked-beats-expired lapse), missing profile/university pending,
    boundedness + no-lock check, controller list end-to-end.
  - `testing/postgres/cutover-rehearsal.integration.ts`: 5 —
    historical purchases/savings retained; email-only fails checkout,
    issuance, claim, legacy report, sealed token entrypoints, and
    fulfillment (`requires_refund` + reconciliation, no stock move);
    enrolled issuance/exchange/fulfillment canary; lapsed paid order
    reconciles; token retirement revokes unused only.
  - `tests/auth/vendor-analytics.test.ts`: 7 — renamed metric,
    deprecated fallback, precedence, missing/non-integer/non-record
    rejection, no verification claim in the parsed shape.
  - `tests/browser/admin-design-regressions.spec.ts`: +1 — independent
    assurance columns, pending reason, legacy `—` fallback.
  - `tests/browser/merchant-design-regressions.spec.ts`: +1 — vendor
    analytics shows `Purchasing Students`, never `Verified Students`.
- Tests intentionally updated: none. No existing test was modified,
  weakened, or deleted.
- Gate commands and results (from worktree root):
  - `npm --prefix apps/backend test` → PASS (199 tests, 0 fail;
    baseline 191 + 8 new).
  - `npm --prefix apps/backend run test:postgres` → PASS via the
    official runner (274 tests: 273 pass, 0 fail, 1 skipped — the
    dedicated compiled fallback smoke, skipped by design in source
    mode).
  - `npm --prefix apps/backend run type-check` → PASS (clean).
  - `npm --prefix apps/backend run test:artifact` → PASS (23
    integration files incl. the 2 new files, 57 staged migrations,
    622 hashed files; OpenAPI parity; source-absent probes).
  - `npm --prefix apps/web run test:auth` → PASS (80 tests, 0 fail).
  - `npm --prefix apps/web run test:browser:typecheck` → PASS (clean).
  - Browser (isolated temp 3117 config + `AWOOF_APP_ORIGIN`, deleted
    after): `admin-design-regressions.spec.ts` +
    `merchant-design-regressions.spec.ts` 9/9 pass (5 + 4, incl. 2 new).
    Protected 127.0.0.1:3107 preview untouched (HTTP 200 before and after).
  - Pre-change failure observation (test-first): new backend suites
    failed (missing `purchasingStudents` / `studentAssurance`;
    `type-check` failed on the missing projection module), `test:auth`
    failed on the missing web lib, both new browser specs failed
    against the original pages (observed via a temporary page-only
    stash, then restored), and the postgres parity suite failed on
    query authoring until the JSONB context join landed.
- Migration check: `056_student_benefit_authorizations.sql` present;
  `057` still absent (B1 owns it). A5 adds no migration (rechecked at
  commit time).
- Deviations:
  - The batch projection joins per-student contexts via
    `jsonb_to_recordset` instead of multi-array `UNNEST` (PostgreSQL
    cannot infer mixed polymorphic array params) and numbers bind
    params per query (unused params fail inference); SQL text is built
    by a small `ctxJoin(param)` helper.
  - The projection takes a single database-time `now` from the state
    batch instead of the point reader's per-step clock reads; parity
    holds outside a millisecond expiry-boundary window, and reporting
    never authorizes.
  - `AdminStudentController` uses optional constructor DI for the
    projection (same rationale as A2: unit tests must not open the
    real pool); the HTTP suite mounts the real admin middleware chain
    with a stubbed projection, while integration covers the real SQL.
  - The admin list's legacy `verificationDate` API field is retained
    untouched: it is not displayed in the UI and nothing authorizes
    from it, so no relabel was required by A5's scope.
- Docs impact (AGENTS.md checklist): no trust/help/partner/developers
  changes — verified no public page or developer doc references the
  analytics endpoint or makes a renamed-metric claim (the `partners.ts`
  analytics line is dashboard copy, unchanged). User-visible changes are
  the in-app independent admin labels and the `Purchasing Students`
  card, both covered by browser tests; OpenAPI documents the new admin
  response and the explicit metric deprecation; the cutover runbook is
  internal. School-account assurance and enrollment eligibility stay
  separated in every response, UI label, and doc touched here.
- Unresolved: deploy gates §6 and real-partner acceptance (§6.6) are
  NOT RUN — production access is forbidden to this task; an operator
  must execute and record each gate during the release window. The
  deprecated `verifiedStudents` alias awaits client-migration removal.

## Task B1: durable login policy, identities, and attempts

- Task: B1 — define durable login policy, identities and attempts
  (`docs/superpowers/plans/2026-09-20-institution-email-auth.md`,
  Task B1).
- Commit: `test(auth): pin SSO handoff and identity-link security contracts`
  on branch `codex/student-email-first-auth` (this commit; hash in completion
  report). See deviations for the message override.
- Source changes:
  - `database/migrations/057_student_sso_auth.sql` (new): additive only —
    `UNIQUE(id, user_id)` on `user_email_proofs` (verified absent at
    baseline: PK on id only plus a `(user_id, email, proven_at)` index);
    greenfield `institution_login_policies` (UNIQUE per
    university/provider plus the UNIQUE id/university/provider triple for
    the domain mapping), `institution_login_domains` (lowercase domain PK,
    one university per domain), `institution_login_domain_providers`
    (composite FKs to both), `student_auth_identities` (UNIQUE per
    provider/issuer/subject plus owner key), `student_school_assertions`
    (exactly-one-evidence CHECK with composite owner FKs to each source),
    `student_auth_attempts` (status/payload CHECKs, 10-minute cap),
    `student_auth_link_handoffs` (single use per attempt, paired targets,
    10-minute cap), `student_auth_reauth_grants` (link/unlink purpose,
    5-minute cap); expiry/status/owner indexes; triggers for identity
    owner immutability, assertion one-way revocation, terminal-attempt
    lock, handoff/grant consume-once, and no-delete retention on
    identities/assertions; nullable
    `users.active_session_auth_identity_id` with no backfill. No
    `microsoft_*` table is created, altered, or referenced for writes.
  - `services/auth/student-sso.types.ts` (new): exact plan transport
    types (`LoginProvider`, `ProviderObservation`, `LoginOptions`),
    separate from persistence. No session code is written or changed.
- Tests added (18):
  - `testing/postgres/student-sso.integration.ts`: 18 — policy
    uniqueness; policy provider/version/window validation; lowercase
    single-university domains; multi-provider domain without ambiguous
    ownership; ambiguous binding rejections; approval-ready lookup joins
    active universities/live approvals only; identity issuer-subject
    uniqueness with same-provider second identity allowed; owner
    immutability with no transfer after revocation plus no-delete; owner
    composite key pinned via `pg_constraint`; exactly-one-evidence
    source matrix; evidence-to-owner binding; assertion one-way
    revocation plus no-delete; attempt status/payload CHECKs with a
    reachable pending→ready→consumed lifecycle; terminal lock with
    state-hash uniqueness; single-use handoffs with paired targets and
    consume-once freeze; bounded lifetimes with expired-row retention;
    single-purpose single-use reauth grants; nullable session
    provenance without backfill.
- Tests intentionally updated (none deleted or weakened): the R3 test
  in `student-assurance.integration.ts` retired its pre-057 stub-table
  matrix (B1 removes the 056-only database) and now pins the surviving
  half: identical assurance before and after real SSO rows exist on the
  upgraded database.
- Gate commands and results (from worktree root):
  - `npm --prefix apps/backend test` → PASS (199 tests, 0 fail).
  - `npm --prefix apps/backend run test:postgres` → PASS via the
    official runner (292 tests: 291 pass, 0 fail, 1 skipped — the
    dedicated compiled fallback smoke, skipped by design in source
    mode).
  - `npm --prefix apps/backend run type-check` → PASS (clean).
  - Pre-change failure observation (test-first, per file):
    `student-sso.integration.ts` failed before migration 057 with
    `relation "institution_login_policies" does not exist` (and sibling
    missing relations); the same file passes 18/18 after. Two
    post-migration failures were test-fixture bugs, not contract bugs:
    an expired-row window wider than the 10-minute cap and a `??`
    helper swallowing explicit `null` payloads — both fixed in the
    tests, with the migration untouched.
- Migration check: no `057` file before; `057_student_sso_auth.sql`
  added (rechecked at commit time). `056` untouched.
- Deviations:
  - Commit message is the owner-specified `test(auth): pin SSO handoff
    and identity-link security contracts`, overriding the plan text's
    `feat(auth): persist student login authority and attempts`.
  - No-delete triggers cover identities and assertions (retention rule
    in the plan) but identity revocation stays clearable so the
    original owner can reactivate after fresh proof per Task B4; only
    the owner/subject key is frozen.
  - Lifetime caps are database CHECKs (attempts/handoffs 10 minutes,
    reauth grants 5 minutes) and approval requires `enabled` plus a
    non-null unexpired `approved_until` (NULL fails closed); the B2
    discovery join shape is pinned by the active-university lookup
    test.
  - Policy version incrementing under lock and SSO university/provider
    matching stay writer rules for B2/B4 (documented in the migration
    header); no writer exists in B1 to test them against.
- Docs impact (AGENTS.md checklist): no trust/help/partner/developers
  changes — B1 adds storage and transport types only, with no API, UI,
  or approval behavior change. School-account assurance and enrollment
  eligibility stay separated in every response, UI label, and doc; no
  new public claims, coverage, institutions, or contacts.
- Unresolved: none for B1. Follow-ups for B2–B4: discovery join,
  OIDC adapters, browser-bound flow, linking writers, and the SSO
  cleanup script.

## Task B2: email-first institution SSO configuration (providers disabled)

- Task: B2 — discover login methods and validate provider claims
  (`docs/superpowers/plans/2026-09-20-institution-email-auth.md`,
  Task B2).
- Commit: `feat(auth): add email-first institution SSO configuration`
  on branch `codex/student-email-first-auth` (this commit; hash in completion
  report). See deviations for the message override.
- Source changes:
  - `services/auth/student-oidc.config.ts` (new):
    `readStudentSsoConfiguration` plus the fixed callback/completion paths
    and `enabledStudentSsoProviders` deployment-readiness helper.
    Opt-in `GOOGLE_LOGIN_*` / `MICROSOFT_LOGIN_*` /
    `STUDENT_SSO_COMPLETION_URL` / `STUDENT_SSO_ATTEMPT_KEY`; disabled
    providers require no credentials (stale values ignored while fully
    disabled); enabled providers require client credentials, the exact
    fixed HTTPS callback path, the fixed same-site completion route
    (tldts site rule shared with verification OIDC, private suffixes
    excluded), and a base64url 32-byte attempt key. No per-institution
    entries: tenants and hosted domains always come from approved
    runtime policy.
  - `services/auth/student-login-options.service.ts` (new):
    `normalizeStudentLoginEmail` (trim/lowercase, plus/dot preserving,
    254-char cap, 400 on malformed), `resolveStudentLoginOptions`
    (single read-only SELECT over login policies, domain-provider
    mappings, domains, and universities — no users/students/identities,
    no legacy mailbox domains, no benefit evidence; enabled + live
    approval + active university/domain; deployment filter; sorted
    dedupe; password-only short-circuit with no lookup when nothing is
    enabled), and Redis quota helpers (`createRedisQuotaStore` atomic
    INCR+PEXPIRE Lua, `checkDiscoveryQuota` 60/IP/10min,
    `checkSsoStartQuota` 10/IP + 5/HMAC(mailbox)/10min for B3 wiring,
    `hmacStudentMailbox` HMAC-SHA256 keyed by the attempt key). Store
    outages fail closed with retryable 503, never unlimited access.
  - `services/auth/student-google-oidc.ts` (new): `StudentGoogleOidc`
    `StudentOidcAdapter` with `forApprovedDomain` bound to a
    server-approved hosted domain. Fixed discovery URL, exact
    allowlisted metadata (authorization origin accounts.google.com,
    token origin oauth2.googleapis.com, JWKS origin
    www.googleapis.com — reverified against the official discovery
    document on 2026-09-21), 5 s deadline, 256 KiB cap, no redirects.
    Validates signature, audience/azp, issuer, expiry, nonce, state,
    PKCE S256, `email_verified`, and hd mapping; login_hint mailbox;
    `openid email profile` only; no tokeninfo call. Approved hd
    attests school membership (explicit mapping may differ from the
    email domain); personal Gmail and unapproved hd authenticate
    without school assurance.
  - `services/auth/student-microsoft-oidc.ts` (new):
    `StudentMicrosoftOidc` adapter with `forApprovedTenant` bound to a
    server-approved tenant UUID and exact tenant issuer. The login
    client asserts audience and issuer on every token, then binds
    tid/oid/sub; `openid profile email` only. Email may be null;
    `preferred_username` never becomes the observed email.
    `schoolMembershipAttested` is always false (a login ID token
    carries no trusted member/guest evidence; approved-mailbox OTP
    remains the fallback school proof) and `mailboxVerified` is
    false. Unapproved tenants rejected.
  - `services/auth/student-sso.types.ts`: added the shared
    `StudentOidcAdapter` authorize/redeem interface (additive).
  - `routes/auth.routes.ts`: `POST /api/auth/student/login-options`
    with injected discovery/quota dependencies (pools open per
    request only), strict `{email}` shape, deterministic 400 before
    quota, proxy-aware IP quota, `Cache-Control: no-store`, no
    request-body logging.
  - `routes/auth.routes.swagger.ts`: OpenAPI doc for the endpoint
    (strict schema, constant-shape response, 400/429/503).
  - `config/env.ts` + `env.example`: opt-in SSO variables wired
    through `config.studentSso`; boot succeeds with all absent.
- Tests added (89):
  - `services/auth/student-oidc.config.test.ts`: 12 — fixed paths,
    disabled-requires-nothing, stale-values boot, credential/callback
    requirements, HTTPS fixed-path callbacks, completion requirement,
    same-site incl. private-suffix rejection, 32-byte key, shared
    completion/key, no per-institution entries.
  - `services/auth/student-login-options.service.test.ts`: 26 —
    normalization (trim/lower, plus/dot), overlong/malformed 400s
    with no lookup (7), unknown-domain password-only, exact domain +
    provider binding, stable multi-provider order, readiness
    filter/dedupe, disabled short-circuit, read-only single-SELECT
    assertion, allowed/forbidden table assertion, live-approval
    predicate assertion, 60/10min quota + IP isolation, 503
    fail-closed, start quotas + HMAC keying, HMAC stability/keying,
    Redis script shape, non-integer fail-closed, transport union.
  - `services/auth/student-google-oidc.test.ts`: 20 — identity
    scopes, authorize URL (S256/login_hint/state/nonce), login-hint
    rejection without network, attested redeem, mapping-differs
    attestation, Gmail unattested, unapproved-hd unattested, 8 claim
    rejections, unknown-key rejection, state/PKCE mismatch, hostile
    metadata, redirect/oversize, construction guards. All discovery
    mocked; no tokeninfo URL touched; no network identity calls.
  - `services/auth/student-microsoft-oidc.test.ts`: 16 — login
    scopes, authorize URL, audience+issuer assertion test, tenant
    binding without membership assertion, null email +
    preferred_username ignored, unapproved-tenant rejection, 7 claim
    rejections, state/PKCE/callback mismatch, hostile metadata +
    redirect, construction guards. All discovery mocked; no network
    identity calls.
  - `controllers/auth.student-login-options.http.test.ts`: 15 —
    options + no-store, password-only passthrough, 8 malformed-shape
    400s (no quota/discovery side effects), overlong 400, 429
    passthrough, 503 passthrough with no discovery, malformed-stays-
    400 during outage, OpenAPI contract assertion.
- Tests intentionally updated: none. No existing test was modified,
  weakened, or deleted.
- Gate commands and results (from worktree root):
  - `npm --prefix apps/backend test` → PASS (288 tests, 0 fail;
    baseline 199 + 89 new).
  - `npm --prefix apps/backend run type-check` → PASS (clean).
  - `npm --prefix apps/web run test:auth` → PASS (80 tests, 0 fail;
    unchanged, no web edits in B2).
  - Extra (routes/swagger changed): `npm --prefix apps/backend run
    test:artifact` → PASS (24 integration files, 58 staged
    migrations, 647 hashed files; OpenAPI parity; source-absent
    probes). Also proves disabled builds boot with no SSO secrets.
  - Pre-change failure observation (test-first, per file): config
    suite failed to load (missing module); login-options suite
    failed to load; Google suite failed to load; Microsoft suite 1
    test / 0 pass / 1 fail; HTTP suite 15 tests / 0 pass / 15 fail.
    Three post-implementation failures were test-fixture bugs, not
    contract bugs (mock token responses lacked the `access_token`
    openid-client requires; a state-mismatch helper moved the
    callback and expectation together; the unapproved-tenant
    transport served the wrong tenant metadata) — fixed in the
    tests, implementations untouched.
- No-database-writes check: B2 sources issue only the discovery
  SELECT; grep over the new service/config/route files finds no
  INSERT/UPDATE/DELETE/BEGIN/COMMIT outside comments and a
  pre-existing doc line.
- Unverified-institution check (recorded): migration 057 contains
  zero INSERTs (grep count 0 — no seed approvals); the SSO config
  carries no per-institution entries (test pins its exact keys and
  serialized shape); discovery requires enabled policy + non-null
  unexpired `approved_until` + active university + active domain;
  disabled deployments return password-only without a lookup.
- Providers-disabled check: both flags default `false`; boot and
  the artifact render run with no SSO variables set; no real
  credentials anywhere (only `test-secret` fixtures inside tests);
  OIDC discovery is mocked in every adapter test — no network
  identity calls, ever.
- Migration check: `056`/`057` present and untouched; B2 adds no
  migration (rechecked at commit time).
- Deviations:
  - Commit message is the owner-specified `feat(auth): add
    email-first institution SSO configuration`, overriding the plan
    text's `feat(auth): add institution discovery and OIDC login
    adapters`. The endpoint is the plan's
    `POST /api/auth/student/login-options`.
  - `StudentOidcAdapter` lives in `student-sso.types.ts` (B1 file,
    additive export): the plan names the interface but no home
    file, and the transport-types module is its specified home.
  - `auth.student-login-options.http.test.ts` is added beyond the
    plan's file list for route coverage (no-store, 400/429/503,
    OpenAPI doc), following the A4 precedent.
  - Quota helpers live in `student-login-options.service.ts`
    (no extra file); SSO start quotas are implemented and tested
    now, wired by the B3 start route later.
  - HMAC-SHA256 via node:crypto keys mailbox quota subjects (same
    primitive family as the existing SHA-256 hashing); key
    validation mirrors the attempt-crypto 32-byte base64url rule.
    No new crypto was invented; session-cookie primitives are N/A
    in B2 (no cookies set — B3 owns the callback cookie and reuses
    the existing Secure HttpOnly SameSite descriptor pattern).
  - The route validates the email before the quota check so
    malformed input is a deterministic 400 even during a quota
    outage; quota failures never reach discovery.
- Docs impact (AGENTS.md checklist): no trust/help/partner/
  developers changes — providers stay disabled, discovery is
  additive and read-only, and no UI, approval, or benefit behavior
  changed. OpenAPI documents the new endpoint with an explicit
  never-authorizes-benefits description; school-account assurance
  and enrollment eligibility stay separated in every response, UI
  label, and doc touched here. No new public claims, coverage,
  institutions, or contacts.
- Unresolved: none for B2. Follow-ups for B3–B5/C1: SSO start
  route wiring (quotas, callback cookies, atomic sessions),
  explicit linking writers, the email-first page, and
  real-provider acceptance (mocked discovery cannot establish it).
