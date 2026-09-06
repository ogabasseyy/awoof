# Browser session safety implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the existing student, vendor and admin screens a storage-tolerant, session-bound authentication foundation before connecting proof-bound student signup.

**Architecture:** Preserve the Axios clients and React AuthProvider, centralize browser-session persistence and lifecycle in one small module, and fence asynchronous completions against the session that started them. A successful current server response establishes account state; neither decoded JWT fields nor legacy verificationStatus establish student eligibility. Public login/signup calls remain outside the authenticated retry interceptor.

**Tech Stack:** Existing Next.js 16, React 19, TypeScript, Axios; Node test runner and existing TypeScript compiler for focused tests. Development-only Playwright is owner-approved for rendered validation, with installed Chrome and no browser download.

**Spec:** `docs/superpowers/specs/2026-09-05-verification-core-remediation-design.md`, sections 1, 4 and 7; `docs/superpowers/specs/2026-09-05-signup-ui-repair-notes.md`, shared-session and redirect requirements. Source preflight: `/Users/mac/.codex/worktrees/7783/Awoof/.superpowers/student-onboarding-preflight.md` at `c075f12aa54f64620a1de870aafde511884dfc02`.

## Global Constraints

- Keep the existing TypeScript/Next/Express/PostgreSQL stack.
- Authentication, student assurance, and merchant permission are separate.
- A permanent `users.verification_status` flag is compatibility/display data, not an authorization source.
- Public account signup/login keep issuing sessions. Eligibility endpoints operate on the authenticated student's own identity and never issue login tokens.
- No VPS deployment, merge or push as part of this implementation run.
- Preserve vendor/admin authentication and the current AuthShell visual language. Paystack, merchant assertions/widget callbacks, manual evidence and live services are outside this task.
- The owner's 2026-09-06 approval supersedes the older unanswered development-only Playwright question; it does not authorize modifying shared dependency directories or deleting unrelated files.
- The implementation owner writes only its native checkout. Other checkouts and any shared dependency symlink targets are read-only. No concurrent source owners or worker-spawned agents.
- No token, password, OTP or submitted signup claims in navigation URLs, logs, snapshots, traces or new pending-flow browser storage. Existing session token persistence is the sole intentional exception for tokens.

## Scope and ownership

This is the shared-auth dependency of student onboarding, not a replacement onboarding design. The next separately reviewed task owns the signup form and its receipt/consent state machine; authenticated verification and merchant UI remain separate consumers.

### Task 1: Fence browser sessions and remove stale account authority

**Files:**
- Modify `apps/web/src/lib/auth.ts`: resilient token persistence, session lifecycle and notifications.
- Modify `apps/web/src/lib/api-client.ts`: request binding and refresh coordination.
- Modify `apps/web/src/contexts/AuthContext.tsx`: server-derived current account and guarded operations.
- Create `apps/web/src/lib/student-return.ts`: pure same-origin return-path validation.
- Create `apps/web/tests/auth/session.test.ts`, `api-client.test.ts`, `student-return.test.ts`: focused real-module regression tests using synthetic storage and Axios transport adapters.
- Create `apps/web/tsconfig.auth-tests.json` and `apps/web/scripts/test-auth.mjs`: compile only these modules/tests with the existing TypeScript compiler into an owned temporary output directory, run Node tests, clean only that generated directory in finally.
- Modify `apps/web/package.json`: add `test:auth`; no runtime dependency changes.
- Create `apps/web/playwright.config.ts`, `apps/web/tests/browser/auth-session.spec.ts`, `apps/web/tests/browser/fixtures.ts`; modify `apps/web/package-lock.json` only for the approved dev-only runner when safe installation is feasible. Add `test:browser` then. Do not install through a dependency symlink.
- Modify `apps/web/.gitignore` if needed solely for generated auth-test and Playwright reports/traces.
- The retired `/verify/email` page and existing signup direct `storeTokens` caller must be inspected for compatibility, but do not restore a retired backend or rewrite those screens in this task. A throwing persistence failure must remain a failure to callers, never silently succeed.

