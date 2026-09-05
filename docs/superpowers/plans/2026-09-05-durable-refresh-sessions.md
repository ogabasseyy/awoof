# Durable Refresh Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Fix audit A14 so logout/password changes and account restrictions cannot be bypassed by losing Redis.

**Architecture:** Preserve the current single-active-refresh-token-per-user semantics, replacing Redis's optional authority with a SHA-256 hash and expiry on the PostgreSQL user row. Refresh tokens remain JWTs with unique random IDs; current database user/role/status controls refresh. Redis may still support unrelated OTP flows but never decides refresh validity.

**Tech Stack:** Existing Express, PostgreSQL, jsonwebtoken, Node crypto and node:test/tsx; no new dependency.

**Spec:** /Users/mac/Downloads/Awoof/docs/audits/2026-09-05-student-verification-audit.md A14 and recovery Phase 0. This is a bounded repair of the existing session behavior, not a new authentication product.

## Global Constraints

- Work only in /Users/mac/Downloads/Awoof/.worktrees/verification-remediation on codex/awoof-verification-remediation.
- Terra implements; Astra reviews; no child agents.
- No push, merge, VPS deployment, production/provider requests or real-user data access.
- Preserve other people's changes; use only synthetic tests; no shared-node_modules edits or installs.
- Do not change Paystack, marketplace decisions, student eligibility policy or API response shapes.
- Fail closed on unavailable session authority; never silently accept an unregistered refresh token.
- Migrations are additive and must not fabricate sessions for old tokens. Existing sessions must sign in again after deployment; preserve short-lived access JWT behavior for now.

### Task 1: Persist and enforce revocable refresh sessions

**Owned files:**
- Create apps/backend/src/database/migrations/028_durable_refresh_sessions.sql
- Create apps/backend/src/services/auth/session.service.ts
- Modify apps/backend/src/services/auth/jwt.service.ts
- Modify apps/backend/src/controllers/auth.controller.ts
- Modify only token-pair issuance calls/imports in apps/backend/src/controllers/verification.controller.ts (identity defects have a separate repair task).
- Create apps/backend/src/controllers/auth-session.controller.test.ts and apps/backend/src/services/auth/session.service.test.ts
- Modify docs/HANDOVER.md to document the migration and re-login requirement.

**Interfaces:** Export `issueSession(payload: TokenPayload, rememberMe?: boolean, expectedPasswordHash?: string): Promise<TokenPair>`, `refreshSession(refreshToken: string): Promise<string>` and `revokeSession(userId: string): Promise<void>` from the session service. Reuse `jwtService` crypto methods, `db.query` and existing AppError classes. `refreshSession` returns the new access-token string; HTTP shapes remain unchanged.

- [x] **Step 1 — RED, reproduce the current fail-open behavior.** In a controller test, mock only the DB/Redis external boundary, use a real signed refresh JWT and set Redis not ready. Return no registered session from the DB. Invoke `new AuthController().refreshToken` with that JWT and assert it rejects rather than setting a response access token. This must fail against the current controller for the missing rejection, not because a test cannot load. Add independent cases for expired/revoked/no session, deleted user, suspended student, suspended/rejected vendor, changed database role/email, and unavailable DB. Restore mocks with node:test context cleanup.

```ts
const token = jwtService.generateRefreshToken({ userId, email: 'student@example.invalid', role: 'student' });
t.mock.method(redis, 'getClient', () => ({}) as ReturnType<typeof redis.getClient>);
t.mock.method(redis, 'isConnected', () => false);
t.mock.method(db, 'query', async () => ({ rows: [], rowCount: 0 }) as never);
await assert.rejects(new AuthController().refreshToken(
  { body: { refreshToken: token } } as Request,
  responseRecorder as unknown as Response,
));
```

The recorder must capture the real controller response; it must not create the failure itself. Use the existing test environment keys and `node --import tsx --test` or the package test runner. Record command/output before implementation.

- [x] **Step 2 — Add durable fields and session functions.** Migration:

```sql
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS refresh_token_hash VARCHAR(64),
    ADD COLUMN IF NOT EXISTS refresh_token_expires_at TIMESTAMPTZ;
```

`generateRefreshToken` must set `jwtid: randomUUID()` in its signing options so two sessions in the same second produce distinct tokens. Compute `createHash('sha256').update(refreshToken).digest('hex')`; persist no plaintext token. Derive expiry from `verifyRefreshToken(token).exp`, rejecting absent/non-finite expiry. Store only for a non-deleted user with role-matching live profile: student must have an active student row; vendor must have a non-deleted pending or active vendor row; admin remains allowed. Treat zero rows as unauthorized. For password login pass the password hash that was actually checked, and include equality in the conditional update to reject a password-reset race. Preserve remember-me lifetime semantics by taking expiry from the token.

```sql
UPDATE users SET refresh_token_hash = $2, refresh_token_expires_at = $3
WHERE id = $1 AND deleted_at IS NULL
  AND ($4::text IS NULL OR password_hash = $4)
RETURNING id;
```

The final query must also enforce the profile/role predicates above. `refreshSession` first verifies the JWT cryptographically, then queries the matching user ID/hash/unexpired durable expiry and live profile status. Issue the access JWT from the returned database email/role, not stale refresh-token claims. DB failure must propagate as unavailable/failure, never success. `revokeSession` clears both fields in PostgreSQL, regardless of Redis status.

- [x] **Step 3 — Wire every existing issuance and revocation path.** Replace all six token-pair issuance sites in auth/verification controllers with awaited `issueSession`; remove optional Redis refresh-token writes and the old conditional refresh lookup. Do not leave a route returning a refresh token that the new authority never recorded. Replace logout with durable revocation. In password reset and authenticated password change, clear both refresh fields in the same SQL UPDATE that changes the password; preserve existing password-reset OTP cleanup. Do not rely on a later best-effort call for atomic revocation. Other Redis password-reset/OTP behavior stays scoped out.

- [x] **Step 4 — GREEN and regression checks.** Tests must show registered valid refresh succeeds with fresh DB claims, unregistered/cleared/mismatched hash refuses, DB/Redis loss does not restore revocation, pending vendor may refresh, suspended/deleted users cannot, repeat issuance has unique refresh tokens, expiry matches 7-day/default and 30-day remember-me token expiry, and password mutation clears durable refresh fields atomically. Assert actual outputs, conditional-update arguments and intended side effects at the DB boundary; do not test source strings as a substitute for behavior. Run focused tests while iterating, then backend `npm test`, `npm run type-check`, `npm run lint`, `git diff --check` before committing. Record baseline warnings distinctly.

- [x] **Step 5 — Document, self-review and commit.** Document that migration 028 must precede backend startup and old refresh tokens need re-login, without running production migrations. Commit only owned changes and this plan as `fix(auth): enforce durable refresh session revocation`. Write a full report with RED/GREEN evidence and named remaining risks to the assigned scratch report; return a compact status and commit.
