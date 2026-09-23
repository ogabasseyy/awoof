# Task 1B execution baselines

Worktree: `/Users/mac/Downloads/Awoof-design-upgrade`, branch
`codex/awoof-design-upgrade`. Baseline commit (Task 1A): `30f0dcb`.
Task 1B work below is uncommitted until the baseline-tooling commit.

## Environment

- Node v24.11.1, npm 11.10.1, LibreSSL 3.3.6, Google Chrome 152.0.7977.84
- Resolved: next 16.3.4, react 19.2.8, @playwright/test 1.63.0,
  lighthouse 13.5.0 (exact), chrome-launcher 1.2.1 (exact)
- Installs: `npm --prefix apps/backend ci` (343 pkgs), `npm --prefix apps/web ci` (410 pkgs)
- Ports 3107/3108/3443–3445 verified free before runs (3117 held this
  session's prototype preview server only). Disk ~5Gi free throughout.

## Regression baselines (pre-visual-change)

- New: `apps/web/tests/browser/widget-design-regressions.spec.ts` (4 tests),
  `apps/web/tests/browser/admin-design-regressions.spec.ts` (4 tests).
- Command: `npm --prefix apps/web run test:browser -- widget-design-regressions.spec.ts admin-design-regressions.spec.ts admin-support-session.spec.ts` → 13/13 pass.
- Full ordinary suite: `npm --prefix apps/web run test:browser` → **152/152 pass** (4.2m, dev mode).
- Typecheck `test:browser:typecheck` clean.
- Source boundaries pinned: `/widget/verify` is a static unavailable notice —
  no iframe/popup/redirect flow exists; admin dashboard owns a Topbar header
  (dashboard chrome, not marketing chrome); marketing chrome identified by the
  footer string "Don't miss the next big Awoof".

## Performance baseline (lab, immutable)

- Harness: `apps/web/lighthouse.public.cjs` (plan §config contract),
  `apps/web/scripts/audit-public-performance.mjs`,
  `apps/web/scripts/public-performance-fixture.mjs`, image fixtures under
  `apps/web/tests/fixtures/public-performance/` (800x450 products, 200x200 logo).
- Unit gate `test:public-performance`: 16/16 pass (fixture CORS/data/images/
  denials/hash-stability + aggregation/median/boundary/mismatch/new-route checks).
- Capture: `npm --prefix apps/web run audit:public:baseline` → 10/10 runs,
  production build `NEXT_PUBLIC_API_URL=http://127.0.0.1:3108`, standalone runner
  on 3107, fixture on 3108, fresh Chrome profile per run, mobile 390x844
  simulate (rtt150/1638kbps/cpu4), browser-cold/server-warm.
- Summary: `apps/web/.performance-artifacts/baseline/summary.json`
  sha256 `b6e1b30cf683bb26d5bee6eea0217995810faf884278c25e8b44bbcabeea7589`
  (raw `lhr-*.json` alongside; directory git-ignored, outside `test-results`).
- Medians: `/` LCP 5557ms, CLS 0, TBT 60ms, script 366598B, LCP element
  `div#hero > img.absolute` (cloud art); `/marketplace` LCP 4015ms, CLS 0.010,
  TBT 48ms, script 369005B, LCP element `h1.text-3xl`.
- Fixture dataset `1cc4ca33…bbd405`; config `5ce8164b…508fb1c`; delivery
  `api-origin-unoptimized` (marketplace images use unoptimized next/image, so
  no optimizer remotePatterns change was needed — disclosed limitation: none,
  this is the real delivery path).
- Corrected captures (disclosed): first capture recorded Chrome as
  "unresolved" (launcher API misuse) and missed LCP elements (Lighthouse 13
  moved them to `lcp-*-insight` audits). Tooling was fixed, unit-tested, and
  the summary rebuilt from the same raw LHRs. No baseline gaming: medians
  identical across captures.

## Artifact-survival check

Baseline summary hash recorded before the ordinary suite (`b6e1b30c…`), full
152-test suite run, hash re-verified identical after. PASS.

## Baseline screenshots

`docs/design/screenshots/baseline/`: home, marketplace, widget-verify at
360/390/768/1440 (12 PNGs, production build + fixture, h1-asserted).
Captured via `apps/web/scripts/capture-route-screenshots.mjs`.

## Task 7 candidate evidence (2026-09-21)

- Candidate capture: 35/35 runs across `/`, `/marketplace`, `/trust`, `/help`,
  `/contact`, `/partner`, `/developers` (same harness, dataset, and Chrome 152).
- Compare verdict: `/` PASS (LCP 5557ms → 2031ms, −63%; script −11%), all five
  new routes PASS absolute budgets (LCP ≤2.1s, CLS 0). `/marketplace` FAILS the
  absolute LCP budget (4010ms vs 2500ms) — preexisting (baseline 4015ms), route
  not materially altered here (footer-only), zero regression (−0.1%).
  Not a sign-off blocker per plan; recorded as carryover work.
- Link crawl on production build: 13/13 public links resolve, zero 404s.
- Lighthouse a11y/seo (run 1): 1.0/1.0 on all new pages and home;
  marketplace a11y 0.96 on preexisting contrast issues in untouched deal-card
  internals (not shell/footer).
- Candidate screenshots: `docs/design/screenshots/task7-candidate/` (8 routes ×
  4 widths, committed). Reviewed mobile + desktop renders.
- Independent review (3 fresh agents, file-delivered reports): 1 FAIL
  (partner `aria-labelledby` self-reference — fixed), typo + `pre` keyboard
  scroll + error-list completeness + 44px nav targets + marketplace metadata
  (wrong-page OG canonical — fixed via registry/layout export) +
  ScrollToHash reduced-motion/focus — all fixed and re-verified.
  Preexisting observations recorded, not introduced here: vendor tabs pattern,
  icon-only copy buttons, dashboard drawer/nav announcements, profile mobile
  back-link name, marketplace contrast/copy (P1/P2), no robots file.
- Full suite after fixes: 180/180 browser + 56/56 auth + 16/16 perf-unit.
  Baseline summary hash re-verified unchanged (`b6e1b30c…`).

## Remix re-verification (2026-09-21, sha `18ad554`)

- Candidate capture: 35/35 runs across all 7 public routes on the remix
  HEAD (same harness/dataset/Chrome 152 as Task 7; app served on 3127 in an
  isolated worktree because the owner's preview holds 3107 — ports only,
  methodology unchanged). Evidence:
  `docs/design/evidence/candidate-remix-18ad554-summary.json`
  (raw 35 LHRs remain git-ignored by design).
- Compare verdict: `/` PASS (LCP 5557ms → 2047ms med, −63%; script −10.5%),
  all five new routes PASS absolute budgets (LCP ≈2.03s, CLS 0).
  `/marketplace` FAILS absolute LCP (4031ms vs 2500ms) — preexisting
  (baseline 4015ms, +0.4%, inside the 10% regression tolerance), route not
  materially altered. Recorded as carryover, not a sign-off blocker per plan.
- Remix homepage LCP element is now `p.remix-lead` (was `h1`); median LCP
  2047ms vs 2031ms pre-remix — the restoration did not regress lab LCP.
- Lighthouse run-1 scores: home + 5 new routes perf 0.98–0.99, a11y 1.0,
  seo 1.0, color-contrast pass. Marketplace a11y 0.96 on the same
  preexisting deal-card contrast fails (slate-500/600 small text on tints,
  emerald-500/white 11px badge); seo 1.0, perf 0.86. Deal-card internals
  untouched by this work; fix needs owner design input (P1/P2 carried).
- Lab INP risk proxy: TBT medians 50–60ms on all routes (good threshold
  <200ms), JS 277–364KB. Field INP/CWV cannot be established in lab: no
  RUM pipeline exists in the repo (no web-vitals/Analytics wiring), so a
  production CWV pass requires post-deploy real-user measurement.
- Responsive/keyboard: new `public-responsive-keyboard.spec.ts` (20 tests)
  covers 320px + 768px on all 7 routes, a 200%-zoom equivalent viewport,
  overflow with the mobile menu expanded, keyboard-only menu toggling, and
  rendered focus outlines. Full suite 202/202 accounted green (21 mid-run
  `page.goto` timeouts under disk starvation, all cleared on re-run; zero
  assertion failures). `src/app/robots.ts` added (allow-all + sitemap);
  `/robots.txt` and `/sitemap.xml` verified rendering.
- Baseline summary hash re-verified unchanged (`b6e1b30c…`).

## Marketplace LCP + contrast fixes (2026-09-21, sha `fdad422`)

- Root causes (researched before fixing): the hero H1 ships in SSR HTML
  but a framer-motion `FadeIn` (`opacity: 0` until hydration) gated its
  paint on JS execution; four text/background pairs failed WCAG AA
  (page-bg slate-500 labels 4.43:1, inactive pills blended 3.44:1 at 70%
  opacity, emerald-500/white badge 2.54:1).
- Fixes (`0dd4111`, all in `marketplace/page.tsx`): hero renders without
  the entrance wrapper (below-fold motion kept); labels to slate-600
  (7.06:1), inactive pills to slate-800 (blended 5.33:1, distinction
  kept), badge to emerald-700 (5.48:1). Passing pairs left untouched.
- First re-audit: marketplace LCP 4031ms → 2860ms med; contrast fixed
  (a11y 1.00, 0 failing nodes × 5 runs). Blocking experiments ruled out
  webfonts and API/prefetch shaping as the remaining sim driver; runs
  were bimodal (2265 vs 2861ms) while real-condition runs held ~2.1s.
- Second cut (`fdad422`): `prefetch={false}` on deal-card and
  browse-more links (7+ wasted `_rsc` requests per visit); primary
  navigation keeps prefetch. Final capture: marketplace LCP **2259ms
  med (2258–2260 all runs)** — variance gone, budget passed.
- Compare verdict: **7/7 PASS** (first clean sweep). Lighthouse run-1:
  perf 0.99, a11y 1.00, seo 1.00, contrast pass on all 7 routes.
  Evidence: `docs/design/evidence/candidate-marketplace-fix-fdad422-summary.json`.
- Full browser suite 202/202 green on the fix commits; baseline summary
  hash re-verified unchanged (`b6e1b30c…`).

## Release blockers carried forward (owner decisions)

- Legal pages (`/privacy`, `/terms`) unpublished — blocked, no placeholder.
- Public inbox/phone: none offered; support-owner decision needed before adding.
- ~~Marketplace LCP (4.0s) and a11y (0.96) preexisting over-budget items.~~
  RESOLVED `fdad422`: LCP 2259ms med, a11y 1.00 (see section above).
- Enrollment-source coverage per institution unverified; no per-school promises made.

## Preexisting findings (not caused by this work)

- `[browser] Image "/images/awoofLogo.png" width/height aspect warning` on
  several specs — preexisting, recorded.
- Lab LCP on both baseline routes exceeds the 2.5s project budget — expected
  for the current cloud/phone hero; budgets gate the candidate, not the baseline.
- Homepage shows unverified download buttons and travel-discount copy —
  content risks already flagged in `docs/design/research/quality.md`.
