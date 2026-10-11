# Student Profile Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, resumable academic-profile experience with evidence-reviewed graduation-year estimates, while preserving existing enrollment authority, authentication continuations, and account-data disposal requirements.

**Architecture:** Add an isolated student-owned academic-profile resource and a reviewed/versioned programme-duration reference. Build a student-only full-screen profile completion experience, entered only from the ordinary post-login browse path or an explicit profile CTA; never interrupt explicit continuations or automatically prompt enrollment-verified students. They may still choose the voluntary profile CTA. Keep the backend feature disabled until disposal, disclosure, data-source, and rollout gates pass.

**Tech Stack:** TypeScript, Express 5, PostgreSQL migrations and integration tests, Zod, Next.js 16 / React 19, Playwright, OpenAPI.

**Spec:** `docs/superpowers/specs/2026-10-03-student-profile-completion-design.md` (Revision 10; read this with the plan).

## Global Constraints

- School-account control, optional academic details, and current enrollment eligibility remain independent; profile answers never create eligibility evidence.
- Do not interrupt explicit auth, merchant, verification, security, recovery, account-linking or consent-action continuations.
- Bind every read/write to the authenticated student and the server's current institution/identity context; never accept student ID, canonical institution ID, eligibility, provider provenance or review status from the browser.
- Keep academic values out of merchant interfaces, logs, URLs, metadata and structured data.
- Preserve existing user changes and do not rewrite historical migrations; create additive migrations only.
- Keep feature-off by default. Do not enable collection until source review/licensing, approved retention and disposal, legal disclosure, claim-register evidence and operational ownership are recorded.
- Update public/API documentation in the implementation PR; do not imply a supported school, manual review, active integration or eligibility effect that is not operationally evidenced.
- Keep country-specific duration rules separate; do not apply Nigerian NUC rules to Ghana or other countries.
- Namespaced defer key: `awoof.profile.defer-prompt.v1.<browserSessionId>`; value contains account ID only. Older-session cleanup must never remove another session's key.
- Respect accessible labels/errors, keyboard operation, reduced motion, mobile layouts at 320px, noindex/private-route SEO, and bounded reference/search payloads.

## Review Focus

- Institution or identity changes racing a profile save: assert stale-context conflict and no old-school values commit in Task 2.
- Invalid, ambiguous, legacy or route-specific programme-duration rows, and unsupported/ambiguous matric formats or century boundaries: assert no estimate/suggestion until the exact rule is reviewed in Tasks 1 and 3.
- Session changes, delayed logout and two open tabs while profile completion is visible: assert no wrong-session suppression, redirect, or dirty-form loss in Task 5.
- Soft-deleted accounts, purge retries and unavailable assurance: assert academic data is inaccessible and disposed without false verification in Tasks 2 and 3.
- Post-save navigation/network failure or lost response: assert committed data is acknowledged/reconciled without duplicate profile writes, verification side effects, or blind overwrite in Tasks 2 and 4.

---

### Task 1: Make the programme reference reproducible and safe to calculate from

**Files:**
- Create: `apps/backend/src/data/academic-programmes/nuc-v2.normalized.json` (or a licence-approved, provenance-complete normalized extract if redistribution of the workbook is not permitted).
- Create: `apps/backend/scripts/build-academic-programme-reference.mjs`
- Create: `apps/backend/scripts/build-academic-programme-reference.test.mjs`
- Create: `docs/research/nuc-programme-reference-provenance.md`
- Source evidence only: `/Users/mac/Downloads/NUC_Programme_Durations_2026-10-02_v2.xlsx`; never modify the source workbook.

**Interfaces:**
- Produces a deterministic, checked-in reference artifact with source version/checksum, stable programme/award ID, aliases, route-specific durations, source/page locator, evidence classification, review state, applicability and preserved exception notes.
- Importer accepts an explicit source path; do not hard-code the developer's Downloads path or commit the original workbook. Unit tests use small synthetic fixtures. Classify every source row as included, excluded with reason, or blocked; only rows cleared for source authority, provenance and redistribution enter the runtime artifact.
- The estimate service may consume only route rules explicitly marked reviewed and applicable; imported `G`/`P` labels and numeric values alone are not approval.

