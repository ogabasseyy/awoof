# Student profile completion and graduation estimates

Date: 3 October 2026
Status: owner-approved on 11 October 2026; implemented in feat/student-profile-completion with collection disabled pending activation gates; not deployed or enabled.
Revision: 10 — ninth repo-grounded review pass applied on 4 October 2026.

## Intent and approved direction

After an authenticated student account is created or signs in, ask only for missing academic-profile details. Personalize the screen with the name established through the login/account flow. Suggest a graduation year after the student chooses their programme and entry route. Do not repeatedly ask integrated-school students for information Awoof already has, or require optional details from students whose current enrollment is already verified.

The owner approved proceeding with this direction in chat. The owner then approved this written design and the implementation plan on 11 October 2026 (see Written-design review checkpoint); that approval authorized implementation. Activation gates in the rollout record still apply.

Profile completeness, school-account control and current enrollment remain independent. Completing this form, choosing a course, entering a school, or accepting an estimate must never generate positive eligibility evidence.

## Existing source and limits

Inspected checkout: `/Users/mac/.codex/worktrees/awoof-production-activation/Awoof`, branch `codex/awoof-production-activation`. The initial application-source base was `51e090f`; the first written design was committed as `71aca3f`. These are review anchors, not a claim of the current branch head. This checkout has unrelated, uncommitted provider-name and diagnostic changes. They must be preserved. A fetch on the review date returned remote main `fcaa881`; neither ref nor this design establishes what production runs. Reconcile the exact target branch before implementation.

- `apps/backend/src/controllers/student.controller.ts` exposes profile reads/updates for name, university text, registration number and phone. There are no academic course, entry-route or graduation fields in this interface.
- `apps/backend/src/routes/students.routes.ts` mounts the authenticated, student-role profile routes.
- `apps/backend/src/services/verification/student-assurance.service.ts` reads school-account and student assurance from current server evidence. An absent institution/profile projects pending, not verified.
- `apps/backend/src/services/verification/student-assurance.types.ts` separates school-account status from student status; enrollment methods are currently registration and Microsoft Graph. It has no manual-review outcome contract.
- `apps/backend/src/database/migrations/030_eligibility_authority.sql` increments identity version when name, university ID, registration number or account status changes. Routine academic-profile edits must not accidentally rewrite those identity fields.
- `apps/web/src/app/student/profile/page.tsx` is an account hub, not a completion form.
- `apps/web/src/app/auth/student/sso/onboarding/page.tsx` is pre-account SSO setup and includes a post-account recovery warning. Preserve that warning and existing continuation handling.
- `apps/web/src/contexts/AuthContext.tsx` and `apps/web/src/app/auth/student/sso/complete/page.tsx` own existing post-auth destinations.
- `apps/web/src/lib/student-return.ts` validates same-origin return destinations. Continue using it rather than adding a second redirect validator.
- `GET /auth/me` returns the student's stored name inside `data.profile`, but `apps/web/src/lib/auth-response.ts` currently validates the top-level account and does not expose that nested profile name through the browser `User` type. The greeting needs an explicitly validated source; it is not available from the current typed auth account alone.
- `apps/backend/src/controllers/university.controller.ts` lists active catalogue institutions. Catalogue membership alone does not establish approved live verification or login support.
- `apps/backend/src/controllers/verification.controller.ts` accepts registration number and a processing grant for registration verification; course, entry year and graduation year are not required by that current contract.
- `apps/backend/src/services/verification/eligibility-context.service.ts` permits protected institution changes, clearing the registration number. Academic data must not silently follow a different institution.
- Inspected retention services scrub transient challenges and diagnostics. This review did not locate an operational account-erasure handler; physical foreign-key cascades are not evidence of soft-deletion cleanup. Academic-profile erasure must be explicitly implemented and tested before activation.

## Approach

Recommended: add a resumable, authenticated academic-profile screen and a server-owned completion projection. Reuse the existing account hub, assurance reader and continuation validator. Add a separate academic-profile store, rather than extending trusted identity fields with unverifiable free text.

