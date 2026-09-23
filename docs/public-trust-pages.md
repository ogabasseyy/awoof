# Public trust and partner pages

Research/repository review: 2026-09-20, inventory refreshed 2026-09-23. Status: first-batch pages shipped; legal policies published as approved release v1.0 (see below). This file is internal planning, not public security assurance.

## Legal publication — approved release v1.0, 23 September 2026 (current)

The owner reported lawyer approval of the five-document package and authorized publication ([authorization record](legal-publication-approval.md)). Release v1.0 publishes these routes indexed (`index, follow`), linked from the public footer, auth navigation and sitemap:

| Route | Published purpose | Standing condition |
| --- | --- | --- |
| `/legal` | Reader-facing legal directory | Version 1.0; no internal review notes |
| `/privacy` | Privacy notice: purposes, lawful bases, recipients, automated decisions, rights | Version 1.0; storage inventory per `/cookies` |
| `/terms` | Student/website terms, checkout responsibilities, IP, restrictions, liability and disputes | Version 1.0; acceptance captured at registration |
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
| Privacy / terms / storage / partner terms | `/privacy`, `/terms`, `/cookies`, `/legal`, `/legal/merchant-terms`, `/legal/data-protection` | Legal content modules; `docs/legal-publication-approval.md`; source evidence in counsel handoff | Owner authorized publication; deploy verification pending. Partner agreements still require execution and annexes. | Owner, reporting counsel approval | 2026-09-23 | Approved release v1.0; not a representation of new operational controls |
| Merchant flow: assertions (student JWT) → server exchange (server key) → receipt; errors 401/409/429 | `/developers`, `/partner` | `merchant-verification.routes.ts` routes + zod schemas + swagger; `public-partner.spec.ts` | Pending — deploy/canary/partner gates NOT RUN (cutover runbook) | Design swarm; needs product owner | 2026-09-21 | Implemented design; publish pending deployment evidence |
| Browser widget verification is unavailable; server API is the supported path | `/partner` | `/widget/verify` page copy (“being replaced”); widget backend exposes only `domain-check` | Pending — deploy/canary/partner gates NOT RUN (cutover runbook) | Design swarm; needs product owner | 2026-09-21 | Implemented design; publish pending deployment evidence |
| No merchant partnerships, SLAs, pricing, or case studies claimed | `/partner` | Copy review; spec asserts absence of guarantee/case-study language | n/a (omission) | Design swarm | 2026-09-21 | Implemented design (omission); publish pending deployment evidence |
| Server keys are backend-only; status overview states derive from `/verification/status` eligibility | `/vendor/integration`, `/student/verification`, `/student/profile` | `merchantServerKey` swagger desc; eligibility-gated UI already in code; `student/merchant-design-regressions.spec.ts` | Pending — deploy/canary/partner gates NOT RUN (cutover runbook) | Design swarm; needs product owner | 2026-09-21 | Implemented design; publish pending deployment evidence |
| Redeemed checkout IDs stay permanently bound (never reusable); abandoned checkouts reusable after 7-day retention | `/partner`, `/developers` | claim-sessions swagger retention note; `partners.ts` §4 copy; `tombstoneExpiredClaimSessions` + `product-claim.integration.ts` retention test | Pending — deploy/canary/partner gates NOT RUN (cutover runbook) | Design swarm; needs product owner | 2026-09-23 | Implemented design; publish pending deployment evidence |

Missing evidence means omit/narrow the claim or label it as planned, never treat the empty register as a passed review. Future PRs must update the register and affected pages or explain why no changes are necessary, as required by AGENTS.md.
