# Trust, SEO, Accessibility, and Performance Research

Status: Task 1A research input, 2026-09-20. Not a design approval. No production code changed.
Owner scope: this file only.
Worktree: `/Users/mac/Downloads/Awoof-design-upgrade`, branch `codex/awoof-design-upgrade`.

## Claim risks (internal register input, not public copy)

Each row needs code/config/test plus deployment evidence before any public claim. Missing evidence means omit, narrow, or label planned.

| Current or proposed wording | Location observed | Risk | Required disposition |
| --- | --- | --- | --- |
| "Reach thousands of verified students" | `apps/web/src/app/components/HomePage/Partner.tsx` | Unverified count; "verified" ambiguous (account vs school vs enrollment) | Remove count or substitute a sourced, dated metric; split assurance levels per AGENTS.md |
| "Unlock exclusive discounts on food, tech, and travel" | `banner.tsx` | Category breadth unproven; "exclusive" implies enforcement | Narrow to evidenced categories or generic "student benefits"; enforcement stays merchant-side |
| "Also on mobile" store badges | `banner.tsx` + `applestore.tsx` / `googleplaystore.tsx` | Implies app-store availability | Remove until listings verified; never link badges to `#` |
| "Join the network, post deals, and track redemptions" | `Partner.tsx` | Implies working dashboard scope | Verify against vendor routes/tests on fresh main; narrow to available steps |
| `support@awoof.tech` as public contact | code references; `docs/public-trust-pages.md` | Inbox monitoring unverified | Promote only after owner confirms monitoring; contact page states sign-in expectation |
| `+2348000000000` | existing support display | Apparent placeholder | Never copy to new pages; no phone until a real monitored number exists |
| Current SSO / enrollment enforcement / manual verification / active university connection | must not appear in prototypes | Planned backend, not deployment proof | Design honest pending/unavailable states; label pilots as planned with dependency recorded |
| Certifications, audits, uptime, SLAs, compliance, testimonials, logos | must not appear | Fabrication risk | Publish only with approved evidence in claim register; prototypes use synthetic data labelled as such |

Legal/publication gates: `/privacy` and `/terms` need owner/legal-approved substantive text; do not ship boilerplate. Security reporting channel needs a confirmed monitored inbox before a `/trust` section or security.txt. Status page and supported-institutions directory stay deferred until real data sources exist.

## Sources inspected

Access date for all: 2026-09-20. Text-fetch evidence; field measurement needs separate consent-respecting real-user data, not authorized here.

| Source | Evidence observed | Weakness in comparator | Recommendation for Awoof | Rejected alternative | Awoof rationale |
| --- | --- | --- | --- | --- | --- |
| https://developers.google.com/search/docs/fundamentals/seo-starter-guide | Titles/links/snippets, sitemaps, canonicalization, JS-SEO basics; no guaranteed rich results | Generic; does not decide Awoof IA or copy | Unique title/description + self-canonical per public route; sitemap only for existing approved indexable URLs; server-rendered hero text | Homepage canonical inherited everywhere; doorway/country-stuffed pages | Prevents index bloat and false coverage; matches plan metadata registry |
| https://www.w3.org/WAI/tutorials/page-structure/headings/ | One H1 topic per page, h2 major sections, h3 subsections; never pick levels for size | Tutorial, not a ranking rule | One descriptive H1 per page (Awoof convention), semantic h2/h3, skip link, labelled controls, visible focus | Heading levels chosen for font size; client-only content | Accessibility and crawler readability both depend on real structure |
| https://web.dev/articles/vitals | Field p75 LCP <= 2.5s, INP <= 200ms, CLS <= 0.1; lab vs field distinction; TBT is not INP | Lab scores do not prove Nigerian field p75 | Project lab gates: median mobile LCP <= 2.5s, CLS <= 0.1, no unexplained >10% JS/LCP regression vs baseline; 5 cold runs per route; field confirmation stays pending | Dev-server Lighthouse screenshot as proof | Plan requires reproducible baseline/candidate protocol with locked tooling |
| https://www.jumia.com.ng/ (independent comparator) | Heavy image-led commerce homepage; many promo tiles and flash-sale modules | High transfer weight; opposite of low-bandwidth goal | Awoof stays light: no hero video, no carousel, deferred below-fold media, minimal fonts, reserved image space | Promo-tile-dense homepage | Low-bandwidth Nigerian mobile is the primary constraint, not desktop richness |

Additional plan-listed source noted: SheerID privacy overview supports the `/trust`-vs-`/privacy` split (plain-language explanation distinct from legal policy). Pion and Student Beans sources are covered in brand-ia and journeys notes.

## SEO constraints for prototypes and pages

- Server-rendered public pages with readable hero text and JS disabled; no full-page client conversion.
- Metadata helper/registry owned by coordinator before page work; each page exports its own entry. No unverified availability claims in titles/descriptions.
- Sitemap includes only completed approved indexable canonicals with truthful modified dates. Auth/admin/private views never enter sitemap; robots rules are not access control.
- Structured data (Organization/WebSite/Breadcrumb) only where it matches visible content. No fabricated reviews, partners, contacts, or guaranteed FAQ rich results.
- Preserve existing protected-route noindex behavior; no global index directive overriding private routes.

## Low-bandwidth and performance constraints

- Budgets: lab median mobile LCP <= 2.5s, CLS <= 0.1 on the fixed profile; same-route transferred JS and median LCP within 10% of baseline unless reviewed. Candidate-only routes get absolute budgets, not fictitious improvements.
- Implementation: static/server-render hero, responsive images with dimensions, preload only actual LCP resource, defer below-fold media, minimize font weights, avoid render-blocking third-party widgets, never lazy-load LCP image.
- Test widths 360/390/768/1440 plus 320px reflow; slow network, blocked image/font, and JS-disabled passes. Exercise menu/FAQ/form interactions for latency; local TBT does not stand in for field INP.
- Artifacts: ignored `.performance-artifacts` outside Playwright cleanup, immutable baseline, timestamped candidate runs, baseline-survival check. Baseline capture refuses overwrite; compare rejects mismatched tool/config/dataset hashes.

## Accessibility constraints

- WCAG AA text contrast (4.5:1 normal, 3:1 large), 44px touch targets, visible focus, descriptive links, labelled fields, error announcements, 200% zoom and 320px reflow without content loss.
- Decorative art `alt=""`; meaningful images get real alt. Respect reduced motion; do not hide essential content behind scroll reveals. No autoplay hero video or scroll-jacking.
- Automated tooling pass is not WCAG certification; keyboard walkthrough and narrow-layout checks are mandatory.

## Rejected alternatives

- Blanket iframe-blocking headers that break the widget: rejected; widget embedding keeps its discovered supported mode and origin/consent checks.
- Indiscriminate prerendering or guaranteed rich-result claims: rejected; unsupported by official docs.
- New animation dependency or tracking scripts for marketing pages: rejected without measured need and consent basis.

## Open questions for coordinator

- Confirm the locked Lighthouse/Chrome versions and fixture dataset hash at Task 1B baseline time.
- Confirm legal-owner approval path and review-date policy for trust/help/privacy/partner/developer copy.
- Confirm monitored contact channel before any `/contact` or reporting copy ships.
