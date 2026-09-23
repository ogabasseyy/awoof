# Awoof Verification-First Design Swarm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax. The requested execution method is a coordinated designer/developer swarm with independent research and review.

**Goal:** Make Awoof approachable for African students and credible to merchants and universities, with a coherent verification-first public site, truthful trust information and clear in-app assurance states.

**Architecture:** Research and agree one shared visual/content contract before parallel page implementation. Reuse server-rendered Next.js pages, existing authentication and APIs, a shared public shell and small interactive components. Keep backend eligibility/SSO implementation separate from this design programme.

**Tech Stack:** Existing Node 24, Next.js App Router, React, TypeScript, Tailwind, Playwright and existing motion/UI libraries. Install locked dependencies, not speculative framework upgrades.

**Spec:** This task's approved intent is captured under Design brief below, with `/Users/mac/Downloads/Awoof/docs/public-trust-pages.md` and `/Users/mac/Downloads/Awoof/docs/superpowers/specs/2026-09-20-student-email-first-auth.md` as supporting requirements. The latter is planned backend behavior, not proof of current deployment. Researchers produce a reviewed visual specification before product implementation.

**Status:** Revision 6: retains the localhost-preview approval gate, protects performance artifacts from browser-test cleanup, and preserves approved research/design documents during baseline setup. Earlier review corrections remain in force. Execution brief only. No worktree, previews, implementation swarm or deployment have been created by writing this document.

## Paste-ready coordinator instruction

You are coordinating Awoof's design upgrade. Read this entire plan, repository AGENTS.md and supporting documents. Create the isolated worktree specified below after checking current Git state. Launch independent research/design agents, challenge the recommendations in this document, and build two isolated runnable localhost homepage prototypes under Task 1A. Open both in the user's Browser and demonstrate mobile and desktop layouts. STOP until the user explicitly approves a named prototype version and any requested revisions. Prototype coding is permitted only inside the isolated prototype directories; it is not permission to change Awoof's production pages, shared styles or behavior. After approval, establish Task 1B baselines and implement Tasks 2–7 in bounded waves with ownership, TDD, independent reviews and SEO/accessibility/CWV gates. Persist through approved implementation, but never treat silence, research approval or an earlier generic proceed as design approval. Do not merge or deploy without explicit instruction.

## Repository and worktree: exact locations

- Source repository: `/Users/mac/Downloads/Awoof`.
- Observed source branch: `codex/awoof-handover-hardening`, HEAD `007491d`; divergent from origin/main. Do not implement on this checkout.
- Inspected main: `4e47ea0` (2026-09-20). Fetch and record a fresh full SHA at execution; this identifier is evidence, not a version pin.
- Proposed execution worktree: `/Users/mac/Downloads/Awoof-design-upgrade`.
- Proposed branch: `codex/awoof-design-upgrade`.
- Proposed worktree does NOT yet exist. If either path/branch exists, inspect it and reuse only if it belongs to this work; never reset or overwrite it.
- Other Awoof worktrees are active. Do not change their branches, remove caches/dependencies or occupy their server ports without checking ownership.

Read `superpowers:using-git-worktrees` first. Then from the source repository:

```bash
git status --short
git worktree list
git fetch origin
git rev-parse origin/main
git worktree add /Users/mac/Downloads/Awoof-design-upgrade -b codex/awoof-design-upgrade origin/main
```

The following source files were untracked when this plan was written; explicitly carry their reviewed content into the new worktree using apply_patch, checking for newer conflicting tracked files first:

- `AGENTS.md`
- `docs/public-trust-pages.md`
- `docs/superpowers/plans/2026-09-20-design-swarm.md`
- `docs/superpowers/plans/2026-09-20-institution-email-auth.md`
- `docs/superpowers/specs/2026-09-20-student-email-first-auth.md`

All relative paths below resolve inside `/Users/mac/Downloads/Awoof-design-upgrade`. Preserve unrelated untracked audit/planning files in the source checkout. Do not copy `.env`, credentials, node_modules or production data. Check disk before installing; lack of space is not authorization to delete other worktrees.

## Required skills and their use

Each agent reads the applicable skill completely from its available skill catalog; paths can change between tasks. The coordinator also reads governing instructions itself.

- Research/design: `superpowers:brainstorming`, `frontend-design`; `emil-design-eng` for interaction detail when relevant.
- Coordination: `superpowers:dispatching-parallel-agents`, `superpowers:subagent-driven-development`, `superpowers:using-git-worktrees`.
- Implementation: `superpowers:test-driven-development`, `next-best-practices`, `vercel-react-best-practices`.
- Validation: `accessibility`, `seo`, `core-web-vitals`, `web-quality-audit`, `superpowers:verification-before-completion`.
- UI inspection: `codex-in-app-browser` for the user's Browser, or `playwright` for repository automation.
- Review: `superpowers:requesting-code-review`; `superpowers:systematic-debugging` for failures.

Use only relevant skills, not every skill on every task. Official current documentation outranks unsupported claims in examples: do not adopt invented ranking-factor percentages, blanket iframe-blocking headers that break the widget, indiscriminate prerendering, or guaranteed rich-result claims.

## Design brief and global constraints