**Interfaces:**
- Consume existing `TokenPair = {accessToken:string; refreshToken:string}` and `User` with student/vendor/admin roles; `/auth/login`, `/auth/register`, `/auth/refresh`, `/auth/me`, `/auth/logout` keep their current backend contracts.
- Exact backend refresh producer at `auth.controller.ts:275–292` returns `{success:true,data:{accessToken:string}}`, not a new refresh token. Preserve the originating refresh token on that response. Accept an optional valid replacement only if returned; missing accessToken is malformed, missing replacement refreshToken is normal. Login returns `{data:{user:{id,email,role,verificationStatus},tokens}}`; vendor register also returns `requiresEmailVerification:true` alongside its real token pair. `/auth/me` returns account fields and optional profile under `data`, with no nested `user`.
- Keep `storeTokens(tokens: TokenPair): void`; it MUST throw a stable safe error on unavailable/invalid persistence. Reads return null and clear tolerates blocked storage. No caller may set user or navigate after a thrown store failure.
- Add `SessionSnapshot` and storage-reconciling identity comparison through the signatures below. Generation is a local invalidation counter; snapshots include the exact token pair as well as generation. Token rotation in the same authenticated session must not invalidate a successful current `/auth/me` response merely because the access token changed.
- Add `subscribeSessionChanges(listener: () => void): () => void`; it reports login/logout and cross-tab replacement/clearing. Refresh rotation must have an explicit same-session path rather than accidentally behaving like a new account login.
- Add `resolveStudentReturn(candidate: string | null, origin: string, fallback?: string): string`. Default fallback is `/marketplace`; an invalid fallback also resolves to `/marketplace`. Accept only http(s), same-origin paths; reject credentials, protocol-relative foreign URLs, malformed input and redirect-to-auth loops. Login success consumes this helper. Later signup/footer-link work imports this exact helper.

```ts
export interface SessionSnapshot {
  generation: number;
  accessToken: string | null;
  refreshToken: string | null;
}
export function getSessionSnapshot(): SessionSnapshot;
export function isCurrentSession(snapshot: SessionSnapshot): boolean;
export function subscribeSessionChanges(listener: () => void): () => void;
export function resolveStudentReturn(
  candidate: string | null,
  origin: string,
  fallback?: string,
): string;
```

`isCurrentSession` means the same logical account-session generation, not byte-equal access tokens following a successful own refresh. It first reconciles actual observable storage; it is NOT a pure comparison of an old in-memory counter. A separate exact-token predicate is required before committing a refresh result or cleaning up its failure; keep that private unless the two owned modules require an export. A private stable random session ID distinguishes login replacement from own refresh; advancing a local generation on an observed external session replacement must happen even before a delayed storage event arrives. Name additional small internal helpers clearly and document them in the report; do not create a general auth framework.

**Persistence decision (binding):** use one JSON envelope under `awoof.session.v1`. Active representation is `{v:1,state:'active',sessionId:string,accessToken:string,refreshToken:string}`; signed-out representation is `{v:1,state:'signed_out'}`. New login uses `crypto.randomUUID()` for a new opaque local session ID; refresh preserves it. Never expose this ID to merchants or claim it is the server session ID.

Envelope presence is authoritative, including a signed-out marker or malformed value. Never fall back to legacy keys when it is present. Only complete nonempty legacy accessToken/refreshToken pairs can migrate when the envelope is absent: write/read-back the complete active envelope first, then best-effort remove legacy keys. Incomplete pairs are not usable. If migration persistence fails, expose no session in the current tab. On normal logout write/read-back the signed-out marker; retain it permanently rather than removing the key, so failed legacy removal cannot resurrect credentials on reload. No clear-all-storage call.

On any storage-access/write/read-back failure, quarantine the running tab's session: getters return null, pending work is invalidated, provider cannot expose an authenticated user. Cleanup failures must not bypass this quarantine. Clearing attempts to persist the signed-out marker and remove legacy keys, but when all writes/removals are blocked, durable logout across reload is impossible; the app must not claim it. Keep quarantine until a subsequent explicit successful store or successful explicit clear persists and verifies the intended envelope. Merely observing an old active envelope when storage access recovers must not sign the tab back in. Expose a safe storage-failure message through the provider's rendered alert state for failed logout; do not reject an unhandled click promise or expose tokens in the message. Server logout remains best-effort and has the separate server race limitation below.

