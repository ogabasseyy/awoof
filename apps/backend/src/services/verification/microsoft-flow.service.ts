import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ConflictError, ForbiddenError, RateLimitError } from '../../common/errors/AppError.js';
import { decryptMicrosoftAttemptVerifier, encryptMicrosoftAttemptVerifier, hashMicrosoftAttemptSecret } from './microsoft-attempt-crypto.js';
import type { MicrosoftOidc, MicrosoftIdentity } from './microsoft-oidc.service.js';
import { lockMicrosoftAttempt } from './microsoft-session.service.js';
import { assertMicrosoftAuthority, type MicrosoftAttemptAuthority } from './microsoft-authority.service.js';
import type { EducationObservation, MicrosoftEducationService } from './microsoft-education.service.js';
import { applyMicrosoftEnrollment } from './eligibility-evidence.service.js';

const ATTEMPT_LIFETIME_SECONDS = 10 * 60;
const START_LIMIT = 5;
const OUTSTANDING_COOKIE_LIMIT = 10;

type Attempt = MicrosoftAttemptAuthority & {
    id: string; user_id: string; university_id: string; institution_policy_version: number; provider_policy_version: number;
    identity_version: number; processing_grant_id: string; provider_consent_id: string; server_session_id: string;
    encrypted_verifier: string | null; nonce: string | null; expires_at: Date; status: 'pending' | 'processing' | 'ready' | 'completed' | 'failed'; result: unknown;
};

export type MicrosoftCallbackCookie = { name: string; value: string; maxAgeSeconds: number; path: '/api/verification/microsoft/callback'; httpOnly: true; secure: true; sameSite: 'lax' };
export type MicrosoftStartPublicResult = { attemptId: string; authorizationUrl: string; finishSecret: string };
export type MicrosoftStartResult = { publicResult: MicrosoftStartPublicResult; callbackCookie: MicrosoftCallbackCookie };
export type MicrosoftCallbackResult = {
    attemptId: string;
    completionUrl: URL;
    /** A bounded, non-authorizing terminal callback outcome. */
    outcome?: 'connection_not_completed';
};
export type MicrosoftFinishResult = { accountLinked: true; enrollment: 'not_checked' | 'eligible' | 'unconfirmed' | 'denied' };

export type MicrosoftFlowDependencies = {
    pool: Pool;
    oidc: MicrosoftOidc | { forTenant(tenantId: string): MicrosoftOidc };
    verifierEncryptionKey: string;
    callbackUrl: URL;
    completionUrl: URL;
    /** Feature gates the service itself; adapters cannot re-enable an in-flight attempt. */
    isEnabled?: () => boolean;
    /** Graph is injected by the server only; a browser cannot select it. */
    education?: Pick<MicrosoftEducationService, 'observe'>;
    now?: () => Date;
    /**
     * Test-only synchronization points for proving PostgreSQL serialization.
     * Production construction never supplies these hooks.
     */
    testHooks?: {
        onFinishTransactionStarted?: (tx: PoolClient) => Promise<void>;
        beforeFinishCommit?: (tx: PoolClient) => Promise<void>;
    };
};

function secret(bytes = 32): string { return randomBytes(bytes).toString('base64url'); }
function cookieName(attemptId: string): string { return `awoof_ms_${attemptId}`; }
function invalidAttempt(): ConflictError { return new ConflictError('Microsoft verification attempt is no longer valid'); }
function fixedCallback(actual: URL, configured: URL): boolean {
    return actual.protocol === 'https:' && !actual.username && !actual.password && !actual.hash
        && actual.origin === configured.origin && actual.pathname === configured.pathname
        && actual.searchParams.getAll('state').length === 1;
}

export class MicrosoftFlowService {
    constructor(private readonly deps: MicrosoftFlowDependencies) {
        if (deps.testHooks && process.env.NODE_ENV !== 'test') {
            throw new Error('Microsoft finish test hooks are unavailable outside tests');
        }
    }