Alternatives considered:

1. Put every field in SSO signup: rejected because it lengthens the expiring pre-account handoff, duplicates integrated-school data and excludes password-login users.
2. Force a global completion redirect on every private route: rejected because it can block security/recovery, consent withdrawal and existing merchant continuations, and can create redirect loops.
3. Resumable post-login completion with a profile/verification CTA: selected. It nudges incomplete users without treating form completion as authorization.

## Journey and routing

Proposed new authenticated route: `/student/profile/complete`. Add a link from the existing profile hub and verification page; do not create a competing public profile route.

After the session is committed, read the completion projection once. For an ordinary login with missing optional academic details, show at most one skippable invitation before the default marketplace browse destination. Apply this automatic prompt only when there is no explicit `redirect` continuation or it resolves exactly to `/marketplace`; any other validated destination takes priority and receives no automatic interruption. This conservative rule also covers product-detail routes that might lead into a claim. Continue directly to merchant offer claims, checkout/redemption, provider handoffs, operational verification, security, recovery, link/unlink and consent-action destinations; these flows must complete before any profile nudge. In particular, missing optional details must not delay a verification method that already has its required inputs. New SSO accounts see the existing recovery warning first. After Continue, apply the same destination rule: show profile completion only when the continuation is absent or exactly `/marketplace`; otherwise preserve the requested destination and leave the profile CTA available there. Do not alter or consume any existing continuation or handoff to implement this feature.

Resolve the continuation with `resolveStudentReturn`, then apply a completion-specific exclusion in the same return-path module: the completion pathname, trailing-slash equivalent and any deeper completion path are not completion exit destinations, regardless of query/hash. Fall back to `/marketplace`. Preserve one validated destination, never recursively wrap a completion URL in another return parameter. The completion route itself does not run the automatic post-login prompt hook. Revalidate the destination on exit. Links from the profile hub and verification page carry their own fixed same-origin return paths through the existing `redirect` parameter so **Complete later** returns to the page the student came from. A direct visit without a valid continuation falls back to `/marketplace`.

Buttons:

- Primary: **Save and continue**.
- Secondary: **Complete later**. This preserves browse access and the validated continuation, without changing benefit restrictions.
- On success: **Profile saved** and the current server-derived student status. Do not say **Verification complete** unless the existing authority reader independently reports valid enrollment.

**Complete later** does not save unsaved form edits. If the form is dirty, ask whether to save, discard and continue, or stay; never silently discard typed data. Saving then leaving remains available through **Save and continue**. Defer suppresses automatic prompting across tabs for the same authenticated browser session and account; the profile/verification CTA remains available. Store only a small defer marker in `localStorage`, namespaced by the current `browserSessionId` from the authenticated session snapshot (for example, `awoof.profile.defer-prompt.v1.<browserSessionId>`) and containing the account ID. Do not store the in-memory generation counter, access/refresh tokens, form values or identity-provider responses. `browserSessionId` remains stable across reloads and tabs for the same active browser session and changes on a new login; generation still fences in-flight operations. Check the current auth snapshot before writing a marker and after the write; if the session changed, remove only the just-written key for the obsolete session. On logout/session invalidation, remove only the key for the invalidated session snapshot—never clear a shared global marker, because a delayed event from an older tab must not erase a newer session's choice. On read, use only the active session's key and clear it if its account binding mismatches. Listen for that session key's storage event in the profile-prompt code; do not treat it as an auth-session change. Stale namespaced markers from abandoned sessions may be pruned opportunistically with bounded work, but pruning must never remove the active session's key. If storage is unavailable, use an in-memory marker scoped to the current tab/session and do not create a redirect loop. A defer choice in one tab suppresses future prompts in other tabs for the same session; an already-open prompt in another tab may finish its current interaction but must not navigate away or discard dirty data automatically. Do not re-prompt a profile with supplied or explicitly skipped optional details on each login. An explicit visit always permits completing/editing academic details.

