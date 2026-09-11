# Student profile control repair implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the reproduced nested-button defect from the student profile and verify one correctly named, keyboard-operable control on desktop and mobile.

**Architecture:** Keep the existing profile row renderer and its local boolean state. Render the visual toggle as non-interactive spans inside one native button with switch semantics; do not introduce a new theme framework or change account authority. Reuse the real rendered browser suite and its exact synthetic API fixtures, and allow its existing production launcher to finish cleanup through an explicit bounded graceful shutdown.

**Tech Stack:** Existing Next.js 16, React 19, TypeScript, Playwright and installed Chrome; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-06-student-verification-ui-route-notes.md`, section Rendered defects observed during browser-session validation. This plan implements only its bounded markup/keyboard repair, not the separate assurance UI or QR observation. Official reference checked 2026-09-06: https://www.w3.org/WAI/ARIA/apg/patterns/switch/.

**Validation prerequisite:** Root observed eight generated Awoof production stages left behind after otherwise passing tests, including its own exact4afa3b0 run. The launcher cleanup handlers work on graceful signals, but Playwright configuration omits gracefulShutdown and the documented default is process-group SIGKILL. Add only the configuration field below; this is test lifecycle setup needed for repeated rendered validation, not a reopening of accepted R13/R14 or a general runner rewrite. Official reference checked: https://playwright.dev/docs/test-webserver.

## Global Constraints

- Keep the existing TypeScript/Next/Express/PostgreSQL stack.
- Authentication, student assurance, and merchant permission are separate.
- A permanent `users.verification_status` flag is compatibility/display data, not an authorization source.
- No VPS deployment, merge or push as part of this implementation run.
- Preserve current profile visual language, routes, sign-out confirmation and all-role session behavior. Do not change theme persistence, global CSS or actual theme application in this markup correction; existing local toggle state is not proof of a delivered dark-theme feature.
- No new dependency, shared dependency write, real environment, live API/provider/payment call or worker-spawned agent.
- No token, password, OTP or submitted signup claims in navigation URLs, logs, screenshots or traces. Use the existing synthetic loopback fixtures and isolated Chrome contexts; keep automatic screenshots/video/traces off. Any optional visual evidence must crop the control only and be outside the repository.
- Work only in the existing isolated source checkout after its prior final review gate passes. Preserve other changes; no concurrent source owners. Parent owns planning/report coordination, Terra owns source, Astra reviews.
- Check at least 3 GiB free before build/server/browser; no unrelated cleanup. Existing unchanged public Google font build fetch is allowed. Default Turbopack build has a reproduced local worker-port EPERM; a one-off `npm run build -- --webpack` is approved for local production validation, keeping source build settings unchanged. Report default-build/CI/VPS parity separately.

### Task 1: Render one accessible profile switch and prove the fix

**Files:**
- Modify `apps/web/src/app/student/profile/page.tsx`: only the row renderer around the existing Dark mode toggle.
- Modify `apps/web/tests/browser/auth-session.spec.ts`: add two focused desktop/mobile profile-control cases using existing private helpers in that file.
- Modify `apps/web/playwright.config.ts`: only the production-mode gracefulShutdown field specified below.
- No changes to auth runtime, browser fixture authority, production launcher script, package files, other profile features or backend.

**Interfaces:**
- Consume existing `darkMode:boolean`, `setDarkMode`, `MenuItem.trailing === 'toggle'`, row `content` and `className` in the profile page.
- Consume the existing browser helpers `seedSession(page,'student')`, `installSyntheticApi(page)`, `collectBrowserFaults(page,api)` and `assertCleanFixture(api,faults)` in the current spec file. They must remain actual browser/fixture helpers, not source-text checks or mocked component replacements.
- Produce exactly one native button with `role="switch"`, stable accessible name `Dark mode` and `aria-checked` reflecting the local boolean. Native click/Space/Enter toggle once. Links and Sign out remain unchanged.

- [ ] **Step 0: Verify and correct production-test teardown before more staged runs.** Source BASE is4afa3b0e7ea64de23f9cd950ad5d1473bf4ec016, whose fresh Webpack artifact and23production tests parent independently validated. Snapshot only direct children of the actual os.tmpdir with the exact awoof-browser-production- prefix, then run one existing production login case. Before changing config, establish RED by observing the new generated stage remains after the CLI exits and no3107listener remains; this is lifecycle evidence, not an application failure. Record exact path, artifact build ID and source marker; do not delete arbitrary matching directories. Parent separately identified and cleaned historical stages, and you own only new copies from your run.

```sh
AWOOF_BROWSER_MODE=production NPM_CONFIG_USERCONFIG=/dev/null NEXT_TELEMETRY_DISABLED=1 npm run test:browser -- --grep '^student login keeps a safe return destination'
```

Add this field inside existing webServer without modifying dev shutdown behavior, test assertions/timeouts, launcher script or runtime source:

```ts
gracefulShutdown: browserMode === 'production'
  ? { signal: 'SIGTERM', timeout: 10_000 }
  : undefined,