    private async transaction<T>(operation: (tx: PoolClient) => Promise<T>): Promise<T> {
        const tx = await this.deps.pool.connect();
        try { await tx.query('BEGIN'); const result = await operation(tx); await tx.query('COMMIT'); return result; }
        catch (error) { await tx.query('ROLLBACK').catch(() => undefined); throw error; }
        finally { tx.release(); }
    }

    private assertEnabled(): void { if (this.deps.isEnabled?.() !== true) throw invalidAttempt(); }
    private oidcForTenant(tenantId: string): MicrosoftOidc {
        return 'forTenant' in this.deps.oidc ? this.deps.oidc.forTenant(tenantId) : this.deps.oidc;
    }

    async start(input: { userId: string; serverSessionId: string; processingGrantId: string; providerConsentId: string }): Promise<MicrosoftStartResult> {
        this.assertEnabled();
        const prepared = await this.transaction(async (tx) => {
            const policyMode = await currentPolicyMode(tx, input.processingGrantId);
            const authority = await assertMicrosoftAuthority(tx, { userId: input.userId, sid: input.serverSessionId, use: 'issuance', processingGrantId: input.processingGrantId, providerConsentId: input.providerConsentId, mode: policyMode });
            const recent = await tx.query<{ count: string }>(`SELECT count(*) FROM microsoft_verification_attempts WHERE user_id=$1 AND created_at > clock_timestamp() - interval '10 minutes'`, [input.userId]);
            if (Number(recent.rows[0]?.count ?? 0) >= START_LIMIT) throw new RateLimitError('Too many Microsoft verification starts');
            const outstanding = await tx.query<{ count: string }>(`SELECT count(*) FROM microsoft_verification_attempts WHERE user_id=$1 AND status IN ('pending','processing') AND expires_at > clock_timestamp()`, [input.userId]);
            if (Number(outstanding.rows[0]?.count ?? 0) >= OUTSTANDING_COOKIE_LIMIT) throw new RateLimitError('Too many outstanding Microsoft verification attempts');
            const attemptId = randomUUID(); const state = secret(); const browserSecret = secret(); const finishSecret = secret(); const nonce = secret(); const verifier = secret(48);
            await tx.query(
                `INSERT INTO microsoft_verification_attempts (id,user_id,university_id,institution_policy_version,provider_policy_version,identity_version,processing_grant_id,provider_consent_id,server_session_id,state_hash,browser_secret_hash,finish_secret_hash,encrypted_verifier,nonce,expires_at,status)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,clock_timestamp()+interval '10 minutes','pending')`,
                [attemptId, input.userId, authority.universityId, authority.institutionPolicyVersion, authority.policy.version, authority.identityVersion, input.processingGrantId, input.providerConsentId, input.serverSessionId, hashMicrosoftAttemptSecret(state), hashMicrosoftAttemptSecret(browserSecret), hashMicrosoftAttemptSecret(finishSecret), encryptMicrosoftAttemptVerifier(verifier, this.deps.verifierEncryptionKey, attemptId), nonce],
            );
            return { attemptId, state, browserSecret, finishSecret, nonce, verifier, tenantId: authority.policy.tenant_id, scopes: authority.policy.scopes };
        });
        // Authorization discovery is deliberately outside the authority transaction.
        let authorizationUrl: string;
        try { authorizationUrl = await this.oidcForTenant(prepared.tenantId).authorize({ tenantId: prepared.tenantId, state: prepared.state, nonce: prepared.nonce, verifier: prepared.verifier, scopes: prepared.scopes }); }
        catch (error) { await this.fail(prepared.attemptId); throw error; }
        await this.transaction(async (tx) => {
            this.assertEnabled();
            const row = await tx.query<Attempt>('SELECT * FROM microsoft_verification_attempts WHERE id=$1', [prepared.attemptId]);
            const attempt = row.rows[0];
            if (!attempt) throw invalidAttempt();
            const policyMode = await currentPolicyMode(tx, attempt.processing_grant_id);
            await assertMicrosoftAuthority(tx, { userId: attempt.user_id, sid: attempt.server_session_id, use: 'issuance', processingGrantId: attempt.processing_grant_id, providerConsentId: attempt.provider_consent_id, expected: attempt, mode: policyMode });
            await lockMicrosoftAttempt(tx, attempt.id);
            const locked = await tx.query<Attempt>('SELECT * FROM microsoft_verification_attempts WHERE id=$1', [attempt.id]);
            const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
            if (!locked.rows[0] || locked.rows[0].status !== 'pending' || locked.rows[0].expires_at <= clock.rows[0]!.now) throw invalidAttempt();
            this.assertEnabled();
        }).catch(async (error) => { await this.fail(prepared.attemptId); throw error; });
        if (this.deps.isEnabled?.() !== true) { await this.fail(prepared.attemptId); throw invalidAttempt(); }
        return { publicResult: { attemptId: prepared.attemptId, authorizationUrl, finishSecret: prepared.finishSecret }, callbackCookie: { name: cookieName(prepared.attemptId), value: prepared.browserSecret, maxAgeSeconds: ATTEMPT_LIFETIME_SECONDS, path: '/api/verification/microsoft/callback', httpOnly: true, secure: true, sameSite: 'lax' } };
    }