- [ ] **Step 1: Write importer tests** for every source ID classified exactly once as included, excluded with a reason, or blocked; duplicate IDs/aliases; missing source locators; exact and compound pending markers (`U`, `P/U`); numeric conflicts; legacy/derived rows; award caveats; route-specific review; and deterministic output/checksum. Assert excluded/blocked rows cannot produce runtime estimates.
- [ ] **Step 2: Run importer tests and observe expected failure.** Run `node --test scripts/build-academic-programme-reference.test.mjs` from `apps/backend`; expected: FAIL because importer/reference contract is not implemented.
- [ ] **Step 3: Confirm actual source terms and provenance.** Record primary NUC source links, pages, source version, checksum and redistribution/attribution position. Do not package source-derived rows where permission is unclear; classify them as blocked and leave their calculations disabled pending authorized provenance. Record the disposition without copying restricted content into tests or public docs.
- [ ] **Step 4: Implement deterministic normalization and validation.** Preserve original labels/notes only where permitted; do not infer missing durations. Fail generation on duplicate keys, unknown statuses, missing locators, inconsistent route values or checksum mismatch; exclude blocked rows from runtime artifacts and include only permitted disposition metadata.
- [ ] **Step 5: Regenerate and test.** Run `node --test scripts/build-academic-programme-reference.test.mjs`; expected: PASS and stable output hash on two consecutive runs.
- [ ] **Step 6: Commit** the importer, artifact and provenance note only.

### Task 2: Add the isolated academic-profile store and transactional API

**Files:**
- Create: next additive migration after the latest migration on the chosen implementation base (currently 084; do not reuse a number if the target branch has advanced), e.g. `apps/backend/src/database/migrations/085_student_academic_profile.sql`.
- Create: `apps/backend/src/services/academic-profile/academic-profile.types.ts`
- Create: `apps/backend/src/services/academic-profile/academic-profile.service.ts`
- Create: `apps/backend/src/services/academic-profile/academic-profile.service.test.ts`
- Create: `apps/backend/src/controllers/student-academic-profile.controller.ts`
- Create: `apps/backend/src/routes/student-academic-profile.routes.ts`
- Create: `apps/backend/src/routes/student-academic-profile.routes.test.ts`
- Modify: `apps/backend/src/index.ts`, `apps/backend/src/config/env.ts`, `apps/backend/env.example`, `apps/backend/src/config/swagger.ts`.
- Test: `apps/backend/src/testing/postgres/academic-profile.integration.ts`.