- Position Awoof as student verification and access to benefits in Nigeria/Africa. The marketplace remains a useful experience, not the entire identity of the company.
- Keep the recognizable Awoof blue and brand name. Explore typography, layout and imagery independently; do not copy Pion's distinctive art or assets.
- Serve three audiences: students seeking benefits, merchants considering verification, and universities considering integration. Provide clear journeys instead of forcing all audiences into signup.
- Proposed navigation: Students → `/marketplace`, Businesses → `/partner`, Universities → `/partner#universities`, Trust → `/trust`, Help → `/help`; retain working login/signup. Split university pages later only if research identifies genuinely distinct content.
- Marketing pages must remain readable without animation/JavaScript. No full-page client conversion, autoplay hero video, scroll-jacking or new animation dependency without measured need.
- Separate account authentication, school-account proof and enrollment eligibility. Preserve existing authorization and session logic; do not fabricate assurance status in the browser.
- Do not promise current SSO, current-enrollment enforcement, manual verification or an active university connection until the actual shipping build and activation support the statement. Design unavailable/pending states honestly.
- Never invent customer counts, university/merchant logos, testimonials, app-store availability, certifications, legal policies or monitored contacts. Mock demonstrations are explicitly labelled and contain synthetic data.
- Reuse existing approved privacy/terms content if it becomes available. Otherwise legal copy is a publication gate, not an invitation to ship boilerplate. Existing broken legal destinations must be reported and repaired only with approved content.
- Do not redesign payments, modify verification algorithms, enable provider flags, access production credentials or deploy as part of visual work.
- All PRs follow AGENTS.md's documentation-impact rule. Implementation source, local tests, external review and production proof are separate outcomes.

## Research already completed: evidence, not a fixed answer

On 2026-09-20 the live Awoof homepage showed a cloud/phone hero, “Verified student marketplace”, Browse deals/signup CTAs and download buttons. The flow explains school email + OTP followed by savings; a partner block claims “thousands of verified students”. These are copy/positioning risks to substantiate or narrow, not proof the backend is insecure. The phone/cloud composition competes with the verification explanation; that is a design judgment to challenge.

Repository evidence: home `src/app/page.tsx`, `components/HomePage/banner.tsx`, `About.tsx`, `Partner.tsx`, `FAQ.tsx`, `Header.tsx`, `Footer.tsx`; paths are under `apps/web`. Marketplace has a separate inline footer in `src/app/marketplace/page.tsx`. `/contact`, `/partner`, `/privacy`, `/terms` were linked but missing on inspected main. Root layout does not install a shared public shell. Existing authenticated support routes are `/student/profile/support` and `/vendor/support`. `support@awoof.tech` exists in code but inbox monitoring is unverified; `+2348000000000` appears to be a placeholder. Current main already removed the old local `/docs/widget` link.

Primary sources to revisit independently:

| Source | What to investigate, not copy |
| --- | --- |
| https://www.wearepion.com/product/verification/closed-consumer-groups | Audience segmentation, hierarchy, business CTAs; do not broaden Awoof beyond students |
| https://www.wearepion.com/ | Partner journeys and integration navigation |
| https://www.sheerid.com/privacy-overview/ | Plain-language trust explanations distinct from full policies |
| https://developer.sheerid.com/ | Quickstarts and integration concepts |
| https://www.myunidays.com/US/en-US/support | Verification failures, unsupported schools, recovery |
| https://help.studentbeans.com/hc/en-us | Student help organization |
| https://www.id.me/security | Trust/privacy/accessibility navigation, not accreditation reuse |
| https://varsityvibe.co.za/ | African student-market context; previous text fetch returned only a JS shell, so inspect in Browser before drawing conclusions |
| https://developers.google.com/search/docs/fundamentals/seo-starter-guide | Current SEO fundamentals |
| https://www.w3.org/WAI/tutorials/page-structure/headings/ | Semantic heading structure |
| https://web.dev/articles/vitals | Field CWV thresholds and lab/field distinction |

Each researcher must inspect at least two relevant primary sources plus one independently chosen comparator. Record URL, access date, screenshot/evidence, one weakness in the comparator, recommendation, rejected alternative and Awoof-specific rationale. Separate observations from inferences. No user data or private screenshots sent to third-party services. Test mobile as well as desktop; page polish alone does not prove usability or conversion.

## Swarm schedule and ownership

Use at most the runtime's available slots; the last observed capacity was four including coordinator. With that limit, run coordinator + three agents, then reuse slots in waves. More agents are not a reason to split one shared component among editors. Respect current model preferences; Terra is suitable for substantial implementation and Luna for bounded inventories, but never silently substitute unavailable models.

| Wave | Agent responsibility | Exclusive outputs/ownership |
| --- | --- | --- |
| Research | Brand/IA designer | `docs/design/research/brand-ia.md`: two proposed directions and critique of this plan |
| Research | Student/partner journey designer | `docs/design/research/journeys.md`: mobile student, merchant and university journeys |
| Research | Trust/accessibility/performance researcher | `docs/design/research/quality.md`: claim risks, SEO and low-bandwidth constraints |
| Prototype, before approval | Brand designer A and journey designer B | Separate `docs/design/prototypes/direction-a/` and `direction-b/`; localhost samples only |
| Foundation, after approval and baselines | Lead design implementer | public shell, tokens, shared header/footer/components; explicit home shell adoption and marketplace inline-footer replacement |
| Pages | Homepage implementer | home page and HomePage components only |
| Pages | Trust/help implementer | `/trust`, `/help`, `/contact` and their content/tests only |
| Pages | Partner/docs implementer | `/partner`, `/developers` and content/tests only |
| Product | Student UX implementer | approved login/verification/profile presentation only |
| Product | Merchant UX implementer | approved vendor integration presentation only |
| Validation | Fresh independent reviewer | read-only review report; coordinator assigns fixes to file owners |

