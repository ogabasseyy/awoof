# Student signup consumer implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the real student signup screen to approved-domain support, affirmative verification consent, purpose-bound OTP receipts and a provider-owned safe session handoff, with honest recovery after ambiguous or committed outcomes.

**Architecture:** Keep Next/React/RHF/Zod and the existing AuthShell visual language. A pure signup-contract module owns parsing and canonical claim types; the existing AuthProvider alone owns confirmation-to-session persistence/navigation. The page owns cancellable preflight/request/resend and local frozen pending proof. A second task repairs generic entry/return links and shared password-control accessibility without another account-creation path.

**Tech Stack:** Existing Next16/React19/TypeScript/Axios/Zod/React Hook Form/Playwright installed Chrome; no new dependency.

**Spec:** docs/superpowers/specs/2026-09-05-signup-ui-repair-notes.md, including independent handoff design and rendered matrix. Storage prerequisite accepted at9c8fab2611ee3524430cd268be3294bc86c2caee; picker accepted atb651b74. This is not student-status/merchant/widget authorization work.

## Global Constraints

- Keep the existing TypeScript/Next/Express/PostgreSQL stack.
- Authentication, student assurance, and merchant permission are separate.
- A permanent users.verification_status flag is compatibility/display data, not an authorization source.
- No VPS deployment, merge or push as part of this implementation run.
- No new dependency, shared dependency write, real environment, live API/provider/payment call or worker-spawned agent.
- No token, password, OTP or submitted signup claims in navigation URLs, logs, screenshots or traces. Synthetic loopback127.0.0.1:3107/3108 only, isolated installed Chrome, automatic screenshots/video/traces off.
- Preserve other changes; no concurrent source owners. Parent owns planning/report coordination, Terra owns source, Astra reviews.
- Check at least3GiB free before build/server/browser. Existing unchanged public Google font build fetch is allowed. One-off npm run build -- --webpack is approved for local validation; do not change default build settings or claim CI/VPS parity.
- Backend schemas/notice/policy/challenge behavior remain unchanged. Generic student registration cannot bypass the dedicated proof flow; vendor/admin behavior remains intact.
- No automatic OTP sends, retries or confirmation on mount/effect; only support lookup may be debounced. Abort cancels local authority, not server transactions.
- Action markers are durable observations, not cross-tab compare-and-swap. Keep all operation/abort/fresh snapshot/quarantine checks; do not broaden the accepted storage/refresh implementation.

### Test-capture hygiene correction established during Task1

Root found that installed Playwright1.63.0 automatically writes an AI-mode page snapshot and a test-source frame to error-context.md even with screenshot/video/trace off. The completed first RED artifact contained synthetic submitted form values, including its dummy password; no real credentials were used. Root replaced that one exact generated artifact with a sanitized failure record. The real notice/consent RED remains valid, but the raw snapshot is intentionally not retained.

This correction supersedes any direct parser-value/sensitive-input assertion in the examples below: compare protected payloads to expected values internally and assert only the resulting boolean. Use boolean expect.poll for asynchronous sensitive input clearing/equality; do not let toHaveValue or non-null parser assertions print mailbox/password/OTP/token/claim values when failing. Node unit tests likewise must not print a wrongly accepted parser object. Assertions on safe notices, types, flags, key names and sanitized navigation paths may remain direct.

Set PLAYWRIGHT_NO_COPY_PROMPT='1' in the owned shared browser fixtures before tests run, and include it in every browser command. Root verified the installed runner's _takePageSnapshot early return for this environment variable in playwright/lib/index.js. It disables automatic DOM capture, not failure reporting or copied source frames; therefore move new browser tests' submitted synthetic identity/password/OTP literals to fixture-only constants imported by the spec. No ariaSnapshot matchers or raw body logging. This is version-specific installed-runner evidence, not a promise of a permanent public configuration API. No package/config/launcher/node_modules changes are authorized.

Before resuming normal browser runs, use one deliberately failing owned browser test with filled synthetic fields to verify no Page snapshot and no submitted values appear in its error-context diagnostic. Keep failure assertions and all browser faults visible. Record safe booleans only; this capture-control check is not application GREEN. Existing baseline tests remain unchanged. Root/Astra must review this hygiene delta along with Task1.

## File responsibilities

Task1 core owns exactly: apps/web/src/lib/student-signup.ts (new pure contract), apps/web/src/lib/student-auth-links.ts (new pure safe links), apps/web/src/hooks/useStudentAuthLinks.ts (new hydration-stable query consumer), apps/web/src/contexts/AuthContext.tsx (new confirmation method and its context registration only), apps/web/src/app/auth/student/register/page.tsx (real proof flow), apps/web/tests/auth/student-signup.test.ts (new pure-boundary regressions), apps/web/tests/auth/student-auth-links.test.ts (new link regressions), apps/web/tests/browser/fixtures.ts and browser-assertions.ts (named signup transport/lifecycle support only), apps/web/tests/browser/student-signup.spec.ts (new actual flow cases). No change to accepted auth.ts/api-client.ts/student-return.ts/auth-response.ts/picker/backend/config/package/launcher.

Task2 entry/accessibility owns exactly: apps/web/src/app/auth/register/page.tsx, apps/web/src/app/auth/student/login/page.tsx, apps/web/src/components/ui/PasswordInput.tsx, apps/web/src/components/auth/AuthShell.tsx and apps/web/tests/browser/auth-entry.spec.ts (new). It consumes Task1's link helper/hook, without modifying their accepted interfaces. Each worker also owns its assigned report only. Root owns this plan and all progress/validation ledgers.