**Interfaces:**
- `AcademicField = 'claimedInstitution' | 'programme' | 'entryYear' | 'entryRoute' | 'expectedGraduationYear'`.
- `ProfileFieldState = 'unanswered' | 'supplied' | 'unknown' | 'skipped'`; `ProfileField<T> = { state: 'supplied'; value: T } | { state: 'unanswered' | 'unknown' | 'skipped' }`; `FieldUpdate<T> = ProfileField<T>`.
- `ProgrammeSelection = { programmeId: string; courseLabel: null } | { programmeId: null; courseLabel: string }`. A selected catalogue item and a free-text course cannot both be null or be submitted as conflicting values; editing selected text clears its selected ID.
- `EntryRoute = 'utme' | 'de_200' | 'de_300' | 'transfer_other'`.
- `GraduationYearChoice = { kind: 'accept_estimate'; year: number } | { kind: 'self_reported'; year: number }`. For `accept_estimate`, after merging the patch with the locked current profile, the server recomputes from the resulting validated inputs and current reviewed reference; reject if unavailable or if the submitted year differs. The browser cannot set calculation origin, rule ID/version or source provenance. `self_reported` is explicitly student supplied and never read-only authority.
- `AcademicProfileInput = { expectedRevision: number; claimedInstitution?: FieldUpdate<{ name: string; countryCode: string }>; programme?: FieldUpdate<ProgrammeSelection>; entryYear?: FieldUpdate<number>; entryRoute?: FieldUpdate<'utme' | 'de_200' | 'de_300' | 'transfer_other'>; expectedGraduationYear?: FieldUpdate<GraduationYearChoice> }`. `countryCode` is ISO 3166-1 alpha-2. Omitted fields mean unchanged; an explicit `unanswered` clears the field, while `unknown` and `skipped` remain distinct stored answers. No user/student ID, canonical institution ID, `studentStatus`, `eligible`, source, origin, read-only, review or rule-approval fields.
- `AcademicProfileFields = { claimedInstitution: ProfileField<{ name: string; countryCode: string }>; programme: ProfileField<ProgrammeSelection>; entryYear: ProfileField<number>; entryRoute: ProfileField<'utme' | 'de_200' | 'de_300' | 'transfer_other'>; expectedGraduationYear: ProfileField<number>; graduationYearOrigin: 'calculated' | 'self_reported' | null; estimateBasis: { programmeId: string; entryYear: number; entryRoute: EntryRoute; ruleId: string; sourceVersion: string } | null; estimateStale: boolean }`. The server sets origin/basis; browser cannot submit them. An institution-confirmed graduation year is a separate read-only projection from an already approved trusted source, if one exists; this feature adds no such provider integration. `claimedInstitution` is only the student's assertion; it must not carry a server-bound school's display value.
- `AcademicProfileInstitution = { displayName: string | null; countryCode: string | null; binding: 'server_bound' | 'student_claimed' | 'unbound' }`. This presentation projection supplies the effective institution label and whether the user may edit it without exposing a canonical institution ID. For `server_bound`, ignore/reject any client attempt to replace the institution; for `student_claimed`, the editable value remains in `fields.claimedInstitution`.
- `EntryYearSuggestion = { state: 'suggested'; year: number; parserId: string; parserVersion: string; confidence: 'high' | 'medium' | 'low' } | { state: 'unavailable'; reason: 'no_registration_number' | 'unsupported_institution' | 'unrecognized_format' | 'ambiguous_format' }`. The student projection includes `entryYearSuggestion: EntryYearSuggestion | null`; `null` means the optional parser is not enabled for the current context. This suggestion is never itself stored as a confirmed profile value.
- `VerificationRequirement = 'registration_number' | 'processing_consent'`.
- Reuse `StudentAssurance` from `apps/backend/src/services/verification/student-assurance.types.ts`.
- `AcademicProfileProjection = { revision: number; fields: AcademicProfileFields; institution: AcademicProfileInstitution; institutionConfirmedGraduationYear: { year: number; observedAt: string } | null; entryYearSuggestion: EntryYearSuggestion | null; optionalUnansweredFields: AcademicField[]; attentionFields: AcademicField[]; verificationRequirements: VerificationRequirement[]; verificationContinuationAvailable: boolean; assuranceState: 'available' | 'unavailable'; assurance: StudentAssurance | null; referenceVersion: string | null; estimate: { year: number; ruleId: string; sourceVersion: string } | null; featureEnabled: boolean; promptDecision: 'complete_profile' | 'continue' }`. `attentionFields` is the union of unanswered optional fields and any stale calculated year requiring confirmation. The server computes `promptDecision` from feature state, current assurance, attention fields and the verification-method resolver; it means only that the profile is eligible to be offered, not that navigation must occur or that authorization changes. `verificationContinuationAvailable` must come from the existing server verification-method resolver, not inferred from profile fields. `institutionConfirmedGraduationYear` is read-only and null unless an existing approved source provides it; expose only the year and observation date, never raw provider payload or internal provider details. Do not create a new source. Do not expose internal canonical institution IDs or identity-version counters in this student-facing projection. A saved estimate is stored only as a student-confirmed expected year; it never becomes an institution/provider observation.
- Service: `readAcademicProfile(pool, userId) -> Promise<AcademicProfileProjection>`; `saveAcademicProfile(pool, userId, input: AcademicProfileInput) -> Promise<AcademicProfileProjection>`; `purgeAcademicProfileForUser(tx, userId) -> Promise<PurgeResult>`.
- Routes: `GET /api/students/academic-profile` and `PUT /api/students/academic-profile`, mounted behind `authenticate` + `requireRole('student')`.
- Migration stores one current row per student; do not add history/source-observation child tables in this release because no new institution data source is being integrated. Keep current-value provenance server-managed on the row. Canonical institution binding is nullable/server-derived. User claims are name/country text, never a claimed canonical ID. A bound institution is display-only/read-only from the client; reject attempts to replace it. Add foreign-key and bounded-length/check constraints and physical cascade for account deletion.
- Backend flag `ACADEMIC_PROFILE_ENABLED` defaults false. When false, suppress automatic prompts and reject new writes, catalogue searches and estimates; authenticated reads of existing own-profile data and authorized erasure/purge remain available. Return `featureEnabled: false` so the UI does not present collection as available. Retention configuration is unset until approved; missing `ACADEMIC_PROFILE_RETENTION_DAYS` makes the purge command refuse to run and keeps collection disabled.