```

Run the identical focused production case and confirm no newly created stage or server remains after exit. Also run the same case with explicit one-off CLI `--timeout=1 --max-failures=1` to induce an intentional test failure after server startup, then confirm cleanup still completes. That nonzero exit is expected fault injection, not application RED or a passing functional case; never keep the1ms override in source. Re-read the current supported CLI options first. The10s graceful budget is finite and lets the existing child-close cleanup run; it cannot promise cleanup after an external forced SIGKILL or process crash. Clean a generated RED-run copy only after its exact resolved path, provenance and no active handles are verified. No broad directory cleanup or install. Report before/after stage inventories and actual outcomes; if the single field is insufficient, report the demonstrated cause before expanding ownership.

- [ ] **Step 1: Verify the reviewed base and baseline.** Record exact source HEAD after the parent passes the shared-session final review. Expect clean `codex/awoof-browser-harness-fix4` at the supplied commit. Check disk and owned dependencies. Do not install/recreate worktrees. Inspect only the existing row and helper signatures before writing the tests. The historical dev baseline was14/17 with the same invalid nesting in three profile flows; production17/17 did not expose that development diagnostic. The final shared-session fix adds six real consumer regressions: preserve all23 existing cases before adding this task's two cases. Parent supplies exact accepted base/results at dispatch; this paragraph is not a claim of new full-suite execution.

```sh
git status --short --branch
git rev-parse HEAD
df -k .
```

- [ ] **Step 2: Write a focused real-browser RED test before changing the page.** Add desktop and mobile cases within the existing spec so its fault/lifecycle helpers are reused. The break being caught is nested interactive controls or a control whose accessible state/keyboard activation does not match the real local UI. Do not assert source strings. Keep this test shape and literal state sequence:

```ts
for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`profile dark-mode control is a single keyboard switch on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await seedSession(page, 'student');
    const api = await installSyntheticApi(page);
    const faults = collectBrowserFaults(page, api);
    await page.goto('/student/profile');
    await api.waitForCurrentUserCompleted(1);
    await expect(page.getByText('student@approved.test', { exact: true })).toBeVisible();
    await expect(page.locator('button button')).toHaveCount(0);

    const control = page.getByRole('switch', { name: 'Dark mode', exact: true });
    await expect(control).toHaveCount(1);
    await expect(control).toHaveAttribute('aria-checked', 'false');
    await expect(control.locator('button, a[href], input, select, textarea, [tabindex]')).toHaveCount(0);
    await page.getByRole('link', { name: 'Notifications', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(control).toBeFocused();
    await page.keyboard.press('Space');
    await expect(control).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Enter');
    await expect(control).toHaveAttribute('aria-checked', 'false');
    await control.click();
    await expect(control).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Receipts', exact: true })).toBeFocused();
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(24);
    expect(box!.height).toBeGreaterThanOrEqual(24);
    await assertCleanFixture(api, faults);
  });
}
```

Run the focused cases with `AWOOF_BROWSER_MODE=dev NPM_CONFIG_USERCONFIG=/dev/null NEXT_TELEMETRY_DISABLED=1 npm run test:browser -- --grep 'profile dark-mode control'`. Use required scoped permission for loopback/browser, no other server on3107. Expected RED is the real nested button count/diagnostic, not dependency/import/server startup failure. Capture that command, failure and source cause before touching page source. If existing link focus order differs from the observed renderer, inspect the actual safe DOM and preserve the test's Tab-in/Tab-out requirement; report any corrected selector.