### Task 1: Implement the consent/receipt signup flow and confirmation handoff

**Files:** The Task1 core ownership list above. Read full current spec from the parent documentation checkout; the source checkout contains an older copy. Read source apps/web/AGENTS.md and installed Next use-search-params/testing guidance. The accepted BASE is9c8fab2611ee3524430cd268be3294bc86c2caee. The current34 browser and25 auth cases must remain unchanged and passing. Tests may add fixture support but must not weaken existing assertions or broadly suppress browser faults.

**Consumes:** publicApiClient.post(path,body,{signal}); getSessionSnapshot():SessionSnapshot; isSessionStorageQuarantined():boolean; existing private commitAuthenticatedResponse(authentication,requiredRole?):User; parseAuthenticationResponse(unknown):AuthenticationResponse|null; resolveStudentReturn(candidate:string|null,origin:string,fallback?:string):string; UniversitySelect's existing value/onChange/error/required props. No new backend interface.

**Produced interfaces (new, not currently exported):**

```ts
export type StudentSignupClaims = Readonly<{
  email: string; name: string; universityId: string; matricNumber: string | null;
  verificationConsent: true; noticeVersion: string;
}>;
export type SignupReceipt = Readonly<{
  email: string; challengeId: string; expiresAt: string; resendAvailableAt: string;
}>;
export type SignupPreflight = Readonly<{
  supported: boolean; verificationNotice: Readonly<{version: string; text: string}>;
}>;
export type SignupConfirmation = StudentSignupClaims & Readonly<{
  password: string; challengeId: string; otp: string;
}>;
export type ConfirmSignupResult =
  | {kind:'completed'}
  | {kind:'not_started';reason:'active_session'|'storage_unavailable'}
  | {kind:'rejected';reason:'validation'|'proof'|'conflict'|'other'}
  | {kind:'account_created';reason:'session_issuance'|'storage';signInPath:string}
  | {kind:'outcome_unknown';reason:'transport'|'invalid_response'|'server';signInPath:string}
  | {kind:'cancelled';reason:'aborted'|'superseded';serverOutcome:'not_dispatched'|'unknown'|'created'};

// Add this method to the existing provider's context type and value:
confirmStudentSignup(
  input: SignupConfirmation,
  options: {signal: AbortSignal; returnTo: string | null},
): Promise<ConfirmSignupResult>;

// student-signup.ts exports these pure boundaries; imports within lib use relative paths.
export function parseSignupPreflight(body: unknown): SignupPreflight | null;
export function parseSignupReceipt(body: unknown, expectedEmail: string): SignupReceipt | null;
export function parseSignupAuthentication(status: number, body: unknown, expectedEmail: string): AuthenticationResponse | null;
export function signupRetryAt(body: unknown, retryAfter: unknown, now: number): number | null;
// Also export studentSignupFormSchema (Zod) for canonical form output/field errors.
// It consumes name/email/university/matricNumber/password/confirmPassword strings.
// Canonical output retains these field names; claims map university -> universityId.

// student-auth-links.ts and useStudentAuthLinks.ts, consumed again by Task2:
export type StudentAuthLinks = Readonly<{loginPath: string; registerPath: string}>;
export function createStudentAuthLinks(returnTo: string | null, origin: string | null): StudentAuthLinks;
export function useStudentAuthLinks(): StudentAuthLinks;
```

Pure parsing functions must validate unknown outer `{success:true,data:...}`, status and required fields, not use a type assertion as validation. Receipt email must equal the submitted canonical email, challengeId is a valid UUID and both dates must parse to finite timestamps. Preflight requires an actual supported boolean plus nonempty notice version/text; supported means domain support, not ownership. Valid confirmation requires201, outer success true, parseAuthenticationResponse success, student role and exact submitted canonical mailbox. Existing parseAuthenticationResponse alone does not establish outer status/success/mailbox and is not changed for other consumers.

Canonical form output trims/lowercases mailbox, trims name2–255, maps blank optional matriculation number to null and caps it100, retains selected UUID and exact displayed noticeVersion/literal consent. Password is untrimmed, must match confirmation and mirror backend min8/ASCII uppercase/lowercase/digit and its existing special-character set. It is component-memory-only and not part of displayed/storage/navigation evidence. No new password policy or enrollment flag.

#### Provider method algorithm