- [ ] **Step 1: Write unit tests** for strict field allowlist, states/partial updates, entry/graduation year bounds, accept-estimate recomputation/mismatch rejection, self-reported origin, no cross-user identifiers, revision conflicts, and server-owned canonical/origin/source fields. Assert the server computes `attentionFields` and `promptDecision` only from current assurance, unanswered fields, stale calculated estimates, operational verification availability and the feature flag; feature-off blocks write/search/estimate and prompting while preserving authenticated self-read and authorized purge.
- [ ] **Step 2: Run focused test and observe expected failure.** From `apps/backend`, run `npx tsx --test src/services/academic-profile/academic-profile.service.test.ts`; expected: newly written tests fail because the service is not implemented.
- [ ] **Step 3: Write Postgres tests** for unrelated-user denial, nullable canonical binding, active user/student row locks, concurrent institution change versus save, optimistic revision conflict, no identity-version/eligibility changes, feature-off write rejection, physical-delete cascade, and no row visibility for a soft-deleted account.
- [ ] **Step 4: Add the additive migration and typed service.** Lock active `users` and `students` rows directly; do not call `lockStudentContext` for null-canonical-institution students. Recheck context and profile revision in one transaction before saving. Recompute accepted estimates against the current reference; atomically set server-owned origin/basis on success, clear those fields on unanswered/unknown/skipped, and reject any attempt to write institution origin.
- [ ] **Step 5: Add controller/routes/OpenAPI/config.** Ensure path and body never allow another student ID, and requests/response never expose internal endpoints or raw provider data.
- [ ] **Step 6: Run focused tests and type-check.** Run the focused backend test file, `npm --prefix apps/backend run type-check`, and `npm --prefix apps/backend run test:artifact`; expected: PASS with generated OpenAPI including the new contract.
- [ ] **Step 7: Commit** migration, service, routes, schema and tests only.

### Task 3: Add bounded catalogue/search, duration estimates, assurance projection and disposal

**Files:**
- Create: `apps/backend/src/services/academic-profile/academic-programme-reference.service.ts`
- Create: `apps/backend/src/services/academic-profile/academic-programme-reference.service.test.ts`
- Create: `apps/backend/src/services/academic-profile/academic-entry-year.service.ts`
- Create: `apps/backend/src/services/academic-profile/academic-entry-year.service.test.ts`
- Create: `docs/research/student-registration-number-formats.md` with source links, synthetic format examples, parser status/version and review notes; do not include real student numbers.
- Create: `apps/backend/src/services/academic-profile/academic-profile-retention.service.ts`
- Create: `apps/backend/src/services/academic-profile/academic-profile-retention.service.test.ts`
- Create: `apps/backend/src/testing/postgres/academic-profile-retention.integration.ts`
- Create: `apps/backend/scripts/cleanup-academic-profile-data.ts`
- Modify: `apps/backend/package.json`, existing approved cleanup/deployment schedule configuration only if one is confirmed.
- Modify: Task 2 controller/routes/OpenAPI for bounded search/estimate and projection fields.

**Interfaces:**
- `EstimateInput = { programmeId: string | null; entryYear: number | null; entryRoute: EntryRoute | null }`. Country is resolved from the server-owned programme reference; never accept a client country override that could apply a rule from another national system. It contains no student ID, institution ID, claimed matriculation year, profile revision, or client-selected rule/source version. Validate bounded identifiers and integer year ranges at the route boundary.
- `EstimateUnavailableReason = 'missing_input' | 'unsupported_country' | 'unsupported_route' | 'unknown_programme' | 'unreviewed_rule' | 'conflicting_rule' | 'out_of_range'`.
- `EstimateResult = { state: 'available'; year: number; ruleId: string; sourceVersion: string } | { state: 'unavailable'; reason: EstimateUnavailableReason }`. `estimateGraduationYear(input: EstimateInput, reference: ProgrammeReference) -> EstimateResult`; never persist an available estimate as an independent fact until the student confirms it as their expected year. Direct-entry uses actual entry level and reviewed remaining duration; `transfer_other` is unavailable unless an explicit reviewed rule exists.
- Internal service only: `suggestEntryYearFromMatric({ institutionId, registrationNumber, currentYear }: { institutionId: string | null; registrationNumber: string | null; currentYear: number }) -> EntryYearSuggestion`; the institution ID and registration number come only from the locked server-side student context, never an HTTP input. The endpoint never accepts, returns, logs or places the registration number in a URL. Only a source-reviewed institution-specific parser documented in `docs/research/student-registration-number-formats.md` may return `suggested`, with confidence set by that parser's documented evidence. Each parser defines and tests its two-digit-year-to-century window; if more than one century is plausible, return `ambiguous_format`. The student must explicitly confirm or edit the year before it becomes `entryYear`; never auto-save a parsed value. Do not re-suggest over an already-confirmed entry year.
- Search responses use `CataloguePage<T> = { items: T[]; nextCursor: string | null }`; institution items expose only `{ name: string; countryCode: string }`, and programme items only `{ programmeId: string; label: string; award: string | null }`. Cursors are opaque, bounded and validated server-side.
- Authenticated endpoints: `GET /api/students/academic-profile/institutions?q=&cursor=&limit=`, `GET /api/students/academic-profile/programmes?q=&cursor=&limit=`, and `POST /api/students/academic-profile/estimate`. Derive canonical institution scope from the locked server-side student context, never a client-supplied institution ID; unbound students may search the general approved reference. Enforce bounded page size, query length/rate limits and parameterized SQL. Return catalogue display fields only.
- Projection separately reports optional unanswered and attention fields, institution-confirmed graduation year only if an existing approved source provides it, typed operational verification requirements, current assurance or unavailable, `entryYearSuggestion`, `referenceVersion`, `featureEnabled` and prompting decision. With the feature disabled, reads remain available for existing data and erasure remains operable, while automatic prompting, writes, search, parser execution and estimate are disabled/rejected. Do not return a suggestion unless the feature is enabled and the current server-bound institution has a reviewed parser.
- `purgeSoftDeletedAcademicProfiles(pool, retentionDays: number, now) -> Promise<PurgeSummary>` uses one owner/legal-approved positive day value from `ACADEMIC_PROFILE_RETENTION_DAYS`; it deletes due academic rows for soft-deleted accounts and records minimal counts/outcomes only, never the deleted values. Superseded institution-bound values are overwritten/deleted transactionally, not retained as history. Do not invent a duration or run the scheduled command without an approved policy.

