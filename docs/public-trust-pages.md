# Public trust and partner pages

Research/repository review: 2026-09-20, inventory refreshed 2026-09-23. Status: first-batch pages shipped; `/privacy` and `/terms` remain deferred. This file is internal planning, not public security assurance.

## Repository evidence

The read-only inventory checked the working tree and origin/main at 4e47ea0. The local branch is divergent; implementation should start from a fresh isolated origin/main worktree, preserving existing work.

Shipped since the first review: `/trust`, `/help`, `/contact`, `/partner`, and `/developers` now have matching page routes. Still deferred with no page routes: `/privacy` and `/terms`. Relevant entry points are `apps/web/src/app/components/Footer.tsx`, `apps/web/src/app/marketplace/layout.tsx`, homepage FAQ components, `apps/web/src/app/sitemap.ts`, and the authenticated vendor integration/support journeys.

The broken links are specifically in the inline footer in `apps/web/src/app/marketplace/page.tsx`; the homepage has a separate Footer component. The root layout does not mount shared public navigation, so provide an explicit reusable public shell. Homepage social links use `#` and should not be presented as real destinations.

Existing authenticated support routes are `/student/profile/support` and `/vendor/support`. Their code references `support@awoof.tech`, which establishes code usage but not inbox operation; confirm monitoring before public promotion. The displayed `+2348000000000` is an apparent placeholder and must not be copied into the new contact page. Current main has already removed the stale local `/docs/widget` link; do not repeat that fix against the old checkout.

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
- `/contact`: working student/vendor support destinations and an owner-confirmed public contact method. Do not invent an inbox, form delivery, phone number or response time.
- `/partner`: merchant journey and a university section explaining institutional cooperation. Merchant remains responsible for applying benefits; distinguish available integration from planned APIs. Reuse this existing footer destination rather than introducing redundant `/merchants` and `/universities` pages immediately.

### Required content with publication dependencies

- `/privacy` and `/terms`: existing broken footer links need valid destinations, but substantive legal text needs confirmed entity/contact details, actual data flows/retention and owner/legal approval. Do not publish generic boilerplate as an approved policy. Record this as a release dependency; do not substitute an empty placeholder policy or remove required signup notices silently.
- `/developers`: add after validating actual public API contracts, authentication, failure modes and merchant examples against source/tests. Link the authenticated integration screen appropriately. Never publish private keys, guessed endpoints or planned interfaces as live.
- Security reporting: include a `/trust` section once a monitored reporting channel is confirmed. A separate disclosure policy or security.txt requires approved contact/expiry and policy details; no invented bug bounty or safe-harbor commitments.
- Accessibility information: add a short help/contact section for reporting access barriers; a formal conformance statement requires an audit.

### Defer until backed by operations

- Live status page: only with monitoring/incident data; no static “all systems operational”.
- Supported-institutions directory: only with approved runtime capabilities; an email-domain seed list is not live integration coverage.
- Certifications, audit reports, subprocessors, DPA and case studies: publish only accurate approved material with the necessary operational/legal evidence. Do not invent them for marketing completeness.

## Agent handoff and acceptance

After approval of the page set, assign one frontend agent ownership of the approved public page routes, reusable public-page component, footer/sitemap updates and focused tests. The coordinator owns AGENTS.md, this inventory, source-backed claim review and legal/operational blockers. Agents must preserve others' changes and follow applicable skills and isolated-worktree instructions.

Before coding, inspect fresh main and record the exact paths to avoid conflicting routes. Before completion, test route rendering, internal links, metadata, public versus authenticated navigation, keyboard access, heading order and mobile layout. Report local checks separately from deployed checks. No deployment is implied by this document.

## Claim register template

Every material public security or operational claim must have a filled record before publication:

| Claim | Public destination | Source/config/test evidence | Deployment/operational evidence | Responsible owner | Review date | Publish decision |
| --- | --- | --- | --- | --- | --- | --- |
| Mailbox check and enrollment check are separate; status names which passed | `/trust`, `/help`, `/` | merchant-verification swagger `assuranceMethod: student_email \| enrollment`; `public-information.spec.ts`, `public-home.spec.ts` | Shipped in this release (code present on branch) | Design swarm; needs product owner | 2026-09-21 | Published |
| Merchants get an eligibility answer + merchant-scoped pseudonym, not documents/email/account IDs | `/trust` | `MerchantVerificationReceipt` schema in `merchant-verification.routes.ts` (merchantSubject “not an Awoof user ID”) | Shipped in this release | Design swarm; needs product owner | 2026-09-21 | Published |
| Assertion codes are short-lived (minutes); server keys never belong in browsers | `/trust` | Same swagger: code lifetime ≤2 min; `merchantServerKey` “Never send this key to a browser” | Shipped in this release | Design swarm; needs product owner | 2026-09-21 | Published |
| Withdrawing consent stops future checks; issued receipts stand as history | `/trust`, `/help` | Exchange endpoint docs (idempotency/consent-withdrawal comment) | Shipped in this release | Design swarm; needs product owner | 2026-09-21 | Published |
| Student accounts are free; merchants set their own offer terms | `/`, `/help` | Registration has no payment step (`auth/student/register`); vendor offer config in vendor deals pages | Shipped in this release | Design swarm; needs product owner | 2026-09-21 | Published |
| Support happens in-app after sign-in; no public inbox or phone is offered | `/contact` | Support routes `/student/profile/support`, `/vendor/support` exist; `support@awoof.tech` monitoring unverified, `+2348000000000` is a placeholder — both omitted | Shipped in this release | Needs support owner before any inbox/phone is added | 2026-09-21 | Published |
| Privacy policy / terms of service | `/privacy`, `/terms` (do not exist) | None — no approved legal content | Blocked | Needs owner/legal | 2026-09-21 | **Blocked: release blocker, not published** |
| Merchant flow: assertions (student JWT) → server exchange (server key) → receipt; errors 401/409/429 | `/developers`, `/partner` | `merchant-verification.routes.ts` routes + zod schemas + swagger; `public-partner.spec.ts` | Shipped in this release | Design swarm; needs product owner | 2026-09-21 | Published |
| Browser widget verification is unavailable; server API is the supported path | `/partner` | `/widget/verify` page copy (“being replaced”); widget backend exposes only `domain-check` | Shipped in this release | Design swarm; needs product owner | 2026-09-21 | Published |
| No merchant partnerships, SLAs, pricing, or case studies claimed | `/partner` | Copy review; spec asserts absence of guarantee/case-study language | n/a (omission) | Design swarm | 2026-09-21 | Published as omission |
| Server keys are backend-only; status overview states derive from `/verification/status` eligibility | `/vendor/integration`, `/student/verification`, `/student/profile` | `merchantServerKey` swagger desc; eligibility-gated UI already in code; `student/merchant-design-regressions.spec.ts` | Shipped in this release | Design swarm; needs product owner | 2026-09-21 | Published |

Missing evidence means omit/narrow the claim or label it as planned, never treat the empty register as a passed review. Future PRs must update the register and affected pages or explain why no changes are necessary, as required by AGENTS.md.