- Copy input primitive fields at entry; Readonly is not runtime immutability. Compute safe return/sign-in link using existing resolveStudentReturn and browser origin; no submitted identity in URLs.
- Reconcile storage BEFORE allocating the operation counter (reconcile may synchronously notify). If active, return not_started(active_session) without clearing/replacing; if quarantined, not_started(storage_unavailable). An already-aborted signal returns cancelled/not_dispatched.
- Capture fresh signed-out generation, allocate operation, and attach an abort listener which invalidates ONLY its own still-current operation. Always remove this listener in finally. Own-commit suppression must not span asynchronous HTTP.
- A current-operation predicate fresh-reconciles before checking mounted, same provider epoch, non-aborted signal, non-quarantine, no active pair, and unchanged starting generation. Existing isCurrentSession/isExactSession deliberately require active state and cannot replace this predicate.
- Send exactly one public POST /auth/student/register-confirm with copied strict body and provided signal. No auto retry, generic register call or compensating logout.
- Classify the observed server outcome before deciding cancellation: valid201 or exact503 SESSION_ISSUANCE_UNAVAILABLE means known created; lost/malformed201/generic503 remains unknown. If local/provider authority is lost, return cancelled with actually observed outcome; never mutate newer state or navigate.
- For a valid current201, check authority immediately before private commitAuthenticatedResponse. Its synchronous store creates a NEW generation. Capture that adopted snapshot; do not reject own success by comparing it to the original signed-out generation after storage.
- A real quarantined write failure after valid201 returns account_created(storage), never account rollback. A persisted-pair mismatch due to concurrent replacement is superseded cancellation, not permission to clear the replacement. Preserve cancellation precedence if abort/unmount/operation replacement already occurred.
- Immediately before publishing, fresh-read and require mounted/current epoch/signal/non-quarantine plus exact adopted generation and expected token pair. With no intervening await, clear loading/error, set server-derived account and initiate safe navigation. Page must not independently navigate when this method resolves. Completed means navigation initiated, not destination-loaded proof.
- Map422/400 to validation,401 to proof,409 to conflict, other4xx to other. Exact503 issuance failure is known-created; generic5xx is unknown(server); malformed success is unknown(invalid_response); network/timeout without a response is unknown(transport). Return only the discriminated result, never raw Axios errors/config, tokens or claims.

#### Page lifecycle and visible outcomes

Use a query-aware inner component under a real Suspense boundary; installed Next guidance says dev success without it is not production proof. Safe links must be hydration-stable, with no direct browser-global read during server render. Provider may read origin during its browser event operation.

The page owns separate preflight and submission AbortControllers, local attempt counters, and mounted ownership. Each asynchronous continuation, catch and finally checks its own counter/signal before changing page state. Back/edit/unmount abort and invalidate their attempt. Provider cancellation and page-local cancellation are independent fences. A late old abort listener may not invalidate a newer attempt.

Keep existing fields and university label/callback. Domain support is a debounced public POST /auth/verify-student-email only for valid canonical email and UUID while details phase is active. Identity edits immediately clear consent/receipt binding; support keyed to old email/university cannot re-enable current consent. Name/matric changes invalidate consent-to-claims without inventing a new university request. A displayed notice/version change requires a new explicit consent action.

Show server notice text as escaped React text with an initially unchecked labelled checkbox. Supported copy must say school-email support and need for OTP, not Email verified or university database match. Unsupported and infrastructure failure are distinct local statuses. Submit must freshly check valid supported identity/notice and consent binding even if button state was stale.

On explicit initial request, freeze canonical claims plus password in memory and send the exact strict POST /auth/student/register-request. A valid receipt switches to OTP and focuses its labelled input. That input is paste-friendly text with inputMode numeric, autoComplete one-time-code, maxLength6 and exact six-ASCII-digit validation. Error/status messages have live semantics and described fields; avoid reading the clock every second through an assertive live region.

Confirmation sends the exact frozen receipt/claims, never current editable fields, through the new provider method. Wrong/expired proof is local and causes zero auth refresh. Completion clears sensitive pending state; cancellation cannot appear as successful signup. Unknown or known-created recovery uses distinct copy plus the sanitized ordinary sign-in link, never an automatic second confirmation/send.

Explicit resend invalidates the old receipt locally before dispatch and clears old OTP. A successful response installs its new challenge and both deadlines. This conservative rule also avoids using a potentially superseded receipt after an ambiguous failure: backend commits the new challenge/cooldown before delivering email, and leaves them after transport failure.429 updates retryAt from error.details (or a valid exposed numeric Retry-After), without claiming delivery. Do not invent a fixed arbitrary retry timestamp if neither is valid. Cooldown controls derive from returned deadlines; server remains validity authority. No auto-resend at expiry.

Back clears pending proof/OTP/consent and restores focus to the editable email field. Original editable form values may remain in page memory; nothing enters storage/URL. Going back rechecks support/notice before new consent. Unmount cancels operations and releases pending references, not a server rollback.

Render account_created(session_issuance/storage) as known successful account creation with sign-in recovery; outcome_unknown as uncertain creation, not a definitive failure/no-account claim. Conflict is not proof account absence. not_started(active_session) leaves the existing session untouched; quarantine does not present persistent authenticated UI. A current page cancelled by session replacement may report that signup stopped without pretending it completed or overwriting the newer login.

#### Execution steps

- [ ] **Step1: Record base and add boundary and rendered RED tests, before application edits.** Unit imports may initially fail because the new module is absent; that is scaffolding evidence, not sufficient application RED. Obtain at least the current page's real unchecked-consent or supported-copy assertion failure with the named fixture installed before changing runtime. Wait for every RED process to exit. Use only synthetic constants shown below; assertions exposing request bodies must compare a boolean inside the fixture and only report safe metadata.