- [ ] **Step 1: Write pure estimate and parser tests** for first year, DE200/DE300 remaining duration, unsupported route/country, missing/unreviewed/conflicted rule, exact reviewed institution-specific matric formats, unsupported institution, unrecognized/ambiguous format, two-digit-year century boundaries, student confirmation/edit before persistence, no registration number in the projection/logs, boundaries, old expected year, self-reported override preservation, institution-confirmed read-only value and stale calculated-estimate invalidation. Do not implement a universal or substring-only matric parser; the UNILAG prefix is enabled only after independent format evidence is recorded and tests pass.
- [ ] **Step 2: Run focused tests to verify they fail.** From `apps/backend`, run `npx tsx --test src/services/academic-profile/academic-programme-reference.service.test.ts src/services/academic-profile/academic-entry-year.service.test.ts src/services/academic-profile/academic-profile-retention.service.test.ts`; expected: missing reference, parser, estimate and retention contracts fail.
- [ ] **Step 3: Implement reference search, reviewed institution-specific entry-year suggestions and estimate** using only reviewed parser rules and Task 1 duration data. Unreviewed data returns unavailable, never a guessed year. Search is authenticated, bounded and does not advertise catalogue entries as supported schools. Parsed years are suggestions only and are persisted solely after student confirmation.
- [ ] **Step 4: Add projection assurance** through the existing server assurance reader; on read failure return an explicit unavailable discriminator, never verified/pending invented from profile fields.
- [ ] **Step 5: Add disposal tests first** for soft-deleted user inaccessibility, physical cascade, same-transaction replacement of stale school-bound values, purge retry after transient DB failure, and no PII in audit logs.
- [ ] **Step 6: Implement retention service and command.** Do not invent a retention period. Parse `ACADEMIC_PROFILE_RETENTION_DAYS` as unset or a strictly positive integer; unset makes the command fail closed. Do not run it until owner/legal approval and an operational schedule exist; leave collection/feature disabled meanwhile. Integrate physical deletion with cascade; sweep soft-deleted users through the narrow academic purge task, not a general account-deletion subsystem.
- [ ] **Step 7: Run tests.** Run focused service tests, `npm --prefix apps/backend run test:postgres`, `npm --prefix apps/backend run type-check`, and `npm --prefix apps/backend run test:artifact`; expected: PASS, including disposable-Postgres integration suites.
- [ ] **Step 8: Commit** reference services, retention service, command, routes and tests only.

### Task 4: Build the authenticated academic-profile screen

**Files:**
- Create: `apps/web/src/app/student/profile/complete/page.tsx`
- Create: `apps/web/src/lib/student-academic-profile.ts`
- Create: `apps/web/src/lib/student-academic-profile.test.ts`
- Modify: `apps/web/src/lib/auth.ts`, `apps/web/src/lib/auth-response.ts`, `apps/web/tests/auth/auth-response.test.ts`.
- Modify: `apps/web/src/app/student/profile/page.tsx`, `apps/web/src/app/student/verification/page.tsx`.
- Test: `apps/web/tests/browser/student-academic-profile.spec.ts`.

