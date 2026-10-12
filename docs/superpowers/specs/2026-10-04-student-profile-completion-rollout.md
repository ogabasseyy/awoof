# Student profile completion — feature-rollout record

Date: 10 October 2026
Worktree branch: `feat/student-profile-completion`
Design: `docs/superpowers/specs/2026-10-03-student-profile-completion-design.md` (Revision 10, unchanged by this record)
Plan: `docs/superpowers/plans/2026-10-04-student-profile-completion.md`, Task 6

This record holds the Task 6 release-gate evidence and the collection
decision. It does not modify the approved design.

## Decision: collection stays OFF

`ACADEMIC_PROFILE_ENABLED` remains `false` by default in
`apps/backend/src/config/env.ts`, and `ACADEMIC_PROFILE_RETENTION_DAYS`
remains unset (`apps/backend/env.example` documents both as commented
defaults). No configuration change in this task enables collection.
Five of the seven gates below lack full evidence; the exact blockers
are named per gate.

## Release gates

| Gate | Verdict | Evidence / exact blocker |
| --- | --- | --- |
| Verified source / licence / provenance | BLOCKED | `docs/research/nuc-programme-reference-provenance.md` records blocked disposition: the workbook carries no licence statement, the upstream CCMAS licence variant is unconfirmed, all 237 register rows are blocked, and the runtime artifact has `calculationsEnabled: false`. Blocker: record the exact upstream licence variant and scope plus written compiler permission before any row is cleared for calculation. |
| Legal-approved collection purpose / disclosure | OPEN | New entry/course/graduation fields change personal-data collection and purpose. `apps/web/src/content/public/privacy-draft.ts` contains no academic-profile purpose (0 matches for academic/graduation/programme), and no legal review record approves one. Blocker: owner and legal review must approve the updated disclosure before activation; public copy in this task claims no new purpose. |
| Approved retention schedule | OPEN | No owner/legal-approved retention period exists. `ACADEMIC_PROFILE_RETENTION_DAYS` is unset by design, which keeps collection disabled via `isAcademicProfileCollectionEnabled` and makes `cleanup-academic-profile-data.ts` refuse to run. Blocker: a single approved positive day value with owner/legal sign-off. No duration is invented here. |
| Physical / soft-delete and backup handling | PARTIAL | Physical cascade and the narrow soft-deleted purge path are implemented and covered by unit plus disposable-Postgres integration tests (Tasks 2–3). Backup disposal handling is undocumented (0 mentions in the retention service and purge script) and there is no authorized legal-hold mechanism. Blocker: documented backup disposal within the approved schedule; soft-delete purge remains unrunnable until the retention gate passes. |
| Operational owner and scheduled purge invocation | OPEN | The purge command exists as the `academic-profile:purge` (source checkout) and `academic-profile:purge:prod` (built artifact, `dist/scripts/cleanup-academic-profile-data.js`) npm scripts with a DO-NOT-RUN header; no operational owner is assigned, no schedule is configured (no workflow or scheduler references the command), and it has never run operationally. Blocker: named owner plus a configured, monitored schedule. |
| Claim register evidence | DONE (this task) | New rows added to the claim register in `docs/public-trust-pages.md`; public copy is enforced by `apps/web/tests/auth/public-academic-profile-claims.test.ts` (11 tests) and a `public-information.spec.ts` render test. Publication of collection itself is not claimed. |
| Accessibility / link review | DONE (this task) | New copy reuses the existing public-page shell (one h1, section headings, existing footer/sitemap links; no new public routes). The new authenticated `/student/profile/complete` route is recorded in the claim register with disabled availability. `public-information.spec.ts` renders `/help`, `/trust`, and `/developers` with the new copy; `test:browser:typecheck`, `lint`, and `build` results are recorded in Step 5. |

## Feature-off verification (Step 3)

No behavior change was required: the collection gate already holds at
every HTTP entry point, and this task locks it with
`apps/backend/src/routes/student-academic-profile.feature-off.test.ts`
(6 tests, all passing):

- Default wiring returns 403 for `PUT /api/students/academic-profile`,
  both catalogue searches, and `POST .../estimate`.
- Browser-supplied flags (`featureEnabled`, `enabled`,
  `ACADEMIC_PROFILE_ENABLED`, `collectionEnabled` in bodies, query
  strings, and headers) cannot enable writes, search, or estimate.
- Authenticated self-read stays available while disabled and reports
  `featureEnabled: false` with `promptDecision: 'continue'`.
- Code default (`env.ts`) and `env.example` keep collection off and
  retention unset.

Residual observation (not a gate): the catalogue/estimate service
wrappers rely on the controller's `requireCollection` check; there is
no HTTP path that reaches them ungated, and the new tests prove the
HTTP property. A future direct service caller must preserve the gate.

## Assessed surfaces and no-change rationales

- `/help` — CHANGED: new "Optional academic details" section. Copy is
  conditional ("If your account is offered…") so it claims no live
  availability while collection is off.
- In-app verification guidance (`/student/verification`) — CHANGED: one
  guidance sentence next to the optional-profile link. No flow change.
- `/developers` + `/partner` (`partners.ts`) — CHANGED: one separation
  line excluding academic answers from receipts and merchant
  integration. No endpoint, key, or pilot change.
- `/trust` — CHANGED: one sentence in "What merchants learn" excluding
  academic answers. No security claim added.
- `/privacy`, `/terms`, `/cookies`, `/legal/*` — NO COPY CHANGE NOW,
  DISCLOSURE OWED AT ACTIVATION: owner-approved legal text, so no
  legal wording changes in this task. The task does add one dormant
  browser-storage purpose — the session-namespaced prompt-deferral
  marker in `localStorage` (`writeDeferral` in
  `apps/web/src/lib/student-profile-prompt.ts`), holding the
  session's own account ID only, never transmitted, removed on
  session change. It cannot write in the shipped configuration:
  the server forces `promptDecision: 'continue'` while collection
  is disabled (`academic-profile.service.ts`), and Complete-later
  clicks while disabled or read-only skip the write
  (`writeCompleteLaterDeferral` returns unless both `featureEnabled`
  and `writeAvailable`; navigation still proceeds). Before
  activation, owner/legal review
  must approve and publish the `/cookies` (and `/privacy`, if
  counsel requires) deferral-purpose disclosure; tracked under
  activation precondition 2. Any future purpose/retention change
  needs fresh legal/owner review.
- `/contact`, `/partner` journey copy — NO CHANGE: support
  destinations, merchant/partner onboarding, and offer mechanics are
  untouched by this feature.
- Backend OpenAPI — NO CHANGE: the academic-profile paths already
  state that completing the profile never verifies enrollment or
  changes eligibility, that catalogue membership is not a
  supported-institution claim, and that writes/search/estimate are
  rejected while collection is disabled. Verified by
  `test:artifact` (OpenAPI parity) in Step 5.

## Activation preconditions (all must hold)

1. Licence/provenance clearance recorded; reviewed rows cleared.
2. Owner/legal-approved collection disclosure published, including
   the prompt-deferral browser-storage purpose.
3. Approved retention value configured with owner/legal sign-off.
4. Backup disposal documented; purge owner and schedule operational.
5. Full Task 7 audit green, including enabled-state checks in a
   synthetic non-production environment.
6. Explicit owner authorization to enable; no merge or deploy is
   authorized by this record.
