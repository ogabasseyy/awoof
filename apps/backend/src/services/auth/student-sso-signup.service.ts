import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { BadRequestError, ConflictError, ServiceUnavailableError, UnauthorizedError } from '../../common/errors/AppError.js';
import { consumeChallenge, requestChallenge } from '../verification/challenge.service.js';
import { normalizeMailbox } from '../verification/eligibility-policy.service.js';
import { recordPasswordlessSignupMailboxProof } from '../verification/eligibility-evidence.service.js';
import { STUDENT_TERMS_VERSION, VERIFICATION_NOTICE_TEXT, VERIFICATION_NOTICE_VERSION } from '../verification/verification-notices.js';
import { decryptMicrosoftAttemptVerifier, hashMicrosoftAttemptSecret } from '../verification/microsoft-attempt-crypto.js';
import { decodeProviderObservation, assertCurrentLoginPolicy, StudentSsoAuthorityInvalidatedError } from './student-sso-onboarding.service.js';
import { issueSessionInTransaction } from './session.service.js';
import type { TokenPair } from './jwt.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const signupSecretHash = (handoffId: string, secret: string) => createHash('sha256').update(`awoof-passwordless-signup-v1\0${handoffId}\0${secret}`).digest('hex');

type Handoff = { id: string; attempt_id: string; secret_hash: string; encrypted_observation: string; policy_id: string; policy_version: number; browser_binding_hash: string; expires_at: Date; consumed_at: Date | null };
type Signup = { id: string; handoff_id: string; secret_hash: string; browser_binding_hash: string; mailbox_challenge_id: string | null; status: 'pending' | 'mailbox_verified' | 'consumed' | 'cancelled' | 'expired'; expires_at: Date };

export type StudentSsoSignupDependencies = {
    pool: Pick<Pool, 'connect'>;
    attemptKey: string | null;
    isEnabled: () => boolean;
    isProviderEnabled?: (provider: 'google' | 'microsoft') => boolean;
    deliverOtp: (email: string, code: string, fullName: string, expiresAt: Date) => Promise<{ success: boolean }>;
};

function invalid(): ConflictError { return new ConflictError('Passwordless student signup is not available. Restart Microsoft sign-in.'); }
function checked(input: { handoffId: unknown; handoffSecret: unknown; browserBinding: unknown }): { handoffId: string; handoffSecret: string; browserBinding: string } {
    if (!UUID.test(String(input.handoffId)) || typeof input.handoffSecret !== 'string' || input.handoffSecret.length < 1 || input.handoffSecret.length > 1024 || typeof input.browserBinding !== 'string' || input.browserBinding.length < 1 || input.browserBinding.length > 1024) throw invalid();
    return input as { handoffId: string; handoffSecret: string; browserBinding: string };
}

