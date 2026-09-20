# Student, Merchant, and University Journeys

Status: Task 1A research input, 2026-09-20. Not a design approval. No production code changed.
Owner scope: this file only.
Worktree: `/Users/mac/Downloads/Awoof-design-upgrade`, branch `codex/awoof-design-upgrade`.

## Repository observations (inspected)

- Home CTAs today: Browse deals (`/marketplace`) and Sign up free (`/auth/student/register`); store badges present without proven app-store availability.
- Partner CTA today goes directly to `/auth/vendor/register`; no intermediate merchant narrative or integration explanation on a public route.
- No public `/partner`, `/trust`, `/help`, `/contact`, `/developers` routes on inspected main; authenticated support exists at `/student/profile/support` and `/vendor/support`.
- Auth spec (`docs/superpowers/specs/2026-09-20-student-email-first-auth.md`) is planned behavior: email-first login options, separate school-account vs student-status assurance, no auto-link, password-backed linking. It is not proof of deployment.

## Inferences (separate from observations)

- Students are forced toward signup before understanding eligibility; pending/expired/unsupported-school states have no honest public home.
- Merchants meet a registration wall before learning responsibilities (they apply benefits; Awoof asserts eligibility).
- Universities have no journey at all; any claim of integration or partnership would be fabrication today.

## Sources inspected

Access date for all: 2026-09-20. Evidence is text fetch plus local reads; Browser visual check recommended before prototype sign-off.

| Source | Evidence observed | Weakness in comparator | Recommendation for Awoof | Rejected alternative | Awoof rationale |
| --- | --- | --- | --- | --- | --- |
| https://help.studentbeans.com/hc/en-us | Topic hubs (account, codes, iD wallet, grad discounts) plus promoted articles for missing email, unlisted institution, unrecognised email | Assumes mature verification coverage and account base | `/help` hubs: verify, OTP/missing school, pending/expired, consent/recovery; promoted "unlisted school" and "no OTP" entries | Single long FAQ page | Students arrive with failure states; hubs route them faster and map to real Awoof support destinations |
| https://www.wearepion.com/ | Business journey: verify audiences, integrate every channel, developer guides, pricing/contact split | Enterprise funnel with sales-led contact; overkill for Awoof now | Merchant path: narrative page, then real next step (register/login or docs); no fake contact form | Gated sales form as only CTA | Plan review gate: merchant CTA must reach a real next step, not a fake form |
| https://www.jumia.com.ng/ (independent comparator) | Account/orders/wishlist/help/cart nav; help center split by task (place, pay, track, cancel, returns) | Pure commerce account model; no eligibility or verification states | Keep Awoof account, school-account proof, and enrollment eligibility visibly separate in nav and copy | One "account" bucket for login + verification + eligibility | AGENTS.md and auth spec require this separation; mixing them causes false verified badges |

## Journey 1: mobile student (390px first, 320px reflow)

Entry points: home hero, Students nav (`/marketplace`), Help.

1. Understand (home, no signup required): what Awoof verifies, what a benefit is, what is not promised. Honest limits visible: no SSO/manual-review promise until shipped.
2. Check eligibility path: school email + OTP explains mailbox control only; enrollment needs authoritative evidence where integrated; unintegrated schools show pending with retry guidance, never a dead upload button.
3. Browse before committing: marketplace preview reachable without login; protected codes/URLs withheld server-side.
4. Act: login/signup preserved; verification page shows loading, error/retry, empty, pending, verified, expired, consent-withdrawn only where actually supported.
5. Recover: missing OTP, unlisted school, expired evidence, withdrawn consent each have a named help entry and a real support destination with sign-in expectation stated.

Mobile requirements: single H1, one main landmark, skip link, 44px targets, readable with JS disabled, no scroll-jacking, no autoplay video, focus visible on menu/FAQ.

## Journey 2: merchant (business)

1. Learn: `/partner` explains business account, integration/offer configuration, student consent/verification, merchant applies benefit, reporting. Each stage labelled available or planned.
2. Validate: `/developers` overview uses real route names and synthetic schema-checked examples; separates login vs eligibility, server credentials vs browser widget, receipt history vs new authorization. No secrets in rendered examples.
3. Start: CTA reaches merchant register/login (existing working route), never a non-delivering form. No pricing/SLA guarantees or invented case studies.
4. Operate: vendor integration presentation explains credential scope and safe server-side use; existing key-reveal/revoke behavior preserved.

## Journey 3: university

1. Learn: `/partner#universities` section with its own heading: what cooperation means, what evidence is required, what Awoof does not claim (no staff-email equivalence, no partnership logos without agreements).
2. Evaluate: integration concepts only where grounded in actual endpoints; planned SSO/enrollment adapters labelled planned with backend dependency recorded.
3. Contact: only owner-confirmed monitored channels; no invented inbox, phone, or response time. Missing contact decision is a release blocker, not a 404.

## IA and navigation proposal

- Students -> `/marketplace`; Businesses -> `/partner`; Universities -> `/partner#universities`; Trust -> `/trust`; Help -> `/help`; retain login/signup. Matches plan; university anchor must have a real heading and be keyboard/anchor-link reachable.
- Footer: same destinations plus contact and legal only when valid. No `href="#"` social links; remove or point at verified profiles.
- No new `/merchants` or `/universities` pages in this batch; split later only on genuinely distinct content.

## Rejected alternatives

- Forcing all audiences through signup: rejected; it hides eligibility truth and inflates drop-off.
- Chatbot or contact-form-first merchant capture: rejected; no delivery backend is approved, so it would be a fake next step.
- Document-upload UI before the manual-review workflow exists: rejected; show pending with honest guidance instead.

## Open questions for coordinator

- Which support inbox is actually monitored, and what sign-in expectation should contact copy state?
- Which merchant integration stages are available on the shipping build at implementation time?
- Is there any approved university contact or pilot to name, or must all university copy stay generic?
