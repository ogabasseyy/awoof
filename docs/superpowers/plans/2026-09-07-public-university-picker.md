# Public university picker repair implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing university selector usable with keyboard and touch, without involving browser-session authority in a public directory lookup.

**Architecture:** Keep the existing component and public props. Use a manually selected editable combobox with DOM focus remaining on its input, controlled identity coming from the parent, and a synchronous blur close. Extend the existing synthetic browser fixture for this public endpoint and reuse its fault assertions; leave signup requests, verification policy and widget authorization untouched.

**Tech Stack:** Existing Next.js16, React19, TypeScript, Axios, Playwright1.63.0 and installed Chrome; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-05-signup-ui-repair-notes.md`, Required integration contract and Continued consumer inspection2026-09-07. The complete signup integration is a later independent plan; this plan covers only the shared picker dependency. W3C reference checked2026-09-07: https://www.w3.org/WAI/ARIA/apg/patterns/combobox/.

## Global Constraints

- Keep the existing TypeScript/Next/Express/PostgreSQL stack.
- Authentication, student assurance, and merchant permission are separate.
- A permanent users.verification_status flag is compatibility/display data, not an authorization source.
- Preserve the public props value?:string, onChange(id:string|null,university:University|null), error?:string, required?:boolean and the current visual language.
- No VPS deployment, merge or push as part of this implementation run.
- No new dependency, shared dependency write, real environment, live API/provider/payment call or worker-spawned agent.
- No token, password, OTP or submitted signup claims in navigation URLs, logs, screenshots or traces. Synthetic loopback127.0.0.1:3107/3108 only, isolated installed Chrome, automatic screenshots/video/traces off.
- Work only in the existing isolated source checkout after the profile-control final review passes. Preserve other changes; no concurrent source owners. Parent owns planning/report coordination, Terra owns source, Astra reviews.
- Check at least3GiB free before build/server/browser. Existing unchanged public Google font build fetch is allowed. One-off npm run build -- --webpack is approved for local validation; do not change default build settings or claim CI/VPS parity.

## File responsibilities

| File | Responsibility |
| --- | --- |
| apps/web/src/components/forms/UniversitySelect.tsx | Public directory fetch, controlled institution identity, combobox keyboard/pointer interaction and accessible local errors |
| apps/web/tests/browser/browser-assertions.ts | Move the existing synthetic HTTP-error classifier, browser-fault collector and clean-fixture assertion here without changing behavior |
| apps/web/tests/browser/auth-session.spec.ts | Import the moved helpers; existing cases and assertions remain unchanged |
| apps/web/tests/browser/fixtures.ts | Add only the university-directory fixture, response control, lifecycle and credential-presence evidence; preserve all existing authentication paths |
| apps/web/tests/browser/university-select.spec.ts | Real signup/widget university-step interactions; no production test page or component mock |

### Task 1: Repair the public directory selector and its actual consumers

**Files:** Modify/create exactly the five files above. Do not change signup/widget page source, AuthContext, shared runtime clients/storage, backend, package files, launcher or Playwright configuration. Read apps/web/AGENTS.md and installed Next testing guidance before implementation. Parent supplies the exact accepted source BASE after the profile task; its expected browser baseline is25 cases, not an unverified fixed count.

**Interfaces:**
- Consume existing publicApiClient.get('/universities', { signal }), which never attaches session authority or refreshes. Producer is backend UniversityController.listUniversities: `{success:true,data:{universities,total}}`.
- Retain University{id:string,name:string,domain?:string,shortcode?:string,country?:string} and existing component props. Select only a returned nonempty id/name entry; ignore malformed entries rather than synthesizing IDs from missing values.
- Export moved `collectBrowserFaults(page:Page,api:ApiFixture):string[]` and `assertCleanFixture(api:ApiFixture,faults:string[]):Promise<void>` from browser-assertions.ts. Move their private synthetic HTTP classifier verbatim with required imports; auth-session.spec imports them and drops only their old definitions/import types. No duplicated assertion implementations.
- Extend ApiFixture with `universityRequests:Array<{ordinal:number;authorizationPresent:boolean}>`, `waitForUniversitiesCompleted(ordinal:number):Promise<void>`, and `setUniversityDirectory(status:200|401|503, universities?:readonly FixtureUniversity[]):void`. Extend ApiFixtureOptions with optional `universityStatus:200|401|503` and `universityResults:readonly FixtureUniversity[]`. Export FixtureUniversity and the fixed synthetic list below. All handlers run inside existing trackHandler/completeLifecycle and use the same failure recording/drain protocol. Never record credential values.

```ts
export type FixtureUniversity = {
  id: string; name: string; shortcode: string; domain: string; country: string;
};
export const fixtureUniversities: readonly FixtureUniversity[] = [
  { id: '10000000-0000-4000-8000-000000000001', name: 'Approved Alpha University', shortcode: 'AAU', domain: 'alpha.approved.test', country: 'Nigeria' },
  { id: '10000000-0000-4000-8000-000000000002', name: 'Approved Beta University', shortcode: 'ABU', domain: 'beta.approved.test', country: 'Ghana' },
];
```

- [ ] **Step1: Establish the base, move reusable assertions and add the exact directory fixture.** Record git status/HEAD/disk and the actual baseline test list. Move only existing helpers, retaining their code. Add a per-directory lifecycle map, count from universityRequests.length+1, record only presence of request Authorization, and handle only GET /universities. Default200 returns `{success:true,data:{universities:directoryResults,total:directoryResults.length}}`. Configured401/503 records the exact synthetic failure and returns `{success:false,error:{message:'Synthetic university directory failure'}}`. The setter changes future fixture responses, never triggers app events or component state. Existing unmatched routes continue failing closed.

```ts
if (path === '/universities' && method === 'GET') {
  const ordinal = fixture.universityRequests.length + 1;
  fixture.universityRequests.push({
    ordinal,
    authorizationPresent: route.request().headers().authorization !== undefined,
  });
  const requestLifecycle = endpointLifecycle(universityLifecycles, ordinal);
  requestLifecycle.start();
  return completeLifecycle(requestLifecycle, async () => {
    if (directoryStatus !== 200) {
      recordSyntheticHttpFailure(path, directoryStatus);
      await respond(route, directoryStatus, { success: false, error: { message: 'Synthetic university directory failure' } });
      return;
    }
    await respond(route, 200, { success: true, data: { universities: directoryResults, total: directoryResults.length } });
  });
}
```

Use mutable fixture-local `directoryStatus` and `directoryResults`, initialized from the optional settings; initialize `universityRequests:[]` and expose the specified setter/completed waiter on fixture. Do not add a general-purpose arbitrary route override, synthetic current-user bypass or wildcard response.

- [ ] **Step2: Add real-browser RED cases before changing the component.** Create university-select.spec.ts using the moved assertion helpers and existing fixture. Keep email empty in signup tests so the still-unfixed preflight is not triggered. Use the actual university input by label so the initial failure is interaction behavior, not solely a missing role. The following keyboard case runs on desktop1280x900 and mobile390x844; both failures must be captured before source correction.

```ts
for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`university selection accepts keyboard choice on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const api = await installSyntheticApi(page);
    const faults = collectBrowserFaults(page, api);
    await page.goto('/auth/student/register');
    const input = page.getByLabel(/^University/);
    await expect(input).toBeEnabled();
    await input.fill('Approved');
    await input.press('ArrowDown');
    await input.press('ArrowDown');
    await input.press('Enter');
    await expect(input).toHaveValue('Approved Beta University');
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute('role', 'combobox');
    await expect(input).toHaveAttribute('aria-expanded', 'false');
    await input.press('Tab');
    await expect(page.getByLabel(/^Matric Number/)).toBeFocused();
    await expect(input).toHaveValue('Approved Beta University');
    expect(api.universityRequests.length).toBeGreaterThan(0);
    expect(api.universityRequests.every((request) => !request.authorizationPresent)).toBe(true);
    await assertCleanFixture(api, faults);
  });
}
```

