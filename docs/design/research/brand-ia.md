# Brand and Information Architecture Research

Status: Task 1A research input, 2026-09-20. Not a design approval. No production code changed.
Owner scope: this file only. Prototypes live under `docs/design/prototypes/direction-a/` and `direction-b/`.
Worktree: `/Users/mac/Downloads/Awoof-design-upgrade`, branch `codex/awoof-design-upgrade`.

## Repository observations (inspected)

Inspected in worktree on 2026-09-20:

- `apps/web/src/app/page.tsx`: hero is full-viewport blue gradient with cloud SVG, then `About`, `TopDeals`, `FAQ`, `Partner`, `Footer`.
- `apps/web/src/app/components/HomePage/banner.tsx`: eyebrow "Verified student marketplace", H1 "Your student ID just got more powerful", subcopy "Unlock exclusive discounts on food, tech, and travel", CTAs Browse deals (`/marketplace`) and Sign up free (`/auth/student/register`), plus "Also on mobile" store badges.
- `apps/web/src/app/components/HomePage/Partner.tsx`: H2 "Reach thousands of verified students", CTA to `/auth/vendor/register`.
- `docs/public-trust-pages.md` and plan: `/contact`, `/partner`, `/privacy`, `/terms` linked but missing; marketplace has a separate inline footer; homepage social links use `#`; `support@awoof.tech` is code usage, not proven monitored inbox; `+2348000000000` is placeholder.

## Inferences (separate from observations)

- The cloud/phone hero competes with the verification explanation; verification reads as a label, not a understood mechanism.
- Marketplace-first ordering makes Awoof read as "another deals site" rather than "student verification that unlocks benefits".
- Copy risks needing substantiation or removal: "thousands", "food, tech, and travel", store availability, partner tracking claims.

## Sources inspected

Access date for all: 2026-09-20. Evidence is text fetch plus local file reads; no screenshots captured in this pass (Browser follow-up recommended for visual detail). No user data sent anywhere.

| Source | Evidence observed | Weakness in comparator | Recommendation for Awoof | Rejected alternative | Awoof rationale |
| --- | --- | --- | --- | --- | --- |
| https://www.wearepion.com/ | Product nav segments Verify / Own experience / Reach millions; separate business and developer entries | Broadens beyond students (10 consumer groups); too enterprise-heavy for Awoof | Keep student-first hierarchy; give Businesses and Universities distinct entries under one Partner destination | Copying Pion multi-audience mega-menu | Awoof is students-only; a smaller nav avoids implying wider verification coverage |
| https://www.sheerid.com/privacy-overview/ | Plain-language data-use explanation separate from full policy | Marketing-heavy shell around trust content; hard to isolate facts | Put a concise trust strip on home and full explanation on `/trust`, distinct from `/privacy` legal text | One long combined trust+legal page | Matches AGENTS.md: trust complements, never replaces, privacy/terms |
| https://www.jumia.com.ng/ (independent comparator, not in plan list) | Dense Nigerian marketplace: search-first, flash sales, price-led cards | No verification story; deal density would bury trust and eligibility states | Keep marketplace preview compact (few cards + link), never the hero | Deal-grid homepage | Awoof's differentiator is verification, not SKU breadth; Jumia wins on breadth, Awoof must win on eligibility clarity |

## Direction A: Verification-first editorial (recommended starter)

Distinct layout, not a colour variant:

- Hero: light background, left-aligned. Eyebrow "Student verification for Nigeria", H1 about verification unlocking benefits, 2-line explainer, two CTAs (Verify student status / Browse marketplace). Right side: small static 3-step card (school email, proof, benefit) with synthetic states, no phone mockup.
- Below hero: three audience cards (Students, Businesses, Universities) with honest one-line outcomes and real destinations.
- Then: "How verification works" in 3 steps with limits stated (mailbox proof vs enrollment; pending guidance). Then compact marketplace preview (3-4 cards). Then trust/help strip.
- Typography: keep Awoof blue (#1D4ED8 family) for actions; pair with a highly legible grotesque for headings and system-friendly body; large line-height, readable without JS.
- Tokens sketch: blue 700 primary, blue 50 surface tint, neutral ink, 8pt spacing, 44px touch targets, visible focus ring. Exact tokens finalized from approved prototype.

## Direction B: Benefit-led checkpoint (genuine alternative)

- Hero: compact blue band with H1 about student benefits, search/browse entry, and an inline "verification checkpoint" card (email input is illustrative only in prototype, labelled synthetic; production keeps real auth untouched).
- Below hero: audience tabs (Students / Businesses / Universities) switching concise benefit + next-step panels without page change; content fully readable with JS disabled as stacked sections.
- Then: verification explanation as timeline with pending/expired branches, then marketplace preview, then partner CTA.
- Same blue retained; heavier card surfaces, denser grid, more marketplace energy than Direction A.

Why two genuinely different options: A leads with understanding (editorial, low-density, trust-first); B leads with doing (compact, checkpoint-first, marketplace-adjacent). Approval picks one named version; a hybrid needs a new runnable preview.

## Critique of the plan

1. Proposed nav (Students/Businesses/Universities/Trust/Help) is sound, but `/partner#universities` risks burying universities. Test a labelled anchor with its own heading and deep link; split only if university content genuinely diverges.
2. "Replace cloud/phone dominance with lighter visual" is correct, but the plan understates the copy job: hero, About, and Partner all need claim review in the same pass, not just imagery.
3. The plan correctly forbids copying Pion art; extend that to IA: do not import Pion's enterprise verification taxonomy. Awoof needs fewer, plainer words (verify, benefit, help, trust).
4. Mobile 390px and 320px reflow should gate prototype approval, not just final QA; the current hero `min-h-screen` + absolute cloud is the highest mobile risk.

## Prototype mapping

- Direction A prototype: editorial hero + step card + audience cards + explanation + compact deals + trust strip.
- Direction B prototype: compact band + checkpoint card + tabs-as-sections + timeline + deals + partner CTA.
- Both labelled "Design prototype — synthetic content", static HTML/CSS, minimal local JS, no real forms, API calls, tracking, or downloads.

## Open questions for coordinator

- Confirm Awoof blue hex lock and whether body font must stay system-only for bandwidth.
- Confirm university content split threshold (one anchor vs separate page).
- Confirm store-badge disposition: remove until app-store availability is proven.
