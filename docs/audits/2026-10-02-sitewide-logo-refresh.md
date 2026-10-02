# Site-wide Awoof logo refresh

Reviewed: 2026-10-02. Base: `origin/main` at `01181472b08b16d91aa32180d8ef15fbb2cc46ba`. Branch: `codex/awoof-sitewide-logo`. Source/local validation only; merge, deployment and live cache verification remain pending.

## Artwork and coverage

The existing blue rounded Awoof artwork supplied in Downloads has the graduation cap and student/check badge. Its previously prepared wordmark and clean square icon were reused from the isolated local logo-refresh branch; the older branch's application files were not copied wholesale. Original artwork and other worktrees remain intact.

`apps/web/src/app/components/logo.tsx` renders blue/white wordmarks and the compact icon. Public navigation/footer, homepage sample pass, authentication screens and shared-logo callback consumers inherit it. Separate marketplace, product-detail, search, student-profile and dashboard placements were converted. The collapsed sidebar uses the full symbol. Source search found no references to the legacy PNG logo paths; unused legacy assets and the old favicon were removed. No application page or API contract was added.

The clean square icon is served through Next's `icon.png` and `apple-icon.png` conventions. The logo is decorative branding, not an account-control or enrollment result; existing assurance/result labels and authorization behavior are unchanged.

The marketplace QR contained the old logo. A new unbranded QR was generated from its exact decoded payload using the native QR encoder. Original and replacement decode to the same destination, including the replacement rendered at 112px in the browser. This does not establish app-store availability or validate the external destination's ongoing service.

## Validation

- Fresh web `npm ci`, typecheck and focused lint passed. Seven existing marketplace/search hook/redirect warnings remain; no lint errors were introduced.
- Fresh read-only source review found no confirmed actionable findings. Authentication, business logic, navigation and accessible Awoof labels are preserved.
- All 28 branding/public/student/merchant/admin browser cases passed, using the existing synthetic API fixtures.
- Local homepage/header and student-login presentation inspected. At 360px there is no horizontal overflow; the header wordmark renders at 128 by 43px. White-on-blue and blue-on-light wordmarks inspected at their actual sizes.
- Browser HTML advertises the new browser-tab and Apple touch icons without the legacy favicon override. Browser tests exercise both icon discovery and asset responses.
- Production web build passed.
- Screenshots under `output/playwright/` are local review artifacts, not production evidence. The Next development badge was hidden only for the login preview. Marketplace requests in the standalone preview used the unavailable loopback API; browser suites use synthetic API fixtures.

## Documentation impact

1. User-visible behavior: updated brand artwork across existing public/auth/student/merchant/admin pages, browser tabs, Apple bookmarks and marketplace QR artwork.
2. Updated this report and `docs/public-trust-pages.md`. Public page text, privacy/terms, help, merchant/developer instructions and legal schedules need no copy change because authentication, verification, data handling, sharing, retention, support destinations and API contracts are unchanged.
3. Source references and local validation are recorded here. No new institution/provider partnership, enrollment, availability or security claim is introduced.
4. Accessible Awoof labels, existing keyboard links, responsive layouts, wordmark proportions and icon discovery checked locally; existing browser checks cover the affected journeys.
5. Merge, deployment and live browser/CDN cache verification remain pending. No new legal or operational commitment is made.

## SEO history assessed

Merged PR #45 (`4074987`) added the public page metadata registry and builder, including unique titles/descriptions, self-canonical and social metadata, plus `robots.ts` and sitemap updates. Merged PR #46 (`889bb39`) added legal-page canonical/indexing metadata and sitemap entries. These are SEO foundations within broader implementation PRs. No dedicated site-wide SEO PR appeared in the repository's first 60 PRs reviewed. This branding change does not alter crawl directives, canonical URLs or content strategy, and is not an indexing/ranking or full SEO-audit claim.
