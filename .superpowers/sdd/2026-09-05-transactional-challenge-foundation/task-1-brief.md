### Task 1: Add atomic challenge storage and a real-database test runner

**Owned files:**
- Create apps/backend/src/database/migrations/029_verification_challenges.sql.
- Create apps/backend/src/services/verification/challenge.service.ts and challenge.service.test.ts.
- Create apps/backend/src/testing/postgres/test-database.ts, challenge.integration.ts and session.integration.ts.
- Create apps/backend/scripts/test-postgres.mjs.
- Modify apps/backend/package.json scripts only and docs/HANDOVER.md validation instructions only.
- Own this plan for checkbox updates/commit. Do not edit current signup/WhatsApp services or controllers yet.

**Public interfaces and semantics:**

```ts
export type ChallengePurpose = 'student_signup' | 'student_email' | 'account_email' | 'whatsapp' | 'password_reset';
export type ChallengeBindings = Record<string, unknown>;
export function requestChallenge(tx: PoolClient, input: {
  purpose: ChallengePurpose; subjectKey: string; bindings: ChallengeBindings;
}): Promise<
  | { status: 'issued'; challengeId: string; code: string; expiresAt: Date }
  | { status: 'cooldown' | 'locked'; retryAt: Date }
>;
export function consumeChallenge(tx: PoolClient, input: {
  purpose: ChallengePurpose; subjectKey: string; challengeId: string; code: string;
}): Promise<
  | { status: 'verified'; challengeId: string; bindings: ChallengeBindings }
  | { status: 'invalid' | 'expired' | 'locked' }
>;
```

Both functions require an already-open caller transaction; they do not COMMIT/ROLLBACK or make external requests. A successful caller consumes then validates/applies the immutable bindings and creates proof in that same transaction. Any later failure rolls back consumption. Failed guesses return an ordinary result so the caller can commit the increment before returning a generic HTTP failure. Document this non-throwing rejection contract explicitly; only infrastructure/programming failures throw. No helper returns the code except the issuance result intended for server-side delivery.

- [x] **Step 1 — Build a guarded disposable test harness, then write RED tests before the service/migration.** `npm run test:postgres` invokes the new Node script. Locate installed initdb/pg_ctl/createdb binaries on PATH or explicit PostgreSQL binary-dir option; fail clearly if absent, never install. Check at least 3 GiB free before cluster creation. Make a unique directory using mkdtemp under the OS temp directory, initialize it with synthetic user `awoof_test`, start on loopback only using an ephemeral selected port and a socket directory within that scratch path, create a database named `awoof_test_<safe random suffix>`, and override child NODE_ENV/test JWT secrets and DATABASE_URL with this fixture URL. No URL supplied from the normal application environment may be used. No server may bind a public address. A port collision must abort, not select an existing instance. Run the real migration runner and then all `.integration.ts` tests with test concurrency 1. Use try/finally and signal handlers to stop only this exact data directory and remove only this invocation's scratch directory; preserve useful failure output without dumping environment values. Limit child startup/test timeouts and clean up after failure as well as success.

The integration helper must reject execution unless NODE_ENV=test and explicit AWOOF_TEST_DATABASE_URL equals DATABASE_URL, the URL host is literal loopback, database matches `^awoof_test_[a-z0-9_]+$`, and a runner-generated guard token is present. Verify current_database() before any fixtures. Do not provide fallback DB settings. Reuse the real application's DB pool/service queries; no fake SQL evaluator. Use synthetic unique IDs and reserved `.invalid` emails only. Close pools at test end. A direct test invocation without the guard must fail clearly. The normal existing `npm test` must remain database-free (integration filenames deliberately do not end `.test.ts`).

Write challenge tests expressing the interfaces above and record the expected RED reason. If the initial failure is missing module/table, record it explicitly as new-feature RED, not as an existing production reproduction. Include a focused crypto/unit test first if useful, but do not claim mocked DB results prove concurrency.

```ts
const issued = await inTransaction(client => requestChallenge(client, {
  purpose: 'student_signup', subjectKey: 'student@example.invalid',
  bindings: { universityId, name: 'Synthetic Student', verificationConsent: true, noticeVersion: 'v1' },
}));
assert.equal(issued.status, 'issued');
// Two separate clients/transactions, real SQL, same challenge and secret:
const outcomes = await Promise.all([confirm(issued), confirm(issued)]);
assert.equal(outcomes.filter(result => result.status === 'verified').length, 1);
```