**Interfaces:**
- Extend validated browser `User` narrowly with optional student `profile.name` (only where returned by `/auth/me`); authentication responses may omit it. Greeting derives only from this validated field; blank/missing uses “Hi there”, no email-derived name.
- `AcademicProfileView` includes `entryYearSuggestion: EntryYearSuggestion | null`, `institutionConfirmedGraduationYear`, `attentionFields`, and server-set graduation origin/basis/staleness fields; `parseAcademicProfileResponse(unknown) -> AcademicProfileView | null` and `buildAcademicProfilePatch(form, revision) -> AcademicProfileInput`; unknown/malformed data fails safely. Confirming a suggested entry year writes the regular student-entered `entryYear`; confirming the estimated graduation value sends `kind: 'accept_estimate'`, while manual override sends `kind: 'self_reported'`. The server recomputes and validates accepted estimates. Dismissing a suggestion does not write or suppress other optional fields.
- Use the API and UI copy in the spec. “Save and continue” saves before navigation; “Complete later” is non-saving unless the student explicitly confirms save. If save is chosen from the dirty-form confirmation, confirm/reconcile the save first, then write deferral and navigate; a save failure stays on the form without deferring. Failed post-save navigation reports saved state and retries navigation without resubmitting.

- [ ] **Step 1: Add parser tests** for valid profile, blank/absent name, invalid payload, unknown field-state, suggested/unavailable entry-year suggestion, stale calculated estimate and server-owned origin fields, institution-confirmed read-only projection, and strict no-eligibility projection.
- [ ] **Step 2: Run `npm --prefix apps/web run test:auth`;** expected: the new parser tests initially fail.
- [ ] **Step 3: Add parser/API client and auth-name parsing** while preserving current auth account validation; verify password and SSO auth responses with absent profile remain valid.
- [ ] **Step 4: Build the route** by freshly loading the authenticated server projection on entry; do not trust a cached post-login routing decision as current status. If current assurance is verified, render only the voluntary profile experience; if expired, denied or revoked, send the student to the existing verification journey; if unavailable, fail open without asserting a status. Include prominent entry for missing unanswered optional fields, and all saved answers displayed/editable on an explicit profile visit (except server-bound institution fields, which remain read-only). Institution-confirmed graduation data, if supplied by an existing approved source, is read-only with the correction path; never offer an edit that writes over it. Show the entry-year suggestion as an editable confirmation, never a preselected persisted answer; changing or dismissing it preserves the existing value until the student confirms a replacement. When course, entry year or route changes, mark a calculated graduation value stale and require explicit confirmation of the newly computed year; preserve a self-reported override, and never replace an institution-confirmed value. Include verified-student voluntary copy, partial save, unknown/skip distinctions, accessible typeahead, estimated-year explanation and honest unavailable/unsupported states. When `featureEnabled` is false, render no collection/edit controls and explain unavailability without blocking account access; authenticated self-read and erasure remain available. This is the full post-login profile screen as well as an explicit profile route, not a modal overlay.
- [ ] **Step 5: Add links** from profile hub and verification page using fixed same-origin `redirect` return paths. Do not make fields required to run the current registration verification flow.
- [ ] **Step 6: Write and run browser tests** for pending→verified, pending→expired/denied/revoked, and pending→assurance-unavailable changes between post-auth routing and fresh page load; also cover verified/assurance-unavailable/unsupported profiles, name fallback, feature-disabled no-controls state, accepting/editing/dismissing a suggested entry year, accepting a recomputed graduation estimate versus entering a self-reported year, stale-estimate reconfirmation after course/entry-year/route changes, preservation of a self-reported override, institution-confirmed graduation year remaining read-only with its correction path, partial save, every optional skip, explicit-visit editing of saved answers, typeahead keyboard operations, dirty form, save/discard/stay outcomes when leaving a dirty form, failed save and saved-but-navigation-failed reconciliation.
- [ ] **Step 7: Run** `npm --prefix apps/web run test:auth`, `npm --prefix apps/web run test:browser -- student-academic-profile.spec.ts`, `npm --prefix apps/web run test:browser:typecheck`, `npm --prefix apps/web run lint`, and `npm --prefix apps/web run build`; expected: PASS.
- [ ] **Step 8: Commit** route, parser, links and tests only.

### Task 5: Add safe post-login completion-screen routing and cross-tab deferral

**Files:**
- Create: `apps/web/src/lib/student-profile-prompt.ts`
- Create: `apps/web/tests/auth/student-profile-prompt.test.ts`
- Modify: `apps/web/src/contexts/AuthContext.tsx`
- Modify: `apps/web/src/app/auth/student/sso/onboarding/page.tsx`, `apps/web/src/app/auth/student/sso/complete/page.tsx`, and student login completion only where current code owns the marketplace redirect.
- Modify: `apps/web/src/lib/student-return.ts`, `apps/web/tests/auth/student-return.test.ts`.
- Test: `apps/web/tests/browser/student-profile-prompt.spec.ts`.

