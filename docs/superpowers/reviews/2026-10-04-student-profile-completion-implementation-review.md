# Student profile completion — implementation review (Task 7)

Date: 10 October 2026
Branch: `feat/student-profile-completion` (worktree `/Users/mac/.codex/worktrees/awoof-student-profile/Awoof`)
Design: `docs/superpowers/specs/2026-10-03-student-profile-completion-design.md` (Revision 10)
Plan: `docs/superpowers/plans/2026-10-04-student-profile-completion.md`
Reviewer: Task 7 audit agent (independent of Tasks 1–6)

Commits reviewed (all on this branch, none pushed, none merged):

| Task | Commit | Subject |
| --- | --- | --- |
| 1 | `9a95395` | feat(academic-profile): add blocked NUC programme reference importer |
| 2 | `7746f34` | feat(academic-profile): add isolated academic-profile store and transactional API |
| 3 | `12550b4` | feat(academic-profile): add bounded catalogue, estimates, entry-year suggestions, and retention purge |
| 4 | `68ab8f6` | feat(web): add authenticated academic-profile completion screen |
| 5 | `a4e0a49` | feat(web): add post-login profile-prompt routing and session deferral |
| 6 | `cfa0ee3` | docs(student-profile): sync public claims and verify feature-off rollout guard |

Base: `fcaa881`. No file outside the six task scopes was modified; the only
tracked-tree delta beyond the six commits is uncommitted `apps/web/package-lock.json`
tool collateral, which this task leaves untouched and uncommitted.

## Verdict

**Pass with one minor finding.** Every spec section is implemented as designed,
backend and web unit/typecheck/lint/build suites are green, the full browser
suite reaches 423 passed with a single pre-existing flake (proven intermittent:
green in isolation and in the other full run), the feature-off state holds at
every HTTP entry point, and the enabled state was exercised synthetically
without touching production.
Collection stays **OFF**: the rollout record's blockers (source licence,
legal disclosure, approved retention, purge ownership/schedule) are unchanged
and accurately recorded. Do not merge or deploy on this review alone.

Minor finding F1: the feature adds one net-new lint warning
(`apps/web/src/app/student/profile/complete/page.tsx:113`,
`react-hooks/set-state-in-effect`, base 52 → 53 warnings, 0 errors). It is the
same kind as several pre-existing warnings and keeps `lint` at exit 0, but it
contradicts the Task 5 report of "zero new" warnings. Recommended follow-up, not
a gate failure: clear the typeahead results without a synchronous setState in
the effect, or record the exception.

## Step 1 — Spec section verification

### Intent and approved direction — PASS

- Academic answers never create eligibility evidence: the service allowlist
  (`academicProfileInputSchema`, strict) rejects identity/eligibility/provenance
  keys; saves never touch identity or eligibility columns (integration test
  `academic saves never touch identity or eligibility columns`); the merchant
  receipt schema (`MerchantVerificationReceipt`, `additionalProperties: false`)
  carries eligibility fields only and no academic field; no file under
  merchant or verification services references academic data (auditor grep).
- Verified students are never auto-prompted: `computePromptDecision` returns
  `complete_profile` only for `studentStatus === 'pending'`, and the browser
  never elevates any other server decision (unit + browser coverage).

### Existing source and limits — PASS

- No overload of `PUT /students/profile`: the feature adds an isolated
  `student_academic_profiles` table (migration `085`, additive, after head
  `084`) and separate routes under `/api/students/academic-profile`.
- Reuses the existing assurance reader (`readStudentAssurance`), the existing
  verification-method resolver (`getAvailableVerificationMethods`), and
  `resolveStudentReturn`; no new provider, Graph permission, or manual-review
  contract was created (`institutionConfirmedGraduationYear` is always null).
- The pre-account SSO recovery warning is preserved; onboarding Continue only
  gains the same destination rule after the warning.

### Approach — PASS

- Separate academic-profile store with server-managed provenance; resumable
  post-login completion screen plus profile/verification CTA; no global
  redirect, no SSO-signup field dump. Matches the selected alternative.

### Journey and routing — PASS

- Route `/student/profile/complete` exists as a full screen (prerendered by
  `next build`), linked from the profile hub and verification page with fixed
  same-origin `redirect` returns; no public profile route was created.