```ts
// tests/auth/student-signup.test.ts (node:test / node:assert/strict)
const notice = { version: '2026-09-05.v1', text: 'Synthetic verification processing notice.' };
const email = 'student@alpha.approved.test';
const challengeId = '20000000-0000-4000-8000-000000000001';
test('preflight requires explicit support and a usable server notice', () => {
  assert.equal(parseSignupPreflight({success:true,data:{supported:'true',verificationNotice:notice}}), null);
  assert.equal(parseSignupPreflight({success:false,data:{supported:true,verificationNotice:notice}}), null);
  assert.equal(parseSignupPreflight({success:true,data:{supported:true,verificationNotice:{version:'',text:'x'}}}), null);
  assert.deepEqual(parseSignupPreflight({success:true,data:{supported:false,verificationNotice:notice}}), {supported:false,verificationNotice:notice});
});
test('receipt binds exact mailbox, UUID and finite server deadlines', () => {
  const data = {email,challengeId,expiresAt:'2030-01-01T00:10:00.000Z',resendAvailableAt:'2030-01-01T00:01:00.000Z'};
  assert.deepEqual(parseSignupReceipt({success:true,data},email), data);
  for (const invalid of [{...data,email:'other@alpha.approved.test'},{...data,challengeId:'not-a-uuid'},{...data,expiresAt:'not-a-date'},{...data,resendAvailableAt:null}]) {
    assert.equal(parseSignupReceipt({success:true,data:invalid},email),null);
  }
});
test('signup authentication requires exact201 outer success and student mailbox', () => {
  const user = {id:'synthetic-account',email,role:'student'};
  const body = {success:true,data:{user,tokens:{accessToken:'synthetic-access',refreshToken:'synthetic-refresh'}}};
  assert.equal(!!parseSignupAuthentication(201,body,email),true);
  assert.equal(parseSignupAuthentication(200,body,email),null);
  assert.equal(parseSignupAuthentication(201,{...body,success:false},email),null);
  for (const changed of [{...user,role:'vendor'},{...user,email:'other@alpha.approved.test'}]) {
    assert.equal(parseSignupAuthentication(201,{...body,data:{...body.data,user:changed}},email),null);
  }
});
test('retry deadline prefers operational details and never guesses one', () => {
  assert.equal(signupRetryAt({error:{details:{retryAt:'2030-01-01T00:01:00Z'}}},'99',0),Date.parse('2030-01-01T00:01:00Z'));
  assert.equal(signupRetryAt({},'60',1000),61000);
  for (const invalid of [undefined,'nonsense','-1',Infinity]) assert.equal(signupRetryAt({},invalid,1000),null);
});
```

Add canonical-schema cases for trimmed/lowercased email/name, blank matricNumber becoming null, name length1/256, matric length101, invalid university UUID, each missing password class, mismatched password confirmation and unchanged valid untrimmed password. Boolean assertions on safeParse avoid echoing submitted secrets. Add link tests for same-origin relative/absolute, external/protocol-relative/javascript/backslash/malformed escape/auth-loop returns and null origin; assert only destination strings with synthetic widget context, never account data.

- [ ] **Step2: Add named signup fixture interfaces and real-browser RED.** These are fixtures only, not production code. The exact added endpoint union and reply queue are below. Each configured response is consumed once by endpoint ordinal; exhausting/missing a configured queue is an unexpected request, not automatic success. Existing non-signup routes keep their current behavior. Safe default helpers may construct explicit queues in the new spec; do not silently enable signup success for every page.

```ts
// fixtures.ts, additional types/options alongside existing ones:
export type SignupEndpoint = 'preflight' | 'request' | 'confirm';
export type SignupReply = Readonly<{
  response: {status: number; body: unknown} | {transportFailure: true};
  gate?: Gate;
  expectCancellation?: boolean;
  expectedBody?: Readonly<Record<string, unknown>>;
}>;
// Add to ApiFixtureOptions:
signup?: Partial<Record<SignupEndpoint, readonly SignupReply[]>>;
// Add to ApiFixture:
signupRequests: Array<{endpoint:SignupEndpoint;ordinal:number;authorizationPresent:boolean;bodyKeys:string[];matchesExpectedBody:boolean}>;
waitForSignupStarted: (endpoint:SignupEndpoint,ordinal:number)=>Promise<void>;
waitForSignupRouteSettled: (endpoint:SignupEndpoint,ordinal:number)=>Promise<void>;
waitForSignupNetworkFailed: (endpoint:SignupEndpoint,ordinal:number)=>Promise<void>;
syntheticTransportFailures: Array<{path:string;errorText:string;consumed:boolean}>;
consumeExpectedTransportFailure: (path:string,errorText:string)=>boolean;
```

Use exact path mapping preflight=/auth/verify-student-email, request=/auth/student/register-request, confirm=/auth/student/register-confirm and POST only. `expectedBody` compares sorted key sets and primitive field equality inside the handler without exporting/logging payloads. Only booleans and sorted keys enter signupRequests. A fixture-local successful signup account override may service subsequent /auth/me for the synthetic signup token; do not mutate global users or alter existing student fixtures. Gate start is recorded before awaiting the gate. Map each intercepted Request to its endpoint/ordinal lifecycle in a WeakMap; page requestfailed is the network-failure fence, route settlement is only handler bookkeeping. It is never React completion.

For a transport reply, pre-register that endpoint's exact observed browser error (initial hypothesis net::ERR_FAILED), then `await route.abort('failed')`. Extend browser-assertions with an exact console text + apiOrigin + exact normalized path + one-time consumed registry entry. Establish the actual console string in controlled RED; do not suppress arbitrary ERR_FAILED/AbortError/auth paths or navigation errors. Preserve every existing HTTP/fault rule. If intentional client cancellation emits no console error, no exception registry is needed for that cancellation.

For configured cancellation, after the browser's mapped requestfailed and gate release, skip unnecessary response work and mark handler settled. If cancellation races an already-running route action, a thrown route action may be classified as expected only when that exact request/ordinal is configured cancellation-expected and its mapped requestfailed already fired. All other exceptions fail drain. Record which route action actually occurred; no assumption that fulfill-after-cancel always throws/succeeds. Release all gates in finally and drain before fixture assertion/context close.