Completion/status read failure shows a retryable message. It must not fabricate a complete or verified state, erase an established session, or prevent use of account security. Do not redirect in a loop.

## Screen and copy

Heading: **Hi, {first name}**. Supporting text: **Complete your student profile** with **These details help you review your academic profile and an estimated graduation year. They do not verify your enrollment.** When an operational verification method is available, show a separate **Continue verification** link directly to that method. Use **Provide the details needed for verification** only for actual required inputs in the existing verification journey, not optional graduation questions. Source the greeting name from the validated student's stored `data.profile.name` returned by `/auth/me`; for SSO signup, this is the profile name saved from a validated provider display name. Extend the account response parser and type narrowly to expose that student profile field, preserving current account validation. Render the short first name as text, never HTML. If the profile name is absent, blank or unavailable, use **Hi there**; do not infer a name from a matric-number email address or make profile completion a route to editing the provider-owned name.

Show two separately labelled status lines when available:

- **School account:** current school-account assurance.
- **Student status:** current enrollment assurance.

For an already verified student visiting voluntarily, use **Add optional academic details** instead of implying verification is incomplete.

Field order:

1. Institution, normally prefilled and read-only when it is bound to the current school identity.
2. Programme/course, with keyboard-operable typeahead.
3. Entry year and admission route (UTME/first-year, Direct Entry 200-level, Direct Entry 300-level, transfer/other).
4. Expected graduation year, suggested when the chosen rule has sufficient evidence and inputs.

For known institutions, the country comes from the catalogue. Ask for country only when storing a user-supplied institution. Nigeria's UTME/Direct Entry terminology and NUC rules must not be applied to Ghana or another country by default. Other-country/transfer routes initially use **Other entry route** and a self-reported expected year without automatic calculation.

Course, entry year/route and expected graduation year are optional for pending and verified students alike. Permit partial saves, **Not sure**, **Skip this detail** and **Complete later** without blocking an operational verification method. Institution is required only when necessary to associate a submitted academic detail; a server-bound institution satisfies this without another question. Uncertainty and intentional skips are stored distinctly from unanswered fields, never converted to fabricated values or a positive verification result. The projection distinguishes optional unanswered fields from missing method-required verification inputs; it must not label an optional answer or **Not sure** as verification-ready. Ask for matric number and consent only in the existing operational verification flow that requires them; do not add phone, birth date, national ID or documents to this form.

## Integrated-school bypass

The server derives prompting from the current evidence and source-backed field provenance, never from a client `integrated=true` flag, a seed domain, SSO success or a stored legacy verified boolean.

- Current enrollment verified: no mandatory completion prompt. Missing programme/graduation fields are optional and cannot remove an existing benefit solely because they are absent.
- Current enrollment pending with optional details supplied or explicitly skipped: skip repeated completion, but retain pending status and show the operational next verification step, or an honest unavailable state if none exists.
- Current enrollment pending with unanswered optional details: offer a skippable invitation containing only missing fields. An available verification continuation still takes priority. Retain approved, current-context integration values as read-only.
- Enrollment expired, denied, revoked or unavailable: use the existing verification journey and truthful status. Completing a profile does not repair or override the evidence.

SSO display name, approved email mapping and Google `hd`/Microsoft tenant membership are not proof that this bypass may advertise current student verification.

An integration can suppress unnecessary prompts using current field provenance, but this design does not create a new institutional endpoint, grant Graph permissions or activate new sources. Do not claim that an existing provider supplies course or graduation data unless its approved response contract and actual validation establish that fact.

## Institution and course suggestions

Distinguish a catalogue entry, an approved login method, an operational verification method and eligibility. The authenticated institution search returns a minimal display projection (ID, label and country), not infrastructure URLs or internal configuration. Search is bounded/paginated and uses parameterized queries. A catalogue listing is not a supported-institution claim.