- `resolveStudentPostAuthNavigation` prompts only for exact `/marketplace`
  browse in an eligible, non-deferred session; every other validated
  destination returns without a projection read (auditor probe confirms the
  read is skipped for non-marketplace destinations).
- Completion self-targets (pathname, trailing slash, deeper path, query/hash
  variants) always continue; `resolveStudentPostAuthDestination` preserves one
  continuation and never wraps recursively.
- Deferral markers are namespaced `awoof.profile.defer-prompt.v1.<browserSessionId>`
  and contain the account ID only; before/after snapshot rechecks, single-key
  removal, mismatch clearing, memory fallback, and a dedicated storage-event
  subscription are implemented and unit-tested (27 cases) plus browser-tested
  (two tabs, reload, delayed logout, dirty form).
- Read failures fail open to the safe destination without blocking login or
  clearing the session; no redirect loops (full browser suite green).

### Screen and copy — PASS

- Heading/greeting from validated `data.profile.name` with `Hi there`
  fallback; name rendered as text, never HTML; no email-derived name.
- `School account` / `Student status` lines; `Add optional academic details`
  for verified visitors; field order institution → programme → entry year/route
  → expected graduation year.
- Country asked only for user-supplied institutions; catalogue country comes
  from the server; Nigerian rules never default onto other countries
  (`ESTIMATE_SUPPORTED_COUNTRY_CODES = ['NG']`, per-programme country from the
  artifact, invalid country fails the artifact closed).
- Partial save, `Not sure` (unknown), `Skip this detail` (skipped), and
  `Complete later` are distinct stored answers; optional answers are never
  labelled verification-ready; matric/consent stay in the verification flow.
- `Save and continue` saves before navigating; dirty `Complete later` asks
  save/discard/stay; save failure stays without deferring; saved-but-naviga­tion-failed
  retries navigation without resubmitting (browser-tested via the documented
  fault-injection seam).

### Integrated-school bypass — PASS

- Prompting derives from server evidence only: feature flag + retention gate,
  current assurance, attention fields, and the resolver's continuation
  availability. No client flag, seed domain, or SSO-success input can elevate.
- Verified → never prompted (CTA only); pending + answered/skipped → no repeat;
  pending + unanswered → one skippable invitation, verification continuation
  first; expired/denied/revoked/unavailable → verification journey or fail-open
  continue. All transitions browser-tested.

### Institution and course suggestions — PASS

- Authenticated, bounded (limit ≤ 50, query ≤ 128 chars, opaque cursors),
  paginated, parameterized search; bound students see only their bound
  institution; unbound students search the general active catalogue.
- **Reviewed deviation (accepted, safer than the text):** the spec's
  "minimal display projection (ID, label and country)" is implemented as
  `{ name, countryCode }` with no ID, matching the plan's "display fields
  only" and the no-canonical-ID projection boundary.
- `Can't find your institution? Add its name` saves a claimed institution with
  no canonical ID, no `universities` insert, no domain/IdP mapping, no trusted
  overwrite; `My institution is incorrect` offers the separate correction path.
- Programme suggestions are labelled programme names with a free-text fallback
  (`programmeId: null` + label + user provenance); editing text clears the
  selected ID; obsolete responses are ignored on query/session change.
- Unsupported institutions show the honest unavailable path with no signup,
  SSO, or login broadening. No `Submit for manual review` affordance exists.

### Programme-duration reference and estimates — PASS

- Source workbook checksum re-verified read-only by this audit:
  `fc0e27a0dd320da5de75c98a2082c302e5b71af1cfa2ee734a10ceb01855f7a2`,
  mtime 3 Oct 2026 (unmodified). No code references a Downloads path (only the
  test asserting its absence).
- All 237 register IDs accounted for exactly once as blocked; artifact
  `calculationsEnabled: false`; importer requires explicit `--source`,
  `--output`, `--expected-checksum`, `--redistribution`; checksum mismatch and
  invalid flags fail without writing (26/26 importer tests pass).
- Compound `P/U` detection, numeric-conflict/legacy/derived handling, award
  caveats, route-specific review, and deterministic output are tested with
  synthetic fixtures only; no workbook content was copied into the repo.