Use this actual page-level RED first (helpers are defined in this spec; preserve current labels):

```ts
async function fillDetails(page: Page): Promise<void> {
  await page.getByLabel('Full Name',{exact:true}).fill('Synthetic Student');
  await page.getByLabel('Student Email',{exact:true}).fill('student@alpha.approved.test');
  await page.getByLabel(/^University/).fill('aau');
  await page.getByLabel(/^University/).press('ArrowDown');
  await page.getByLabel(/^University/).press('Enter');
  await page.getByLabel('Password',{exact:true}).fill('Synthetic!Pass9');
  await page.getByLabel('Confirm Password',{exact:true}).fill('Synthetic!Pass9');
}
test('supported school email still requires affirmative processing consent',async({page})=>{
  const api = await installSyntheticApi(page,{signup:{preflight:[{response:{status:200,body:{success:true,data:{supported:true,verificationNotice:notice}}}}]}});
  const faults = collectBrowserFaults(page,api);
  await page.goto('/auth/student/register');
  await fillDetails(page);
  await expect(page.getByText(notice.text,{exact:true})).toBeVisible();
  const consent = page.getByRole('checkbox',{name:'I agree to student verification processing'});
  await expect(consent).not.toBeChecked();
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('consent');
  await expect(consent).toBeFocused();
  expect(api.signupRequests.filter(r=>r.endpoint==='request')).toHaveLength(0);
  expect(api.refreshCalls).toBe(0);
  await assertCleanFixture(api,faults);
});
```

Run `NPM_CONFIG_USERCONFIG=/dev/null NEXT_TELEMETRY_DISABLED=1 npm run test:browser -- tests/browser/student-signup.spec.ts --grep 'affirmative processing consent'` from apps/web after a fresh>=3GiB guard. The current screen cannot render notice/consent and must fail its actual expectation; missing API/fixture setup is not that application failure. Finish RED before source edits.

- [ ] **Step3: Implement pure boundaries and hydration-stable links.** Mirror exact backend password regex from source password.service.ts. Use Zod unknown parsing or explicit record guards and reconstruct only trusted fields. Reject malformed response fields before forming a receipt or authenticated response. `signupRetryAt` accepts finite ISO details.retryAt first; otherwise a finite nonnegative numeric Retry-After value in seconds; reject blank strings/nonfinite values and return null rather than fabricate a cooldown. Dates need not be future for parser validity; page deadline status handles elapsed values and server decides proof validity. These link implementations provide the agreed interfaces without duplicating return-policy rules:

```ts
// src/lib/student-auth-links.ts
import {resolveStudentReturn} from './student-return';
export type StudentAuthLinks = Readonly<{loginPath:string;registerPath:string}>;
export function createStudentAuthLinks(returnTo:string|null,origin:string|null):StudentAuthLinks {
  if (!origin || returnTo === null) return {loginPath:'/auth/student/login',registerPath:'/auth/student/register'};
  const query = new URLSearchParams({redirect:resolveStudentReturn(returnTo,origin)}).toString();
  return {loginPath:`/auth/student/login?${query}`,registerPath:`/auth/student/register?${query}`};
}
// src/hooks/useStudentAuthLinks.ts
'use client';
import {useSyncExternalStore} from 'react';
import {useSearchParams} from 'next/navigation';
import {createStudentAuthLinks,type StudentAuthLinks} from '@/lib/student-auth-links';
const subscribeOrigin = (_listener:()=>void) => () => {};
const getOrigin = () => window.location.origin;
const getServerOrigin = () => null;
export function useStudentAuthLinks():StudentAuthLinks {
  const search = useSearchParams();
  const origin = useSyncExternalStore(subscribeOrigin,getOrigin,getServerOrigin);
  return createStudentAuthLinks(search.get('redirect'),origin);
}
```

Origin is immutable within one document; no-op subscription is intentional, server and initial hydration both receive null, then React reads the stable primitive browser snapshot. Hook callers must be under Suspense. Links contain only the existing sanitized return path; no new identity parameters. Preserve an existing safe widget return path without treating it as merchant consent.

- [ ] **Step4: Implement provider operation with the algorithm above.** Add only the new typed method/imports/context value/dependencies; do not rewrite login/register/logout/refresh. Copy all input primitives into the dispatched body. The pre-commit and post-commit phases require separate predicates; the following is the essential ordering, integrated with existing refs:

```ts
const started = getSessionSnapshot(); // may synchronously invalidate another operation
if (signal.aborted) return {kind:'cancelled',reason:'aborted',serverOutcome:'not_dispatched'};
if (isSessionStorageQuarantined()) return {kind:'not_started',reason:'storage_unavailable'};
if (started.accessToken || started.refreshToken) return {kind:'not_started',reason:'active_session'};
const operation = ++operationRef.current;
const onAbort = () => { if (operationRef.current === operation) operationRef.current += 1; };
signal.addEventListener('abort',onAbort,{once:true});
const ownsBeforeCommit = () => {
  const fresh = getSessionSnapshot();
  return mountedRef.current && operationRef.current === operation && !signal.aborted
    && !isSessionStorageQuarantined() && !fresh.accessToken && !fresh.refreshToken
    && fresh.generation === started.generation;
};
// In try/finally, check ownsBeforeCommit immediately before dispatch and commit.
// finally always removes onAbort. Parse/classify response before cancellation result.
// After commit, adopted = getSessionSnapshot(); compare subsequent reads to adopted,
// exact expected tokens and current operation/signal, not to started.generation.
```