Coordinator owns `AGENTS.md`, global SEO wiring, package/lock/config changes, research synthesis, acceptance records and all staging/commits. Every worker prompt must say: “You are not alone in the codebase. Do not revert others' edits. Own only the listed files; request coordinator changes to shared files. Do not run git add, commit, switch, checkout, merge, stash or reset.” Workers report exact changed paths and test results. The coordinator pauses affected writers, reviews their diffs, stages only approved paths, checks the staged diff for unrelated changes, then commits each bounded task. All later instructions to commit mean coordinator-only commits. One coordinator-owned browser/test server; serialize build/tests that share ports, fixtures, the Git index or `.next` outputs.

## Review focus

1. Mobile menu/focus/reduced motion and no-JS reading — Tasks 2, 7.
2. A pending/expired student or failed API must never see a fabricated verified badge — Task 6.
3. Merchant/university CTA must reach a real next step, not a fake contact form — Tasks 4, 5.
4. Authenticated navigation and existing signup/checkout must survive the public redesign — Tasks 2, 6, 7.
5. Attractive hero assets must not regress LCP/CLS or conceal text from crawlers — Tasks 3, 7.

## Task 1A: Independent research and localhost design approval

**Files:** researcher-owned documents listed above; isolated `docs/design/prototypes/direction-a/` and `direction-b/` containing each prototype's HTML, CSS and local assets; coordinator-owned `docs/design/prototypes/index.html`, `docs/design/verification-first-design.md` and `docs/design/design-approval.md`.

- [ ] Inspect Git state, create the worktree safely and carry reviewed instructions into it. Read current source and inspect the live design; do not install the full app/backend or build performance infrastructure just to show concepts.
- [ ] Run independent research first. Each designer develops its own recommendation before reading the other's. Produce two distinct directions, not colour variations of one layout. Each sample must include hero/navigation, verification explanation, a student-facing benefit section and a merchant/university section.
- [ ] Build responsive, runnable static HTML/CSS samples with synthetic content in the two isolated directories. Keep any prototype JS local and minimal. No changes to `apps/`, root package/lock/config, shared styles, authentication, backend, provider flags or data. No real forms, API calls, tracking or downloads. Clearly label every sample “Design prototype — synthetic content”. Use normal preview navigation; simulated actions must not imply a successful real transaction or verification.
- [ ] Create a comparison index linking to both samples and displaying their version identifiers. Bind a static server only to loopback after checking port ownership; default preview port is 3117, separate from app test ports. If Python 3 is available, run from the worktree root:

```bash
python3 -m http.server 3117 --bind 127.0.0.1 --directory docs/design/prototypes
```

- [ ] Open `http://127.0.0.1:3117/direction-a/` and `http://127.0.0.1:3117/direction-b/` visibly in the user's Browser, verify they load, and show each at 390px and 1440px widths. Also check 320px reflow, focus visibility and reduced motion. Record actual URLs if a different free port is used; never terminate another task's listener. Use the browser skill's handoff mechanism to retain preview tabs for the decision. Static prototypes need no backend dependency installation.
- [ ] Record each preview's version, file hashes, screenshots, design rationale and proposed tokens. Ask the user which version to approve or what to revise. **Hard stop:** no Task 1B, foundation or page/product implementation agents may start until explicit design approval. Silence, approval of research, or “show me” is not approval. Requested revisions produce a new preview version and another review, not permission to ship the old one.
- [ ] Record approval in `docs/design/design-approval.md`: approved direction/version, file hashes, date, user's approval wording, scope, requested changes and their disposition. A hybrid requires a runnable combined preview and approval of that version. Finalize the shared design contract from the approved preview; material later changes to typography, layout or visual direction require renewed approval. Accessibility fixes within the approved direction do not require needless reapproval.
- [ ] Keep prototypes outside application routes/build inputs and sitemap. They are review artifacts, not production implementation. Do not copy prototype files wholesale into the product; implement approved behavior through existing app components and tests afterward. Coordinator alone stages/commits any retained artifacts.

## Task 1B: Post-approval execution baselines

**Files:** read and preserve Task 1A's `docs/design/research/brand-ia.md`, `journeys.md`, `quality.md`, `docs/design/verification-first-design.md` and `docs/design/design-approval.md`. The coordinator creates `docs/design/validation.md` for baseline evidence; do not regenerate or overwrite the approved design/research documents during setup.