**Owned-commit decision (binding):** AuthProvider marks only the synchronous validated store of its current login/register completion as its own commit. The subscription recognizes that specific expected session write and does not cancel that action or start a duplicate me request. After store returns, the action adopts the resulting reconciled snapshot, verifies the intended session actually persisted, clears the synchronous marker in finally, then publishes its server-validated user and destination. Pending HTTP login is NOT a notification suppression window. An external replacement, logout, unmount or later operation still invalidates the action; reconcile observable storage both before committing and before accepting state/navigation. If a concurrent external write wins, do not restore this action's tokens or user.

- [ ] **Step 1: Establish the exact base and lightweight test execution.** Verify c075f12 and clean status, create `codex/awoof-browser-session-safety` in the native worktree if absent. Check `df -h`; no install/build/browser launch below 3 GiB free. A read-only symlink to the existing web dependency directory is allowed only for compiler, lint and tests that write their output into this checkout. Never run install against it. Do not modify its target. The test runner must work without machine-specific paths when normal web dependencies are installed.

The focused runner uses the existing compiler and Node; configure the tests with CommonJS output, Node module resolution, `rootDir:'.'`, `noEmit:false`, `incremental:false`, DOM library for the browser modules, and isolated output under `apps/web` so Axios resolves normally. Use relative imports in these small owned modules/tests. Capture genuine failing behavior before the production fix; missing-export/compiler errors are scaffolding failures, not RED security evidence. If later transitioning to a real owned dependency install, verify with lstat/readlink that this task's apps/web/node_modules is the expected symlink and unlink only that symlink, never its target; record it and recheck disk before installing. Otherwise keep browser validation blocked.

```js
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const output = mkdtempSync(join(webRoot, '.auth-test-'));
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: webRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return false;
  }
  return true;
}
try {
  if (run([require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.auth-tests.json', '--outDir', output])) {
    const directory = join(output, 'tests', 'auth');
    const files = readdirSync(directory).filter(name => name.endsWith('.test.js'));
    if (files.length === 0) throw new Error('No compiled auth tests found');
    run(['--test', ...files.map(name => join(directory, name))]);
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}
```

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "CommonJS", "moduleResolution": "Node",
    "lib": ["ES2022", "DOM"], "types": ["node"], "rootDir": ".",
    "strict": true, "esModuleInterop": true, "skipLibCheck": true,
    "noEmit": false, "incremental": false
  },
  "include": ["src/lib/auth.ts", "src/lib/api-client.ts", "src/lib/student-return.ts", "tests/auth/**/*.ts"]
}
```

- [ ] **Step 2: Write and run failing storage/refresh regression tests.** Install a synthetic `window` and Storage object in the test process, with property reads and individual methods independently configurable to throw. Restore globals and Axios adapters in finally; do not invoke real HTTP. Include existing-public-API failures before introducing new exports.

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAccessToken, getRefreshToken, storeTokens } from '../../src/lib/auth';

function withStorage(storage: Storage, run: () => void) {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: storage, addEventListener() {}, removeEventListener() {},
  } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try { run(); } finally {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}
test('blocked reads return no usable session', () => {
  withStorage({ length: 0, clear() {}, key() { return null; },
    setItem() {}, removeItem() {}, getItem() { throw new Error('SecurityError'); },
  }, () => {
    assert.equal(getAccessToken(), null);
    assert.equal(getRefreshToken(), null);
  });
});
test('failed token persistence cannot be reported as success', () => {
  const values = new Map<string, string>();
  let writes = 0;
  withStorage({ get length() { return values.size; }, clear() { values.clear(); },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    removeItem() { throw new Error('Removal denied'); },
    setItem(key, value) {
      if (++writes === 2) throw new Error('QuotaExceededError');
      values.set(key, value);
    },
  }, () => {
    assert.throws(() => storeTokens({ accessToken: 'new-a', refreshToken: 'new-r' }));
    assert.equal(getAccessToken(), null);
    assert.equal(getRefreshToken(), null);
  });
});
```

The second baseline test targets the current two-write pair; if the chosen implementation changes to a one-write envelope, retain a denied-envelope-write regression with existing old values and a separate failed-legacy-migration case. Do not retain an assertion of two writes when a single atomic write replaces that mechanism.

Record baseline refresh tests with a deferred Axios adapter: start a 401/refresh for A, then replace storage through `storeTokens(B)` or `clearTokens()`, then release A's success/failure. Assert A cannot replace B, restore logout, clear B, navigate B, or replay A's original request with B's Authorization. Parallel A requests cause one refresh; a later B request never joins A's promise. Bound all deferred awaits, attach rejection handlers immediately and release them in finally.