**Interfaces:**
- `profilePromptDecision({ promptDecision, destination, explicitContinuation, deferred }) -> 'complete_profile' | 'continue'`. `promptDecision` is the server-projected eligibility from `AcademicProfileProjection`; the browser adds only safe-destination, explicit-continuation and session-deferral gates. Auto-route only when assurance is available and current enrollment is specifically pending, `attentionFields` is non-empty because of unanswered optional details or a stale calculated estimate, no operational verification continuation is available, and the other gates pass. Known verified students always continue; expired, denied or revoked students go to the existing verification journey, not profile completion; unavailable/unknown assurance always continues without assuming pending. `unknown` and `skipped` answers are complete choices. Tests must prove feature/status/provenance inputs are not replaced by client-supplied values.
- `resolveStudentPostAuthDestination({ decision, safeDestination }) -> string`; `complete_profile` routes to `/student/profile/complete?redirect=<safeDestination>`. No modal/overlay is introduced. Explicit non-marketplace destinations go straight to the validated destination.
- `deferKey(browserSessionId) -> string`; `writeDeferral(storage, sessionSnapshot, accountId)`, `readDeferral(storage, sessionSnapshot, accountId)`, and `clearDeferral(storage, invalidatedSessionSnapshot)` implement session-namespaced marker behavior. Before and after writes, recheck active auth snapshot; remove only the obsolete key. Do not clear by prefix during logout.
- After session commit, read the profile projection. Route to the full completion screen only when the feature is enabled, assurance is available and reports current enrollment specifically pending, `attentionFields` is non-empty because of unanswered optional details or a stale calculated estimate, no operational verification continuation is available, there is no explicit continuation or the destination is exactly `/marketplace`, and this session has not deferred. A known enrollment-verified student is never auto-prompted for optional details; keep the voluntary CTA and “Add optional academic details” copy. Expired, denied or revoked students continue to the existing verification journey, not profile completion. If assurance is unavailable/unknown or the projection cannot be read, continue to the original safe destination and leave an explicit retry/CTA; do not treat unavailable as pending. If the existing server method resolver reports an available verification continuation, that continuation takes priority. `unknown`/`skipped` answers do not trigger repeated prompts. **Complete later** records the deferral and returns to that exact safe destination. Other validated destinations bypass the screen. Existing recovery warning stays first; completion route never auto-prompts. An already-open completion page in another tab stays put when a deferral event arrives; it must not discard edits or navigate unexpectedly.

- [ ] **Step 1: Test pure routing and deferral helpers** against server projections for eligible pending with unanswered details or a stale calculated year, verified, expired, denied, revoked, assurance-unavailable, verification-continuation-available and disabled-feature states; the client must not recompute or elevate an ineligible server `promptDecision`. Also cover every excluded flow, unsafe/self/deep completion return, explicit redirect priority, cross-tab storage event, account mismatch, session replacement during write, stale old-session logout, in-memory fallback and unavailable storage.
- [ ] **Step 2: Run `npm --prefix apps/web run test:auth`;** expected: new tests fail before helper code.
- [ ] **Step 3: Implement pure routing/marker helpers** with session-specific namespaced keys and dedicated storage-event handling separate from auth events.
- [ ] **Step 4: Integrate the full completion route at the post-auth boundary** only for ordinary marketplace browse. On status/projection read failure, continue to the original safe destination and expose retry from the explicit profile CTA; do not block login or clear the session.
- [ ] **Step 5: Implement the “Complete later” persistence and navigation.** If dirty, ask save/discard/stay. On save, confirm or reconcile the committed revision before writing deferral; on save failure, stay on the form and do not defer. Confirmed discard affects only this page's unsaved local draft. After save or discard is resolved, write the defer marker for the captured session and return to the exact validated continuation; never let a late write from an obsolete session suppress another login.
- [ ] **Step 6: Add Playwright coverage** for password login, SSO re-login, SSO signup after recovery warning, pending status with unanswered optional fields and no verification continuation, verification-continuation priority, enrollment-verified bypass, status transitions between post-auth routing and fresh completion-page projection (verified stays voluntary; expired/denied/revoked return to verification), assurance/projection unavailable fail-open, disabled feature, unknown/skipped choices not re-prompting, merchant claim/checkout, verification, recovery, link/unlink, consent action, two tabs, reload, new login, delayed logout, active dirty form, and profile CTA.
- [ ] **Step 7: Run** focused auth tests, both browser specs, `npm --prefix apps/web run test:browser:typecheck`, `npm --prefix apps/web run lint`, and `npm --prefix apps/web run build`; expected: PASS with no auth/redirect loop.
- [ ] **Step 8: Commit** routing, deferral, profile-route integration and tests only.

