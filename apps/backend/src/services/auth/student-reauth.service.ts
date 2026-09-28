import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ConflictError, NotFoundError, ServiceUnavailableError, UnauthorizedError } from '../../common/errors/AppError.js';
import { encryptMicrosoftAttemptVerifier, hashMicrosoftAttemptSecret } from '../verification/microsoft-attempt-crypto.js';
import type { ApprovedLoginPolicy, FreshProviderObservation, LoginProvider, StudentOidcAdapter } from './student-sso.types.js';
import type { ActionPurpose, ActionGrantResult } from './student-action-grant.service.js';
import { issueActionGrant } from './student-action-grant.service.js';
import { decryptMicrosoftAttemptVerifier } from '../verification/microsoft-attempt-crypto.js';
import { lockStudentContext } from '../verification/eligibility-context.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const STUDENT_REAUTH_LIFETIME_SECONDS = 5 * 60;
export const STUDENT_REAUTH_CLOCK_SKEW_SECONDS = 60;

function secret(bytes = 32): string { return randomBytes(bytes).toString('base64url'); }
function invalidReauth(): ConflictError { return new ConflictError('Student SSO reauthentication is no longer valid'); }

/** Per-attempt browser binding cookie prefix; the route layer scans it to dispatch callbacks for scrubbed attempts. */
export const STUDENT_REAUTH_COOKIE_PREFIX = 'awoof_reauth_';

/** Browser binding cookie for one reauthentication attempt; shared with the route layer. */
export function studentReauthCookieName(attemptId: string): string { return `${STUDENT_REAUTH_COOKIE_PREFIX}${attemptId}`; }

/** Validates the provider assertion relative to the server-held attempt, not token issuance time. */
export function assertFreshAuthTime(authTime: unknown, startedAt: Date, now: Date): asserts authTime is number {
    if (typeof authTime !== 'number' || !Number.isSafeInteger(authTime)
        || authTime < Math.floor(startedAt.getTime() / 1000) - STUDENT_REAUTH_CLOCK_SKEW_SECONDS
        || authTime > Math.floor(now.getTime() / 1000) + STUDENT_REAUTH_CLOCK_SKEW_SECONDS) {
        throw new ConflictError('Fresh Microsoft authentication is required');
    }
}

export type StudentReauthDependencies = {
    pool: Pool;
    attemptKey: string;
    oidcForPolicy: (policy: ApprovedLoginPolicy) => StudentOidcAdapter;
    isProviderEnabled: (provider: LoginProvider) => boolean;
    completionUrl: URL;
};

export class StudentReauthService {
    constructor(private readonly deps: StudentReauthDependencies) {}