- [ ] Verify Task 1A's version-specific approval record; use the already-created worktree, not a second worktree. Record fresh SHA, package versions, free space and existing failing checks. Confirm no production code changed during prototyping.
- [ ] Before any baseline/test command, check Node 24, npm, OpenSSL (`openssl version`) and the installed Chrome channel expected by Playwright. Install locked dependencies with `npm --prefix apps/backend ci` and `npm --prefix apps/web ci`. Backend dependencies are required by the Microsoft HTTPS fixture, even for frontend-only work. Do not use production environment files. Inventory listeners with `lsof -nP -iTCP -sTCP:LISTEN`; ordinary tests reserve 3107/3108, Microsoft fixtures reserve 3107/3443/3444/3445. Missing prerequisites must be fixed or explicitly recorded, not counted as a passing baseline.
- [ ] Inspect current main routes and actual browser journeys. Save baseline screenshots at 360, 390, 768 and 1440 CSS-pixel widths; include logged-out navigation and representative synthetic pending/error states.
- [ ] Before Task 2 changes any shared layout/styles, the coordinator creates `apps/web/tests/browser/widget-design-regressions.spec.ts` and `admin-design-regressions.spec.ts` using the synthetic fixtures and cases specified in Task 7. Run `npm --prefix apps/web run test:browser -- widget-design-regressions.spec.ts admin-design-regressions.spec.ts admin-support-session.spec.ts`. Capture supported embedding mode, narrow-layout screenshots, focus/session behavior and exact baseline SHA. Record preexisting failures without weakening assertions or treating failures as passes. Task 7 repeats these same checks against the candidate; it does not create the baseline retrospectively.
- [ ] Establish the performance tooling and fixture described below before visual implementation. Register the exact package scripts below, run their unit tests, then run `npm --prefix apps/web run audit:public:baseline`. A failed/incomplete capture blocks performance comparison until corrected. Keep the immutable baseline report and its fixture/config hashes; do not overwrite it during candidate runs.
- [ ] Confirm the approved contract specifies tokens, type scale, spacing, buttons, cards, focus states, navigation, page outlines and copy/claim register. Preserve that direction during implementation; surface any backend/legal constraint that would materially change the approved experience.
- [ ] Coordinator commits reviewed baseline tooling separately from prototype/design artifacts before Task 2. All later references to Task 1 baseline setup mean Task 1B; references to research/concepts/approval mean Task 1A.

## Task 2: Shared public shell and navigation

**Create:** `apps/web/src/components/public/PublicShell.tsx`, `PublicHeader.tsx`, `PublicFooter.tsx`, `PublicPage.tsx`, `apps/web/src/styles/public-tokens.css`; `apps/web/tests/browser/public-shell.spec.ts`.
**Modify:** existing Header/Footer wrappers, `apps/web/src/app/page.tsx` (shell adoption only), `apps/web/src/app/marketplace/page.tsx` (inline-footer replacement only), with coordinator review. Avoid mounting public chrome in authenticated layouts. Foundation work completes before the homepage worker receives ownership of page.tsx. Do not alter marketplace data fetching, purchase actions or eligibility checks.

**Interface:** `PublicShell({children}: {children: React.ReactNode})` renders header, skip link, one `<main id="main-content">`, footer. `PublicPage({title,intro,children}: {title:string; intro:string; children:React.ReactNode})` renders one h1 and content inside that shell. Homepage uses shell directly and owns its h1. No nested main landmarks.

**Coordinator-owned SEO prerequisite:** Before the page wave, create `apps/web/src/lib/public-metadata.ts` and `apps/web/src/content/public/page-metadata.ts`. The latter exports a typed `publicPageMetadata` map for `/`, `/trust`, `/help`, `/contact`, `/partner`, `/developers`. Add approved legal routes only when their content is ready. Each entry has a unique title, description and production pathname approved against its visible copy. Example titles: `Student Verification and Benefits | Awoof`, `Security and Trust | Awoof`, `Student Verification Help | Awoof`, `Contact Awoof`, `Student Verification for Partners | Awoof`, `Developer Integration Guide | Awoof`. Descriptions must be written and reviewed in Task 1's content contract, not invented by separate page agents. No unverified availability claims.

The helper contract is:

```ts
import type { Metadata } from 'next';
export type PublicMetadataInput = {
  pathname: `/${string}`;
  title: string;
  description: string;
  socialImagePath?: `/${string}`;
};
export function buildPublicMetadata(input: PublicMetadataInput): Metadata {
  const url = new URL(input.pathname, 'https://awoof.tech').href;
  const images = input.socialImagePath
    ? [new URL(input.socialImagePath, 'https://awoof.tech').href]
    : undefined;
  return {
    title: { absolute: input.title },
    description: input.description,
    alternates: { canonical: url },
    openGraph: { title: input.title, description: input.description,
      url, siteName: 'Awoof', type: 'website', images },
    twitter: { title: input.title, description: input.description,
      card: images ? 'summary_large_image' : 'summary', images },
  };
}
```

- [ ] Test the helper through `apps/web/tests/auth/public-metadata.test.ts`, registered in the existing auth test tsconfig/runner as needed: `/trust` canonical and Open Graph URL must be `https://awoof.tech/trust`, titles are absolute, missing image produces a summary card, and an optional image resolves to the production origin. Metadata input is trusted checked-in content, never request/query input. Validate registry paths reject `//`, protocols, query/fragment and duplicate canonicals. Do not put account or private routes in this registry.
- [ ] Freeze helper/registry contracts before handing pages to workers. Each server page exports `buildPublicMetadata(publicPageMetadata[itsPath])`; workers request coordinator changes to registry values rather than independently editing shared files. This registry is not an automatic sitemap: only completed, approved indexable routes enter sitemap. Test final rendered metadata in Task 7, including absence of duplicated/inherited homepage social URLs. Do not add a global index directive that could override private-route noindex.

