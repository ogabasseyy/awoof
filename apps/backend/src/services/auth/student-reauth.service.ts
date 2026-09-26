import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ConflictError, ServiceUnavailableError, UnauthorizedError } from '../../common/errors/AppError.js';
import { encryptMicrosoftAttemptVerifier, hashMicrosoftAttemptSecret } from '../verification/microsoft-attempt-crypto.js';
import type { ApprovedLoginPolicy, FreshProviderObservation, LoginProvider, StudentOidcAdapter } from './student-sso.types.js';
import type { ActionPurpose, ActionGrantResult } from './student-action-grant.service.js';
import { issueActionGrant } from './student-action-grant.service.js';

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
};

export class StudentReauthService {
    constructor(private readonly deps: StudentReauthDependencies) {}

    async start(input: { userId: string; sid: string; purpose: ActionPurpose; targetIdentityId?: string; pendingCodeId?: string }): Promise<{ attemptId: string; authorizationUrl: string }> {
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
        const authorizationUrl = await adapter.authorizeFresh({ state, nonce, verifier, loginHint: identity.observed_email });
        await this.deps.pool.query(
            `INSERT INTO student_auth_reauth_attempts
                 (id, user_id, sid, credential_generation, purpose, policy_id, policy_version, provider,
                  state_hash, callback_cookie_hash, encrypted_verifier, nonce, proof_identity_id, target_identity_id, pending_code_id, expires_at)
             VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, 'microsoft', $8, $9, $10, $11, $12, $13, $14, clock_timestamp() + interval '5 minutes')`,
            [attemptId, input.userId, input.sid, Number(identity.credential_generation), input.purpose, policy.id, policy.version,
                hashMicrosoftAttemptSecret(state), hashMicrosoftAttemptSecret(secret()), encryptMicrosoftAttemptVerifier(verifier, this.deps.attemptKey, attemptId), nonce,
                identity.identity_id, input.targetIdentityId ?? null, input.pendingCodeId ?? null],
        );
        return { attemptId, authorizationUrl: authorizationUrl.href };
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