- [x] **Step 2 — Add migration 029 and the minimal service.** `verification_challenge_budgets` has a composite key `(purpose, subject_digest)`, a current challenge ID, fixed-window start, failed-attempt count, send count and resend deadline. `verification_challenges` holds UUID, purpose, subject digest, keyed secret digest, immutable bounded JSON bindings, created/expiry/consumed/superseded timestamps. Do not store raw OTP, raw subject key, passwords, or tokens in these tables. Use database constraints for valid purposes/nonnegative counters/digest lengths and useful lookup/expiry indexes. Preserve old challenge rows so proof can later refer to an immutable consumed challenge; a resend marks/replaces the current challenge, it never overwrites historical bindings.

Use Node randomInt for a six-digit OTP and randomUUID for challenge IDs. Derive separate HMAC-SHA256 digests with the existing strong config.jwt.secret and explicit distinct domain-separation labels for subject and OTP; OTP digest input includes purpose, subject digest, random challenge ID and code. Do not use plain SHA-256 for low-entropy OTPs. Constant-time compare fixed-length digest buffers; malformed inputs return rejection, not uncaught buffer exceptions. Document that JWT-secret rotation invalidates outstanding challenges. Bindings must be a plain JSON object with a small serialized size cap (e.g. 4 KiB), copied/persisted rather than caller-mutated; never log code/bindings/digests.

Acquire locks consistently: caller locks account/policy/grants first (future core), then this service upserts the subject budget and locks it FOR UPDATE, then the selected challenge row. Two first requests must converge on the same budget row. Read database clock_timestamp() after obtaining the budget lock so time is not stale after waiting. OTP expiry is 10 minutes after issuance. A fixed 10-minute subject/purpose window allows at most five failed attempts and at most ten sends, with at least 60 seconds between sends; requests/resends do not reset a live window's counters. Reset the fixed window only after its deadline, never on success/resend. Use a user-level subject key for authenticated email challenges regardless of institution to prevent school-switching from resetting limits; callers will normalize signup email before supplying the key. Subject and purpose are server-side inputs, never taken as an authority from an untrusted submitted ID.

Only the budget's current, unconsumed, unsuperseded, unexpired challenge for that exact subject/purpose may succeed. Invalid/wrong ID/secret attempts on an existing budget consume its failure allowance; an exhausted window rejects even a correct code until the window ends. A resend replaces the old challenge and retains the budget. Successful consumption marks consumed_at while holding the locks and returns persisted bindings only; concurrent retry cannot succeed. Resend-versus-confirm is serialized by the budget lock. No Redis dependency or cache fallback.

- [x] **Step 3 — GREEN real-database challenge tests.** Cover: wrong subject/purpose/ID/secret; malformed code; OTP and subject not stored plaintext; six digits and distinct challenges; immutable claim binding; expiry; exact five-failure cutoff; cooldown; resend supersession; failure/send budgets survive resend; budget resets only at fixed-window expiry; two concurrent first requests; simultaneous correct confirmations have one winner; concurrent wrong guesses never undercount; resend/confirm races; successful consume followed by thrown proof-write failure rolls back and permits a later legitimate completion. Advance database fixture timestamps explicitly rather than sleep for minutes. Use independent real clients with controlled locks/barriers and bounded timeouts, not high-count probabilistic loops.

- [x] **Step 4 — Close A14's real-SQL test gap.** In session.integration.ts use real issueSession/refreshSession/revokeSession and actual users/students/vendors rows after real migrations. Verify pending/active vendors succeed, suspended/rejected/deleted vendors and suspended/deleted students cannot issue or refresh, deleted user denies, old unregistered refresh denies, fresh database email/role claims are used, second issuance revokes first, logout clears authority with no Redis, and verified-password mismatch rejects. For a real reset-versus-login race hold the user row in one transaction, change password and clear durable fields, start issuance with the formerly checked password on another connection, then commit the reset and assert issuance rejects. Assert stored hashes/expiry and resulting JWT claims, not source strings. Preserve session API behavior; report an actual implementation flaw to the controller instead of editing unowned session code.

- [x] **Step 5 — Validate, document and commit.** Run the disposable PostgreSQL suite, backend npm test, type-check, lint and git diff --check. Record exact counts and any existing warnings; prove the scratch instance stopped and temporary fixture directory was removed. Document command, local binary requirement, guardrails and the still-unwired route boundary. Update this plan's checks; commit owned files only as `feat(verification): add transactional bounded OTP challenges`. Write the full assigned scratch report with RED/GREEN evidence, schema/interfaces, cleanup evidence and remaining risks; return compact commit/status. This task alone does not close A12 because route migration is a dependent task.