- [ ] Write failing browser tests against the existing `/` route for one main, one h1, Skip to content focus, mobile menu toggle and Escape close/focus return. Verify existing login/signup/marketplace destinations now. Assert no `href="#"` social links. Defer tests requiring new `/trust`, `/help`, `/contact`, `/partner` and `/developers` destinations to their owning page tasks and the final route sweep; do not create placeholder pages to make the foundation pass.
- [ ] Run `npm --prefix apps/web run test:browser -- public-shell.spec.ts`; record expected failures before implementation.
- [ ] Implement approved tokens and shell, using semantic anchors for navigation and buttons for actions. Use existing accessible primitives; preserve authenticated role destinations. Keep menu state local, not a client wrapper around all content.
- [ ] Example acceptance test (real Playwright import, no undefined fixtures):

```ts
import { test, expect } from '@playwright/test';
test('public shell has a single topic and keyboard entry', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.locator('h1')).toHaveCount(1);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
});
```

- [ ] Make the main skip target programmatically focusable with tabIndex={-1}. Re-run tests and inspect mobile/desktop. Verify marketplace has one footer and retains working deal/navigation actions; test its shared footer with synthetic existing API fixtures. Record that unpublished navigation targets are pending, not launch-ready. Commit scoped foundation changes and freeze the component contract before the page wave.

## Task 3: Verification-first homepage

**Modify:** `apps/web/src/app/page.tsx`, `apps/web/src/app/components/HomePage/banner.tsx`, `About.tsx`, `Partner.tsx`, `FAQ.tsx`, `TopDeals.tsx`, `AnimatedTop.tsx` only where used.
**Test:** `apps/web/tests/browser/public-home.spec.ts`.

- [ ] Write failing tests asserting hero topic is student verification, Students/Businesses/Universities paths are discoverable, deals remain reachable and hero text exists in HTML with JavaScript disabled.
- [ ] Implement approved order: purpose/CTAs → three audience paths → clear verification explanation → truthful product demonstration → marketplace preview → trust/help → partner next step. Keep existing anchor IDs where possible; correct broken anchor links if sections change.
- [ ] Replace cloud/phone dominance with the approved lighter product visual. Use synthetic illustrative states; do not imply a live verification demonstration. Remove or substantiate “thousands”, travel offers and download claims. No automatically rotating carousel.
- [ ] Run `npm --prefix apps/web run test:browser -- public-home.spec.ts`, compare screenshots and baseline transfer/LCP, then commit.

## Task 4: Trust, help, contact and legal-page readiness

**Create:** `apps/web/src/app/trust/page.tsx`, `help/page.tsx`, `contact/page.tsx`; content in `apps/web/src/content/public/trust.ts`, `help.ts`, `contact.ts`; `apps/web/tests/browser/public-information.spec.ts`.
**Conditional:** `privacy/page.tsx`, `terms/page.tsx` only with owner-approved substantive content.

- [ ] Write failing tests for page headings, support links, no fabricated certification/count/phone number, usable help without login and honest unavailable verification guidance.
- [ ] Implement Trust with separate identity/enrollment explanation, substantiated practices and limits. Help covers OTP delivery, missing school, pending/expired state, consent and recovery. Contact links real student/vendor support with sign-in expectations; promote an inbox only once confirmed monitored.
- [ ] Do not publish unapproved legal documents or build non-delivering forms. Ask the owner for missing legal/contact decisions while continuing independent page work. Missing legal destinations remain a release blocker for the complete batch, not a secretly accepted 404.
- [ ] Update the internal claim register in `docs/public-trust-pages.md` with exact evidence and publication status. Run `npm --prefix apps/web run test:browser -- public-information.spec.ts`, review copy independently, commit.

## Task 5: Partner and developer journeys

**Create:** `apps/web/src/app/partner/page.tsx`, `developers/page.tsx`; `apps/web/src/content/public/partners.ts`; `apps/web/tests/browser/public-partner.spec.ts`.
**Read:** `apps/web/src/app/vendor/integration/page.tsx`, backend merchant routes/Swagger and verification services on fresh main.

- [ ] Write failing tests for university anchor, merchant register/login, developer documentation links and absence of secrets in rendered examples.
- [ ] Implement merchant narrative: business account → integration/offer configuration → student consent/verification → merchant applies benefit → reporting. Label unavailable stages explicitly. University section explains cooperation and evidence requirements without claiming partnerships or staff-email equivalence.
- [ ] Build a small server-rendered developer overview using real route names and synthetic examples verified against schemas. Clearly separate login from eligibility, server credentials from browser widget and receipt history from new authorization. Do not document planned auth interfaces as live.
- [ ] If current APIs cannot support the described journey, narrow copy and record the backend dependency rather than creating a new backend in this task. No pricing/SLA guarantees or fabricated partner case studies.
- [ ] Run `npm --prefix apps/web run test:browser -- public-partner.spec.ts`, inspect both audiences' paths and commit.

## Task 6: Apply approved design to student and merchant product surfaces

**Student owner modifies:** `apps/web/src/app/auth/student/login/page.tsx`, `student/verification/page.tsx`, `student/profile/page.tsx`; test `apps/web/tests/browser/student-design-regressions.spec.ts`.
**Merchant owner modifies:** `apps/web/src/app/vendor/integration/page.tsx`; test `apps/web/tests/browser/merchant-design-regressions.spec.ts`.