Add these five additional cases with actual user actions and visible assertions (seven new cases total):

```ts
// Pointer/touch: use a new mobile context configured hasTouch:true, not a desktop click labeled touch.
await input.fill('aau');
await page.getByRole('option', { name: /Approved Alpha University/ }).tap();
await expect(input).toHaveValue('Approved Alpha University');
await input.press('Tab');
await expect(input).toHaveValue('Approved Alpha University');

// Escape: from 'Approved', ArrowDown highlights but must not commit; Escape closes.
await input.press('ArrowDown');
await input.press('Escape');
await expect(input).toHaveAttribute('aria-expanded', 'false');
await expect(input).toHaveValue('Approved');
await input.press('Tab');
await expect(input).toHaveValue('');

//401 public isolation/retry: seedSession student before opening actual signup; fixture status401.
await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
expect(api.refreshCalls).toBe(0);
expect(api.universityRequests.every((request) => !request.authorizationPresent)).toBe(true);
// Snapshot the session envelope before the directory request via existing storage-tab helper pattern;
// compare the final serialized envelope to that exact snapshot without printing its value.
api.setUniversityDirectory(200);
await page.getByRole('button', { name: 'Retry', exact: true }).click();
await input.fill('aau');
await input.press('ArrowDown');
await input.press('Enter');
await expect(input).toHaveValue('Approved Alpha University');
expect(api.refreshCalls).toBe(0);

// Empty result: fixture universityResults[], type aau; announce only a local no-match message.
await input.fill('aau');
await expect(page.getByRole('status')).toContainText('No matching university');
await expect(page.getByRole('option')).toHaveCount(0);
await input.press('Tab');
await expect(input).toHaveValue('');

// Controlled identity in the second real consumer; no verification method request is made.
await page.goto('/widget/verify?apiKey=synthetic-public-key&vendorId=synthetic-vendor&origin=https%3A%2F%2Fmerchant.approved.test');
await page.getByRole('checkbox').check();
await page.getByRole('button', { name: 'Continue', exact: true }).click();
await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
await input.fill('aau');
await input.press('ArrowDown');
await input.press('Enter');
await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
await input.fill('different school');
await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
await input.press('Tab');
await expect(input).toHaveValue('');
```