Use structural or Axios isAxiosError narrowing for response status/body; do not log/return raw errors. Known-created classification precedes local cancellation classification, but only a current operation may publish recovery. If method stops before dispatch because authority changed, return cancelled/not_dispatched. A response without evidence of creation remains unknown. Provider never auto-logs out to make room for signup; active accounts remain untouched.

- [ ] **Step5: Implement the details/OTP/recovery state machine above.** Keep page route as a Suspense wrapper and query-aware inner form. Use RHF/Zod for details validation; maintain pending frozen claims/password/receipt separately from editable fields. The affirmative binding is the exact canonical identity/claims plus notice version that the person saw. Clear it immediately on relevant edits and always compare again inside submit. Keep consent available with explicit associated validation rather than only a disabled Continue button. No provider operation begins until a valid receipt and six-digit code exist. Core rendered control contract:

```tsx
<p id="verification-notice">{preflight.verificationNotice.text}</p>
<label htmlFor="verification-consent">I agree to student verification processing</label>
<input id="verification-consent" type="checkbox" aria-describedby="verification-notice consent-error" />
<p id="consent-error" role="alert">{consentError}</p>
<Label htmlFor="otp">Verification Code</Label>
<Input id="otp" name="otp" type="text" inputMode="numeric" autoComplete="one-time-code"
  maxLength={6} aria-invalid={!!otpError} aria-describedby="otp-help otp-error" />
<p id="otp-help">Enter the six-digit code sent to your school email.</p>
<p id="otp-error" role="alert">{otpError}</p>
```

Integrate controlled checked/value/events/refs and conditional error nodes; IDs referenced by aria-describedby must exist. Preserve native keyboard/paste and button semantics. Freeze selected claims at request time and compare receipt mailbox before entering OTP. Every continuation has its own current-attempt guard including finally. Support responses use a separate counter/controller; Back aborts both, discards proof/consent and focuses email; old callbacks cannot change that state. Keep a usable Back button while sending/confirming so cancellation is real. After ambiguous resend retain frozen claims for an explicit resend but set receipt=null and block confirmation until a new valid receipt. Treat known-created/unknown as terminal proof-flow recovery; release pending password/OTP and show normal sign-in with safe return.

- [ ] **Step6: Complete actual rendered regression matrix, then run GREEN.** Define `enterOtp(page, api)` in the new spec by calling fillDetails, waiting for the consent checkbox, checking it, clicking Continue and awaiting focused Verification Code. All endpoint queues are explicit in each test or a clearly named shared test factory. At minimum add the following separately named/parameterized cases; each asserts zero refresh, safe request metadata and clean fixture drainage. Use page DOM/URL/session boolean state as application completion; lifecycle waits merely order the test.

| Browser test group | Explicit setup and assertions |
| --- | --- |
| Domain outcomes | supported true/false and503 queues; true displays notice but not Email verified; false reports unsupported,503 says unable to check and has Retry; neither request/confirm runs automatically |
| Stale support/consent | Gate A preflight, edit email/university to B, serve B with different notice; A configured cancellation. Verify B stays current and unchecked after A gate release; separately check consent then edit name/matric/email to prove each invalidation |
| Request contract/receipts | expectedBody exact canonical fields and no confirmPassword; request valid receipt enters focused OTP, no session; malformed email/UUID/date receipt stays details with honest error and no confirm |
| Wrong/expired/invalid OTP | request then confirm401; enter six ASCII digits by actual paste event and stay OTP with proof error/no refresh; five digits, letters and fullwidth digits send no confirm |
| Successful resend | First receipt resendAvailableAt in past; fill old OTP, click Resend code; second receipt has different UUID and future cooldown; input cleared, confirmation body matches second receipt/frozen claims, resend disabled until returned deadline |
| Failed resend | Parameterize429(details.retryAt),503 and explicit transport abort; discard old receipt and OTP, no created/sent claim, confirm blocked,429 retry disabled by body deadline; explicit valid subsequent request recovers |
| Back during request/confirm | Gate exact ordinal with expectCancellation; click Back, wait network failed, release in finally, assert Email focus/details/unchecked consent/no new auth route; edit and retry after Back must not accept old completion |
| Unmount during request/confirm | Gate, navigate to ordinary student login, wait network failure then release; remain login with no signup session, no stale redirect; this is local cancellation, no assertion of server rollback |
| Valid201 | Exact student/canonical email with tokens, server redirect deliberately external; safe redirect query /marketplace?source=widget is followed, authenticated account visible from named /auth/me, URL contains no proof/identity credentials |
| Known-created | Exact503 SESSION_ISSUANCE_UNAVAILABLE; separately201 plus controlled active-envelope write denial after request dispatch; show account-created sign-in recovery, no stored active pair/no redirect/no automatic retry |
| Unknown outcomes | Parameterize malformed201, outerfalse201, wrong-role201, wrong-mailbox201, generic503 and transport failure; show uncertain copy and safe sign-in, no active pair/redirect/automatic resend |
| Existing authority | Seed active vendor before confirmation; no confirm request, byte-for-byte synthetic session unchanged. Seed a deterministic storage-read denial before load; no confirmation and no persistent authenticated UI |
| Replacement/logout race | Gate confirmation, another storage tab writes vendor session or tagged signed-out action before release; preserve newer serialized value, no signup navigation. Include unobserved active->tagged signed-out writes and fresh-read check, without claiming storage locking |
| Desktop/mobile keyboard | Repeat valid request and proof-error/back flow at1280x900 and390x844; label/error descriptions, consent Space, OTP paste, Back focus, buttons in viewport; Task2 adds visibility-control traversal |

