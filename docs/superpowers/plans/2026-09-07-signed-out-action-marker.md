# Durable signed-out action marker implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a completed remote logout distinguishable from a previously observed signed-out state before a pending authentication result can rely on that old state.

**Architecture:** Add an optional opaque actionId to the existing signed-out envelope, preserving active sessions, exports and legacy markers. Reconciliation observes the marker identity without writing; successful explicit clears create identities and retain the existing quarantine lifecycle. This is a durable observation fence, not cross-tab atomic locking.

**Tech Stack:** Existing TypeScript, Node test runner, Next16/React19 and installed Playwright/Chrome; no dependencies.

**Spec:** `docs/superpowers/specs/2026-09-07-signed-out-action-marker.md`. The broader signup contract remains in `docs/superpowers/specs/2026-09-05-signup-ui-repair-notes.md`; this task covers only its explicit signed-out action-history gap.

## Global Constraints

- Keep the existing TypeScript/Next/Express/PostgreSQL stack.
- Authentication, student assurance, and merchant permission are separate.
- A permanent users.verification_status flag is compatibility/display data, not an authorization source.
- Keep storage key `awoof.session.v1`, active envelope format and every exported auth function signature unchanged.
- No VPS deployment, merge or push as part of this implementation run.
- No new dependency, shared dependency write, real environment, live API/provider/payment call or worker-spawned agent.
- No token, password, OTP or submitted signup claims in navigation URLs, logs, screenshots or traces. Synthetic loopback127.0.0.1:3107/3108 only, isolated installed Chrome, automatic screenshots/video/traces off.
- Work only in the existing isolated source checkout after the public university picker final review passes. Preserve other changes; no concurrent source owners. Parent owns planning/report coordination, Terra owns source, Astra reviews.
- Check at least3GiB free before build/server/browser. Existing unchanged public Google font build fetch is allowed. One-off npm run build -- --webpack is approved for local validation; do not change default build settings or claim CI/VPS parity.
- No AuthContext, api-client, signup/UI, backend, fixture, package, launcher or configuration changes. Same legacy/rotation/quarantine behavior must pass existing regressions.

## File responsibilities

| File | Responsibility |
| --- | --- |
| apps/web/src/lib/auth.ts | Parse/observe signed-out identity and generate it on explicit clear, preserving public interfaces and active-session semantics |
| apps/web/tests/auth/session.test.ts | Five focused storage contract regressions using the existing memoryStorage/withStorage helpers |

### Task 1: Fence signed-out observations with durable action identity

**Files:** Modify exactly the two files above. Parent supplies accepted exact source BASE and report path at dispatch. Read apps/web/AGENTS.md and the installed Next test guide; no new test framework or module reset API. Existing session.test.ts uses a synchronous global-window fixture and resets state through clearTokens; preserve its finally cleanup and serial tests.

**Interfaces:** Consume existing `getSessionSnapshot():SessionSnapshot` (generation/accessToken/refreshToken), `clearTokens():void`, `isSessionStorageQuarantined():boolean`, `subscribeSessionChanges(listener:()=>void):()=>void`, `storeTokens(TokenPair):void`. All signatures remain unchanged. Private `SignedOutEnvelope` becomes `{v:1;state:'signed_out';actionId?:string}`. ActiveEnvelope and SESSION_KEY unchanged. New ids come from existing `newSessionId():string` with its safe failure behavior. No new exported application interface. Later provider operations may compare fresh generation and quarantine but this does not make check/write atomic.

- [ ] **Step1: Establish exact base and add five regression tests before runtime edits.** Record git status/HEAD and existing test counts. Use the current in-file memoryStorage/withStorage/resetSessionState helpers. Append these five tests (format to existing conventions). All values are synthetic; do not print real browser storage.