- [ ] First inspect the actual shipping API contract. The enrollment-only/email-first plan is separate. If StudentAssurance or provider discovery is absent, do not fake it: retain working behavior and limit this task to visual clarity or hold the dependent UI until that backend PR is available.
- [ ] Write failing tests using existing browser route fixtures for loading, error/retry, empty, pending, verified, expired and consent-withdrawn where actually supported. No production records or real OTP delivery for synthetic fixtures.
- [ ] Implement hierarchy, labelled fields, focus/error summaries, explicit next steps and readable status cards; preserve handlers, session generation guards, consent and API authorization. Never display a green current-enrollment badge from generic verification_status.
- [ ] Merchant presentation explains credential scope and safe server-side use without rendering keys in public pages or logging them. Preserve existing key-reveal/revoke behavior.
- [ ] Run both new suites and existing auth/browser regression suites. Confirm login, verification, marketplace navigation and vendor integration still work. Commit each owner's bounded changes separately.

## Task 7: SEO, accessibility, CWV and independent release review

**Coordinator modifies:** `apps/web/src/app/layout.tsx`, `sitemap.ts`, existing robots metadata if present; audit the foundation-owned public-metadata helper and registry; create `apps/web/tests/browser/public-quality.spec.ts` and re-run the widget/admin regression files established in Task 1.
**Reviewer creates:** `docs/design/review.md`. Evidence goes in `docs/design/validation.md` with exact SHA/environment.

- [ ] Write failing route/metadata tests before SEO wiring. One descriptive h1 per page is an Awoof convention, not a claimed Google ranking requirement. Use h2 for major sections, h3 for subsections; never choose heading levels for font size. Each page gets unique title/description and its own production canonical, not the homepage canonical inherited everywhere.
- [ ] Include only existing public indexable canonical URLs in sitemap. Use truthful modification dates. Auth/admin/private views must not become indexable or enter sitemap; robots rules are not access control, and blocked crawling must not be mistaken for applied noindex. Preserve existing protected-route behavior.
- [ ] Add relevant verified Organization/WebSite/Breadcrumb structured data only where it matches visible content. No fabricated reviews/ratings, partners, contacts or guaranteed FAQ rich results. Avoid duplicated FAQ content and keyword-stuffed Africa/country doorway pages.
- [ ] Use accessible contrast (WCAG AA text: 4.5:1 normal, 3:1 large), visible focus, descriptive link names, labelled controls and error announcements. Target 44px touch controls, 200% zoom and 320px reflow without horizontal content loss. Meaningful image alt; decorative art alt="". Respect reduced motion and do not hide essential content behind scroll reveals.
- [ ] Run link/heading checks, keyboard walkthrough and available automated accessibility tooling. Automated pass is not full WCAG certification. Test at 360/390/768/1440 widths, slow network, blocked image/font and JavaScript-disabled public content.
- [ ] Re-run the Task 1 widget baseline suite against the candidate. Its required cases are `/widget/verify` directly and in the actual supported merchant embedding mode discovered from source. Use a local merchant-origin fixture, never weaken CSP/frame restrictions to make the test pass. At 320/390px iframe widths verify no clipped form/actions, usable keyboard focus and error announcements, no public header/footer, and unchanged cancel/completion/parent-message behavior. Assert existing origin validation and consent checks still reject invalid inputs. If iframe mode is unsupported, record that boundary and test the actual supported popup/redirect flow; do not claim embedding support.
- [ ] Add admin smoke tests for authenticated dashboard navigation and a representative student/support view, unauthorized redirect/denial, readable tables at narrow widths (contained table scrolling is allowed), and no public chrome. Re-run existing `admin-support-session.spec.ts` with the new `admin-design-regressions.spec.ts` to preserve session isolation. A passed public-page test cannot substitute for these checks. Keep global CSS/metadata changes scoped; changes affecting widget/admin require these suites before acceptance.
- [ ] Performance implementation: static/server-render hero text, optimize and reserve image space, use responsive sizes, preload only the actual LCP resource where needed, defer below-fold media, minimize font weights, avoid render-blocking third-party widgets. Do not lazy-load the LCP image. Scope style/token changes so authenticated screens do not regress.
- [ ] Field goals: p75 LCP <=2.5s, INP <=200ms, CLS <=0.1, segmented mobile/desktop. Measure candidate and baseline production builds under identical browser/version/viewport/throttling/cache conditions; record at least five cold runs per representative route and median/worst lab results. Local Lighthouse/TBT is not field INP. Exercise menu/FAQ/form interactions for latency; field confirmation remains pending without sufficient real-user data.
- [ ] Project lab budgets: median mobile LCP <=2.5s and CLS <=0.1 on the fixed profile; no unexplained >10% regression in same-route transferred JS or median LCP versus baseline. Record the chosen profile and baseline BEFORE changes. These are project gates, not universal Google thresholds. Do not weaken budgets after a failure without reviewed justification.
- [ ] Use the reproducible performance protocol below, not a dev-server Lighthouse screenshot. Configure and capture its baseline in Task 1 before visual edits; repeat in Task 7. New pages without a baseline get absolute budgets only, not a fictitious percentage improvement.
- [ ] Check fresh-main scripts, then run from worktree root:

```bash
npm --prefix apps/backend ci
npm --prefix apps/web ci
npm --prefix apps/web run test:auth
npm --prefix apps/web run test:browser:typecheck
npm --prefix apps/web run lint
NEXT_PUBLIC_API_URL=http://127.0.0.1:3108 NEXT_TELEMETRY_DISABLED=1 npm --prefix apps/web run build
AWOOF_BROWSER_MODE=production npm --prefix apps/web run test:browser
npm --prefix apps/web run test:browser:microsoft
npm --prefix apps/web run test:public-performance
npm --prefix apps/web run audit:public:candidate
npm --prefix apps/web run audit:public:compare
```