- Estimates consume only reviewed + applicable + estimable route rules;
  `transfer_other` has no calculation without an explicit reviewed rule;
  Direct Entry uses actual-level entry year plus remaining duration
  (auditor probe: UTME 2022 + 4 = 2026; DE200 2023 + 3 = 2026).
- No universal/substring matric parser exists; the production registry is
  empty; the UNILAG prefix remains an unreviewed, disabled lead with
  synthetic-only `TST/YY/NNNN` illustrations. Year bounds (entry 1900–current,
  graduation ≤ current + 20, past years allowed, `Not sure` → null) enforced
  server-side.
- Estimates are advisory and display-only: no eligibility/reminder/marketing/
  merchant use, no expiry/revocation/scheduled job was added.

### Storage and API boundaries — PASS

- Strict allowlist input, optimistic `expectedRevision`, server-owned
  canonical/origin/basis/provenance; `GET`/`PUT /api/students/academic-profile`
  plus catalogue/estimate endpoints are all behind `authenticate` +
  `requireRole('student')`, bound to the session user with no path/body
  student ID.
- Institution-confirmed graduation year is a null-unless-approved read-only
  projection (always null; no provider added). A saved estimate is a
  student-confirmed year, never a provider observation.
- Stale revision returns 409 with reload guidance; retired references never
  silently rewrite confirmed values; explicit null/unknown is distinct from
  omitted fields.
- No academic values in merchant output, logs, or URLs (auditor grep over
  merchant/verification surfaces is clean; purge output is counts-only).
- Client discards obsolete-session results, clears drafts on session
  replacement, preserves drafts on validation/network failure; lost-response
  reconciliation reads back before retrying (unit + browser tested).

### Institution and identity lifecycle — PASS

- Direct row locks (no `lockStudentContext`), nullable binding, single-tx
  context + revision recheck; a racing institution change commits only the
  server-driven invalidation and returns `ACADEMIC_PROFILE_INSTITUTION_CHANGED`
  without persisting old-school values (integration-tested).
- Reads withhold drifted values (`scopedUnanswered`); identity-only changes
  preserve self-reported details; revocations invalidate provenance; academic
  edits never increment identity version (integration-tested).
- Superseded values are overwritten/deleted transactionally; no history store
  was introduced.

### UI, accessibility and performance — PASS

- Brand shell, mobile-first single column, one h1 per state, labelled
  controls with associated errors, async announcements without focus theft,
  keyboard-operable comboboxes, 39 ARIA/role hooks, no animations (reduced
  motion trivially satisfied), 320px viewport browser-tested.
- No PII in metadata (no metadata exports on the route); sitemap is
  public-only (verified: no student paths); reference lookup is lazy/bounded,
  nothing workbook-sized ships to the browser.
- **Noted convention:** no `noindex` metadata was added, consistent with every
  sibling private student page (auditor grep finds no `noindex`/`robots` under
  `apps/web/src/app/student/`). The spec asks for noindex on authenticated
  pages; the codebase has no such convention to follow. Recommend a follow-up
  only if the convention is adopted site-wide.

### Documentation and release boundaries — PASS

- `docs/public-trust-pages.md` + claim register updated in the same change as
  the copy; `/help` conditional section, `/trust` merchant exclusion,
  `/developers` separation, and in-app verification guidance are exact-text
  tested (11 contract tests + render tests). No manual-review, partnership,
  supported-school, or benefit claim was added.
- `/privacy`, `/terms`, `/cookies`, `/legal/*`, `/contact`, partner-journey
  copy, and OpenAPI carry explicit no-change rationales in the rollout
  record; OpenAPI already states the never-verifies / catalogue-is-not-support /
  rejected-while-disabled boundaries (parity-checked by `test:artifact`).

### Academic-data disposal activation gate — PASS (as a gate, still closed)

- Physical cascade (`ON DELETE CASCADE` on users/students, covered by
  integration test); soft-deleted accounts denied immediately
  (`deleted_at` → 404, suspended → read-only); narrow purge
  (`purgeSoftDeletedAcademicProfiles` + `academic-profile:purge` script,
  counts-only, idempotent, retry-safe) covered by 8 unit + 3 integration tests.
- Retention window unset by design: purge refuses with exit 1 and a
  counts-only message (auditor ran both unset and `0`); the same unset value
  keeps collection disabled via `isAcademicProfileCollectionEnabled`.