    private async fail(attemptId: string): Promise<void> {
        await this.transaction(async (tx) => { await tx.query(`UPDATE microsoft_verification_attempts SET status='failed', encrypted_verifier=NULL, nonce=NULL, result=NULL WHERE id=$1 AND status IN ('pending','processing','ready')`, [attemptId]); });
    }

    async callback(input: { callbackUrl: URL; browserCookie?: string; browserCookies?: readonly { name: string; value: string }[] }): Promise<MicrosoftCallbackResult> {
        this.assertEnabled();
        if (!fixedCallback(input.callbackUrl, this.deps.callbackUrl)) throw invalidAttempt();
        const state = input.callbackUrl.searchParams.get('state');
        if (!state) throw invalidAttempt();
        const claimed = await this.transaction(async (tx) => {
            // State locates the per-attempt cookie, but never authorizes it.
            // Canonical authority is locked before the attempt itself.
            const row = await tx.query<Attempt>(`SELECT * FROM microsoft_verification_attempts WHERE state_hash=$1`, [hashMicrosoftAttemptSecret(state)]);
            const attempt = row.rows[0];
            // State resolves the durable attempt first, then only that exact
            // server-generated cookie name may supply browser continuity.
            const browserCookie = input.browserCookies?.find((cookie) => cookie.name === cookieName(attempt?.id ?? ''))?.value ?? input.browserCookie;
            if (!attempt || attempt.status !== 'pending' || attempt.expires_at <= new Date() || !browserCookie || hashMicrosoftAttemptSecret(browserCookie) !== (await tx.query<{ browser_secret_hash: string }>('SELECT browser_secret_hash FROM microsoft_verification_attempts WHERE id=$1', [attempt.id])).rows[0]?.browser_secret_hash) throw invalidAttempt();
            const policyMode = await currentPolicyMode(tx, attempt.processing_grant_id);
            const authority = await assertMicrosoftAuthority(tx, { userId: attempt.user_id, sid: attempt.server_session_id, use: 'issuance', processingGrantId: attempt.processing_grant_id, providerConsentId: attempt.provider_consent_id, expected: attempt, mode: policyMode });
            await lockMicrosoftAttempt(tx, attempt.id);
            const locked = await tx.query<Attempt>('SELECT * FROM microsoft_verification_attempts WHERE id=$1', [attempt.id]);
            const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
            if (!locked.rows[0] || locked.rows[0].status !== 'pending' || locked.rows[0].expires_at <= clock.rows[0]!.now) throw invalidAttempt();
            if (authority.policy.tenant_id.length === 0 || !attempt.encrypted_verifier || !attempt.nonce) throw invalidAttempt();
            this.assertEnabled();
            const updated = await tx.query(`UPDATE microsoft_verification_attempts SET status='processing' WHERE id=$1 AND status='pending'`, [attempt.id]);
            if (updated.rowCount !== 1) throw invalidAttempt();
            return { attempt, tenantId: authority.policy.tenant_id, state, verifier: decryptMicrosoftAttemptVerifier(attempt.encrypted_verifier, this.deps.verifierEncryptionKey, attempt.id), nonce: attempt.nonce };
        });
        let identity: MicrosoftIdentity;
        let graphAccessToken: string | undefined;
        try {
            const redeemed = await this.oidcForTenant(claimed.tenantId).redeem({ tenantId: claimed.tenantId, callback: input.callbackUrl, state: claimed.state, nonce: claimed.nonce, verifier: claimed.verifier });
            identity = redeemed.identity;
            graphAccessToken = redeemed.graphAccessToken;
        }
        catch {
            // Only a callback that has already passed the fixed URL, state,
            // cookie, authority and attempt-CAS checks reaches this point.
            // Provider denial/cancellation and redemption transport failures
            // are deliberately indistinguishable to the browser and cannot
            // authorize finish or evidence creation.
            await this.fail(claimed.attempt.id);
            const completionUrl = new URL(this.deps.completionUrl);
            completionUrl.searchParams.set('attempt', claimed.attempt.id);
            completionUrl.searchParams.set('outcome', 'connection_not_completed');
            return { attemptId: claimed.attempt.id, completionUrl, outcome: 'connection_not_completed' };
        }
        try {
            const mode = await this.transaction(async (tx) => {
                this.assertEnabled();
                const preliminary = await tx.query<Attempt>('SELECT * FROM microsoft_verification_attempts WHERE id=$1', [claimed.attempt.id]);
                const preAttempt = preliminary.rows[0];
                if (!preAttempt) throw invalidAttempt();
                // This is the pre-Graph authority transaction. It returns
                // before any provider request is started.
                const policyMode = await currentPolicyMode(tx, preAttempt.processing_grant_id);
                const authority = await assertMicrosoftAuthority(tx, { userId: preAttempt.user_id, sid: preAttempt.server_session_id, use: 'issuance', processingGrantId: preAttempt.processing_grant_id, providerConsentId: preAttempt.provider_consent_id, expected: preAttempt, mode: policyMode });
                await lockMicrosoftAttempt(tx, claimed.attempt.id);
                const row = await tx.query<Attempt>('SELECT * FROM microsoft_verification_attempts WHERE id=$1', [claimed.attempt.id]);
                const attempt = row.rows[0];
                const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
                if (!attempt || attempt.status !== 'processing' || attempt.expires_at <= clock.rows[0]!.now) throw invalidAttempt();
                await assertMicrosoftAuthority(tx, { userId: attempt.user_id, sid: attempt.server_session_id, use: 'issuance', processingGrantId: attempt.processing_grant_id, providerConsentId: attempt.provider_consent_id, expected: attempt, mode: policyMode });
                this.assertEnabled();
                // Stay processing until Graph's out-of-transaction result is
                // post-authorized below; identity-only remains ready here.
                if (policyMode === 'identity_only') {
                    const updated = await tx.query(`UPDATE microsoft_verification_attempts SET status='ready', encrypted_verifier=NULL, nonce=NULL, result=$2::jsonb WHERE id=$1 AND status='processing'`, [attempt.id, JSON.stringify(identity)]);
                    if (updated.rowCount !== 1) throw invalidAttempt();
                } else {
                    // Migration 040 requires verifier/nonce while processing.
                    // They are scrubbed atomically with the graph-ready result.
                }
                return authority.policy.mode;
            });
            let observation: EducationObservation | undefined;
            if (mode === 'graph_enrollment') {
                // A missing access token is unknown, never a scope escalation.
                observation = graphAccessToken && this.deps.education
                    ? await this.deps.education.observe({ accessToken: graphAccessToken, expectedOid: identity.objectId })
                    : { outcome: 'unknown', reason: 'unavailable' };
                await this.transaction(async (tx) => {
                    this.assertEnabled();
                    const preliminary = await tx.query<Attempt>('SELECT * FROM microsoft_verification_attempts WHERE id=$1', [claimed.attempt.id]);
                    const attempt = preliminary.rows[0];
                    if (!attempt) throw invalidAttempt();
                    await assertMicrosoftAuthority(tx, { userId: attempt.user_id, sid: attempt.server_session_id, use: 'issuance', processingGrantId: attempt.processing_grant_id, providerConsentId: attempt.provider_consent_id, expected: attempt, mode: 'graph_enrollment' });
                    await lockMicrosoftAttempt(tx, attempt.id);
                    const locked = (await tx.query<Attempt>('SELECT * FROM microsoft_verification_attempts WHERE id=$1', [attempt.id])).rows[0];
                    const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
                    if (!locked || locked.status !== 'processing' || locked.expires_at <= clock.rows[0]!.now) throw invalidAttempt();
                    await assertMicrosoftAuthority(tx, { userId: locked.user_id, sid: locked.server_session_id, use: 'issuance', processingGrantId: locked.processing_grant_id, providerConsentId: locked.provider_consent_id, expected: locked, mode: 'graph_enrollment' });
                    this.assertEnabled();
                    const updated = await tx.query(`UPDATE microsoft_verification_attempts SET status='ready', encrypted_verifier=NULL, nonce=NULL, result=$2::jsonb WHERE id=$1 AND status='processing'`, [locked.id, JSON.stringify({ identity, educationObservation: observation })]);
                    if (updated.rowCount !== 1) throw invalidAttempt();
                });
            }
        } catch (error) { await this.fail(claimed.attempt.id); throw error; }
        const completionUrl = new URL(this.deps.completionUrl); completionUrl.searchParams.set('attempt', claimed.attempt.id);
        return { attemptId: claimed.attempt.id, completionUrl };
    }