- [ ] NEXT_PUBLIC_API_URL is embedded at build time: changing only the standalone server environment does not retarget an already-built browser bundle. The production browser suite must use the explicit fixture-origin build above. The existing runner stages `.next/standalone`; do not run a simultaneous dev/build process against it. The Microsoft suite launches its own synthetic HTTPS/dev fixture and depends on backend tsx/Express and OpenSSL, not a production Microsoft tenant. Inspect 3107/3108/3443/3444/3445 ownership before running; never kill another task's server. Coordinate a free window or adapt a separate config and every fixture reference consistently. Record ordinary production-browser and Microsoft synthetic-dev results separately.
- [ ] A fresh reviewer checks design coherence, source-backed copy, session/verification regressions, links, metadata and measured performance. Owners fix valid findings with regression tests. Re-run relevant checks after each fix.
- [ ] Final handoff lists implemented routes, screenshots, test commands/results, unresolved legal/contact/backend dependencies, local versus field CWV evidence, exact branch/SHA and whether any PR exists. No merge/VPS deployment under this brief. If later asked to create a PR, include documentation-impact evidence and attach it to the Codex task.

## Reproducible performance protocol

**Coordinator creates:** `apps/web/lighthouse.public.cjs`, `apps/web/scripts/audit-public-performance.mjs`; records tool versions and results in `docs/design/validation.md`. Install Lighthouse as an exact devDependency chosen from the official package at execution, committing the lockfile before baseline collection; reuse that same resolved version and Chrome binary for the candidate. Never compare runs performed with different tool versions. An exact package version is deliberately selected at execution rather than guessed here.

### Executable package-script contract

The coordinator adds these entries to `apps/web/package.json` in Task 1, alongside the runner, fixture and tests. They are new scripts to implement, not claims that the repository already provides them:

```json
{
  "test:public-performance": "node --test scripts/public-performance-fixture.test.mjs scripts/audit-public-performance.test.mjs",
  "audit:public:baseline": "node scripts/audit-public-performance.mjs capture --label baseline",
  "audit:public:candidate": "node scripts/audit-public-performance.mjs capture --label candidate",
  "audit:public:compare": "node scripts/audit-public-performance.mjs compare"
}
```

Runner paths resolve from its own file location, not caller cwd. `capture` checks owned/free ports, starts the deterministic fixture, builds with the test API origin, starts the existing standalone staging runner, waits for readiness, performs the five-run route audit, and terminates only its child processes in finally blocks. No external server-start step is required. The Microsoft fixture may have changed build output; each capture therefore creates its own fresh production build after prior suites exit.

Write raw reports plus `summary.json` under `apps/web/.performance-artifacts/baseline/` or `candidate/`, resolved from the web application root. The coordinator adds `/apps/web/.performance-artifacts/` to the repository-root `.gitignore` during Task 1B. This directory must remain outside Playwright's `test-results` output directory and any other test/build cleanup target. Baseline capture refuses to overwrite an existing baseline. Candidate capture uses a new timestamped run directory and records its path in the candidate summary. Preserve reports as ignored local artifacts; record their paths/hashes and concise results in docs/design/validation.md. Never clean the baseline directory between captures. Both capture and compare use this same artifact root; no fallback to the retired test-results path.

Add an artifact-survival check to validation: record the baseline summary hash, run the ordinary browser suite, then assert the baseline still exists with the same hash before candidate capture/comparison. A missing or changed baseline is a failed gate, not permission to silently recreate it from the candidate build.

`compare` requires both completed summaries. Reject absent/failed routes, missing metrics, mismatched tool/config/dataset hashes or noncomparable delivery modes. Compare baseline routes `/` and `/marketplace`; apply absolute budgets to candidate-only approved public routes. Exit nonzero on a failed budget, incomplete audit or invalid comparison; emit a route-by-route result, not just an aggregate score. Unit tests in `scripts/audit-public-performance.test.mjs` cover median calculation, exact 10% boundary, over-budget values, missing runs/metrics, hash mismatch and new-route absolute checks. Neither skipped tests nor invalid runs count as successful performance verification.

Configuration contract for lighthouse.public.cjs:

```js
module.exports = {
  extends: 'lighthouse:default',
  settings: {
    onlyCategories: ['performance', 'accessibility', 'seo'],
    formFactor: 'mobile',
    screenEmulation: { mobile: true, width: 390, height: 844, deviceScaleFactor: 1, disabled: false },
    throttlingMethod: 'simulate',
    throttling: { rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4 },
    disableStorageReset: false,
  },
};
```

The audit script imports the locked Lighthouse and Chrome launcher packages, launches a fresh Chrome/profile for each run, calls Lighthouse with this config and writes JSON locally. If chrome-launcher is imported directly, pin it as a direct devDependency too. Run five sequential cold-browser runs per route with browser storage reset and a warmed local production server; no parallel test/browser work. Record OS, hardware, Node, Chrome, Lighthouse, exact Git SHA, build env, screen profile and cache policy. Browser-cold/server-warm is the defined profile; do not call it a cold server test.

Routes: `/` and `/marketplace` before and after; `/trust`, `/help`, `/contact`, `/partner`, `/developers` after creation. Legal routes are included only after approved content exists. Before measuring each route, assert successful response, expected h1 and no API-error screen. Capture LCP element, CLS, TBT and script transfer totals per run, plus median/worst results. Keep authentication flows in browser interaction tests, not unauthenticated Lighthouse scores of redirected login pages.