Cancellation tests must observe actual AbortSignal effect through the configured requestfailed event; if Playwright routed requests cannot expose that event before route resolution, report the specific evidence and ask root for a fixture-only adjustment rather than silently skipping or using arbitrary sleeps. Late server response/session-replacement tests do not abort unless the application actually does; they must release and then wait for rendered stopped/recovery state or fixture-owned browser continuation fence if no positive UI can settle. Do not use a route-fulfilled promise as the sole fence for a negative assertion.

Example safe outcome test pattern, with explicit fixture response and only boolean session evidence:

```ts
for (const scenario of [
  {name:'known committed issuance failure',status:503,body:{success:false,error:{code:'SESSION_ISSUANCE_UNAVAILABLE'}},copy:/account was created/i},
  {name:'unknown generic server failure',status:503,body:{success:false,error:{code:'SERVICE_UNAVAILABLE'}},copy:/could not confirm whether/i},
]) {
  test(scenario.name,async({page})=>{
    const api = await installSyntheticApi(page,{signup:{
      preflight:[{response:{status:200,body:{success:true,data:{supported:true,verificationNotice:notice}}}}],
      request:[{response:{status:200,body:{success:true,data:{email,challengeId,expiresAt:new Date(Date.now()+600000).toISOString(),resendAvailableAt:new Date(Date.now()-1000).toISOString()}}}}],
      confirm:[{response:{status:scenario.status,body:scenario.body}}],
    }});
    const faults = collectBrowserFaults(page,api);
    await page.goto('/auth/student/register?redirect=%2Fmarketplace%3Fsource%3Dwidget');
    await enterOtp(page,api);
    await page.getByLabel('Verification Code',{exact:true}).fill('123456');
    await page.getByRole('button',{name:'Create Account',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText(scenario.copy);
    await expect(page.getByRole('link',{name:'Sign in',exact:true}).last()).toHaveAttribute('href','/auth/student/login?redirect=%2Fmarketplace%3Fsource%3Dwidget');
    expect(await page.evaluate(()=>{const raw=localStorage.getItem('awoof.session.v1');return raw!==null && JSON.parse(raw).state==='active';})).toBe(false);
    expect(api.signupRequests.filter(r=>r.endpoint==='confirm')).toHaveLength(1);
    expect(api.refreshCalls).toBe(0);
    await assertCleanFixture(api,faults);
  });
}
```

Test-only storage denial helpers belong in fixtures.ts, with explicit target key/state and finally restoration or isolated context disposal. No raw storage/body output. Existing fixture writeSignedOutMarker emits legacy anonymous marker; do not globally change its old tests. Add a separately named tagged-action helper for new races or write exact synthetic tagged state in a fixture-only page.evaluate. Test credentials may be typed but never photographed, traced or included in failures via raw toEqual(body).

- [ ] **Step7: Run complete validation sequentially on frozen source.** All npm calls use NPM_CONFIG_USERCONFIG=/dev/null. Run test:auth, both TypeScript checks (`npm run test:browser:typecheck`, `./node_modules/.bin/tsc --noEmit --incremental false`) and scoped lint for all owned TS/TSX. Fresh disk guard before full dev suite; wait for exit. Fresh guard before `NEXT_PUBLIC_API_URL=http://127.0.0.1:3108 NEXT_TELEMETRY_DISABLED=1 npm run build -- --webpack`; record actual page count and BUILD_ID. Fresh guard before `AWOOF_BROWSER_MODE=production NEXT_TELEMETRY_DISABLED=1 npm run test:browser`. No skips/retries, no backend server, no concurrent build/dev. Record exact counts/command outputs/warnings, listener/stage ownership and cleanup. Do not claim accessibility merely from markup: actual keyboard/mobile cases must pass. Root will repeat proportional independent exact-head checks; Astra reviews fullBASE..HEAD.

- [ ] **Step8: Commit and freeze.** git diff --check and inspect scoped delta, explicitly stage owned files, commit `fix(signup): bind student proof flow to consent and session authority`. Report exact BASE/HEAD, real RED/GREEN, all matrix coverage, remaining limits and cleanup in root-assigned report. No push/merge/deploy. Stop source edits until task gate; root will send bounded findings if any. Do not start Task2 without root dispatch after Task1 acceptance.

### Task 2: Route auth entry safely and finish password-control accessibility

**Files:** Modify apps/web/src/app/auth/register/page.tsx, apps/web/src/app/auth/student/login/page.tsx, apps/web/src/components/ui/PasswordInput.tsx, apps/web/src/components/auth/AuthShell.tsx. Create apps/web/tests/browser/auth-entry.spec.ts. Consume Task1's accepted source; parent supplies exactBASE/report. No provider/storage/picker/signup-core changes.

**Interfaces:** Consume `useStudentAuthLinks():Readonly<{loginPath:string;registerPath:string}>` from hooks/useStudentAuthLinks, called only within Suspense; existing useAuth.login(email,password,'student',rememberMe):Promise<void> remains navigation owner; existing PasswordInputProps=React.ComponentProps<typeof Input> and forwarded ref stay compatible. No new public interface or student generic-create call.