When the school is absent, offer **Can't find your institution? Add its name**. Save this as a claimed institution with no approved institution ID. Do not automatically insert it into `universities`, map its email domain, choose an identity provider, overwrite the authenticated `students.university_id`, or release an existing verified identity. For an account already bound to a different institution, show a separate **My institution is incorrect** support/identity-change path rather than silently switching trusted identity here.

Course typeahead initially draws from a reviewed, versioned national programme reference and clearly labels suggestions as programme names, not a confirmed list of courses offered by the selected institution. School-specific inventories take priority only when evidenced. Offer a free-text course fallback, retaining `programmeId = null`, the submitted label and user-supplied provenance.

Changing a suggestion's text must clear the selected ID. Ignore obsolete search responses when the query or authenticated session changes. Bound and normalize free text and search requests; render it safely. Suggestions need loading, empty, unavailable and unknown-entry states.

Unsupported institutions: show **We haven't enabled verification for this institution yet**. Account holders may save the profile and browse while eligibility remains governed by the existing backend. This feature does not broaden account creation, approved SSO domains, signup eligibility or login policies. A new applicant whose school cannot authenticate/register needs the existing honest unsupported-school path; broader signup is a separate design.

Do not offer **Submit for manual review** or imply an application has entered a review queue unless an approved operational workflow exists. Adding document intake, reviewer authorization, decisions, appeals and retention is outside this design. Until enabled, provide existing monitored support and a truthful unavailable/pending state, with no promised turnaround or automatic eligibility.

## Programme-duration reference and estimates

Source reviewed locally: `/Users/mac/Downloads/NUC_Programme_Durations_2026-10-02_v2.xlsx`, SHA-256 `fc0e27a0dd320da5de75c98a2082c302e5b71af1cfa2ee734a10ceb01855f7a2`. This local path is provenance for this review only; it is not an implementation input another developer or CI can assume exists.

The register has 237 Nigerian entries across 17 disciplines, 39 Education entries and 17 populated exception records. These are compilation counts, not a claim of all current national programme approvals. Cross-checking is targeted; this review is not certification of every clause.

Import preparation must address these observed issues:

- Read Me pending formulas match only exact `U`, missing compound `P/U` unresolved routes.
- Numeric fields are not sufficient authority: some conflict, legacy and derived rows retain numbers.
- Notes contain additional award/naming caveats not fully represented in the Exceptions sheet.
- Ghana Examples has only three institutional examples. Do not treat it as a Ghana national duration register.

Create stable programme/award identifiers, aliases and route-specific rules with source URL, page locator, source version, evidence classification, review status and applicability. Preserve uncertainty per route: a supported UTME duration does not approve its unresolved Direct Entry counterpart. Raw records retain original labels and exception notes. A normalized rule is selectable for calculation only after explicit review; a number or imported `G`/`P` label alone is not an approval flag.

Do not import into production directly from Excel and do not change the user's original files. Before implementation, make the reviewed source reproducibly available to the implementation team: include a permitted, versioned source artifact or a provenance-complete normalized extract plus deterministic transformation/validation tooling. Record source checksum and version in the generated artifact and CI checks. If licence terms do not permit committing source-derived content, keep it in an access-controlled approved location and provide an explicit acquisition/checksum procedure; do not make builds depend on a developer's personal Downloads folder. Produce a reviewable normalized reference with duplicate/alias, source-reference, numeric-conflict and exception checks before enabling suggestions. Confirm republication/attribution requirements from the actual source licence before redistributing source-derived data. Claims of institution-specific applicability require evidence of that institution's programme/cohort, not national minima alone.

Use full four-digit year values. First-year entry: estimated graduation year = confirmed entry year + reviewed route duration. Direct Entry: use the year the student entered at their actual level plus the reviewed remaining route duration, not an assumed first-year-equivalent matric year. Other/transfer/unknown routes have no automatic calculation unless a separate reviewed rule exists.

Matric-number year extraction is an optional school-format-specific suggestion with confidence/provenance and student confirmation. The owner's UNILAG `14` prefix example is a research lead, not an approved universal parser. Do not reverse-engineer faculty/course codes into authoritative programme selection. Store unconfirmed inference separately from accepted entry year.