Lighthouse cannot use Playwright's per-page route interception. Implement a local deterministic public API fixture for the actual read requests identified from fresh source and a browser network trace. Give it synthetic fixed university/deal responses and deny unexpected paths; never proxy to live services. The coordinator owns this fixture (`apps/web/scripts/public-performance-fixture.mjs`), and records the response dataset/hash. Use identical fixture responses before/after. If a route is measured in a deliberately empty state, label that state; do not treat it as representative populated-page performance.

Fixture completeness is a gate, not an optional refinement:

- Allow browser Origin `http://127.0.0.1:3107` explicitly on fixture responses; ports 3107 and 3108 are different origins. Support OPTIONS for the methods/headers actually sent by the checked-in API client (including Content-Type), set Vary: Origin, and reject unapproved origins/preflights. Do not use wildcard credentialed CORS. Credential support is off unless a tested fixture flow requires it. These are test-only fixture settings, not production policy changes.
- Bundle synthetic product/vendor image bytes under `apps/web/tests/fixtures/public-performance/`, with fixed dimensions and a recorded content hash. Serve the exact paths returned in synthetic API JSON, with correct content types and deterministic cache headers. No live product images, random URLs or third-party fallbacks. Test the real Next image optimization path: verify its remote/local image rules accept the chosen fixture image source, without broadly relaxing production remotePatterns or local-IP protections. If that cannot be achieved safely, use source-supported same-origin static fixture image paths consistently for both builds and disclose the measurement limitation.
- Add `apps/web/scripts/public-performance-fixture.test.mjs` and run it with `node --test`: assert approved/disallowed origins, successful preflight, stable query-dependent API responses, successful image bytes/dimensions, missing-image 404 and unknown-path refusal. Include the fixture and asset hashes with every measurement batch.
- Reject a performance run on failed required API/image/font requests, CORS errors, broken image natural dimensions or an unexpected external resource. Collect browser/network failures as well as fixture logs; a rendered h1 alone is not success. Baseline/candidate must use the same seeded dataset and image delivery mode. Explicitly distinguish intentional negative tests from valid performance runs.

For this audit reserve 3107/3108, start the fixture on 3108, build using the explicit build-time API origin above, then start the existing `apps/web/scripts/serve-browser-production.mjs` on 3107 with its configured environment. The coordinator shuts down only its own child processes afterward. The performance script must test its result aggregation with synthetic JSON: five known LCP values produce the expected median, missing audits fail the run, a missing route never becomes a zero score, and >10% comparable regression fails. Record the baseline commit/results before any implementation; do not reset the source checkout to reconstruct them.

This lab profile is a repeatable regression tool, not a simulation of every Nigerian mobile network or proof of field p75. Real-user INP/CWV requires separate consent-respecting operational measurement; no new analytics integration is authorized by this design plan.

## Revision 2 review closure

1. Foundation tests now use an existing route; new-destination checks are deferred to their owning tasks.
2. Baseline setup now includes backend dependencies, Chrome/OpenSSL, fixture ports and build-time API configuration.
3. Foundation owner explicitly replaces the marketplace footer before handing home ownership to the page worker.
4. Only the coordinator stages and commits; worker Git-index races are prohibited.
5. Performance now has explicit configuration, routes, deterministic fixtures, version locking and baseline rules.

## Revision 3 review closure

1. Performance fixtures now specify CORS/preflight handling, deterministic image assets, image-optimizer compatibility and network failure gates.
2. Shared design changes now require widget and admin regression tests, including constrained embedded layout where supported and unchanged authorization/session boundaries.
3. Metadata helper/registry contracts move into foundation work before page implementation; Task 7 validates final rendered output rather than inventing the contract after the swarm has built pages.

## Revision 4 review closure

1. Task 1 now owns widget/admin fixture creation, baseline capture and checks before any shared style/layout change; Task 7 repeats the existing suites.
2. Performance fixture/aggregation tests, candidate capture and budget comparison are explicitly invoked in final validation. Baseline capture is a separate mandatory pre-implementation step, with immutable reports and failing exit codes for incomplete/noncomparable results.

## Revision 5 review closure

1. Two responsive, isolated runnable localhost prototypes replace ambiguous screenshot-only concept delivery.
2. Explicit named-version approval is a hard stop before Task 1B and Tasks 2–7; prototype permissions do not permit product edits.
3. Extensive regression/performance infrastructure moves after the design decision but remains mandatory before shared production-code changes.

## Revision 6 review closure

1. Performance reports now use an ignored `.performance-artifacts` directory outside Playwright cleanup, with a baseline-survival check and consistent capture/compare paths.
2. Task 1B explicitly reads and preserves the already-approved research, design and approval records; only baseline evidence is newly created there.

## Self-review and completion criteria

Plan coverage: research independence → Task 1; shared system → Task 2; positioning/home → Task 3; trust/help/legal readiness → Task 4; merchant/university/developer → Task 5; in-app consistency → Task 6; SEO/H1-H3/accessibility/CWV/regression → Task 7. Backend implementation is explicitly separate and conditional UI cannot ship ahead of its contract.

Done means approved designs are implemented, reviewed and tested at the stated scope, with remaining external gates disclosed. It does not mean a mockup, green Lighthouse score or merged source proves live university integration, merchant enforcement, legal approval or field performance. Persist through fixable implementation issues; pause only the affected workstream when new authority or a real external dependency is required.
