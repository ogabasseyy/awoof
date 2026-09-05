# Widget browser validation inventory

Read-only Terra inventory, checked during remediation. No test package was installed and no live application/provider was contacted.

## Repository facts

- apps/web has dev/build/start/lint scripts, and apps/widget has build/build:dev/dev scripts. Neither contains an existing browser/DOM test suite, Playwright/Vitest/Jest/Cypress configuration or test fixture directory.
- @playwright/test appears in the web lockfile only as an optional Next peer, not an installed project test dependency. Known linked dependency paths lack @playwright/test, playwright, vitest, jest, jsdom, @testing-library/react and msw. Next and Rollup are installed. Chrome is installed; no project Playwright browser installation was established.
- Backend node:test/tsx is usable but does not execute browser DOM, iframe or popup behavior. A source search or passing build is not browser-flow evidence.

## Tool versus project test infrastructure

The session has computer/browser automation tools for interactive checks. Absence of a project Playwright dependency is not evidence that all browser access is unavailable. The legacy bundled Browser skill path referenced by codex-in-app-browser had no readable SKILL.md at discovery; do not invent its runtime API or treat a package-directory stub as a working Browser plugin. Current CUA entry-point instructions remain the appropriate documentation if using that tool later.

The frontend-testing skill requires rendered interaction evidence, and the CLI Playwright skill does not allow silently pivoting to committed test specs without user direction. An asynchronous owner question therefore asks whether to add development-only Playwright plus a repeatable signup/widget/CI suite or use manual browser checks for now. No answer yet. Backend remediation continues independently. Do not install through existing node_modules symlinks or assume the owner agreed from the recommended option being preselected.

## Proposed repeatable suite if approved

One development test dependency and a small local fixture harness are sufficient; isolate its actual dependency directory before installation, keep old symlink targets intact, and use explicit worktree-local dependency ownership. Resolve exact supported version from official documentation/current registry at implementation. A package entry alone does not prove browser runtime compatibility; run it and record the real browser/version.

Run local Next and a built-widget synthetic merchant HTTP fixture on distinct loopback ports, for example Awoof 3001 and merchant4173 only after checking they are free. Route all API requests to synthetic responses or a loopback fixture API; unexpected external requests fail. Never hit production, PostgreSQL/Redis, Brevo, WhatsApp or a university from UI tests. Real backend database/security tests remain separate and complementary.

Required actual interactions: signup/request/OTP/session/return; signed-out iframe login return and account switching; accept only exact Awoof origin plus tracked iframe/popup WindowProxy plus nonce; reject same host/different port, wrong source and wrong nonce; blocked iframe storage with functional user-clicked top-level fallback; correct parent versus opener handling and cleanup of stale/cancelled/reinitialized flows; explicit merchant consent before issuance; withdrawal denies new assertion; mobile viewport; Tab/Shift+Tab/Escape and focus return; OTP label/autocomplete/paste and announced errors. Use real iframe/popup MessageEvents and focused-control evidence, not source-string assertions. Synthetic eligibility success in a browser does not replace real server authorization tests.

Current surfaces: apps/widget/src/widget.js message listener, modal.js dialog lifecycle, apps/web/src/app/widget/verify/page.tsx parent/opener response, student register page's OTP stages and redirect, AuthContext and lib/auth.ts/lib/api-client.ts storage behavior. The actual UI rewrite must remove global student ID and browser-invented assurance/time claims from merchant callbacks.

Record page identity, meaningful content, no framework overlay, relevant console errors, actual state after target interaction, desktop/mobile screenshots where useful. Keep temporary traces/screenshots outside source unless explicitly requested as committed artifacts. CI logs/counts, interactive browser proof, and production tests remain distinct claims.
