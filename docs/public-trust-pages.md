# Public trust and partner pages

Research/repository review: 2026-09-20, inventory refreshed 2026-09-24. Status: first-batch pages shipped; legal release v1.0 remains published. Owner-authorized v1.1 Terms/privacy source updates are pending merge and deployment (see below). This file is internal planning, not public security assurance.

## Published release v1.0; owner-authorized source update v1.1 pending rollout

The owner reported lawyer approval of the five-document package and authorized its publication ([authorization record](legal-publication-approval.md)). The live published package remains v1.0 until this branch merges and deploys. This source update prepares v1.1 Terms and privacy text under the owner's 18+ student-account authorization. After rollout, routes remain indexed (`index, follow`), linked from the public footer, auth navigation and sitemap:

| Route | Published purpose | Standing condition |
| --- | --- | --- |
| `/legal` | Reader-facing legal directory | Version 1.0; no internal review notes |
| `/privacy` | Privacy notice: purposes, lawful bases, recipients, automated decisions, rights | v1.0 published; proposed v1.1 discloses the self-declared age field and server-recorded acceptance |
| `/terms` | Student/website terms, checkout responsibilities, IP, restrictions, liability and disputes | v1.0 published; proposed v1.1 requires self-declared age 18+ and acceptance for student signup |
| `/terms/v1-0` | Frozen public archive of the version 1.0 student/website terms | Byte-identical to the v1.0 release; linked from `/terms` and `/legal`, in sitemap |
| `/privacy/v1-0` | Frozen public archive of the version 1.0 privacy notice | Byte-identical to the v1.0 release; linked from `/privacy` and `/legal`, in sitemap |
| `/cookies` | Cookies/browser-storage notice | Version 1.0 |
| `/legal/merchant-terms` | Business terms requiring an accepted order form/payment schedule | Terms alone execute no agreement |
| `/legal/data-protection` | Controller-sharing/processor modules and integration annex | Personal-data exchange requires completed annexes |

[Counsel handoff](legal-review-handoff.md) records research, source evidence, candidate retention periods, commercial choices and deployment/operational gaps. Publication does not execute merchant agreements, create historical terms acceptance, or represent new operational controls. Existing historical inventory below remains background.

### Historical note (superseded 23 September 2026)

Before owner authorization, the same routes existed as draft/noindex review copies excluded from the footer and sitemap: `/legal` as a counsel reading guide, `/privacy` and `/terms` as candidate notices, `/cookies` pending a production inventory, and the merchant/data-protection pages as proposed modules. The draft-only guidance is retained in git history and in the superseded sections of [legal-policy-review.md](legal-policy-review.md); do not follow it for the published routes.

## Repository evidence

The read-only inventory checked the working tree and origin/main at 4e47ea0. The local branch is divergent; implementation should start from a fresh isolated origin/main worktree, preserving existing work.

Shipped since the first review: `/trust`, `/help`, `/contact`, `/partner`, and `/developers` now have matching page routes, and the six legal routes are published as approved release v1.0 (indexed, footer/sitemap/auth-navigation linked) per the publication record above; do not use them as Microsoft consent links. Relevant entry points are the public footer, `apps/web/src/app/sitemap.ts`, homepage FAQ components, and the authenticated vendor integration/support journeys.

The broken links are specifically in the inline footer in `apps/web/src/app/marketplace/page.tsx`; the homepage has a separate Footer component. The root layout does not mount shared public navigation, so provide an explicit reusable public shell. Homepage social links use `#` and should not be presented as real destinations.

Existing authenticated support routes are `/student/profile/support` and `/vendor/support`. Their code references `support@awoof.tech`; the owner confirmed on 2026-09-23 that this inbox is monitored for privacy/legal requests, so `/contact` now includes it. The displayed `+2348000000000` is an apparent placeholder and must not be copied into the contact page. Current main has already removed the stale local `/docs/widget` link; do not repeat that fix against the old checkout.

## Competitor evidence and implications