### Task 6: Synchronize public claims and implement release/retention gates

**Files:**
- Modify: `docs/public-trust-pages.md`
- Modify: the current claim register location identified by `docs/public-trust-pages.md` (do not create a duplicate register).
- Modify: `apps/web/src/content/public/help.ts` and the existing verification guidance identified by route inventory.
- Modify if evidence requires: `/trust`, `/privacy`, `/developers`, `apps/web/src/content/public/partners.ts`, backend OpenAPI.
- Create/update: `docs/superpowers/specs/2026-10-03-student-profile-completion-design.md` implementation status section or a new feature-rollout record containing approvals/evidence, without changing the approved design silently.

- [ ] **Step 1: Write documentation contract tests** for exact page/link text, no claim that profile completion verifies enrollment, no merchant access to academic fields, and disabled/unavailable estimates where source/review is missing.
- [ ] **Step 2: Implement truthful help and integration guidance** alongside any behavior changes. Add an explicit no-change rationale for each assessed public page not affected.
- [ ] **Step 3: Add backend feature-off verification** so writes, search and estimate cannot be activated by a browser flag or direct API request. Default config remains false in code and environment examples.
- [ ] **Step 4: Complete release gates:** verified source/licence/provenance; legal-approved collection purpose/disclosure; approved retention schedule; physical/soft-delete and backup handling evidence; operational owner and scheduled purge invocation; claim register evidence; accessibility/link review. If any gate is open, leave the feature off and state the precise blocker.
- [ ] **Step 5: Run** public-help/browser tests, OpenAPI artifact checks, backend type-check/tests and web tests from Tasks 2–5; expected: all green and public copy matches enforced behavior.
- [ ] **Step 6: Commit** documentation and rollout guard only.

### Task 7: Independent implementation audit and handoff

**Files:**
- Review all files created/modified by Tasks 1–6; no unreviewed code or evidence files.
- Create: `docs/superpowers/reviews/2026-10-04-student-profile-completion-implementation-review.md`.

- [ ] **Step 1: Verify each spec section** against implementation, tests, API/OpenAPI, claim register and release gates. Separate code merged, feature configured, provider approved and production deployed states.
- [ ] **Step 2: Run full checks:** `npm --prefix apps/backend test`, `npm --prefix apps/backend run test:postgres`, `npm --prefix apps/backend run type-check`, `npm --prefix apps/backend run test:artifact`, `npm --prefix apps/web run test:auth`, `npm --prefix apps/web run test:browser`, `npm --prefix apps/web run test:browser:typecheck`, `npm --prefix apps/web run lint`, and `npm --prefix apps/web run build`.
- [ ] **Step 3: Test feature-off state** by direct API and UI access; expected: no profile persistence or prompt while disabled, no enrollment/benefit changes, existing login and verification journeys unchanged.
- [ ] **Step 4: Test enabled state only in a synthetic non-production environment** after all legal/data/retention gates pass; verify read/write/purge, same-origin continuation, mobile/accessibility and no merchant data leakage.
- [ ] **Step 5: Record remaining gates and exact deployment evidence.** Do not merge or deploy unless the user separately authorizes it and required gates are satisfied.

## Coverage Map

| Spec area | Plan task |
|---|---|
| Programme source provenance, exceptions, route-specific estimates, matric-parser evidence and explicit year confirmation | 1, 3, 4 |
| Authenticated isolated academic data, concurrency, assurance | 2, 3 |
| Soft/physical deletion and retention | 2, 3, 6 |
| Profile route, name, fields, accessibility and save recovery | 4 |
| Prompt eligibility, continuation safety, cross-tab deferral | 5 |
| Trust/help/OpenAPI/claim register and feature-off rollout | 2, 6, 7 |
| Full integration/security/production boundary verification | 7 |

## Handoff

Implement in a clean feature worktree based on the current intended target branch, not this review worktree with unrelated uncommitted provider-name/diagnostic changes. Confirm branch/migration head before starting; preserve all pre-existing user changes. Approval record: on 11 October 2026 the owner approved this plan and the written design and authorized handoff; execution method is sequential subagent-driven implementation on branch `feat/student-profile-completion` based on `origin/main`. Earlier approval of the general direction was not approval of these artifacts. Execute tasks sequentially because the reference artifact, API contract, UI and prompt consume earlier task interfaces. Do not merge or deploy. Stop with the feature disabled if data-source licensing, the approved collection disclosure, retention schedule or purge operation lacks evidence/approval.