    async start(input: { userId: string; sid: string; purpose: ActionPurpose; targetIdentityId?: string; pendingCodeId?: string }): Promise<{ attemptId: string; authorizationUrl: string; callbackCookie: string }> {
        if (!UUID.test(input.userId) || !UUID.test(input.sid)) throw new UnauthorizedError('Student SSO session is not available');
        const row = await this.deps.pool.query<{
            identity_id: string; provider: LoginProvider; observed_email: string | null; policy_id: string; policy_version: number;
            issuer: string; realm: string; university_id: string; credential_generation: string | number;
        }>(
            `SELECT identity.id AS identity_id, identity.provider, identity.observed_email,
                    policy.id AS policy_id, policy.version AS policy_version, policy.issuer,
                    policy.provider_realm AS realm, policy.university_id, users.credential_generation
             FROM users
             JOIN student_auth_identities identity ON identity.user_id = users.id AND identity.revoked_at IS NULL
             JOIN students student ON student.user_id = users.id
                 AND student.status = 'active'
                 AND student.university_id = identity.university_id
             JOIN universities university ON university.id = identity.university_id AND university.is_active
             JOIN institution_login_policies policy ON policy.university_id = identity.university_id
                 AND policy.provider = identity.provider AND policy.issuer = identity.issuer
                 AND policy.enabled AND policy.approved_by IS NOT NULL AND policy.approved_until > clock_timestamp()
             JOIN institution_login_domain_providers mapping ON mapping.policy_id = policy.id
                 AND mapping.university_id = policy.university_id AND mapping.provider = policy.provider
             JOIN institution_login_domains domain ON domain.domain = mapping.domain
                 AND domain.university_id = mapping.university_id AND domain.is_active
             WHERE users.id = $1 AND users.role = 'student' AND users.deleted_at IS NULL AND users.active_session_id = $2::uuid
                 AND identity.provider = 'microsoft'
                 AND identity.observed_email IS NOT NULL AND identity.observed_email <> ''
             ORDER BY identity.linked_at DESC LIMIT 1`,
            [input.userId, input.sid],
        );
        const identity = row.rows[0];
        if (!identity || identity.provider !== 'microsoft' || !identity.observed_email || !this.deps.isProviderEnabled(identity.provider)) throw invalidReauth();
        // Bound the composite attempt foreign keys before issuance, mirroring
        // password reauthentication: a missing or foreign target must surface
        // as an operational error, never a PostgreSQL 23503 surfaced as a 500.
        if (input.targetIdentityId !== undefined) {
            if (!UUID.test(input.targetIdentityId)) throw invalidReauth();
            const target = await this.deps.pool.query<{ id: string }>(
                'SELECT id FROM student_auth_identities WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
                [input.targetIdentityId, input.userId],
            );
            if (!target.rows[0]) throw new NotFoundError('Student SSO login identity not found');
        }
        if (input.pendingCodeId !== undefined) {
            if (!UUID.test(input.pendingCodeId)) throw invalidReauth();
            const pending = await this.deps.pool.query<{ id: string }>(
                'SELECT id FROM student_auth_recovery_codes WHERE id = $1 AND user_id = $2',
                [input.pendingCodeId, input.userId],
            );
            if (!pending.rows[0]) throw new NotFoundError('Student SSO recovery code not found');
        }
        const policy: ApprovedLoginPolicy = {
            id: identity.policy_id, version: identity.policy_version, provider: identity.provider,
            issuer: identity.issuer, realm: identity.realm, universityId: identity.university_id,
        };
        const adapter = this.deps.oidcForPolicy(policy);
        if (!adapter.authorizeFresh) throw new ServiceUnavailableError('Fresh Microsoft authentication is unavailable');
        const attemptId = randomUUID();
        const state = secret();
        const nonce = secret();
        const verifier = secret(48);
        const callbackCookie = secret();
        const authorizationUrl = await adapter.authorizeFresh({ state, nonce, verifier, loginHint: identity.observed_email });
        await this.deps.pool.query(
            `INSERT INTO student_auth_reauth_attempts
                 (id, user_id, sid, credential_generation, purpose, policy_id, policy_version, provider,
                  state_hash, callback_cookie_hash, encrypted_verifier, nonce, proof_identity_id, target_identity_id, pending_code_id, expires_at)
             VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, 'microsoft', $8, $9, $10, $11, $12, $13, $14, clock_timestamp() + interval '5 minutes')`,
            [attemptId, input.userId, input.sid, Number(identity.credential_generation), input.purpose, policy.id, policy.version,
                hashMicrosoftAttemptSecret(state), hashMicrosoftAttemptSecret(callbackCookie), encryptMicrosoftAttemptVerifier(verifier, this.deps.attemptKey, attemptId), nonce,
                identity.identity_id, input.targetIdentityId ?? null, input.pendingCodeId ?? null],
        );
        return { attemptId, authorizationUrl: authorizationUrl.href, callbackCookie };
    }

    async isReauthState(state: string | null): Promise<boolean> {
        return (await this.callbackCookieNameForState(state)) !== null;
    }

    /** State is hashed before lookup; callers receive a cookie name only. */
    async callbackCookieNameForState(state: string | null): Promise<string | null> {
        if (!state || state.length > 1024) return null;
        const result = await this.deps.pool.query<{ id: string }>(
            'SELECT id FROM student_auth_reauth_attempts WHERE state_hash = $1', [hashMicrosoftAttemptSecret(state)],
        );
        return result.rows[0] ? studentReauthCookieName(result.rows[0].id) : null;
    }

    /** Hashed state lookup for failure redirects; the id lands the browser on the bounded completion page. */
    async attemptIdForState(state: string | null): Promise<string | null> {
        if (!state || state.length > 1024) return null;
        const result = await this.deps.pool.query<{ id: string }>(
            'SELECT id FROM student_auth_reauth_attempts WHERE state_hash = $1', [hashMicrosoftAttemptSecret(state)],
        );
        return result.rows[0]?.id ?? null;
    }