Each case has its own fixture/fault collector and ends with assertCleanFixture. Complete setup in each case from the exact keyboard-test setup above. For touch use `browser.newContext({baseURL:appOrigin,viewport:{width:390,height:844},hasTouch:true,serviceWorkers:'block'})`, install the same fixture on its page, and close that context in finally; never use a persistent user profile. The widget query is synthetic public configuration, not a credential; never submit its later verification steps or claim this proves the widget product works. For the401 test, after seedSession and fixture installation, first navigate to `${appOrigin}${storageTabPath}`, capture `await page.evaluate(() => localStorage.getItem('awoof.session.v1'))`, then navigate to signup. Compare the final serialized value to that exact snapshot with a boolean equality assertion, so failures do not print credential values. Do not assert only a refresh-call count. Record RED cases actually observed; scaffolding or timeout-before-page-start failures are not application RED.

Run from apps/web: `AWOOF_BROWSER_MODE=dev NPM_CONFIG_USERCONFIG=/dev/null NEXT_TELEMETRY_DISABLED=1 npm run test:browser -- university-select.spec.ts`. Focused RED may stop at the first concrete keyboard failure to avoid seven repeated slow waits, then run all new cases after correction.

- [ ] **Step3: Implement the controlled manual-selection combobox.** Use the existing public client, abort fetch on unmount/replacement, and guard both success/catch/finally against the current request; intentional abort is not a directory error. Retry is an explicit button action. Preserve existing styling, label and selected university data. Parse only an actual array from the supported response, filter invalid id/name records, and expose a local associated error with Retry for failed/malformed responses.

Derive the selected university from current value plus fetched list, and filter the list during render instead of effect-updated state. A query draft is separate from parent selection; selecting reports the full university exactly once, editing a selected choice calls onChange(null,null) and preserves the newly typed query. An external changed/reset value must replace/discard the old draft. This compact state pattern is suitable:

```ts
type SearchState = { value: string; draft: string | null; clearingFrom: string | null };
const normalizedValue = value ?? '';
const selected = universities.find((entry) => entry.id === normalizedValue) ?? null;
const [open, setOpen] = useState(false);
const [activeIndex, setActiveIndex] = useState(-1);
const [search, setSearch] = useState<SearchState>({ value: normalizedValue, draft: null, clearingFrom: null });
let currentSearch = search;
if (search.value !== normalizedValue) {
  const ownClear = normalizedValue === '' && search.clearingFrom === search.value;
  currentSearch = { value: normalizedValue, draft: ownClear ? search.draft : null, clearingFrom: null };
  setSearch(currentSearch);
  if (!ownClear) {
    setOpen(false);
    setActiveIndex(-1);
  }
}
const query = currentSearch.draft ?? selected?.name ?? '';
const term = query.trim().toLowerCase();
const matches = term ? universities.filter((entry) =>
  [entry.name, entry.shortcode, entry.domain].some((part) => part?.toLowerCase().includes(term)),
) : [];

function changeQuery(text: string) {
  setSearch({ value: normalizedValue, draft: text, clearingFrom: normalizedValue || null });
  setActiveIndex(-1);
  setOpen(true);
  if (value) onChange(null, null);
}
function selectUniversity(university: University) {
  setSearch({ value: normalizedValue, draft: null, clearingFrom: null });
  setActiveIndex(-1);
  setOpen(false);
  onChange(university.id, university);
}
function closePopup() {
  setOpen(false);
  setActiveIndex(-1);
}
```