Use **Estimated graduation year** and a short explanation of the selected duration. No exact graduation date is generated. Preserve an explicitly confirmed override. If course/route/year changes, invalidate stale estimates and ask for confirmation of a new suggestion; never silently overwrite an accepted override. A school-confirmed graduation year remains read-only in this form, with a correction path.

Validate integer entry years against the server's current year (1900 through current year, inclusive). Future entry is not a current-student route. A self-reported graduation year must not precede the entry year and must not exceed current year + 20. Permit a past expected year without implying present enrollment or refusing an account with legitimate delays. Invalid values receive a field error. **Not sure** remains null with an explicit uncertainty marker, never zero.

Graduation estimates are advisory. In this release, optional academic details are used only to display the student's own profile and a clearly labelled estimate. They are not used to determine, extend, deny or expire enrollment/discount eligibility; trigger reminders or marketing; or share with merchants. This release does not set eligibility expiry, revoke enrollment, grant a five-year discount programme, send new reminders or add scheduled jobs. Existing evidence freshness/expiry remains authoritative. Any later use for cohort monitoring, eligibility decisions, reminders, marketing or partner sharing requires a separately approved purpose, data-minimization and retention review, updated user disclosure/consent where required, documented enforcement and corresponding public-page updates before activation.

## Storage and API boundaries

Add an additive, authenticated academic-profile resource scoped to the logged-in student, with a strict allowlist of fields and optimistic versioning. Do not overload `PUT /students/profile` identity edits or accept another student's ID from the client.

Proposed stored fields: bound student ID, nullable server-bound canonical institution ID and observed identity version, optional user-claimed institution name/country (never a claimed canonical institution ID), programme ID or user-supplied course label, entry year, entry route/uncertainty/skip state, confirmed expected graduation year/uncertainty/skip state, graduation origin (calculated/self-reported/institution), duration-rule reference/version, server-managed source/review provenance, profile revision and update time. Each optional field has an unanswered, supplied, unknown or skipped state. Completion/prompting is derived from these fields and their current context, not a permanent boolean that bypasses future checks. User-submitted values and server-validated source observations remain distinguishable; browser input cannot set an institutional source, review outcome, or canonical binding.

### Institution and identity lifecycle

Reads and writes compare the persisted institution/identity binding with the current authenticated student context. Lock/recheck this context in the save transaction alongside optimistic profile revision, so an institution switch cannot race a save. For an active student without a canonical institution, support the nullable binding and claimed-school profile without requiring `lockStudentContext`, which currently rejects that case; authenticate and lock the active user/student independently. This does not enable new signup or verification support.

- Institution changes, including previously unbound accounts gaining a canonical institution: old course, entry-route/year and graduation values become stale and cannot satisfy the new context or remain integration-owned read-only fields. Do not carry them forward automatically. Offer explicit reconfirmation of former self-reported values; calculate/confirm any new estimate only after reconfirmation. Remove obsolete provider-owned academic values from the active projection and purge superseded academic data under the approved disposal schedule; do not introduce an indefinite history store.
- Identity version changes without an institution change: preserve self-reported academic details, but revalidate integration observations against their source binding, revocation and freshness before they remain read-only or suppress prompting. A harmless name change does not erase user-entered course data.
- Account compromise, revoked sources, expired observations or unsupported mappings: invalidate affected integration provenance. No academic field may restore revoked enrollment evidence. Show self-reported details only as self-reported and expose the existing correction/verification path.
- Academic edits themselves never change canonical identity fields or increment identity version. Context-invalid saves return a distinct reload/reconfirmation conflict without committing obsolete institution data.

Store any approved integration-provided academic data through the existing provider trust boundary, with its source reference, observation time and applicable identity/institution binding. Never accept institution provenance, approved rule status, readonly-field replacement, `studentStatus`, `eligible` or `verificationStatus` from the form.