```ts
test('each explicit durable clear writes a distinct opaque action id', () => {
  resetSessionState();
  withStorage(memoryStorage(), () => {
    clearTokens();
    const first = JSON.parse(window.localStorage.getItem('awoof.session.v1')!);
    clearTokens();
    const second = JSON.parse(window.localStorage.getItem('awoof.session.v1')!);
    assert.equal(first.state, 'signed_out');
    assert.equal(typeof first.actionId, 'string');
    assert.ok(first.actionId.length > 0);
    assert.equal(typeof second.actionId, 'string');
    assert.notEqual(first.actionId, second.actionId);
    assert.deepEqual(Object.keys(second).sort(), ['actionId', 'state', 'v']);
  });
});

test('a changed signed-out marker notifies once and repeated reads are stable', () => {
  resetSessionState();
  const storage = memoryStorage();
  withStorage(storage, () => {
    clearTokens();
    const before = getSessionSnapshot();
    const seen: number[] = [];
    const stop = subscribeSessionChanges(() => { seen.push(getSessionSnapshot().generation); });
    try {
      storage.setItem('awoof.session.v1', JSON.stringify({ v: 1, state: 'signed_out', actionId: 'remote-action-b' }));
      const after = getSessionSnapshot();
      assert.equal(after.generation, before.generation + 1);
      assert.equal(after.accessToken, null);
      assert.equal(after.refreshToken, null);
      assert.deepEqual(seen, [after.generation]);
      assert.deepEqual(getSessionSnapshot(), after);
      assert.deepEqual(getSessionSnapshot(), after);
      assert.deepEqual(seen, [after.generation]);
    } finally { stop(); }
  });
});

test('a fresh read detects an unobserved active then signed-out round trip', () => {
  resetSessionState();
  const storage = memoryStorage();
  withStorage(storage, () => {
    clearTokens();
    const before = getSessionSnapshot();
    // Simulate completed other-tab writes without delivering intermediate events or reads.
    storage.setItem('awoof.session.v1', JSON.stringify({ v: 1, state: 'active', sessionId: 'remote-active', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' }));
    storage.setItem('awoof.session.v1', JSON.stringify({ v: 1, state: 'signed_out', actionId: 'remote-action-c' }));
    const after = getSessionSnapshot();
    assert.equal(after.generation, before.generation + 1);
    assert.equal(after.accessToken, null);
    assert.equal(after.refreshToken, null);
    assert.equal(isSessionStorageQuarantined(), false);
  });
});

test('legacy and invalid signed-out markers never revive residual legacy credentials', () => {
  resetSessionState();
  const storage = memoryStorage({ accessToken: 'legacy-access', refreshToken: 'legacy-refresh' });
  withStorage(storage, () => {
    for (const marker of [
      { v: 1, state: 'signed_out' },
      { v: 1, state: 'signed_out', actionId: '' },
      { v: 1, state: 'signed_out', actionId: { invalid: true } },
    ]) {
      const encoded = JSON.stringify(marker);
      storage.setItem('awoof.session.v1', encoded);
      const first = getSessionSnapshot();
      assert.equal(first.accessToken, null);
      assert.equal(first.refreshToken, null);
      assert.deepEqual(getSessionSnapshot(), first);
      assert.equal(storage.getItem('awoof.session.v1'), encoded);
    }
  });
});

test('action id generation failure leaves clear quarantined until explicit recovery', () => {
  resetSessionState();
  withStorage(memoryStorage(), () => {
    storeTokens({ accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' });
    const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
      randomUUID() { throw new Error('Synthetic entropy unavailable'); },
    } });
    try {
      assert.doesNotThrow(() => clearTokens());
      assert.equal(isSessionStorageQuarantined(), true);
      assert.equal(getAccessToken(), null);
      assert.equal(getRefreshToken(), null);
    } finally {
      if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
      else Reflect.deleteProperty(globalThis, 'crypto');
    }
    clearTokens();
    assert.equal(isSessionStorageQuarantined(), false);
    assert.equal(getAccessToken(), null);
    assert.equal(typeof JSON.parse(window.localStorage.getItem('awoof.session.v1')!).actionId, 'string');
  });
});
```

- [ ] **Step2: Complete the RED run before changing runtime source.** From apps/web run `NPM_CONFIG_USERCONFIG=/dev/null npm run test:auth`. Expected concrete failures include missing actionId and unchanged generation after remote marker/round trip; legacy compatibility may already pass. Record actual assertions. If the runner/setup fails, repair only test setup first; do not count that as application RED or edit runtime while a test process still runs.