These sources inform information architecture only. Do not copy their claims, policy terms or capability promises into Awoof.

| Primary source | Observed page purpose | Implication for Awoof |
| --- | --- | --- |
| [SheerID privacy overview](https://www.sheerid.com/privacy-overview/) | Plain-language data use and security explanation, separate from full policy | `/trust` should explain data flow and verified controls without certification claims |
| [SheerID developer center](https://developer.sheerid.com/) | Quickstart, integration concepts and API reference | Provide an integration entry point grounded in Awoof's actual endpoints |
| [UNiDAYS support](https://www.myunidays.com/US/en-US/support) | Verification, unsupported institutions, account and OTP troubleshooting | Explain pending status, unavailable schools and recovery in public help |
| [UNiDAYS identity privacy](https://www.myunidays.com/US/en-US/content/identity-privacy-policy) | Verification-specific privacy notice | Awoof's policy must cover verification and merchant sharing, not just shopping |
| [Student Beans help](https://help.studentbeans.com/hc/en-us) | Searchable student account/verification help | Reuse existing FAQ material, correct unsupported claims and link actual support |
| [Pion partner site](https://www.wearepion.com/) | Business proposition, integration guides and partner contact; Student Beans partner URL redirects here | Separate student help from partner onboarding and technical integration |
| [ID.me security](https://www.id.me/security) | Security explanation plus privacy, accessibility and rights links | Add accessible trust information and real contact paths; do not imitate its accreditation claims |

Varsity Vibe's homepage returned only a JavaScript shell to this research tool; its page inventory is unverified and is not used as evidence of missing/present pages.

## Proposed implementation scope

Use existing Awoof visual tokens, public header/footer and an accessible editorial layout. Prefer server-rendered information pages with metadata, readable line lengths, section navigation and mobile-friendly spacing. Do not add a CMS, tracking scripts or a new design system for this work.

### First batch: foundational public pages

- `/trust`: understandable verification/data-flow explanation, evidence-backed controls, limits and links to privacy/help. Explain school-account versus enrollment as the product direction, but do not describe planned enforcement or SSO as currently deployed. Public wording must match the release it ships with.
- `/help`: verification explanations and FAQ, missing OTP, pending/expired status, unsupported schools, consent and account recovery; link existing working flows. No manual-upload or instant-verification promise when absent.
- `/contact`: working student/vendor support destinations and the owner-confirmed `support@awoof.tech` privacy/legal contact. Do not invent another inbox, form delivery, phone number or response time.
- `/partner`: merchant journey and a university section explaining institutional cooperation. Merchant remains responsible for applying benefits; distinguish available integration from planned APIs. Reuse this existing footer destination rather than introducing redundant `/merchants` and `/universities` pages immediately.

### Required content with publication dependencies

- `/privacy` and `/terms`: published as approved release v1.0 (indexed, footer/sitemap/auth-navigation linked) after owner-reported lawyer approval — see `docs/legal-publication-approval.md`. They must not be used as Microsoft consent links. Remaining operating work (retention schedule, provider inventory verification, Azure branding URLs) is tracked in `docs/legal-policy-review.md` and the counsel handoff; future text changes need fresh review and sign-off before becoming effective.
- `/developers`: add after validating actual public API contracts, authentication, failure modes and merchant examples against source/tests. Link the authenticated integration screen appropriately. Never publish private keys, guessed endpoints or planned interfaces as live.
- Security reporting: include a `/trust` section once a monitored reporting channel is confirmed. A separate disclosure policy or security.txt requires approved contact/expiry and policy details; no invented bug bounty or safe-harbor commitments.
- Accessibility information: add a short help/contact section for reporting access barriers; a formal conformance statement requires an audit.

### Defer until backed by operations

- Live status page: only with monitoring/incident data; no static “all systems operational”.
- Supported-institutions directory: only with approved runtime capabilities; an email-domain seed list is not live integration coverage.
- Certifications, audit reports, subprocessors, DPA and case studies: publish only accurate approved material with the necessary operational/legal evidence. Do not invent them for marketing completeness.

## Agent handoff and acceptance (completed September 2026 — historical)

The page-set implementation this section planned is finished and shipped (see the publication record above); do not re-assign ownership or restart pre-coding work from these instructions.

Historical instructions, retained for context: after approval of the page set, assign one frontend agent ownership of the approved public page routes, reusable public-page component, footer/sitemap updates and focused tests. The coordinator owns AGENTS.md, this inventory, source-backed claim review and legal/operational blockers. Agents must preserve others' changes and follow applicable skills and isolated-worktree instructions.

Before coding, inspect fresh main and record the exact paths to avoid conflicting routes. Before completion, test route rendering, internal links, metadata, public versus authenticated navigation, keyboard access, heading order and mobile layout. Report local checks separately from deployed checks. No deployment is implied by this document.

## Claim register template

Every material public security or operational claim must have a filled record before publication:

| Claim | Public destination | Source/config/test evidence | Deployment/operational evidence | Responsible owner | Review date | Publish decision |
| --- | --- | --- | --- | --- | --- | --- |
| Mailbox check and enrollment check are separate; status names which passed | `/trust`, `/help`, `/` | merchant-verification swagger `assuranceMethod: student_email \| enrollment`; `public-information.spec.ts`, `public-home.spec.ts` | Pending — deploy/canary/partner gates NOT RUN (cutover runbook) | Design swarm; needs product owner | 2026-09-21 | Implemented design; publish pending deployment evidence |
| Merchants get an eligibility answer + merchant-scoped pseudonym, not documents/email/account IDs | `/trust` | `MerchantVerificationReceipt` schema in `merchant-verification.routes.ts` (merchantSubject “not an Awoof user ID”) | Pending — deploy/canary/partner gates NOT RUN (cutover runbook) | Design swarm; needs product owner | 2026-09-21 | Implemented design; publish pending deployment evidence |
| Assertion codes are short-lived (minutes); server keys never belong in browsers | `/trust` | Same swagger: code lifetime ≤2 min; `merchantServerKey` “Never send this key to a browser” | Pending — deploy/canary/partner gates NOT RUN (cutover runbook) | Design swarm; needs product owner | 2026-09-21 | Implemented design; publish pending deployment evidence |
| Withdrawing consent stops future checks; issued receipts stand as history | `/trust`, `/help` | Exchange endpoint docs (idempotency/consent-withdrawal comment) | Pending — deploy/canary/partner gates NOT RUN (cutover runbook) | Design swarm; needs product owner | 2026-09-21 | Implemented design; publish pending deployment evidence |
| Student accounts are free; merchants set their own offer terms | `/`, `/help` | Registration has no payment step (`auth/student/register`); vendor offer config in vendor deals pages | Pending — deploy/canary/partner gates NOT RUN (cutover runbook) | Design swarm; needs product owner | 2026-09-21 | Implemented design; publish pending deployment evidence |
| Account-specific support happens in-app; privacy/legal requests can use a public inbox | `/contact` | Support routes `/student/profile/support`, `/vendor/support` exist; owner confirmed `support@awoof.tech` is monitored on 2026-09-23; `+2348000000000` remains a placeholder and is omitted | Pending — contact change not deployed | Support owner | 2026-09-23 | Implemented; publish pending deployment evidence |
| Privacy / terms / storage / partner terms | `/privacy`, `/terms`, `/cookies`, `/legal`, `/legal/merchant-terms`, `/legal/data-protection` | Legal content modules; `docs/legal-publication-approval.md`; source evidence in counsel handoff | v1.0 publication authorized; v1.1 rollout explicitly directed by business owner as an exception to the prior counsel-review hold, independent legal review unconfirmed, merge/deploy pending. Partner agreements still require execution and annexes. | Business owner; counsel approval reported for v1.0 only | 2026-09-24 | Source candidate v1.1; not a representation of deployed behavior or new operational controls |
| Student accounts require an affirmative 18+ self-declaration; age is not independently verified | `/terms`, `/privacy` | Signup controller/service reject missing or false `ageAttested`; migration 068 stores it with Terms version and server `accepted_at`; `student-signup.service.test.ts`, `student-signup.integration.ts`, browser signup suite | Pending merge/deploy and rendered-page checks; provider-based new-account journeys reuse password signup, real-provider acceptance not run | Owner | 2026-09-24 | Source/tests only; declaration is not verified-age evidence |
| Privacy notice security controls: access controls, password hashing, verification-request checks | `/privacy` | `middleware/auth.middleware.ts` (`authenticate`, `requireRole`) on admin/vendor/student routes + stale-JWT tests; `password.service.ts` bcrypt hash (`$2` asserted in `student-signup.integration.ts`); `challenge.service.ts` guess/send budgets + route quotas with HTTP/postgres coverage | Pending — deploy/canary/partner gates NOT RUN (cutover runbook) | Design swarm; needs product owner | 2026-09-23 | Implemented; publish pending deployment evidence |
| Merchant flow: assertions (student JWT) → server exchange (server key) → receipt; errors 401/409/429 | `/developers`, `/partner` | `merchant-verification.routes.ts` routes + zod schemas + swagger; `public-partner.spec.ts` | Pending — deploy/canary/partner gates NOT RUN (cutover runbook) | Design swarm; needs product owner | 2026-09-21 | Implemented design; publish pending deployment evidence |
| Browser widget verification is unavailable by default; server API is the supported path | `/partner`, `/developers` | `/widget/verify` shows the unavailable notice unless the pilot flag and vendor allowlist are set; widget backend exposes `domain-check` and pilot-gated `merchant-context`; `pilot-assertions` additionally requires a synthetic-student allowlist | Pending — controlled pilot source/test only; deploy/canary/partner gates NOT RUN | Design swarm; needs product owner | 2026-09-25 | Default unavailable; pilot activation pending deployment evidence |
| No merchant partnerships, SLAs, pricing, or case studies claimed | `/partner` | Copy review; spec asserts absence of guarantee/case-study language | n/a (omission) | Design swarm | 2026-09-21 | Implemented design (omission); publish pending deployment evidence |
| Server keys are backend-only; status overview states derive from `/verification/status` eligibility | `/vendor/integration`, `/student/verification`, `/student/profile` | `merchantServerKey` swagger desc; eligibility-gated UI already in code; `student/merchant-design-regressions.spec.ts` | Pending — deploy/canary/partner gates NOT RUN (cutover runbook) | Design swarm; needs product owner | 2026-09-21 | Implemented design; publish pending deployment evidence |
| Redeemed checkout IDs stay permanently bound (never reusable); abandoned checkouts reusable after 7-day retention | `/partner`, `/developers` | claim-sessions swagger retention note; `partners.ts` §4 copy; `tombstoneExpiredClaimSessions` + `product-claim.integration.ts` retention test | Pending — deploy/canary/partner gates NOT RUN (cutover runbook) | Design swarm; needs product owner | 2026-09-23 | Implemented design; publish pending deployment evidence |

Missing evidence means omit/narrow the claim or label it as planned, never treat the empty register as a passed review. Future PRs must update the register and affected pages or explain why no changes are necessary, as required by AGENTS.md.

## Controlled widget pilot impact (source branch, 2026-09-25)

The source-only pilot in [merchant-widget-pilot.md](merchant-widget-pilot.md) adds a gated `/widget/verify` popup journey and `POST /api/widget/merchant-context` plus `POST /api/merchant-verification/pilot-assertions`. The route already existed as an unavailable notice; no competing public page was added. When flags are unset, the unavailable notice remains. When enabled in an isolated sandbox for allowlisted synthetic students and merchants, it shows the registered merchant and purpose, links to sign-in and verification status, asks for explicit disclosure, and returns only an opaque code to the initiating merchant origin. Source references: `apps/web/src/app/widget/verify/{page,HostedPilot}.tsx`, `apps/widget/src/widget.js`, `apps/backend/src/controllers/widget.controller.ts`, `apps/backend/src/routes/merchant-verification.routes.ts`. Deployment and live-provider evidence: **none**; activation pending.

Documentation impact checklist for this PR:

1. **User-visible behavior/pages:** controlled popup and merchant integration only. `/partner`, `/developers`, `/trust`, `/help`, `/privacy`, and the vendor integration screen retain their existing public/live positioning. Their copy must not imply that the gated widget is generally available; no new legal or data-sharing commitment is published.
2. **Updated documentation:** the internal integration and Ogabassey handoff document above, `/developers`, vendor payment/integration guidance, and this route inventory; the widget example no longer describes a modal or legacy token. Public copy still requires review before any real rollout is authorized and evidenced.
3. **Claim evidence:** the code paths above and focused tests are source/test evidence only. The pilot flags and synthetic IDs must be explicitly configured; no current-enrollment provider, merchant acceptance, or production activation is established here.
4. **Links, labels, accessibility:** hosted journey links to existing `/trust`, `/privacy`, `/help`, student sign-in, and verification-status pages; it uses one h1, a request h2, labelled checkbox, button disabled during submission, error/status regions, responsive widths, and popup rather than an embedded third-party frame. Browser checks still required before activation.
5. **Outstanding checks/approvals:** real current-enrollment evidence and revocation, legal/data-sharing approval for live use, monitored support, merchant backend checkout binding, synthetic end-to-end sandbox exchange, and deployment review. No live discounts are enabled by this PR.

## Developer guide update for controlled pilot (source branch, 2026-09-25)

The existing `/developers` route now includes a clearly labelled, synthetic-account-only hosted-widget quickstart, a public-site-key versus private-server-key boundary, the merchant's own checkout handoff, server exchange request, receipt fields, error handling, and explicit default-disabled/live-enrollment limitations. No new public route or merchant availability claim was added. Source evidence: `apps/web/src/app/developers/page.tsx`, `apps/web/src/content/public/partners.ts`, `apps/widget/src/widget.js`, `apps/backend/src/routes/merchant-verification.routes.ts`, and `docs/merchant-widget-pilot.md`. Swagger `/api-docs` remains development-only in `apps/backend/src/index.ts`. Deployment/partner activation evidence: **none**. Product owner review is pending before public rollout.

Documentation-impact checklist: (1) `/developers` is the affected public page; `/partner`, `/trust`, `/help`, and privacy need no copy change because no behavior or legal commitment was added there. Vendor payment and integration guidance are updated below to remove stale installation instructions. (2) The page and this inventory were updated in the same PR, with the internal pilot brief reconciled. (3) Added claims are limited to source contracts and synthetic local tests; live enrollment and merchant activation remain pending. (4) The guide uses existing trust/privacy/vendor links, one page h1, ordered headings, labelled code blocks, table headers, keyboard-focusable examples, and mobile overflow controls; browser rendering checks are required before completion. (5) Owner/legal review for live data sharing, provider evidence, merchant onboarding, and deployment remain outstanding. Do not make the pilot guide a production-installation promise.

## Review-feedback documentation correction (source branch, 2026-09-25)

The public `/developers` pilot guide now states the required opener-policy pairing and server-authoritative expiry check. The vendor payment screen no longer offers a stale script URL or a callback that treats an opaque code as a discount; its integration card links to `/developers` and `/vendor/integration`. The vendor integration screen labels the widget as unavailable for general installation and names the controlled popup's COOP requirement. The claim-register row above reflects the default unavailable state and the two gated routes. OpenAPI source annotations now cover `merchant-context` and the pilot assertion request and response. These are source/test corrections only, with no deployment or merchant activation evidence. Before pilot activation, inspect the effective merchant and hosted response headers and complete a real synthetic popup return and server exchange.