    /** State is hashed before lookup; callers receive a cookie name only. */
    async callbackCookieNameForState(callbackUrl: URL): Promise<string | null> {
        if (!fixedCallback(callbackUrl, this.deps.callbackUrl)) return null;
        const state = callbackUrl.searchParams.get('state');
        if (!state) return null;
        const result = await this.deps.pool.query<{ id: string }>('SELECT id FROM microsoft_verification_attempts WHERE state_hash=$1', [hashMicrosoftAttemptSecret(state)]);
        return result.rows[0] ? cookieName(result.rows[0].id) : null;
    }

    async finish(input: { userId: string; serverSessionId: string; attemptId: string; finishSecret: string }): Promise<MicrosoftFinishResult> {
        this.assertEnabled();
        return this.transaction(async (tx) => {
            this.assertEnabled();
            await this.deps.testHooks?.onFinishTransactionStarted?.(tx);
            // Session lock occurs before the attempt lock, including retry reads.
            const attemptRow = await tx.query<Attempt>('SELECT * FROM microsoft_verification_attempts WHERE id=$1', [input.attemptId]);
            const preliminary = attemptRow.rows[0];
            if (!preliminary || preliminary.user_id !== input.userId || hashMicrosoftAttemptSecret(input.finishSecret) !== (await tx.query<{ finish_secret_hash: string }>('SELECT finish_secret_hash FROM microsoft_verification_attempts WHERE id=$1', [input.attemptId])).rows[0]?.finish_secret_hash) throw new ForbiddenError('Microsoft verification finish secret is invalid');
            const finishMode = isGraphAttemptResult(preliminary.result) ? 'graph_enrollment' : 'identity_only';
            await assertMicrosoftAuthority(tx, { userId: input.userId, sid: input.serverSessionId, use: 'owner', processingGrantId: preliminary.processing_grant_id, providerConsentId: preliminary.provider_consent_id, expected: preliminary, mode: finishMode });
            await lockMicrosoftAttempt(tx, input.attemptId);
            const row = await tx.query<Attempt>('SELECT * FROM microsoft_verification_attempts WHERE id=$1', [input.attemptId]); const attempt = row.rows[0];
            const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
            if (!attempt || attempt.expires_at <= clock.rows[0]!.now) throw invalidAttempt();
            const currentAuthority = await assertMicrosoftAuthority(tx, { userId: input.userId, sid: input.serverSessionId, use: 'owner', processingGrantId: attempt.processing_grant_id, providerConsentId: attempt.provider_consent_id, expected: attempt, mode: finishMode });
            if (attempt.status === 'completed') {
                const receipt = attempt.result as { accountLinked?: boolean; enrollment?: string; identityId?: string; evidenceId?: string; providerProofId?: string } | null;
                if (!receipt?.accountLinked || !isEnrollmentReceipt(receipt.enrollment) || typeof receipt.identityId !== 'string') throw invalidAttempt();
                const linked = await tx.query('SELECT id FROM microsoft_identities WHERE id=$1 AND user_id=$2 AND university_id=$3 AND revoked_at IS NULL', [receipt.identityId, input.userId, attempt.university_id]);
                if (linked.rowCount !== 1) throw invalidAttempt();
                // The completed audit receipt remains immutable, but a later
                // authoritative denial must never be reported as live success.
                this.assertEnabled();
                if (finishMode === 'graph_enrollment' && currentAuthority.authoritativeDenial) return { accountLinked: true, enrollment: 'denied' };
                if (receipt.enrollment === 'eligible') {
                    if (typeof receipt.evidenceId !== 'string' || typeof receipt.providerProofId !== 'string') throw invalidAttempt();
                    const provenance = await tx.query(
                        `SELECT 1 FROM eligibility_evidence evidence
                         JOIN microsoft_provider_proofs proof ON proof.id=evidence.provider_proof_id
                         WHERE evidence.id=$1 AND proof.id=$2 AND proof.attempt_id=$3
                           AND evidence.revoked_at IS NULL AND proof.revoked_at IS NULL
                           AND evidence.expires_at > clock_timestamp()`,
                        [receipt.evidenceId, receipt.providerProofId, attempt.id],
                    );
                    if (provenance.rowCount !== 1) throw invalidAttempt();
                }
                return { accountLinked: true, enrollment: receipt.enrollment };
            }
            const storedResult = attempt.result;
            const graphReady = isGraphReadyResult(storedResult);
            const graphResult = graphReady ? storedResult : null;
            const identity = (graphResult ? graphResult.identity : attempt.result) as MicrosoftIdentity | null;
            if (attempt.status !== 'ready' || !identity || typeof identity.tenantId !== 'string' || typeof identity.objectId !== 'string') throw invalidAttempt();
            const existing = await tx.query<{ id: string; user_id: string; university_id: string; revoked_at: Date | null }>('SELECT id,user_id,university_id,revoked_at FROM microsoft_identities WHERE tenant_id=$1 AND object_id=$2 FOR UPDATE', [identity.tenantId, identity.objectId]);
            const linked = existing.rows[0];
            if (linked && (linked.user_id !== input.userId || linked.university_id !== attempt.university_id || linked.revoked_at !== null)) throw new ConflictError('Microsoft identity cannot be transferred or restored');
            const identityId = linked?.id ?? (await tx.query<{ id: string }>('INSERT INTO microsoft_identities (user_id,university_id,tenant_id,object_id) VALUES ($1,$2,$3,$4) RETURNING id', [input.userId, attempt.university_id, identity.tenantId, identity.objectId])).rows[0]!.id;
            this.assertEnabled();
            const applied = graphReady ? await applyMicrosoftEnrollment(tx, attempt.id, this.deps.isEnabled ? { isEnabled: this.deps.isEnabled } : {}) : null;
            const enrollment = applied ? enrollmentReceipt(applied) : 'not_checked';
            const receipt = { accountLinked: true, enrollment, identityId,
                ...(applied?.eligible ? await receiptProvenance(tx, applied.evidenceId, attempt.id) : {}) };
            // The canonical writer may have waited on authority/evidence locks.
            // Refresh both authority and the expiry boundary before final CAS.
            if (graphReady) await assertMicrosoftAuthority(tx, { userId: input.userId, sid: input.serverSessionId, use: 'owner', processingGrantId: attempt.processing_grant_id, providerConsentId: attempt.provider_consent_id, expected: attempt, mode: 'graph_enrollment' });
            const finalClock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
            if (attempt.expires_at <= finalClock.rows[0]!.now) throw invalidAttempt();
            this.assertEnabled();
            // This is only populated by the integration suite. It holds the
            // final authority locks so both transaction orders are observable.
            await this.deps.testHooks?.beforeFinishCommit?.(tx);
            this.assertEnabled();
            const completed = await tx.query(`UPDATE microsoft_verification_attempts SET status='completed', result=$2::jsonb WHERE id=$1 AND status='ready'`, [attempt.id, JSON.stringify(receipt)]);
            if (completed.rowCount !== 1) throw invalidAttempt();
            return { accountLinked: true, enrollment };
        });
    }
}