- [ ] **Step3: Implement the minimal marker observation.** Add actionId?:string to the private signed-out type. In `isSignedOutEnvelope`, require absent actionId or a nonempty string in addition to existing version/state checks. `parseEnvelope` may return a newly constructed signed-out record containing only known fields; invalid values return null and the caller treats them as anonymous signed out. Keep active parsing untouched. Reconcile the actual parsed signed-out marker, not a constant:

```ts
function invalidateToSignedOut(
  force = false,
  next: SignedOutEnvelope = { v: 1, state: 'signed_out' },
): void {
  const changed = force || observed.state === 'active' || observed.actionId !== next.actionId;
  observed = next;
  if (changed) {
    generation += 1;
    emit();
  }
}

// In reconcileStorage, when encoded !== null:
const envelope = parseEnvelope(encoded);
if (envelope && envelope.state === 'active') observeActive(envelope);
else invalidateToSignedOut(false, envelope?.state === 'signed_out' ? envelope : undefined);
return;
```

Use explicit parentheses or equivalent narrowing if required by TypeScript. Preserve existing other callers/default semantics. State must be updated before emit; no writes in reads. When clearTokens has quarantined local authority and obtained storage, create the marker in a try/catch; failure returns with quarantine intact. Preserve writeAndReadBack, legacy cleanup and provisional/final lifecycle:

```ts
let marker: SignedOutEnvelope;
try {
  marker = { v: 1, state: 'signed_out', actionId: newSessionId() };
} catch {
  return; // Existing quarantine stays authoritative; explicit retry is required.
}
if (!writeAndReadBack(storage, marker)) return;
// Retain existing best-effort legacy key removal here, with its existing catch.
observed = marker;
quarantined = false;
emit();
```

Assign observed before releasing quarantine/final emit so a subscriber's getSessionSnapshot does not add another generation/notification for this own marker. The provisional quarantine already advanced the local generation. Keep clearTokens void and do not weaken failure quarantine, change active sessionId semantics or introduce a read-modify-write counter. Add a concise comment clarifying action identity is not cross-tab atomic exclusion.

- [ ] **Step4: Run focused and existing regression checks.** `NPM_CONFIG_USERCONFIG=/dev/null npm run test:auth` must pass every original case plus the five new tests. In particular preserve own-refresh logical-session/exact-pair behavior and original subscriber counts (login + provisional clear + durable clear equals3; failed-clear recovery has one quarantined and one durable state). Do not adjust these expected counts just to conceal duplicate notifications. Run `npm run test:browser:typecheck`, `./node_modules/.bin/tsc --noEmit --incremental false`, and `npm run lint -- src/lib/auth.ts tests/auth/session.test.ts`. Report commands and actual counts; use NPM_CONFIG_USERCONFIG=/dev/null on npm invocations.

- [ ] **Step5: Verify the actual existing browser consumers on the same source.** Fresh disk guard before each heavy run. Full dev browser suite; wait for exit before build. Fresh `NEXT_PUBLIC_API_URL=http://127.0.0.1:3108 NEXT_TELEMETRY_DISABLED=1 NPM_CONFIG_USERCONFIG=/dev/null npm run build -- --webpack`; record54-page output and actual BUILD_ID. Then full `AWOOF_BROWSER_MODE=production NPM_CONFIG_USERCONFIG=/dev/null NEXT_TELEMETRY_DISABLED=1 npm run test:browser`. Preserve all currently accepted browser tests with no skips/retries/suppression and no browser test changes. New storage tests prove deterministic reconciliation, not real cross-tab signup completion (that remains future UI coverage). Record owned listener/stage inventory before and after and source status. Only terminate processes started for this task; no broad cleanup.

- [ ] **Step6: Commit and freeze for root/Astra.** Run `git diff --check`, inspect only owned delta, stage the two explicit paths and commit `fix(auth): distinguish durable signed-out actions`. Write the assigned report with exact BASE/HEAD, RED/GREEN, command evidence, warnings, residual no-CAS/legacy-client limits and cleanup. Freeze source until root independent validation and task/final Astra review. No push, merge, deployment or claim the signup UI is repaired.