- [ ] **Step 3: Implement session persistence and the fenced Axios path.** Implement the binding envelope/marker/quarantine decision above, including its explicit durable-logout limitation. Do not claim cross-tab atomic compare-and-swap that localStorage cannot provide.

Capture request session metadata only on its first dispatch. A retry must preserve its original logical session and never silently attach a different account's current credentials. Key the shared refresh by the originating logical generation and refresh token. Check current generation and exact original pair before persisting the rotated pair. Promise cleanup must remove only that promise entry. A stale 401/success cannot clear or restore current account state.

Before refreshing a 401, reconcile current storage and compare the original logical session. A different session rejects with no replay/clear/navigation. If it is still the same session but the access token is now newer than the token used on the failed dispatch, replay once with that session's current token without starting another refresh. Only a failure using the current access token may start/join the keyed refresh. Track the actual credentials used on each dispatch separately from the original logical session. Any retry is once-only; a final401 can clear/navigate only if its logical session and exact actual failed token pair remain current. If another rotation/replacement already won, reject the stale failure without touching it. Test A2's delayed original401 arriving after A1's refresh and promise cleanup: one refresh total, A2 uses A's newer token; with B replacement before A2 releases, zero replay under B.

```ts
// Required control flow, not an unconditional retry of the current account.
const started = getSessionSnapshot();
const refreshed = await refreshFor(started);
if (!isCurrentSession(started)) throw staleSessionError;
// refreshFor commits only against its own current token snapshot.
// Replay only this session, once; never read another account into old config.
```

Missing refresh tokens and refresh failure may clear/navigate only their current originating session. A malformed refresh response is failure. Public client requests never trigger refresh, global clear or navigation. Preserve multipart boundary handling and SSR guards. Do not introduce logging of headers/token-bearing configs.

Persistence cases must concretely prove: successful legacy migration with failed legacy removals followed by signed-out marker/reload remains signed out; malformed envelope plus complete legacy pair stays signed out; failed envelope write/migration and failed cleanup quarantines the tab; after blocked clear, storage recovery alone stays signed out, and an explicit successful clear persists a reload-safe marker; active/signed-out/malformed envelope cross-tab changes are reconciled. Preserve tests of baseline first/second legacy write failures as historical RED evidence, but test the implemented one-write protocol rather than requiring a second write in the new path.

- [ ] **Step 4: Make AuthProvider use current server authority.** Remove the JWT fallback. Login and register use `publicApiClient`; validate role/user structure and persisted session before accepting the response. Preserve vendor requiresEmailVerification behavior, admin/vendor destinations and student safe return. Introduce a local operation sequence so an old init/me/login/logout completion cannot update state after a newer action, session event, unmount or account switch.

```ts
const operation = ++operationRef.current;
const started = getSessionSnapshot();
const response = await apiClient.get('/auth/me');
if (operation !== operationRef.current || !isCurrentSession(started)) return;
setUser(validatedServerUser(response.data.data));
```

Handle refresh-generated token rotation without cancelling the current request's successful user read. Use the binding owned-commit notification protocol above, with explicit tests for live subscriptions and delayed storage events. On transient `/auth/me` failure, render unauthenticated/error honestly; never set user from a decoded token. Expired-session cleanup remains bound to that session. Cross-tab logout/account replacement clears stale rendered user immediately and refetches current server state when usable credentials remain. Ensure subscriptions do not recursively trigger an endless refetch cycle.

Logout clears local authority immediately, sends at most one best-effort no-refresh logout request with the captured old access token, and never clears/navigates a newly established session when that network request later settles. Login completion cannot restore a session after a later logout. All asynchronous callbacks guard mount and operation/session identity before setting user or navigating. Do not add a new durable login mechanism or change rememberMe backend semantics.

Backend boundary: current `/auth/logout` revokes by user ID, not by captured session. An old logout processed after a new same-user login can revoke that newer server refresh session. This browser task must not claim server-session survival or treat synthetic browser fixtures as proof of that race; it remains a separately tracked backend correction. Do not broaden this task's backend ownership.

- [ ] **Step 5: Add pure redirect and all-role regression tests.** Test null and invalid fallback, relative marketplace/widget return, same-origin absolute return, foreign https URL, `//foreign.example`, javascript/data URLs, credentials, backslashes, malformed escapes and auth-loop destinations. Preserve safe query/hash context without adding any secrets.