- [ ] **Step 3: Apply the smallest valid markup correction.** Change the left content group's `div` to a flex `span` so the new native button contains phrasing content. Replace the inner toggle button with an `aria-hidden="true"` span retaining existing knob classes; remove its onClick/type/aria-label because it is decorative. Before the href branch, return the single toggle row control:

```tsx
if (item.trailing === 'toggle') {
    return (
        <button
            key={item.label}
            type="button"
            role="switch"
            aria-label="Dark mode"
            aria-checked={darkMode}
            onClick={() => setDarkMode((previous) => !previous)}
            className={`w-full text-left ${className} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1D4ED8]`}
        >
            {content}
        </button>
    );
}
```

Use the existing row class and visual knob state; no manual key handlers on a native button, no double state update, no new storage/theme effect. Keep links and ordinary action-row code below this branch untouched. Decorative icons must not add a changing accessible name.

- [ ] **Step 4: Run focused GREEN, then complete browser regression in both modes.** First run the same focused dev command and confirm both controls pass with zero application console/page faults and correct Tab/Space/Enter/click behavior. Then run the full dev suite once; target25/25 (the existing23 plus two new cases), specifically closing all three known profile nesting failures while preserving six new session races. Build fresh application output after the page change with the approved explicit loopback API and supported Webpack option, then run the full production suite once; target25/25. Never reuse the old production artifact as proof of the page fix. Keep synthetic API errors narrowly modeled; no warning suppression, skipped tests or arbitrary timeout increases. Capture one credential-free crop of the focused switch if visual focus needs proof; do not capture profile identity or credentials.

```sh
AWOOF_BROWSER_MODE=dev NPM_CONFIG_USERCONFIG=/dev/null NEXT_TELEMETRY_DISABLED=1 npm run test:browser
NEXT_PUBLIC_API_URL=http://127.0.0.1:3108 NEXT_TELEMETRY_DISABLED=1 NPM_CONFIG_USERCONFIG=/dev/null npm run build -- --webpack
AWOOF_BROWSER_MODE=production NPM_CONFIG_USERCONFIG=/dev/null NEXT_TELEMETRY_DISABLED=1 npm run test:browser
NPM_CONFIG_USERCONFIG=/dev/null npm run test:auth
NPM_CONFIG_USERCONFIG=/dev/null npm run test:browser:typecheck
./node_modules/.bin/tsc --noEmit --incremental false
NPM_CONFIG_USERCONFIG=/dev/null npm run lint -- src/app/student/profile/page.tsx tests/browser/auth-session.spec.ts playwright.config.ts
git diff --check
```

Run from apps/web, with fresh guards and no concurrent server/build. Generated next-env path changes from dev runs must not enter the commit; restore only generated drift with apply_patch after servers stop. Record inherited Node color-environment warnings distinctly, not as browser errors or pristine output.

- [ ] **Step 5: Self-review, commit only the three owned files, and report.** Verify no other application/config/dependency changes, no listener/new stage remains after full production execution, and the UI's actual local-only behavior is stated honestly. Append exact RED/GREEN commands, lifecycle success/fault-injection outcomes, full dev/production case totals, source/base/head and residuals to the report path supplied by parent. Commit the scoped page, tests and one-field config setup, never push. Parent independently validates and Astra reviews the exact delta before acceptance.

```sh
git diff --stat
git status --short
git add -- apps/web/src/app/student/profile/page.tsx apps/web/tests/browser/auth-session.spec.ts apps/web/playwright.config.ts
git commit -m "fix(web): remove nested profile toggle buttons"
```

## Plan self-review

One task owns the only shared files; there are no cross-task interface dependencies inside this plan. The row has one action before and after the repair, but removes the invalid nested target and makes state explicit. The literal false/true/false/true sequence catches double activation and stale updates, while Tab-out catches accidental extra focus targets. Existing whole auth cases preserve role/logout/account replacement coverage. No full-theme, verification, widget, backend or default-build claims are made. The prior shared-session final review must pass before dispatch.