export class StudentSsoSignupService {
    constructor(private readonly deps: StudentSsoSignupDependencies) {}
    private async transaction<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> { const tx = await this.deps.pool.connect(); try { await tx.query('BEGIN'); const result = await work(tx); await tx.query('COMMIT'); return result; } catch (error) { await tx.query('ROLLBACK').catch(() => undefined); throw error; } finally { tx.release(); } }
    private enabled(): void { if (!this.deps.isEnabled() || !this.deps.attemptKey) throw invalid(); }
    private async load(tx: PoolClient, raw: { handoffId: unknown; handoffSecret: unknown; browserBinding: unknown }): Promise<{ input: ReturnType<typeof checked>; handoff: Handoff; signup: Signup; observation: ReturnType<typeof decodeProviderObservation>; email: string; universityId: string }> {
        this.enabled(); const input = checked(raw);
        const handoff = (await tx.query<Handoff>('SELECT * FROM student_auth_link_handoffs WHERE id = $1 FOR UPDATE', [input.handoffId])).rows[0];
        if (!handoff || handoff.consumed_at || handoff.expires_at <= new Date() || handoff.secret_hash !== hashMicrosoftAttemptSecret(input.handoffSecret) || handoff.browser_binding_hash !== hashMicrosoftAttemptSecret(input.browserBinding)) throw invalid();
        let observation; try { observation = decodeProviderObservation(decryptMicrosoftAttemptVerifier(handoff.encrypted_observation, this.deps.attemptKey!, handoff.id)); } catch { throw invalid(); }
        if (observation.provider !== 'microsoft' || this.deps.isProviderEnabled?.('microsoft') === false || !observation.email) throw invalid();
        const attempt = (await tx.query<{ requested_email: string }>('SELECT requested_email FROM student_auth_attempts WHERE id = $1 FOR UPDATE', [handoff.attempt_id])).rows[0];
        if (!attempt) throw invalid();
        let policy; try { policy = await assertCurrentLoginPolicy(tx, handoff.policy_id, handoff.policy_version, attempt.requested_email); } catch (error) { if (error instanceof StudentSsoAuthorityInvalidatedError) throw invalid(); throw error; }
        if (policy.provider !== observation.provider || policy.issuer !== observation.issuer || normalizeMailbox(observation.email) !== normalizeMailbox(attempt.requested_email)) throw invalid();
        const existing = await tx.query<{ id: string }>('SELECT id FROM student_auth_identities WHERE provider = $1 AND issuer = $2 AND subject = $3 FOR UPDATE', [observation.provider, observation.issuer, observation.subject]);
        if (existing.rowCount) throw new ConflictError('Use existing-account sign-in or recovery.');
        const secret = signupSecretHash(input.handoffId, input.handoffSecret);
        await tx.query(`INSERT INTO student_auth_signup_challenges (handoff_id, secret_hash, browser_binding_hash, expires_at)
            VALUES ($1, $2, $3, $4) ON CONFLICT (handoff_id) DO NOTHING`, [input.handoffId, secret, hashMicrosoftAttemptSecret(input.browserBinding), handoff.expires_at]);
        const signup = (await tx.query<Signup>('SELECT * FROM student_auth_signup_challenges WHERE handoff_id = $1 FOR UPDATE', [input.handoffId])).rows[0];
        if (!signup || signup.secret_hash !== secret || signup.browser_binding_hash !== hashMicrosoftAttemptSecret(input.browserBinding) || signup.status === 'consumed' || signup.expires_at <= new Date()) throw invalid();
        return { input, handoff, signup, observation, email: normalizeMailbox(observation.email), universityId: policy.universityId };
    }
    async context(input: { handoffId: unknown; handoffSecret: unknown; browserBinding: unknown }): Promise<{ email: string; universityId: string; termsVersion: string; noticeVersion: string; noticeText: string; expiresAt: string }> {
        this.enabled();
        return this.transaction(async tx => { const state = await this.load(tx, input); return { email: state.email, universityId: state.universityId, termsVersion: STUDENT_TERMS_VERSION, noticeVersion: VERIFICATION_NOTICE_VERSION, noticeText: VERIFICATION_NOTICE_TEXT, expiresAt: state.handoff.expires_at.toISOString() }; });
    }
    async sendCode(input: { handoffId: unknown; handoffSecret: unknown; browserBinding: unknown }): Promise<{ challengeId: string; expiresAt: string }> {
        const sent = await this.transaction(async tx => {
            const state = await this.load(tx, input);
            // Resumable transition: after a reload the browser lost its
            // challenge but the signup may already be mailbox_verified.
            // Issuing again would try to replace the trigger-immutable
            // binding, so return the bound challenge instead. The client
            // re-enters the emailed code and verification replays
            // idempotently. No new code exists, so nothing is delivered.
            // Cancelled and expired signups cannot receive codes either:
            // fail bounded instead of tripping the binding trigger.
            if (state.signup.status !== 'pending' && state.signup.status !== 'mailbox_verified') throw invalid();
            if (state.signup.status === 'mailbox_verified') {
                if (!state.signup.mailbox_challenge_id) throw invalid();
                return { email: null as string | null, code: null as string | null, challengeId: state.signup.mailbox_challenge_id, expiresAt: state.signup.expires_at };
            }
            const issued = await requestChallenge(tx, { purpose: 'student_sso_signup', subjectKey: state.email, bindings: { email: state.email, name: '', universityId: state.universityId, matricNumber: null, policyVersion: state.handoff.policy_version, noticeVersion: VERIFICATION_NOTICE_VERSION }, expiresAt: state.handoff.expires_at }); if (issued.status !== 'issued') throw new ConflictError('Please wait before requesting another signup code.'); await tx.query('UPDATE student_auth_signup_challenges SET mailbox_challenge_id = $2 WHERE id = $1', [state.signup.id, issued.challengeId]); return { email: state.email, code: issued.code, challengeId: issued.challengeId, expiresAt: issued.expiresAt };
        });
        if (sent.email === null || sent.code === null) return { challengeId: sent.challengeId, expiresAt: sent.expiresAt.toISOString() };
        try { const result = await this.deps.deliverOtp(sent.email, sent.code, '', sent.expiresAt); if (!result.success) throw new Error('rejected'); } catch { throw new ServiceUnavailableError('We could not deliver a signup code. Please wait before trying again.'); }
        return { challengeId: sent.challengeId, expiresAt: sent.expiresAt.toISOString() };
    }
    async verifyCode(input: { handoffId: unknown; handoffSecret: unknown; browserBinding: unknown; challengeId: unknown; code: unknown }): Promise<{ verified: true; expiresAt: string }> {
        if (!UUID.test(String(input.challengeId)) || typeof input.code !== 'string' || !/^\d{6}$/.test(input.code)) throw new BadRequestError('Signup OTP must be six digits');
        const result = await this.transaction(async tx => {
            const state = await this.load(tx, input);
            if (state.signup.mailbox_challenge_id !== input.challengeId) throw invalid();
            // Idempotent replay: when the success response was lost after
            // commit, retrying the same bound challenge returns the verified
            // result instead of consuming the spent challenge twice. The
            // challenge stays bound and the signup stays verified; no new
            // proof is minted and resend remains trigger-forbidden.
            if (state.signup.status === 'mailbox_verified') return 'verified' as const;
            const consumed = await consumeChallenge(tx, { purpose: 'student_sso_signup', subjectKey: state.email, challengeId: input.challengeId as string, code: input.code as string }); if (consumed.status !== 'verified') return consumed.status; await tx.query(`UPDATE student_auth_signup_challenges SET status = 'mailbox_verified', mailbox_verified_at = clock_timestamp() WHERE id = $1 AND status = 'pending'`, [state.signup.id]); return 'verified' as const;
        });
        if (result !== 'verified') throw new UnauthorizedError('Invalid or expired signup code.');
        return { verified: true, expiresAt: (await this.context(input)).expiresAt };
    }
    async complete(input: { handoffId: unknown; handoffSecret: unknown; browserBinding: unknown; fullName: unknown; ageAttested: unknown; termsAccepted: unknown; termsVersion: unknown; verificationConsent: unknown; noticeVersion: unknown }): Promise<{ user: { id: string; email: string; role: 'student' }; tokens: TokenPair }> {
        if (typeof input.fullName !== 'string' || input.fullName.trim().length < 2 || input.fullName.trim().length > 255 || input.ageAttested !== true || input.termsAccepted !== true || input.termsVersion !== STUDENT_TERMS_VERSION || input.verificationConsent !== true || input.noticeVersion !== VERIFICATION_NOTICE_VERSION) throw new BadRequestError('Current age, Terms, and verification processing assent are required');
        const fullName = input.fullName.trim();
        try { return await this.transaction(async tx => { const state = await this.load(tx, input); if (state.signup.status !== 'mailbox_verified') throw invalid(); const university = (await tx.query<{ name: string; is_active: boolean }>('SELECT name, is_active FROM universities WHERE id = $1 FOR UPDATE', [state.universityId])).rows[0]; if (!university || university.is_active !== true) throw invalid();
            // This durable marker survives optional password establishment;
            // legacy mailbox-only reset/setup must never become an ownership
            // transfer path for a recycled institution address.
            const user = (await tx.query<{ id: string; email: string; role: 'student' }>(`INSERT INTO users (email, password_hash, role, password_setup_requires_recovery_code) VALUES ($1, NULL, 'student', true) RETURNING id, lower(btrim(email)) AS email, role`, [state.email])).rows[0]; if (!user) throw invalid();
            await tx.query(`INSERT INTO students (user_id, name, university, university_id, registration_number, status) VALUES ($1, $2, $3, $4, NULL, 'active')`, [user.id, fullName, university.name, state.universityId]);
            await tx.query(`INSERT INTO terms_acceptances (user_id, kind, terms_version, age_attested) VALUES ($1, 'student_terms', $2, true)`, [user.id, STUDENT_TERMS_VERSION]);
            await tx.query(`INSERT INTO verification_consents (user_id, kind, university_id, notice_version, accepted) VALUES ($1, 'processing', $2, $3, true)`, [user.id, state.universityId, VERIFICATION_NOTICE_VERSION]);
            await recordPasswordlessSignupMailboxProof(tx, user.id, state.signup.mailbox_challenge_id!);
            const identity = (await tx.query<{ id: string }>(`INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject, observed_email) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [user.id, state.universityId, state.observation.provider, state.observation.issuer, state.observation.subject, state.observation.email])).rows[0]; if (!identity) throw invalid();
            const tokens = await issueSessionInTransaction(tx, { userId: user.id, email: user.email, role: 'student' }); await tx.query('UPDATE users SET active_session_auth_identity_id = $2 WHERE id = $1', [user.id, identity.id]);
            const consumed = await tx.query(`UPDATE student_auth_link_handoffs
                SET consumed_at = clock_timestamp(), secret_hash = NULL, browser_binding_hash = NULL, encrypted_observation = NULL
                WHERE id = $1 AND consumed_at IS NULL`, [state.handoff.id]); if (consumed.rowCount !== 1) throw invalid(); await tx.query(`UPDATE student_auth_signup_challenges
                SET status = 'consumed', consumed_at = clock_timestamp(), terminal_at = clock_timestamp(), secret_hash = NULL, browser_binding_hash = NULL
                WHERE id = $1`, [state.signup.id]); return { user, tokens }; }); } catch (error) { if ((error as { code?: string }).code === '23505') throw new ConflictError('Use existing-account sign-in or recovery.'); throw error; }
    }
}