The read response includes saved academic details, editable/read-only fields, optional unanswered-field keys, separately identified operational verification requirements, current assurance or an unavailable discriminator, reference version and prompt decision. The write commits validated data and returns the committed profile revision and recalculated academic projection. An independent post-commit assurance failure returns assurance unavailable, not a false save failure or verified status. Stale revision returns a conflict with reload guidance; invalid/deleted/retired programme references do not silently change a student's confirmed values. An explicit null/unknown is distinguishable from an omitted update field.

Separate the authenticated academic-profile search/estimate endpoints from public vendor interfaces. Do not expose course, matric-derived year or graduation data to merchants in this feature. Authentication may permit reading one's profile, never granting benefits. Reads/writes use existing authentication, student-role restrictions, rate limits and request protection. No raw OAuth claims, tokens, OTPs or academic field values in logs or URLs.

The client discards pending read/search/save results captured for an obsolete user or session generation, clears drafts on session replacement and preserves drafts after ordinary validation/network failures. No unauthenticated persistence of academic details. Commit a profile save independently of continuation success; if redirect/status refresh fails after saving, show the saved outcome and retry navigation rather than repeating verification or creating duplicate accounts. A lost write response is an unknown outcome: read back the current revision/values in the same session before retrying. If the intended values are present, acknowledge the saved state; if a conflicting edit exists, offer reload/reconciliation rather than silently overwriting it or blindly resubmitting the old revision.

## UI, accessibility and performance

Reuse the approved Awoof brand shell and logo with preserved aspect ratio. Mobile-first single-column form, clear progress within this screen, no ornamental claim of verified status. One h1 with field groups below; visible labels and errors associated to controls. Announce asynchronous suggestions and save outcomes without stealing focus.

Comboboxes support arrows, Enter, Escape and ordinary typing; selected IDs track the actual chosen option. Free-text fallbacks stay accessible. Provide sufficient contrast, visible focus, touch targets and no horizontal scrolling at 320px. Respect reduced motion. Keep screen-reader status text independent of decorative icons.

Authenticated completion pages are noindex and excluded from sitemap. No PII in metadata or structured data. Lazy/bounded reference lookup rather than shipping an entire workbook or large programme dataset in the auth bundle. Reserve layout space for suggestions/errors; check production-route loading, layout stability and responsive screenshots with synthetic data.

## Documentation and release boundaries

During implementation, update `docs/public-trust-pages.md`, the claim register, `/help` and verification guidance with truthful profile/estimate/unsupported-school behaviour. Assess `/trust`, `/privacy`, `/developers`, `apps/web/src/content/public/partners.ts` and OpenAPI in the same PR, providing a precise no-change rationale where applicable.

New entry/course/graduation fields change personal-data collection and purpose. Owner and appropriate legal review must approve updated disclosure before production activation. Public copy must not advertise manual review, new institutions, university partnerships or benefits unlocked by completing this form.

### Academic-data disposal activation gate

The implementation plan must identify the actual authorized account-erasure mechanism and approved retention schedule; neither is established by foreign-key declarations or existing challenge cleanup. If no operational mechanism exists, implement a narrow, authorized academic-data purge path before activating collection, with documented operational ownership and failure/retry handling. Do not silently expand this feature into a general account-deletion subsystem or claim one already exists.

Physical deletion must cascade to academic profiles and observations. Soft-deleted accounts must be denied academic access immediately and their academic data purged through the approved erasure process; updating `users.deleted_at` alone is insufficient. The same process must cover superseded institution-bound values and any new academic-data child/search/materialized stores. Record only minimal erasure audit metadata, not deleted field values. Legal-hold exceptions require an actual authorized, restricted retention mechanism and reviewed disclosure; absent such a requirement, do not create an exception by default. Document backup disposal handling within the approved account schedule without claiming immediate backup erasure. Do not invent a public fixed retention period. Collection stays feature-off until disposal coverage and its disclosures are verified.