- No invented duration, no schedule (auditor grep: no workflow/scheduler
  references), no backup-disposal documentation, no legal-hold mechanism, no
  owner assigned — all accurately recorded as blockers in the rollout record.
  Collection stays off, correctly.

### Acceptance tests and execution order — PASS

1. Reference validation: 237/237 IDs blocked, no silent defaults, variant/
   conflict/legacy/derived rules non-calculating, deterministic output.
2. Backend TDD: missing/partial/answered/skipped, strict keys, stale
   revisions, races, nullable bindings, drift, bounded search, purge + retry.
3. Estimate TDD: UTME/DE200/DE300, unsupported country/route, missing/
   unreviewed/conflicting rules, parser suggestion + boundaries, overrides,
   staleness.
4. DB integration: no eligibility/identity/login-policy effect from any save;
   no merchant/reminder/marketing output; identity version untouched.
5. Browser: greeting + fallback, missing-fields-only, verified skip with CTA,
   answered/skipped pending skip, partial save, verification reachable
   without answers, dirty Complete-later, unsupported free text, autocomplete,
   mobile, keyboard errors, draft preservation, stale-school reconfirmation.
6. Auth/browser regression: prompt only before ordinary browse; all
   continuations uninterrupted; return-path rejection matrix; hub/verification
   returns; direct-visit fallback; cross-tab deferral incl. reload, new login,
   delayed logout, obsolete-session write, dirty form, unavailable storage,
   session switch during pending requests; no loops; save/reconcile recovery.
7. This review; merchant-boundary rejection verified for the receipt schema
   and all merchant/verification surfaces (synthetic; collection is off so no
   live academic record exists to leak).
8. Feature-off rollout first: migration `085` is additive with rollback =
   stop prompting (saved data untouched); activation blockers recorded; live
   provider tests correctly not claimed (no provider integrated).

Implementation order was followed (reference → API → estimate/lookup →
screen → prompting → docs/release); no UI was built on fabricated responses.

## State separation

| State | Status | Evidence |
| --- | --- | --- |
| Code merged | No — 6 commits on unmerged feature branch | `git log` on `feat/student-profile-completion`; no push/merge performed |
| Feature configured | OFF by default, retention unset | `env.ts` default `false`, `env.example` commented, collection gate requires positive retention |
| Provider approved | None — no provider integration added | `institutionConfirmedGraduationYear` always null; no new endpoint/permission/contract |
| Production deployed | No | Branch unmerged; no deploy step run or authorized |

## Step 2 — Full check suite (verbatim, observed by this audit)

Backend:

- `npm --prefix apps/backend test` → `tests 619, pass 619, fail 0` (exit 0)
- `npm --prefix apps/backend run test:postgres` → `tests 495, pass 494,
  fail 0, skipped 1` (exit 0). The skip is the pre-existing
  microsoft-fallback-conditional case, untouched by this feature. All 15
  academic-profile integration tests (12 store + 3 retention) pass; with
  `fail 0` overall nothing in the feature regressed.
- `npm --prefix apps/backend run type-check` → clean (exit 0)
- `npm --prefix apps/backend run test:artifact` → parity + runtime probes
  passed, 32 integration tests / 86 migrations packaged (exit 0)
- Importer (Task 1 scope, extra): `node --test
  scripts/build-academic-programme-reference.test.mjs` → 26/26 pass

Web:

- `npm --prefix apps/web run test:auth` → `tests 180, pass 180, fail 0`
- `npm --prefix apps/web run test:browser:typecheck` → clean (exit 0)
- `npm --prefix apps/web run lint` → `0 errors, 53 warnings` (exit 0); base
  `fcaa881` lints to `0 errors, 52 warnings` (auditor re-ran in a temporary
  worktree), so the feature adds exactly one warning — finding F1. The
  `verification/page.tsx:107` warning is byte-identical pre-existing code.
- `npm --prefix apps/web run build` → exit 0, `/student/profile/complete`
  prerendered