    async callback(input: { callbackUrl: URL; callbackCookie: string | undefined }): Promise<{ attemptId: string; completionUrl: URL }> {
        const state = input.callbackUrl.searchParams.get('state');
        if (!state || !input.callbackCookie) throw invalidReauth();
        const found = await this.deps.pool.query<ReauthAttempt & { now: Date }>(
            `SELECT attempt.*, identity.provider AS identity_provider, identity.issuer AS identity_issuer, identity.subject AS identity_subject,
                    policy.issuer AS policy_issuer, policy.provider_realm AS policy_realm, policy.university_id,
                    clock_timestamp() AS now
             FROM student_auth_reauth_attempts attempt
             JOIN student_auth_identities identity ON identity.id = attempt.proof_identity_id
             JOIN institution_login_policies policy ON policy.id = attempt.policy_id
             WHERE attempt.state_hash = $1`, [hashMicrosoftAttemptSecret(state)],
        );
        const attempt = found.rows[0];
        // The preflight expiry uses the database clock from the same
        // statement: an application host ahead of PostgreSQL must not
        // reject an attempt the database still considers live.
        if (!attempt || attempt.status !== 'pending' || attempt.expires_at <= attempt.now
            || hashMicrosoftAttemptSecret(input.callbackCookie) !== attempt.callback_cookie_hash
            || attempt.provider !== 'microsoft' || attempt.identity_provider !== 'microsoft'
            || !this.deps.isProviderEnabled('microsoft')) throw invalidReauth();
        const adapter = this.deps.oidcForPolicy({ id: attempt.policy_id, version: attempt.policy_version, provider: 'microsoft', issuer: attempt.policy_issuer, realm: attempt.policy_realm, universityId: attempt.university_id });
        if (!adapter.redeemFresh) throw new ServiceUnavailableError('Fresh Microsoft authentication is unavailable');
        // Single-use claim before any external redemption: a concurrently
        // delivered duplicate observes processing (or loses the CAS) and
        // never redeems the one-use authorization code. The claim holds no
        // secrets hostage: failures revert to pending so the route layer
        // keeps sole ownership of terminalization.
        await this.transaction(async (tx) => {
            await tx.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [attempt.user_id]);
            const locked = await tx.query<{ status: string }>(
                'SELECT status FROM student_auth_reauth_attempts WHERE id = $1 FOR UPDATE', [attempt.id],
            );
            if (locked.rows[0]?.status !== 'pending') throw invalidReauth();
            const claimed = await tx.query(
                "UPDATE student_auth_reauth_attempts SET status = 'processing' WHERE id = $1 AND status = 'pending'", [attempt.id],
            );
            if (claimed.rowCount !== 1) throw invalidReauth();
        });
        let observation: FreshProviderObservation;
        try {
            observation = await adapter.redeemFresh({ callback: input.callbackUrl, state, nonce: attempt.nonce, verifier: decryptMicrosoftAttemptVerifier(attempt.encrypted_verifier, this.deps.attemptKey, attempt.id) });
        } catch (error) {
            await this.revertClaim(attempt.id);
            throw error;
        }
        try {
            return await this.transaction(async (tx) => {
                // Canonical lock order (see finish): the owner row precedes the
                // attempt row so this cannot deadlock against account recovery.
                const account = await tx.query<{ active_session_id: string | null; credential_generation: string | number; deleted_at: Date | null }>(
                    'SELECT active_session_id, credential_generation, deleted_at FROM users WHERE id = $1 FOR UPDATE', [attempt.user_id],
                );
                const locked = await tx.query<ReauthAttempt & { policy_approved_by: string | null }>(
                    `SELECT attempt.*, identity.provider AS identity_provider, identity.issuer AS identity_issuer, identity.subject AS identity_subject,
                            policy.issuer AS policy_issuer, policy.provider_realm AS policy_realm, policy.university_id,
                            policy.enabled AS policy_enabled, policy.approved_until, policy.approved_by AS policy_approved_by
                     FROM student_auth_reauth_attempts attempt
                     JOIN student_auth_identities identity ON identity.id = attempt.proof_identity_id
                     JOIN institution_login_policies policy ON policy.id = attempt.policy_id
                     WHERE attempt.id = $1 FOR UPDATE`, [attempt.id],
                );
                const current = locked.rows[0];
                const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
                const approvedUntil = current?.approved_until;
                if (!current || current.status !== 'processing' || current.expires_at <= clock.rows[0]!.now
                    || !current.policy_enabled || !approvedUntil || approvedUntil <= clock.rows[0]!.now
                    || current.policy_approved_by == null
                    || !this.deps.isProviderEnabled('microsoft')
                    || observation.issuer !== current.identity_issuer || observation.subject !== current.identity_subject) throw invalidReauth();
                assertFreshAuthTime(observation.authTime, current.created_at, clock.rows[0]!.now);
                if (!account.rows[0] || account.rows[0]!.deleted_at !== null || account.rows[0]!.active_session_id !== current.sid
                    || Number(account.rows[0]!.credential_generation) !== Number(current.credential_generation)) throw invalidReauth();
                const ready = await tx.query("UPDATE student_auth_reauth_attempts SET status = 'ready' WHERE id = $1 AND status = 'processing'", [current.id]);
                if (ready.rowCount !== 1) throw invalidReauth();
                const completionUrl = new URL(this.deps.completionUrl.href);
                completionUrl.searchParams.set('reauth', current.id);
                return { attemptId: current.id, completionUrl };
            });
        } catch (error) {
            await this.revertClaim(attempt.id);
            throw error;
        }
    }

    /**
     * Release a redemption claim back to pending. Best-effort by design: a
     * row the winner already advanced (ready), the route terminalized
     * (failed), or cleanup reaped simply misses the CAS. Only the claim
     * holder's own processing row reverts, so a duplicate loser can never
     * resurrect another in-flight redemption.
     */
    private async revertClaim(attemptId: string): Promise<void> {
        const tx = await this.deps.pool.connect();
        try {
            await tx.query('BEGIN');
            await tx.query("UPDATE student_auth_reauth_attempts SET status = 'pending' WHERE id = $1 AND status = 'processing'", [attemptId]);
            await tx.query('COMMIT');
        } catch {
            await tx.query('ROLLBACK').catch(() => undefined);
        } finally {
            tx.release();
        }
    }

    /**
     * Terminalize a dead authorization attempt: terminal callback failures
     * (provider cancellation, invalid identity, expired binding) redirect
     * to the bounded completion page and clear the browser cookie, after
     * which the pending row can never finish. Mark it failed and scrub
     * the state hash, callback binding, verifier, and nonce instead of
     * retaining them until expiry cleanup. Mirrors the finish-consumed
     * scrub; ready rows are never touched.
     */
    async terminalizeFailedAttempt(attemptId: string): Promise<void> {
        if (!UUID.test(attemptId)) throw invalidReauth();
        await this.deps.pool.query(
            `UPDATE student_auth_reauth_attempts
             SET status = 'failed', consumed_at = clock_timestamp(), state_hash = NULL, callback_cookie_hash = NULL,
                 encrypted_verifier = NULL, nonce = NULL
             WHERE id = $1 AND status = 'pending'`,
            [attemptId],
        );
    }

    /**
     * True when the attempt can never finish: terminal (failed, consumed)
     * or missing entirely. The callback dispatcher uses this to recognize
     * a delayed provider callback for a scrubbed attempt from its
     * per-attempt cookie after state-hash dispatch fails. Pending, ready,
     * and processing rows are never dead: their state hashes are intact,
     * so a state miss with a live cookie falls through to ordinary login
     * instead of hijacking it.
     */
    async isDeadAttempt(attemptId: string): Promise<boolean> {
        if (!UUID.test(attemptId)) return false;
        const row = await this.deps.pool.query<{ status: string }>(
            'SELECT status FROM student_auth_reauth_attempts WHERE id = $1', [attemptId],
        );
        const status = row.rows[0]?.status;
        return status === undefined || (status !== 'pending' && status !== 'ready' && status !== 'processing');
    }

    async finish(input: { userId: string; sid: string; attemptId: string; callbackCookie: string | undefined }): Promise<ActionGrantResult & { purpose: ActionPurpose; pendingCodeId: string | null; targetIdentityId: string | null; activeCodeGeneration: number | null }> {
        if (!UUID.test(input.userId) || !UUID.test(input.sid) || !UUID.test(input.attemptId) || !input.callbackCookie) throw invalidReauth();
        const callbackCookie = input.callbackCookie;
        return this.transaction(async (tx) => {
            // Canonical lock order: the owner row precedes the attempt row,
            // matching account recovery (user first, attempts later) so the
            // two cannot deadlock when they race for the same user.
            const account = await tx.query<{ active_session_id: string | null; credential_generation: string | number }>('SELECT active_session_id, credential_generation FROM users WHERE id = $1 FOR UPDATE', [input.userId]);
            const attemptResult = await tx.query<ReauthAttempt>('SELECT * FROM student_auth_reauth_attempts WHERE id = $1 FOR UPDATE', [input.attemptId]);
            const attempt = attemptResult.rows[0];
            const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
            if (!attempt || attempt.status !== 'ready' || attempt.user_id !== input.userId || attempt.sid !== input.sid
                || attempt.expires_at <= clock.rows[0]!.now || hashMicrosoftAttemptSecret(callbackCookie) !== attempt.callback_cookie_hash) throw invalidReauth();
            const context = await lockStudentContext(tx, input.userId);
            if (!context.active) throw invalidReauth();
            const policy = await tx.query<{ enabled: boolean; approved_by: string | null; approved_until: Date }>('SELECT enabled, approved_by, approved_until FROM institution_login_policies WHERE id = $1 AND version = $2 FOR UPDATE', [attempt.policy_id, attempt.policy_version]);
            const identity = await tx.query<{ user_id: string; revoked_at: Date | null }>('SELECT user_id, revoked_at FROM student_auth_identities WHERE id = $1 FOR UPDATE', [attempt.proof_identity_id]);
            // Approval withdrawal (approved_by cleared) invalidates the
            // proof exactly like disablement or expiry: login discovery
            // would reject the policy, so reauthentication must too.
            if (!account.rows[0] || account.rows[0]!.active_session_id !== input.sid || Number(account.rows[0]!.credential_generation) !== Number(attempt.credential_generation)
                || !policy.rows[0]?.enabled || policy.rows[0]!.approved_by == null || policy.rows[0]!.approved_until <= clock.rows[0]!.now
                || !identity.rows[0] || identity.rows[0]!.user_id !== input.userId || identity.rows[0]!.revoked_at !== null
                || !this.deps.isProviderEnabled(attempt.provider as LoginProvider)) throw invalidReauth();
            const active = await tx.query<{ generation: string | number }>(
                "SELECT generation FROM student_auth_recovery_codes WHERE user_id = $1 AND status = 'active' FOR UPDATE",
                [input.userId],
            );
            const grant = await issueActionGrant(tx, {
                userId: input.userId, sid: input.sid, purpose: attempt.purpose as ActionPurpose,
                credentialGeneration: Number(attempt.credential_generation), proofIdentityId: attempt.proof_identity_id,
                targetIdentityId: attempt.target_identity_id, pendingCodeId: attempt.pending_code_id,
                ...(active.rows[0] === undefined ? {} : { activeCodeGeneration: Number(active.rows[0].generation) }),
            });
            await tx.query(`UPDATE student_auth_reauth_attempts
                SET status = 'consumed', consumed_at = clock_timestamp(), state_hash = NULL, callback_cookie_hash = NULL,
                    encrypted_verifier = NULL, nonce = NULL
                WHERE id = $1 AND status = 'ready'`, [attempt.id]);
            // These values come from the locked server-side attempt. They let
            // the browser select the already-authorized continuation without
            // treating a client return parameter as authority.
            return { ...grant, purpose: attempt.purpose as ActionPurpose, pendingCodeId: attempt.pending_code_id, targetIdentityId: attempt.target_identity_id, activeCodeGeneration: active.rows[0] === undefined ? null : Number(active.rows[0].generation) };
        });
    }

    private async transaction<T>(operation: (tx: PoolClient) => Promise<T>): Promise<T> {
        const tx = await this.deps.pool.connect();
        try { await tx.query('BEGIN'); const result = await operation(tx); await tx.query('COMMIT'); return result; }
        catch (error) { await tx.query('ROLLBACK').catch(() => undefined); throw error; } finally { tx.release(); }
    }

    /**
     * Callback callers hold the attempt/account/identity locks, validate its
     * provider identity, policy and current session, then mint this grant.
     * It deliberately returns no session/token material.
     */
    async issueFreshGrant(tx: PoolClient, input: {
        userId: string; sid: string; purpose: ActionPurpose; credentialGeneration: number; proofIdentityId: string;
        targetIdentityId?: string | null; pendingCodeId?: string | null; observation: FreshProviderObservation; startedAt: Date; now: Date;
    }): Promise<ActionGrantResult> {
        assertFreshAuthTime(input.observation.authTime, input.startedAt, input.now);
        return issueActionGrant(tx, {
            userId: input.userId, sid: input.sid, purpose: input.purpose, credentialGeneration: input.credentialGeneration,
            proofIdentityId: input.proofIdentityId,
            ...(input.targetIdentityId === undefined ? {} : { targetIdentityId: input.targetIdentityId }),
            ...(input.pendingCodeId === undefined ? {} : { pendingCodeId: input.pendingCodeId }),
        });
    }
}

type ReauthAttempt = {
    id: string; user_id: string; sid: string; credential_generation: string | number; purpose: string; policy_id: string; policy_version: number;
    provider: string; state_hash: string; callback_cookie_hash: string; encrypted_verifier: string; nonce: string; proof_identity_id: string;
    target_identity_id: string | null; pending_code_id: string | null; status: 'pending' | 'processing' | 'ready' | 'consumed' | 'failed'; expires_at: Date; created_at: Date;
    identity_provider: string; identity_issuer: string; identity_subject: string; policy_issuer: string; policy_realm: string; university_id: string;
    policy_enabled?: boolean; approved_until?: Date;
};
