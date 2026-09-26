import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ConflictError, ServiceUnavailableError, UnauthorizedError } from '../../common/errors/AppError.js';
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
             JOIN institution_login_policies policy ON policy.university_id = identity.university_id
                 AND policy.provider = identity.provider AND policy.enabled AND policy.approved_until > clock_timestamp()
             WHERE users.id = $1 AND users.role = 'student' AND users.deleted_at IS NULL AND users.active_session_id = $2::uuid
             ORDER BY identity.linked_at DESC LIMIT 1`,
            [input.userId, input.sid],
        );
        const identity = row.rows[0];
        if (!identity || identity.provider !== 'microsoft' || !identity.observed_email || !this.deps.isProviderEnabled(identity.provider)) throw invalidReauth();
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
        if (!state || state.length > 1024) return false;
        const result = await this.deps.pool.query('SELECT 1 FROM student_auth_reauth_attempts WHERE state_hash = $1', [hashMicrosoftAttemptSecret(state)]);
        return (result.rowCount ?? 0) === 1;
    }

    async callback(input: { callbackUrl: URL; callbackCookie: string | undefined }): Promise<{ attemptId: string; completionUrl: URL }> {
        const state = input.callbackUrl.searchParams.get('state');
        if (!state || !input.callbackCookie) throw invalidReauth();
        const found = await this.deps.pool.query<ReauthAttempt>(
            `SELECT attempt.*, identity.provider AS identity_provider, identity.issuer AS identity_issuer, identity.subject AS identity_subject,
                    policy.issuer AS policy_issuer, policy.provider_realm AS policy_realm, policy.university_id
             FROM student_auth_reauth_attempts attempt
             JOIN student_auth_identities identity ON identity.id = attempt.proof_identity_id
             JOIN institution_login_policies policy ON policy.id = attempt.policy_id
             WHERE attempt.state_hash = $1`, [hashMicrosoftAttemptSecret(state)],
        );
        const attempt = found.rows[0];
        if (!attempt || attempt.status !== 'pending' || attempt.expires_at <= new Date()
            || hashMicrosoftAttemptSecret(input.callbackCookie) !== attempt.callback_cookie_hash
            || attempt.provider !== 'microsoft' || attempt.identity_provider !== 'microsoft'
            || !this.deps.isProviderEnabled('microsoft')) throw invalidReauth();
        const adapter = this.deps.oidcForPolicy({ id: attempt.policy_id, version: attempt.policy_version, provider: 'microsoft', issuer: attempt.policy_issuer, realm: attempt.policy_realm, universityId: attempt.university_id });
        if (!adapter.redeemFresh) throw new ServiceUnavailableError('Fresh Microsoft authentication is unavailable');
        const observation = await adapter.redeemFresh({ callback: input.callbackUrl, state, nonce: attempt.nonce, verifier: decryptMicrosoftAttemptVerifier(attempt.encrypted_verifier, this.deps.attemptKey, attempt.id) });
        return this.transaction(async (tx) => {
            const locked = await tx.query<ReauthAttempt>(
                `SELECT attempt.*, identity.provider AS identity_provider, identity.issuer AS identity_issuer, identity.subject AS identity_subject,
                        policy.issuer AS policy_issuer, policy.provider_realm AS policy_realm, policy.university_id,
                        policy.enabled AS policy_enabled, policy.approved_until
                 FROM student_auth_reauth_attempts attempt
                 JOIN student_auth_identities identity ON identity.id = attempt.proof_identity_id
                 JOIN institution_login_policies policy ON policy.id = attempt.policy_id
                 WHERE attempt.id = $1 FOR UPDATE`, [attempt.id],
            );
            const current = locked.rows[0];
            const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
            const approvedUntil = current?.approved_until;
            if (!current || current.status !== 'pending' || current.expires_at <= clock.rows[0]!.now
                || !current.policy_enabled || !approvedUntil || approvedUntil <= clock.rows[0]!.now
                || !this.deps.isProviderEnabled('microsoft')
                || observation.issuer !== current.identity_issuer || observation.subject !== current.identity_subject) throw invalidReauth();
            assertFreshAuthTime(observation.authTime, current.created_at, clock.rows[0]!.now);
            const account = await tx.query<{ active_session_id: string | null; credential_generation: string | number; deleted_at: Date | null }>(
                'SELECT active_session_id, credential_generation, deleted_at FROM users WHERE id = $1 FOR UPDATE', [current.user_id],
            );
            if (!account.rows[0] || account.rows[0]!.deleted_at !== null || account.rows[0]!.active_session_id !== current.sid
                || Number(account.rows[0]!.credential_generation) !== Number(current.credential_generation)) throw invalidReauth();
            await tx.query("UPDATE student_auth_reauth_attempts SET status = 'ready' WHERE id = $1 AND status = 'pending'", [current.id]);
            const completionUrl = new URL(this.deps.completionUrl.href);
            completionUrl.searchParams.set('reauth', current.id);
            return { attemptId: current.id, completionUrl };
        });
    }

    async finish(input: { userId: string; sid: string; attemptId: string; callbackCookie: string | undefined }): Promise<ActionGrantResult & { purpose: ActionPurpose; pendingCodeId: string | null; targetIdentityId: string | null; activeCodeGeneration: number | null }> {
        if (!UUID.test(input.userId) || !UUID.test(input.sid) || !UUID.test(input.attemptId) || !input.callbackCookie) throw invalidReauth();
        const callbackCookie = input.callbackCookie;
        return this.transaction(async (tx) => {
            const attemptResult = await tx.query<ReauthAttempt>('SELECT * FROM student_auth_reauth_attempts WHERE id = $1 FOR UPDATE', [input.attemptId]);
            const attempt = attemptResult.rows[0];
            const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
            if (!attempt || attempt.status !== 'ready' || attempt.user_id !== input.userId || attempt.sid !== input.sid
                || attempt.expires_at <= clock.rows[0]!.now || hashMicrosoftAttemptSecret(callbackCookie) !== attempt.callback_cookie_hash) throw invalidReauth();
            const context = await lockStudentContext(tx, input.userId);
            if (!context.active) throw invalidReauth();
            const account = await tx.query<{ active_session_id: string | null; credential_generation: string | number }>('SELECT active_session_id, credential_generation FROM users WHERE id = $1 FOR UPDATE', [input.userId]);
            const policy = await tx.query<{ enabled: boolean; approved_until: Date }>('SELECT enabled, approved_until FROM institution_login_policies WHERE id = $1 AND version = $2 FOR UPDATE', [attempt.policy_id, attempt.policy_version]);
            const identity = await tx.query<{ user_id: string; revoked_at: Date | null }>('SELECT user_id, revoked_at FROM student_auth_identities WHERE id = $1 FOR UPDATE', [attempt.proof_identity_id]);
            if (!account.rows[0] || account.rows[0]!.active_session_id !== input.sid || Number(account.rows[0]!.credential_generation) !== Number(attempt.credential_generation)
                || !policy.rows[0]?.enabled || policy.rows[0]!.approved_until <= clock.rows[0]!.now
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
    target_identity_id: string | null; pending_code_id: string | null; status: 'pending' | 'ready' | 'consumed' | 'failed'; expires_at: Date; created_at: Date;
    identity_provider: string; identity_issuer: string; identity_subject: string; policy_issuer: string; policy_realm: string; university_id: string;
    policy_enabled?: boolean; approved_until?: Date;
};