- `npm --prefix apps/web run test:browser` → run 1: `422 passed, 2 failed,
  9 skipped` (23.5m); run 2 on healthy disk: `423 passed, 1 failed,
  9 skipped` (18.4m, exit 1 solely for the single flake below). The three
  failures across both runs are three *different* timing-sensitive tests, each
  green in isolation and in the other full run:
  - run 1: `student-profile-prompt.spec.ts:284` (expired-enrollment routing)
    and `student-verification.spec.ts:176` (vendor dashboard return) — both
    pass in run 2 and in isolation (26/26 and 19/19).
  - run 2: `auth-session.spec.ts:409` (cross-tab student→vendor replacement
    race; `toHaveURL(/\/vendor\/dashboard$/)` 5s timeout) — passes 28/28 in
    isolation. The spec is byte-identical to base, never logs in (uses
    session seeding), and exercises only vendor-role routing, which bypasses
    the feature's student-only prompt branch entirely.
  - run 2 confirms all 68 feature browser tests (42 completion + 26 prompt)
    green in a full-suite run.
  - Environment note: run 1 executed under severe disk pressure (188Mi free;
    a subsequent attempt wedged on dev-server `ENOSPC` and was terminated).
    The audit freed only regenerable gitignored outputs in this worktree
    (`apps/web/.next`, `apps/backend/dist`, `test-results`) before run 2;
    no source, test, or config file was touched for this.

Count reconciliation note: the Task 3 report cites 496 postgres passes; this
audit observes 494 with `fail 0`. The delta is fully explained: Task 2's base
was 491 (including the 12 store integration tests), Task 3 added 3 retention
tests (491 + 3 = 494), and Task 3's 496 figure was measured while its
temporary 2-test scratch file still existed (since deleted, as its report
states). No test is missing: the tree holds exactly the 12 + 3
academic-profile integration tests, all passing.

## Step 3 — Feature-off state (auditor-observed)

- Focused `student-academic-profile.feature-off.test.ts` → 6/6 pass: default
  wiring returns 403 for PUT, both catalogue searches, and estimate;
  browser-supplied flags in bodies, query strings, and headers cannot enable;
  authenticated self-read stays available with `featureEnabled: false` and
  `promptDecision: 'continue'`; code and `env.example` defaults hold.
- Postgres integration `feature-off rejects writes while reads and purge
  stay available` passes against a real database.
- Purge CLI fail-closed, auditor-run: unset retention → exit 1
  (`academic profile purge refused: retention window is not set to an
  approved positive value`); `ACADEMIC_PROFILE_RETENTION_DAYS=0` → exit 1
  with the same counts-only refusal. No values, emails, or identifiers print.
- UI: with `featureEnabled: false` the completion route renders no
  collection/edit controls (browser-tested); login and verification journeys
  are unchanged (full auth/browser regression green — see Step 2).

## Step 4 — Enabled state, synthetic non-production only

The rollout gates have not passed, so collection was not enabled anywhere;
instead this audit exercised every enabled code path with synthetic fixtures
in throwaway probes (`/tmp/audit-enabled-probe/`, not committed):

- Backend probe (17/17 pass): collection-gate matrix; UTME/DE200 estimates on
  a synthetic reviewed reference; all seven unavailable reasons;
  disabled-artifact refusal; NG-only estimate scope; malformed-artifact
  fail-closed; bounded/sorted/display-only programme search with cursor
  paging; `accept_estimate` origin/basis commit; year-mismatch rejection;
  stale marking on input change; self-report basis clearing; bound-institution
  replacement rejection; empty production parser registry; exact-only
  synthetic parser matching; suggestion projection gating; retention-window
  parsing; full `computePromptDecision` matrix.
- Web probe (6/6 pass): prompt gating incl. completion self-targets and
  explicit-continuation priority; single-continuation destination resolution;
  namespaced account-bound deferral round-trip incl. mismatch clearing,
  obsolete-session write isolation, and logout scoping; fail-open navigation
  on projection-read failure with no read for non-marketplace destinations;
  malformed/eligibility-bearing projection rejection; narrow patch building.
- Enabled-path persistence is additionally covered by the committed suites:
  `unbound students save and read claimed institutions through real
  constraints`, `reviewed estimates persist calculated origin and basis end
  to end` (real Postgres), the 44 service unit tests with enabled deps, and
  the 42 + 26 completion/prompt browser specs against mocked enabled
  projections.