async function currentPolicyMode(tx: PoolClient, processingGrantId: string): Promise<'identity_only' | 'graph_enrollment'> {
    const result = await tx.query<{ mode: 'identity_only' | 'graph_enrollment' }>(
        `SELECT policy.mode FROM verification_consents processing_consent
         JOIN institution_microsoft_policies policy ON policy.university_id=processing_consent.university_id
         WHERE processing_consent.id=$1`, [processingGrantId],
    );
    const mode = result.rows[0]?.mode;
    if (mode !== 'identity_only' && mode !== 'graph_enrollment') throw invalidAttempt();
    return mode;
}

async function receiptProvenance(tx: PoolClient, evidenceId: string, attemptId: string): Promise<{ evidenceId: string; providerProofId: string }> {
    const result = await tx.query<{ evidence_id: string; provider_proof_id: string }>(
        `SELECT evidence.id AS evidence_id, proof.id AS provider_proof_id
         FROM eligibility_evidence evidence JOIN microsoft_provider_proofs proof ON proof.id=evidence.provider_proof_id
         WHERE evidence.id=$1 AND proof.attempt_id=$2 AND evidence.revoked_at IS NULL AND proof.revoked_at IS NULL
           AND evidence.expires_at > clock_timestamp()`,
        [evidenceId, attemptId],
    );
    const row = result.rows[0];
    if (!row) throw invalidAttempt();
    return { evidenceId: row.evidence_id, providerProofId: row.provider_proof_id };
}