```ts
assert.equal(resolveStudentReturn('/verify/widget?flow=synthetic', 'https://awoof.test'),
  '/verify/widget?flow=synthetic');
assert.equal(resolveStudentReturn('https://evil.test', 'https://awoof.test'), '/marketplace');
assert.equal(resolveStudentReturn('/auth/student/login', 'https://awoof.test'), '/marketplace');
```

Run `npm run test:auth`, TypeScript with `--noEmit --incremental false`, scoped ESLint for owned files, then `git diff --check`. Explicitly test missing window, malformed/partial storage, failed reads/writes/removals, old-session 401, parallel refresh, account switch, logout and cross-tab clear/replacement. Assertions must inspect actual owned module outputs/request headers/state, not only fake-adapter calls.

- [ ] **Step 6: Verify rendered provider consumers when resources permit.** Use the approved dev-only Playwright runner with the installed Chrome channel, no downloaded browser, no real API/server/email credentials. `webServer` binds 127.0.0.1:3107 with `reuseExistingServer:false`; set `NEXT_PUBLIC_API_URL` to a loopback fixture origin, block unexpected browser requests, service workers and external requests. Use synthetic fixed UUIDs/users and non-secret test tokens; route synthetic API responses explicitly. Preserve existing UI styles.

```ts
test('student login keeps a safe return destination', async ({ page }) => {
  await page.goto('/auth/student/login?redirect=%2Fmarketplace%3Ffrom%3Dauth-test');
  await page.getByLabel(/email/i).fill('student@approved.test');
  await page.getByLabel(/^password/i).fill('Synthetic-Password1!');
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(page).toHaveURL(/\/marketplace\?from=auth-test$/);
});
```

Fixtures must include login success and `/auth/me` for student, vendor and admin while session subscriptions are active; invalid credentials401 causes zero refresh calls; storage denial causes no authenticated navigation; existing JWT-looking token plus failing `/auth/me` never exposes protected content; cross-tab logout removes protected content; delayed `/auth/me` cannot resurrect the previous user; logout while refresh is pending does not reauthenticate; vendor email-verification response retains its current onboarding behavior without dashboard navigation. Also test external replacement during pending login, logout after login starts, and storage replacement observed by a completion before the storage event is delivered. Test keyboard submit and mobile viewport. Check console/hydration errors. Use bounded network barriers and cleanup. Disable traces/videos/screenshots capturing credentials; use synthetic fixtures with no real accounts. Report browser evidence separately from unit evidence; do not call source work fully validated if this gate is resource-blocked.

When disk permits a production web build, run it once and then the rendered suite against that owned local build (Next guidance); development-server feedback is allowed earlier but does not establish production-build success. No bypass of disk guards, no unrelated cache deletion and no shared node_modules installation. If blocked, finish the safe unit-tested code/report, identify the specific remaining gate and let the parent arrange resources.

`app/layout.tsx` currently imports next/font/google: browser route blocking does not govern build-time Node fetches. If no existing cache/offline font fixture is available, record production build as additionally blocked by that external request rather than silently fetching Google fonts or changing production typography. Do not add an environment-dependent production font workaround in this task.

- [ ] **Step 7: Self-review, commit scoped changes and report.** Confirm no source changes outside the ownership set, no token-bearing artifacts, no unrelated package churn, no unfinished tests falsely recorded green. Commit the locally implemented source/tests (even if rendered validation remains explicitly blocked), never push. Report BASE/HEAD, exact failing and passing commands/results, storage choice and migration behavior, reviewed consumer compatibility, remaining browser/build gates and resource facts. Astra independently reviews this exact full task range before any downstream signup dependency is accepted.

## Plan self-review and external references

Core account/UI requirements map to Task1 Steps2–6; provider and merchant assurance are deliberately unchanged. Signup receipt/consent and authenticated verification screens remain separate forthcoming plans, not silently counted as covered here. No dependencies between multiple tasks exist in this single-deliverable plan.

Checked current official documentation on 2026-09-06: [Playwright webServer](https://playwright.dev/docs/test-webserver), [Next.js Playwright testing](https://nextjs.org/docs/app/guides/testing/playwright). The former supplies owned server/baseURL lifecycle; the latter recommends production-build testing. Neither is evidence that the actual Awoof browser tests have run.