- No production config was changed, no live account touched, no real student
  number used anywhere (auditor scan: all matric-shaped fixtures are
  `TST/YY/NNNN` synthetics; all emails are `.test`/`.example`/`.invalid` or
  repo-owned; the only real address is the public NUC permission contact in
  the provenance note).

## Step 5 — Remaining gates and deployment evidence

No deployment evidence exists and none is authorized. Activation requires all
of the following, per the rollout record (unchanged by this review):

1. Licence/provenance clearance: exact upstream CCMAS licence variant + scope
   and written compiler permission; then re-run the importer with
   redistribution allowed and clear rows per route review.
2. Owner/legal-approved collection purpose and updated disclosure published;
   `/privacy` and related legal text need fresh review at that point.
3. A single approved positive `ACADEMIC_PROFILE_RETENTION_DAYS` with
   owner/legal sign-off, configured operationally (not merely in code).
4. Documented backup disposal within the approved schedule; named purge owner
   plus a configured, monitored schedule; first operational purge run observed.
5. This Task 7 audit green (this document, after the browser result lands).
6. Explicit owner authorization to enable, merge, and deploy — none given.

Rollback remains: stop prompting / keep the flag off; saved data is untouched
by rollback because nothing in the release deletes on disable.

## Findings

- F1 (minor, new — resolved in `bc4e7b8`, see Addendum): one net-new lint
  warning, `apps/web/src/app/student/profile/complete/page.tsx:113`
  (`setResults([])` synchronously in an effect). Restructured to render-time
  adjustment; the file lints clean and the repo total is back to the 52
  pre-existing warnings.
- F2 (report accuracy, no code impact): Task 5's "53 warnings, identical
  count on untouched base, zero new" is inaccurate — the base has 52. Task 3's
  "496" postgres figure included its since-deleted scratch file. Both are
  reconciled above; the underlying suites are green.
- Accepted deviations (audited, no action): ID-less institution catalogue
  items (safer than spec text, matches plan); parser tests under
  `tests/auth/` per repo layout; deferral persistence owned by Task 5 with
  `page.tsx`/`fixtures.ts` in its commit; server-rendered `noindex` added
  11 October 2026 (see Addendum; supersedes the earlier no-`noindex`
  deviation); feature-disabled read-only summary without a
  user erasure control (purge is ops-owned); catalogue/estimate service
  wrappers gated at the controller (no ungated HTTP path; rollout record
  notes the future-caller obligation).

## Handoff

- This review is complete: all five Task 7 steps executed, all suites observed,
  feature-off and synthetic enabled-state probes run, gates recorded.
- Do not merge or deploy. The feature branch stays unmerged with collection
  disabled; the next action is owner disposition of gates 1–4 and 6 above.
- Uncommitted collateral intentionally left alone: `.build/` and the untracked
  `docs/research/2026-10-03-institution-providers/` reference copy. The
  approved plan and design docs were committed with the owner-approval record
  (`2f833c6`); `package-lock.json` and `next-env.d.ts` test/build
  normalizations were reverted.

## Addendum — 11 October 2026 (post-audit fixes)

- F1 resolved in `bc4e7b8`: catalogue-search clearing/loading moved from the
  effect body to render-time adjustment (React's documented pattern). Checks
  actually run: eslint on `page.tsx` (clean), full `npm run lint` (52
  warnings, 0 errors — the untouched-base count), `tsc --noEmit`,
  `test:browser:typecheck`, `student-academic-profile.spec.ts` 42/42.
- Server-rendered noindex for `/student/profile/complete` in `ed70d92`: new
  server `layout.tsx` exporting `robots: { index: false, follow: false }`
  (the page is a client component, so metadata lives in the layout), plus a
  browser test asserting `meta[name="robots"]` renders `noindex, nofollow`.
  Checks actually run: new test pass; `student-academic-profile.spec.ts`
  43/43; `student-profile-prompt.spec.ts` 26/26; `test:auth` 180/180; eslint
  clean on both touched files; `tsc --noEmit`; `test:browser:typecheck`;
  `npm run build` exit 0 with the route present in the build manifest. The
  sitemap already excludes the route; root layout sets no competing robots
  tag.
- Gates 1–4 and 6 remain with the owner; no merge, deploy, or enable performed.