The conditional same-component state reconciliation above retains only the just-requested edit-to-empty transition, and drops the draft on any other external value change. It must terminate after one state update because the recorded value becomes normalizedValue; never set state unconditionally during render. React's documented previous-render state adjustment is the relevant narrow pattern (https://react.dev/reference/react/useState#storing-information-from-previous-renders). On blur, clear draft with `setSearch({value:normalizedValue,draft:null,clearingFrom:null})` and call closePopup; no delayed closure. A transient draft must not override a newly selected external institution or revive after a later reset. No effect reopens the popup after selection.

Use input role=combobox, aria-autocomplete=list, aria-expanded, stable useId-derived aria-controls pointing to role=listbox, aria-activedescendant only while its actual option exists, aria-required and error aria-describedby. List options have role=option, stable id, aria-selected for the active option, no Tab stop, visual active styling and onClick selection. Prevent pointer-down focus theft without committing on pointer-down; click/tap commits once. Input blur synchronously closes and discards uncommitted text; selected parent value remains. Error/status nodes stay outside the popup and are labelled/announced without pretending directory success is verification.

```ts
function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && matches.length) {
    event.preventDefault();
    setOpen(true);
    setActiveIndex((current) => event.key === 'ArrowDown'
      ? Math.min(current + 1, matches.length - 1)
      : (current < 0 ? matches.length - 1 : Math.max(current - 1, 0)));
  } else if (event.key === 'Enter' && open && activeIndex >= 0 && matches[activeIndex]) {
    event.preventDefault();
    selectUniversity(matches[activeIndex]);
  } else if (event.key === 'Escape' && open) {
    event.preventDefault();
    closePopup();
  }
}
```

Leave native text editing/Tab behavior alone. Scrolling the active option into view is permitted for the existing scrollable list; no new library or component framework. On empty matches, show `No matching university. Try another name or shortcode.` in a polite status; do not imply ineligibility from this directory UI.

- [ ] **Step4: Validate the new and existing rendered flows.** Run the identical focused command to GREEN, then the complete dev suite. Fresh3GiB guard, approved explicit-loopback Webpack build, then full production suite. Target32 cases if baseline remains25. Require20auth tests, browser semantic types, app types, full owned-file lint and diff checks. Restore only generated next-env drift with apply_patch after servers stop. Confirm no new production stage/listener remains. No skips, fixed sleeps, timeout increases or broad browser-error suppression.

```sh
AWOOF_BROWSER_MODE=dev NPM_CONFIG_USERCONFIG=/dev/null NEXT_TELEMETRY_DISABLED=1 npm run test:browser
NEXT_PUBLIC_API_URL=http://127.0.0.1:3108 NPM_CONFIG_USERCONFIG=/dev/null NEXT_TELEMETRY_DISABLED=1 npm run build -- --webpack
AWOOF_BROWSER_MODE=production NPM_CONFIG_USERCONFIG=/dev/null NEXT_TELEMETRY_DISABLED=1 npm run test:browser
NPM_CONFIG_USERCONFIG=/dev/null npm run test:auth
NPM_CONFIG_USERCONFIG=/dev/null npm run test:browser:typecheck
./node_modules/.bin/tsc --noEmit --incremental false
NPM_CONFIG_USERCONFIG=/dev/null npm run lint -- src/components/forms/UniversitySelect.tsx tests/browser
git diff --check
```

- [ ] **Step5: Self-review, commit only the five owned files and freeze.** Report exact base/head, RED cause and GREEN commands, seven added case names/counts, existing regressions, public401 session invariance, touch context evidence, cleanup results and any deviations. Distinguish tests of the widget's selector from verification/merchant permission; signup OTP/consent remain pending. Parent independently validates and Astra reviews before acceptance.

```sh
git add -- apps/web/src/components/forms/UniversitySelect.tsx apps/web/tests/browser/browser-assertions.ts apps/web/tests/browser/auth-session.spec.ts apps/web/tests/browser/fixtures.ts apps/web/tests/browser/university-select.spec.ts
git commit -m "fix(web): make university lookup public and keyboard accessible"
git status --short
git rev-parse HEAD
```

## Plan self-review

The directory lookup, controlled selection and keyboard semantics form one independently testable deliverable. Fixture/assertion setup is included with that deliverable, not split into an unreviewable setup-only task. Only one source owner touches shared browser files after the profile gate. Full signup proof/consent/receipt/session adoption is expressly outside this plan and remains in the parent signup notes. There is no producer/consumer mismatch: public endpoint is already available; both actual callers consume the same id/object callback; existing auth fixture/runtime behavior remains unchanged.