Internal design-only publication requires no public route change now: this document makes no claim that the proposed API, screen, importer or bypass is shipped. Implementation, reviewed reference, institutional activation, live provider checks and deployment must be reported separately. No production configuration, provider policy, university domain, merchant pricing or deployment change is authorized by this design stage.

## Acceptance tests and execution order

1. Reference validation before importer: all 237 source IDs accounted for; no silent zero/defaults; unresolved/variant/conflict/legacy/derived rules cannot calculate until explicitly reviewed for the selected route; Education discipline rule confirmed; awards/aliases and route-specific exceptions preserved.
2. TDD backend: missing/partial/answered/skipped profiles; uncertain values never implying verification readiness; trusted-data read-only controls; unrelated-student access rejection; strict extra-key rejection; stale revisions; institution/identity changes and save races; nullable canonical bindings; rule-version drift; bounded searches; physical and soft-deletion purge, child-store cleanup and purge retries.
3. TDD estimates: UTME, DE200, DE300, unsupported country, missing rule, matric-year suggestion, past/future boundaries, user override, course/route changes and unknown values.
4. Database integration: saving every form field cannot create eligibility evidence, change institution login policy, overwrite trusted name/university/registration, remove an authoritative denial, or allow any student benefit. Academic values cannot drive eligibility, expiry, marketing, reminders or merchant data output in this release. Academic edits do not increment identity version. Identity correction uses the existing separate protected flow.
5. Browser: validated `/auth/me` profile-name greeting for known-name and **Hi there** fallback when name is missing/blank/unavailable; only missing fields; integrated verified skip with optional-details CTA; answered/skipped-but-pending skip without verified copy; partial save; operational registration verification reachable with no course/graduation answers; dirty-form **Complete later** confirmation; unsupported free text with no fake review queue; accessible autocomplete; mobile layout; keyboard errors; draft preserved on network failure; stale-school values require reconfirmation.
6. Auth/browser regression: password login, SSO re-login, new SSO signup plus existing recovery warning, link/unlink, recovery and merchant continuation; automatic profile prompt appears only before ordinary browse and never interrupts merchant claim/checkout/redemption, provider handoff, verification, security, recovery, link/unlink or consent-action continuations; safe return path; completion self-target, trailing slash, deeper path, query/hash and recursive return rejection; profile-hub and verification-page return destinations; direct-visit fallback; defer choice is shared across tabs for the same account/session, survives reload within that session, and is cleared on logout/new login/account switch; an old session's delayed logout/cleanup cannot remove a newer session's marker; a session switch during marker write removes only the obsolete session key; concurrent tab prompt and dirty-form behavior; unavailable storage; session switch during all pending requests; no auth/completion loop; committed-save assurance/redirect failure and lost-response reconciliation without account duplication or overwriting concurrent edits.
7. Independent review of implementation and its authority boundaries; updated public/API documentation and required approvals; synthetic merchant-boundary rejection for pending, denied and expired users.
8. Feature-off rollout first. Review exact current target branch, migration compatibility and rollback (stop prompting without undoing saved data). Activate only after tests, approved collection disclosures and demonstrated academic-data disposal coverage. Live provider/institution tests need consenting accounts and an operational approved source; synthetic integration fixtures are not proof of a live university connection.

Implementation order: reviewed reference and additive academic-profile API, then estimate/lookup contracts, then the screen, then post-auth prompting and integrated-source bypass, then documentation/release validation. Do not implement the UI with fabricated API/profile responses and call it wired.

## Written-design review checkpoint

Approval record: on 11 October 2026 the owner approved this written design and the implementation plan at `docs/superpowers/plans/2026-10-04-student-profile-completion.md`, and authorized handoff to implementation. Execution method: sequential subagent-driven implementation (one worker per plan task, Tasks 1–7 in order) on branch `feat/student-profile-completion` based on `origin/main`. Earlier approval of the general direction was not approval of these artifacts; this record supersedes the pending-review checkpoint. Implementation is complete with collection disabled; the activation gates in the rollout record still apply.