- [ ] **Step1: Write actual entry-link/keyboard RED tests and run them before source edits.** Named fixture routes remain fail-closed. Both student and vendor choices must be links, not credential submission. An explicit safe widget return must survive student chooser->signup->login->signup. Unsafe/auth-loop candidates must resolve to existing safe fallback. The generic route must expose no password or role submission form and no generic register request. Concrete first RED:

```ts
test('generic entry links students into the proof flow and preserves vendor entry',async({page})=>{
  const api=await installSyntheticApi(page);
  const faults=collectBrowserFaults(page,api);
  await page.goto('/auth/register?redirect=%2Fmarketplace%3Fsource%3Dwidget');
  await expect(page.getByRole('link',{name:'Continue as a student'})).toHaveAttribute('href','/auth/student/register?redirect=%2Fmarketplace%3Fsource%3Dwidget');
  await expect(page.getByRole('link',{name:'Continue as a vendor'})).toHaveAttribute('href','/auth/vendor/register');
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  expect(api.registerCalls).toBe(0);
  await assertCleanFixture(api,faults);
});
for(const viewport of [{width:1280,height:900},{width:390,height:844}]) {
  test(`student password visibility is a native keyboard control at${viewport.width}`,async({page})=>{
    await page.setViewportSize(viewport);
    const api=await installSyntheticApi(page);
    const faults=collectBrowserFaults(page,api);
    await page.goto('/auth/student/login');
    const input=page.getByLabel('Password',{exact:true});
    await input.focus();
    await input.press('Tab');
    const show=page.getByRole('button',{name:'Show password',exact:true});
    await expect(show).toBeFocused();
    await show.press('Space');
    await expect(input).toHaveAttribute('type','text');
    const hide=page.getByRole('button',{name:'Hide password',exact:true});
    await hide.press('Enter');
    await expect(input).toHaveAttribute('type','password');
    expect(api.loginCalls).toBe(0);
    await assertCleanFixture(api,faults);
  });
}
```

Run only new file under normal loopback dev fixture after fresh disk guard. Expect missing chooser links/named password button in existing source; document actual assertions. Add signup password+confirm-password traversal (two controls scoped by their enclosing relative wrapper/field, not ambiguous global names), safe link roundtrip/external/auth-loop cases and disabled-control behavior during gated login. Real Enter on form still submits once; existing vendor/admin auth suite must pass unchanged.

- [ ] **Step2: Replace generic credentials with existing dedicated choices under Suspense.** No generic useAuth.register/router.push remains on this route. Keep AuthShell generic title/subtitle/style and ordinary generic sign-in footer. Inner component uses Task1 hook; map its registerPath to student only. Minimal content:

```tsx
<div className="grid gap-4">
  <Link href={registerPath} className="rounded-xl border p-4 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2">Continue as a student</Link>
  <Link href="/auth/vendor/register" className="rounded-xl border p-4 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2">Continue as a vendor</Link>
</div>
```

Wrap query-aware inner content in `<Suspense fallback={<p role="status">Loading account options...</p>}>`, keeping the AuthShell around that inner boundary where practical; no browser-global render or dynamic-route bypass. Keep dedicated vendor route unchanged.

- [ ] **Step3: Share named password visibility and safe student links.** Student login inner component under Suspense reads registerPath, replaces its nameless custom icon markup with PasswordInput and retains RHF ref/validation/rememberMe/login callback. Use `autoComplete="current-password"`, disabled={isLoading}, associated error IDs and live error box. Signup already uses shared PasswordInput, so its toggles gain native keyboard access with this change. Preserve prop/ref compatibility:

```tsx
// PasswordInput destructuring keeps type controlled by visibility, not caller override:
({className,disabled,...props},ref) => {
  const [showPassword,setShowPassword]=React.useState(false);
  // Existing wrapper/classes retained; input forwards all remaining native props/ref.
  // Input receives {...props}, disabled={disabled}, then controlled visibility type.
  return <div className="relative">
    <Input {...props} ref={ref} disabled={disabled} type={showPassword?'text':'password'} className={cn('pr-9',className)} />
    <button type="button" disabled={disabled} onClick={()=>setShowPassword(value=>!value)}
      aria-label={showPassword?'Hide password':'Show password'}
      className="absolute right-2 top-1/2 -translate-y-1/2 min-h-6 min-w-6 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50">
      {showPassword?<EyeOff className="h-4 w-4" aria-hidden/>:<Eye className="h-4 w-4" aria-hidden/>}
    </button>
  </div>;
}
```

The controlled type comes after the native props spread, so an inherited type prop cannot override visibility; no tabIndex=-1, no custom keydown activation, no nested interactive element. At least24px target and visible focus must be checked on real pages. Keep PasswordInput disabled along with gated login fields so toggle cannot mutate disabled control. Change only student AuthShell line to `Verify your student status and keep it up to date. Save on food, tech, fashion, and more.` No permanent verification or enrollment guarantee.

- [ ] **Step4: Full verification, commit and freeze.** Run auth/semantic types/scoped lint; full dev browser; freshguard+Webpack build with synthetic API; recordBUILD_ID; freshguard+fullproduction browser. Existing all-role auth and Task1 signup suites must pass, no skips/no browser fault suppression. Preserve warnings honestly; inspect desktop/mobile focus geometry without identity screenshots. git diff --check, explicit owned staging, commit `fix(auth-ui): route student entry and restore keyboard controls`. Write assigned report with exact BASE/HEAD/RED/GREEN/cleanup. Freeze for root/Astra task gate and then one final plan-range review. No push, merge, VPS or whole-project readiness claim.