function isGraphReadyResult(value: unknown): value is { identity: MicrosoftIdentity; educationObservation: EducationObservation } {
    return !!value && typeof value === 'object' && !Array.isArray(value)
        && !!(value as { identity?: unknown }).identity
        && typeof (value as { identity: MicrosoftIdentity }).identity.tenantId === 'string'
        && typeof (value as { identity: MicrosoftIdentity }).identity.objectId === 'string'
        && !!(value as { educationObservation?: unknown }).educationObservation;
}

function isGraphAttemptResult(value: unknown): boolean {
    if (isGraphReadyResult(value)) return true;
    return !!value && typeof value === 'object' && !Array.isArray(value)
        && (value as { accountLinked?: unknown }).accountLinked === true
        && (value as { enrollment?: unknown }).enrollment !== 'not_checked';
}

function isEnrollmentReceipt(value: unknown): value is MicrosoftFinishResult['enrollment'] {
    return value === 'not_checked' || value === 'eligible' || value === 'unconfirmed' || value === 'denied';
}

function enrollmentReceipt(result: Awaited<ReturnType<typeof applyMicrosoftEnrollment>>): MicrosoftFinishResult['enrollment'] {
    if (result.eligible) return 'eligible';
    return result.reason === 'enrollment_denied' ? 'denied' : 'unconfirmed';
}
