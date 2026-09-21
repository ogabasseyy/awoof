import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
    BadRequestError,
    ConflictError,
    NotFoundError,
    RateLimitError,
    ServiceUnavailableError,
    UnauthorizedError,
} from '../../common/errors/AppError.js';
import {
    decryptMicrosoftAttemptVerifier as decryptSsoSecret,
    encryptMicrosoftAttemptVerifier as encryptSsoSecret,
    hashMicrosoftAttemptSecret as hashSsoSecret,
} from '../verification/microsoft-attempt-crypto.js';
import { lockStudentContext } from '../verification/eligibility-context.service.js';
import { normalizeStudentDomain } from '../verification/eligibility-policy.service.js';
import { normalizeStudentLoginEmail } from './student-login-options.service.js';
import { readStudentAssuranceOrNull } from '../verification/student-assurance.service.js';
import type { StudentAssurance } from '../verification/student-assurance.types.js';
import { issueSessionInTransaction } from './session.service.js';
import type { TokenPair } from './jwt.service.js';
import { GOOGLE_ISSUER } from './student-google-oidc.js';
import type { LoginProvider, ProviderObservation, StudentOidcAdapter } from './student-sso.types.js';

/**
 * Browser-bound atomic SSO login (Task B3).
 *
 * Canonical lock order for every writer here (B4 link/unlink extends it):
 * users → students → universities → institution_login_policies →
 * student_auth_identities → student_auth_attempts → student_auth_link_handoffs.
 * Callback holds only policy/attempt locks (no user exists yet); finish holds
 * the full chain. No network call ever runs inside an open transaction.
 */

export const STUDENT_SSO_COOKIE_PATH = '/api/auth/student/sso';
export const STUDENT_SSO_ATTEMPT_LIFETIME_SECONDS = 10 * 60;
export const STUDENT_SSO_HANDOFF_LIFETIME_SECONDS = 10 * 60;
export const STUDENT_SSO_OPEN_ATTEMPT_LIMIT = 3;
const STUDENT_SSO_RETURN_PATH_MAX_LENGTH = 2048;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type StudentSsoCallbackCookie = {
    name: string;
    value: string;
    maxAgeSeconds: typeof STUDENT_SSO_ATTEMPT_LIFETIME_SECONDS;
    path: typeof STUDENT_SSO_COOKIE_PATH;
    httpOnly: true;
    secure: true;
    sameSite: 'lax';
};

export type StudentSsoStartPublicResult = {
    attemptId: string;
    authorizationUrl: string;
    finishSecret: string;
    expiresAt: string;
    serverNow: string;
};

export type StudentSsoStartResult = { publicResult: StudentSsoStartPublicResult; callbackCookie: StudentSsoCallbackCookie };

export type StudentSsoCallbackResult = {
    attemptId: string;
    completionUrl: URL;
    /** A bounded, non-authorizing terminal callback outcome. */
    outcome?: 'connection_not_completed';
};

export type StudentSsoAuthenticatedResult = {
    outcome: 'authenticated';
    user: { id: string; email: string; role: 'student'; verificationStatus: string };
    tokens: TokenPair;
    /** Null is permitted only with assuranceStatus 'unavailable'; never set student verified on error. */
    studentAssurance: StudentAssurance | null;
    assuranceStatus: 'available' | 'unavailable';
};

export type StudentSsoFinishResult =
    | StudentSsoAuthenticatedResult
    | { outcome: 'link_required'; handoffId: string; handoffSecret: string; expiresAt: string }
    | { outcome: 'restart_required' };

export type ApprovedLoginPolicy = {
    id: string;
    universityId: string;
    provider: LoginProvider;
    issuer: string;
    realm: string;
    version: number;
};

export type StudentSsoOidcResolver = {
    forPolicy(policy: ApprovedLoginPolicy): StudentOidcAdapter;
};

export type StudentSsoFlowDependencies = {
    pool: Pool;
    oidc: StudentSsoOidcResolver;
    attemptKey: string;
    callbackUrls: Record<LoginProvider, URL>;
    completionUrl: URL;
    /** Feature gates the service itself; adapters cannot re-enable an in-flight attempt. */
    isEnabled?: () => boolean;
    /** Best-effort assurance read after commit; defaults to the shared reader. */
    readAssurance?: (userId: string) => Promise<StudentAssurance | null>;
};

type PendingAuthenticatedFinish = {
    outcome: 'authenticated';
    user: StudentSsoAuthenticatedResult['user'];
    tokens: TokenPair;
    readAssurance: (userId: string) => Promise<StudentAssurance | null>;
};

type SsoAttempt = {
    id: string;
    policy_id: string;
    policy_version: number;
    provider: string;
    requested_email: string;
    state_hash: string;
    callback_cookie_hash: string;
    finish_secret_hash: string;
    encrypted_verifier: string | null;
    nonce: string | null;
    encrypted_observation: string | null;
    status: 'pending' | 'processing' | 'ready' | 'consumed' | 'failed';
    expires_at: Date;
    remember_me: boolean;
    return_path: string | null;
    created_at: Date;
};

function secret(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
}

/** Per-attempt host-only cookie name. The binding survives callback and finish-to-handoff; link/cancel/expiry clears it. */
export function studentSsoCookieName(attemptId: string): string {
    return `awoof_sso_${attemptId}`;
}

function invalidAttempt(): ConflictError {
    return new ConflictError('Student SSO attempt is no longer valid');
}

/** Authority revoked after the cookie check: the browser gets a bounded redirect, not a raw error. */
class StudentSsoAuthorityInvalidatedError extends ConflictError {
    constructor() {
        super('Student SSO attempt is no longer valid');
    }
}

class StudentSsoAttemptExpiredError extends ConflictError {
    constructor(readonly attemptId: string) {
        super('Student SSO attempt is no longer valid');
    }
}

function fixedCallback(actual: URL, configured: URL): boolean {
    // Exact configured match (origin plus fixed path), no credentials or
    // fragment, exactly one state. Production configuration is HTTPS-only;
    // the service pins the configured value so loopback fixtures can run.
    return !actual.username && !actual.password && !actual.hash
        && actual.origin === configured.origin && actual.pathname === configured.pathname
        && actual.searchParams.getAll('state').length === 1;
}

export function parseStudentSsoProvider(value: unknown): LoginProvider {
    if (value === 'google' || value === 'microsoft') return value;
    throw new BadRequestError('Unknown student SSO provider');
}

/**
 * Backend mirror of the web student-return rules: same-origin relative
 * targets only, never an /auth loop. Absent input stores NULL; present but
 * invalid input is a 400, never a silent fallback.
 */
export function resolveStudentSsoReturnPath(candidate: unknown, origin: string): string | null {
    if (candidate === null || candidate === undefined) return null;
    if (typeof candidate !== 'string' || candidate.trim() === '' || candidate.length > STUDENT_SSO_RETURN_PATH_MAX_LENGTH) {
        throw new BadRequestError('Student SSO return path is invalid');
    }
    if (/%(?![\dA-Fa-f]{2})/.test(candidate) || candidate.includes('\\')) {
        throw new BadRequestError('Student SSO return path is invalid');
    }
    let resolved: URL;
    try {
        resolved = new URL(candidate, origin);
    } catch {
        throw new BadRequestError('Student SSO return path is invalid');
    }
    if ((resolved.protocol !== 'http:' && resolved.protocol !== 'https:')
        || resolved.origin !== origin || resolved.username || resolved.password
        || resolved.pathname === '/auth' || resolved.pathname.startsWith('/auth/')) {
        throw new BadRequestError('Student SSO return path is invalid');
    }
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

/** Fail closed on misconfigured policy trust data before any provider call. */
export function assertAdapterPolicy(policy: ApprovedLoginPolicy): void {
    if (policy.provider === 'google') {
        try {
            normalizeStudentDomain(policy.realm);
        } catch {
            throw invalidAttempt();
        }
        if (policy.issuer !== GOOGLE_ISSUER) throw invalidAttempt();
        return;
    }
    if (!TENANT_UUID.test(policy.realm)) throw invalidAttempt();
    if (policy.issuer !== `https://login.microsoftonline.com/${policy.realm}/v2.0`) throw invalidAttempt();
}

function encodeObservation(observation: ProviderObservation): string {
    return JSON.stringify({
        provider: observation.provider,
        issuer: observation.issuer,
        subject: observation.subject,
        email: observation.email,
        mailboxVerified: observation.mailboxVerified,
        realm: observation.realm,
        schoolMembershipAttested: observation.schoolMembershipAttested,
    });
}

function decodeObservation(raw: string): ProviderObservation {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw invalidAttempt();
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidAttempt();
    const value = parsed as Record<string, unknown>;
    if ((value.provider !== 'google' && value.provider !== 'microsoft')
        || typeof value.issuer !== 'string' || value.issuer === ''
        || typeof value.subject !== 'string' || value.subject === ''
        || (typeof value.email !== 'string' && value.email !== null)
        || typeof value.mailboxVerified !== 'boolean'
        || typeof value.realm !== 'string'
        || typeof value.schoolMembershipAttested !== 'boolean') {
        throw invalidAttempt();
    }
    return {
        provider: value.provider,
        issuer: value.issuer,
        subject: value.subject,
        email: value.email,
        mailboxVerified: value.mailboxVerified,
        realm: value.realm,
        schoolMembershipAttested: value.schoolMembershipAttested,
    };
}

function validOpaque(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}

export class StudentSsoFlowService {
    constructor(private readonly deps: StudentSsoFlowDependencies) {}

    private async transaction<T>(operation: (tx: PoolClient) => Promise<T>): Promise<T> {
        const tx = await this.deps.pool.connect();
        try {
            await tx.query('BEGIN');
            const result = await operation(tx);
            await tx.query('COMMIT');
            return result;
        } catch (error) {
            await tx.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            tx.release();
        }
    }

    private assertEnabled(): void {
        if (this.deps.isEnabled?.() !== true) throw invalidAttempt();
    }

    private async failAttempt(attemptId: string): Promise<void> {
        await this.transaction(async (tx) => {
            await tx.query(
                `UPDATE student_auth_attempts
                 SET status = 'failed', encrypted_verifier = NULL, nonce = NULL, encrypted_observation = NULL
                 WHERE id = $1 AND status IN ('pending', 'processing', 'ready')`,
                [attemptId],
            );
        });
    }

    private boundedFailureCompletion(attemptId: string): StudentSsoCallbackResult {
        const completionUrl = new URL(this.deps.completionUrl.href);
        completionUrl.searchParams.set('attempt', attemptId);
        completionUrl.searchParams.set('outcome', 'connection_not_completed');
        return { attemptId, completionUrl, outcome: 'connection_not_completed' };
    }

    /**
     * Current-policy recheck under the policy lock: enabled, live approval,
     * pinned version, active university, active domain mapping. Trust edits
     * increment the version under the same lock, so equality is meaningful.
     */
    private async assertCurrentPolicy(tx: PoolClient, policyId: string, version: number, mailbox: string): Promise<ApprovedLoginPolicy> {
        await tx.query('SELECT id FROM institution_login_policies WHERE id = $1 FOR UPDATE', [policyId]);
        const domain = mailbox.slice(mailbox.lastIndexOf('@') + 1);
        const result = await tx.query<ApprovedLoginPolicy & { university_id: string; provider_realm: string }>(
            `SELECT p.id, p.university_id, p.provider, p.issuer, p.provider_realm, p.version
             FROM institution_login_policies p
             JOIN universities u ON u.id = p.university_id AND u.is_active
             JOIN institution_login_domain_providers dp
               ON dp.policy_id = p.id
              AND dp.university_id = p.university_id
              AND dp.provider = p.provider
             JOIN institution_login_domains d
               ON d.domain = dp.domain
              AND d.university_id = dp.university_id
              AND d.is_active
             WHERE p.id = $1
               AND p.version = $2
               AND p.enabled
               AND p.approved_until IS NOT NULL
               AND p.approved_until > clock_timestamp()
               AND d.domain = $3`,
            [policyId, version, domain],
        );
        const row = result.rows[0];
        if (!row || (row.provider !== 'google' && row.provider !== 'microsoft')) {
            throw new StudentSsoAuthorityInvalidatedError();
        }
        const policy: ApprovedLoginPolicy = {
            id: row.id,
            universityId: row.university_id,
            provider: row.provider,
            issuer: row.issuer,
            realm: row.provider_realm,
            version: row.version,
        };
        try {
            assertAdapterPolicy(policy);
        } catch {
            throw new StudentSsoAuthorityInvalidatedError();
        }
        return policy;
    }

    async start(input: { provider: unknown; email: unknown; rememberMe?: unknown; returnPath?: unknown }): Promise<StudentSsoStartResult> {
        this.assertEnabled();
        const provider = parseStudentSsoProvider(input.provider);
        const mailbox = normalizeStudentLoginEmail(input.email);
        if (input.rememberMe !== undefined && typeof input.rememberMe !== 'boolean') {
            throw new BadRequestError('Student SSO remember-me flag is invalid');
        }
        const rememberMe = input.rememberMe === true;
        const returnPath = resolveStudentSsoReturnPath(input.returnPath, this.deps.completionUrl.origin);

        const prepared = await this.transaction(async (tx) => {
            const domain = mailbox.slice(mailbox.lastIndexOf('@') + 1);
            // Unlocked approval read: callback and finish re-lock and enforce
            // currency, so a concurrent policy change fails there, safely.
            const policy = await tx.query<{ id: string; version: number; provider: string; issuer: string; provider_realm: string; university_id: string }>(
                `SELECT p.id, p.version, p.provider, p.issuer, p.provider_realm, p.university_id
                 FROM institution_login_policies p
                 JOIN universities u ON u.id = p.university_id AND u.is_active
                 JOIN institution_login_domain_providers dp
                   ON dp.policy_id = p.id
                  AND dp.university_id = p.university_id
                  AND dp.provider = p.provider
                 JOIN institution_login_domains d
                   ON d.domain = dp.domain
                  AND d.university_id = dp.university_id
                  AND d.is_active
                 WHERE p.enabled
                   AND p.approved_until IS NOT NULL
                   AND p.approved_until > clock_timestamp()
                   AND d.domain = $1
                   AND p.provider = $2`,
                [domain, provider],
            );
            const row = policy.rows[0];
            if (!row) throw new NotFoundError('Student SSO is not available for this email domain');
            const approved: ApprovedLoginPolicy = {
                id: row.id,
                universityId: row.university_id,
                provider,
                issuer: row.issuer,
                realm: row.provider_realm,
                version: row.version,
            };
            assertAdapterPolicy(approved);
            const open = await tx.query<{ count: string }>(
                `SELECT count(*) FROM student_auth_attempts
                 WHERE policy_id = $1 AND requested_email = $2
                   AND status IN ('pending', 'processing')
                   AND expires_at > clock_timestamp()`,
                [approved.id, mailbox],
            );
            if (Number(open.rows[0]?.count ?? 0) >= STUDENT_SSO_OPEN_ATTEMPT_LIMIT) {
                throw new RateLimitError('Too many outstanding student SSO attempts');
            }
            const attemptId = randomUUID();
            const state = secret();
            const browserSecret = secret();
            const finishSecret = secret();
            const nonce = secret();
            const verifier = secret(48);
            const inserted = await tx.query<{ expires_at: Date; now: Date }>(
                `INSERT INTO student_auth_attempts
                     (id, policy_id, policy_version, provider, requested_email, state_hash,
                      callback_cookie_hash, finish_secret_hash, encrypted_verifier, nonce,
                      expires_at, remember_me, return_path)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, clock_timestamp() + interval '10 minutes', $11, $12)
                 RETURNING expires_at, clock_timestamp() AS now`,
                [
                    attemptId, approved.id, approved.version, provider, mailbox,
                    hashSsoSecret(state), hashSsoSecret(browserSecret), hashSsoSecret(finishSecret),
                    encryptSsoSecret(verifier, this.deps.attemptKey, attemptId), nonce,
                    rememberMe, returnPath,
                ],
            );
            return {
                attemptId, state, browserSecret, finishSecret, nonce, verifier,
                policy: approved,
                expiresAt: inserted.rows[0]!.expires_at,
                serverNow: inserted.rows[0]!.now,
            };
        });

        // Provider authorization runs outside the transaction; a failure
        // terminalizes the attempt instead of leaking a dead URL.
        let authorizationUrl: URL;
        try {
            authorizationUrl = await this.deps.oidc.forPolicy(prepared.policy).authorize({
                state: prepared.state,
                nonce: prepared.nonce,
                verifier: prepared.verifier,
                loginHint: mailbox,
            });
        } catch {
            await this.failAttempt(prepared.attemptId);
            throw new ServiceUnavailableError('Student SSO is temporarily unavailable. Please try again.');
        }
        if (this.deps.isEnabled?.() !== true) {
            await this.failAttempt(prepared.attemptId);
            throw invalidAttempt();
        }
        return {
            publicResult: {
                attemptId: prepared.attemptId,
                authorizationUrl: authorizationUrl.href,
                finishSecret: prepared.finishSecret,
                expiresAt: prepared.expiresAt.toISOString(),
                serverNow: prepared.serverNow.toISOString(),
            },
            callbackCookie: {
                name: studentSsoCookieName(prepared.attemptId),
                value: prepared.browserSecret,
                maxAgeSeconds: STUDENT_SSO_ATTEMPT_LIFETIME_SECONDS,
                path: STUDENT_SSO_COOKIE_PATH,
                httpOnly: true,
                secure: true,
                sameSite: 'lax',
            },
        };
    }

    async callback(input: { provider: unknown; callbackUrl: URL; browserCookies: readonly { name: string; value: string }[] }): Promise<StudentSsoCallbackResult> {
        this.assertEnabled();
        const provider = parseStudentSsoProvider(input.provider);
        if (!fixedCallback(input.callbackUrl, this.deps.callbackUrls[provider])) throw invalidAttempt();
        const state = input.callbackUrl.searchParams.get('state');
        if (!state) throw invalidAttempt();

        let claimed: { attempt: SsoAttempt; policy: ApprovedLoginPolicy; state: string; verifier: string; nonce: string };
        let cookieAuthenticatedAttemptId: string | null = null;
        let undecryptableAttemptId: string | null = null;
        try {
            claimed = await this.transaction(async (tx) => {
                // State locates the attempt, but only the per-attempt cookie
                // authenticates the browser. Provider must match the route.
                const row = await tx.query<SsoAttempt>('SELECT * FROM student_auth_attempts WHERE state_hash = $1', [hashSsoSecret(state)]);
                const attempt = row.rows[0];
                const browserCookie = attempt
                    ? input.browserCookies.find((cookie) => cookie.name === studentSsoCookieName(attempt.id))?.value
                    : undefined;
                if (!attempt || attempt.provider !== provider || attempt.status !== 'pending'
                    || !browserCookie || hashSsoSecret(browserCookie) !== attempt.callback_cookie_hash) {
                    throw invalidAttempt();
                }
                cookieAuthenticatedAttemptId = attempt.id;
                const policy = await this.assertCurrentPolicy(tx, attempt.policy_id, attempt.policy_version, attempt.requested_email);
                await tx.query('SELECT id FROM student_auth_attempts WHERE id = $1 FOR UPDATE', [attempt.id]);
                const locked = await tx.query<SsoAttempt>('SELECT * FROM student_auth_attempts WHERE id = $1', [attempt.id]);
                const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
                if (!locked.rows[0] || locked.rows[0].status !== 'pending') throw invalidAttempt();
                if (locked.rows[0].expires_at <= clock.rows[0]!.now) throw new StudentSsoAttemptExpiredError(locked.rows[0].id);
                if (!attempt.encrypted_verifier || !attempt.nonce) throw invalidAttempt();
                this.assertEnabled();
                // Single-use claim before any external redemption: concurrent
                // callbacks redeem exactly once.
                const updated = await tx.query(`UPDATE student_auth_attempts SET status = 'processing' WHERE id = $1 AND status = 'pending'`, [attempt.id]);
                if (updated.rowCount !== 1) throw invalidAttempt();
                let verifier: string;
                try {
                    verifier = decryptSsoSecret(attempt.encrypted_verifier, this.deps.attemptKey, attempt.id);
                } catch {
                    undecryptableAttemptId = attempt.id;
                    throw new StudentSsoAuthorityInvalidatedError();
                }
                return { attempt, policy, state, verifier, nonce: attempt.nonce };
            });
        } catch (error) {
            if (error instanceof StudentSsoAttemptExpiredError) {
                await this.failAttempt(error.attemptId);
                return this.boundedFailureCompletion(error.attemptId);
            }
            if (undecryptableAttemptId !== null) {
                await this.failAttempt(undecryptableAttemptId);
                return this.boundedFailureCompletion(undecryptableAttemptId);
            }
            if (cookieAuthenticatedAttemptId !== null && error instanceof StudentSsoAuthorityInvalidatedError) {
                await this.failAttempt(cookieAuthenticatedAttemptId);
                return this.boundedFailureCompletion(cookieAuthenticatedAttemptId);
            }
            throw error;
        }

        let observation: ProviderObservation;
        try {
            observation = await this.deps.oidc.forPolicy(claimed.policy).redeem({
                callback: input.callbackUrl,
                state: claimed.state,
                nonce: claimed.nonce,
                verifier: claimed.verifier,
            });
        } catch {
            // Only a callback that passed fixed URL, state, cookie, policy,
            // and attempt-CAS checks reaches redemption. Denial and transport
            // failures are deliberately indistinguishable and authorize
            // nothing; no upstream string crosses this boundary.
            await this.failAttempt(claimed.attempt.id);
            return this.boundedFailureCompletion(claimed.attempt.id);
        }

        try {
            await this.transaction(async (tx) => {
                this.assertEnabled();
                await this.assertCurrentPolicy(tx, claimed.attempt.policy_id, claimed.attempt.policy_version, claimed.attempt.requested_email);
                await tx.query('SELECT id FROM student_auth_attempts WHERE id = $1 FOR UPDATE', [claimed.attempt.id]);
                const row = await tx.query<SsoAttempt>('SELECT * FROM student_auth_attempts WHERE id = $1', [claimed.attempt.id]);
                const attempt = row.rows[0];
                const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
                if (!attempt || attempt.status !== 'processing') throw invalidAttempt();
                if (attempt.expires_at <= clock.rows[0]!.now) throw new StudentSsoAttemptExpiredError(attempt.id);
                this.assertEnabled();
                // The ready observation is stored only while the attempt is
                // still current and the policy still approves it.
                const updated = await tx.query(
                    `UPDATE student_auth_attempts
                     SET status = 'ready', encrypted_verifier = NULL, nonce = NULL, encrypted_observation = $2
                     WHERE id = $1 AND status = 'processing'`,
                    [attempt.id, encryptSsoSecret(encodeObservation(observation), this.deps.attemptKey, attempt.id)],
                );
                if (updated.rowCount !== 1) throw invalidAttempt();
            });
        } catch (error) {
            await this.failAttempt(claimed.attempt.id);
            if (error instanceof StudentSsoAttemptExpiredError || error instanceof StudentSsoAuthorityInvalidatedError) {
                return this.boundedFailureCompletion(error instanceof StudentSsoAttemptExpiredError ? error.attemptId : claimed.attempt.id);
            }
            return this.boundedFailureCompletion(claimed.attempt.id);
        }

        const completionUrl = new URL(this.deps.completionUrl.href);
        completionUrl.searchParams.set('attempt', claimed.attempt.id);
        return { attemptId: claimed.attempt.id, completionUrl };
    }

    /** State is hashed before lookup; callers receive a cookie name only. */
    async callbackCookieNameForState(callbackUrl: URL, provider: LoginProvider): Promise<string | null> {
        if (!fixedCallback(callbackUrl, this.deps.callbackUrls[provider])) return null;
        const state = callbackUrl.searchParams.get('state');
        if (!state) return null;
        const result = await this.deps.pool.query<{ id: string }>(
            'SELECT id FROM student_auth_attempts WHERE state_hash = $1 AND provider = $2',
            [hashSsoSecret(state), provider],
        );
        return result.rows[0] ? studentSsoCookieName(result.rows[0].id) : null;
    }

    async finish(input: { attemptId: unknown; finishSecret: unknown; browserCookie: string | undefined }): Promise<StudentSsoFinishResult> {
        this.assertEnabled();
        if (typeof input.attemptId !== 'string' || !UUID.test(input.attemptId)) throw invalidAttempt();
        if (!validOpaque(input.finishSecret) || !validOpaque(input.browserCookie)) throw invalidAttempt();
        const attemptId = input.attemptId;
        const finishSecret = input.finishSecret;
        const browserCookie = input.browserCookie;

        type SettledFinish = Extract<StudentSsoFinishResult, { outcome: 'link_required' }> | { restart: true } | PendingAuthenticatedFinish;
        let finished: SettledFinish;
        try {
            finished = await this.transaction(async (tx): Promise<SettledFinish> => {
                this.assertEnabled();
                const row = await tx.query<SsoAttempt>('SELECT * FROM student_auth_attempts WHERE id = $1', [attemptId]);
                const attempt = row.rows[0];
                // Both the tab secret and the browser binding must prove before
                // any outcome, including restart, is revealed.
                if (!attempt || hashSsoSecret(finishSecret) !== attempt.finish_secret_hash
                    || hashSsoSecret(browserCookie) !== attempt.callback_cookie_hash) {
                    throw invalidAttempt();
                }
                if (attempt.status === 'consumed' || attempt.status === 'failed') {
                    await this.invalidateAbandonedAttempts(tx, attempt);
                    return { restart: true };
                }
                const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
                if (attempt.expires_at <= clock.rows[0]!.now) {
                    await this.terminalizeAttempt(tx, attempt.id);
                    await this.invalidateAbandonedAttempts(tx, attempt);
                    return { restart: true };
                }
                if (attempt.status !== 'ready' || !attempt.encrypted_observation) throw invalidAttempt();
                let observation: ProviderObservation;
                try {
                    observation = decodeObservation(decryptSsoSecret(attempt.encrypted_observation, this.deps.attemptKey, attempt.id));
                } catch {
                    await this.terminalizeAttempt(tx, attempt.id);
                    await this.invalidateAbandonedAttempts(tx, attempt);
                    return { restart: true };
                }
                if (observation.provider !== attempt.provider) throw invalidAttempt();

                try {
                    const identity = await tx.query<{ id: string; user_id: string; revoked_at: Date | null }>(
                        `SELECT id, user_id, revoked_at FROM student_auth_identities
                         WHERE provider = $1 AND issuer = $2 AND subject = $3`,
                        [observation.provider, observation.issuer, observation.subject],
                    );
                    const linked = identity.rows[0];
                    // A revoked identity takes the unlinked path so only the original
                    // owner can reactivate it after fresh proof (B4); it never logs in.
                    if (!linked || linked.revoked_at !== null) {
                        return await this.finishUnlinked(tx, attempt, observation);
                    }
                    return await this.finishLinked(tx, attempt, observation, linked);
                } catch (error) {
                    if (error instanceof StudentSsoAttemptExpiredError) {
                        await this.terminalizeAttempt(tx, attempt.id);
                        await this.invalidateAbandonedAttempts(tx, attempt);
                        return { restart: true };
                    }
                    throw error;
                }
            });
        } catch (error) {
            // A lost handoff race surfaces as a unique conflict; the attempt
            // outcome is already decided, so report it as invalid, never raw SQL.
            if ((error as { code?: unknown }).code === '23505') throw invalidAttempt();
            throw error;
        }

        if ('restart' in finished) return { outcome: 'restart_required' };
        if (finished.outcome !== 'authenticated') return finished;
        // Assurance reads only after commit: a status failure keeps the login
        // successful with explicitly unavailable assurance, never a 500.
        try {
            const studentAssurance = await finished.readAssurance(finished.user.id);
            return {
                outcome: 'authenticated',
                user: finished.user,
                tokens: finished.tokens,
                studentAssurance,
                assuranceStatus: 'available',
            };
        } catch {
            return {
                outcome: 'authenticated',
                user: finished.user,
                tokens: finished.tokens,
                studentAssurance: null,
                assuranceStatus: 'unavailable',
            };
        }
    }

    private async terminalizeAttempt(tx: PoolClient, attemptId: string): Promise<void> {
        await tx.query(
            `UPDATE student_auth_attempts
             SET status = 'failed', encrypted_verifier = NULL, nonce = NULL, encrypted_observation = NULL
             WHERE id = $1 AND status IN ('pending', 'processing', 'ready')`,
            [attemptId],
        );
    }

    /** A controlled restart invalidates abandoned pre-callback flows for the same policy mailbox. Ready siblings survive. */
    private async invalidateAbandonedAttempts(tx: PoolClient, attempt: SsoAttempt): Promise<void> {
        await tx.query(
            `UPDATE student_auth_attempts
             SET status = 'failed', encrypted_verifier = NULL, nonce = NULL, encrypted_observation = NULL
             WHERE policy_id = $1 AND requested_email = $2
               AND status IN ('pending', 'processing') AND id <> $3`,
            [attempt.policy_id, attempt.requested_email, attempt.id],
        );
    }

    private async finishLinked(
        tx: PoolClient,
        attempt: SsoAttempt,
        observation: ProviderObservation,
        linked: { id: string; user_id: string },
    ): Promise<PendingAuthenticatedFinish | { restart: true }> {
        // Lock order: user → student → university → policy → identity → attempt.
        let context;
        try {
            context = await lockStudentContext(tx, linked.user_id);
        } catch (error) {
            if (error instanceof NotFoundError) throw new UnauthorizedError('Student SSO login is not available for this account');
            throw error;
        }
        if (!context.active) throw new UnauthorizedError('Student SSO login is not available for this account');
        const policy = await this.assertCurrentPolicy(tx, attempt.policy_id, attempt.policy_version, attempt.requested_email);
        if (policy.provider !== observation.provider || policy.issuer !== observation.issuer) throw invalidAttempt();
        const lockedIdentity = await tx.query<{ id: string; user_id: string; revoked_at: Date | null }>(
            'SELECT id, user_id, revoked_at FROM student_auth_identities WHERE id = $1 FOR UPDATE',
            [linked.id],
        );
        const identity = lockedIdentity.rows[0];
        if (!identity || identity.user_id !== context.userId || identity.revoked_at !== null) throw invalidAttempt();
        await tx.query('SELECT id FROM student_auth_attempts WHERE id = $1 FOR UPDATE', [attempt.id]);
        const locked = await tx.query<SsoAttempt>('SELECT * FROM student_auth_attempts WHERE id = $1', [attempt.id]);
        const finalClock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
        if (!locked.rows[0]) throw invalidAttempt();
        if (locked.rows[0].status === 'consumed' || locked.rows[0].status === 'failed') {
            // Lost a concurrent finish race after the pre-read: controlled
            // restart, never a second session.
            await this.invalidateAbandonedAttempts(tx, attempt);
            return { restart: true };
        }
        if (locked.rows[0].status !== 'ready') throw invalidAttempt();
        if (locked.rows[0].expires_at <= finalClock.rows[0]!.now) throw new StudentSsoAttemptExpiredError(locked.rows[0].id);
        this.assertEnabled();
        const tokens = await issueSessionInTransaction(
            tx,
            { userId: context.userId, email: context.email, role: 'student' },
            locked.rows[0].remember_me,
        );
        await tx.query('UPDATE users SET active_session_auth_identity_id = $2 WHERE id = $1', [context.userId, identity.id]);
        const consumed = await tx.query(
            `UPDATE student_auth_attempts
             SET status = 'consumed', encrypted_verifier = NULL, nonce = NULL, encrypted_observation = NULL
             WHERE id = $1 AND status = 'ready'`,
            [attempt.id],
        );
        if (consumed.rowCount !== 1) throw invalidAttempt();
        const profile = await tx.query<{ verification_status: string }>('SELECT verification_status FROM users WHERE id = $1', [context.userId]);
        // Commit issuance and consumed state together; tokens and assurance
        // go out only after commit.
        return {
            outcome: 'authenticated',
            user: {
                id: context.userId,
                email: context.email,
                role: 'student' as const,
                verificationStatus: profile.rows[0]?.verification_status ?? 'unverified',
            },
            tokens,
            readAssurance: this.deps.readAssurance ?? ((userId: string) => readStudentAssuranceOrNull(this.deps.pool, userId)),
        };
    }

    private async finishUnlinked(
        tx: PoolClient,
        attempt: SsoAttempt,
        observation: ProviderObservation,
    ): Promise<Extract<StudentSsoFinishResult, { outcome: 'link_required' }> | { restart: true }> {
        // Lock order subset: policy → attempt, then the single handoff insert.
        const policy = await this.assertCurrentPolicy(tx, attempt.policy_id, attempt.policy_version, attempt.requested_email);
        if (policy.provider !== observation.provider || policy.issuer !== observation.issuer) throw invalidAttempt();
        await tx.query('SELECT id FROM student_auth_attempts WHERE id = $1 FOR UPDATE', [attempt.id]);
        const locked = await tx.query<SsoAttempt>('SELECT * FROM student_auth_attempts WHERE id = $1', [attempt.id]);
        const finalClock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
        if (!locked.rows[0]) throw invalidAttempt();
        if (locked.rows[0].status === 'consumed' || locked.rows[0].status === 'failed') {
            await this.invalidateAbandonedAttempts(tx, attempt);
            return { restart: true };
        }
        if (locked.rows[0].status !== 'ready') throw invalidAttempt();
        if (locked.rows[0].expires_at <= finalClock.rows[0]!.now) throw new StudentSsoAttemptExpiredError(locked.rows[0].id);
        this.assertEnabled();
        const handoffId = randomUUID();
        const handoffSecret = secret();
        // The handoff inherits the browser binding so linking still proves
        // the same browser; the cookie is retained, never cleared here.
        const inserted = await tx.query<{ expires_at: Date }>(
            `INSERT INTO student_auth_link_handoffs
                 (id, attempt_id, secret_hash, encrypted_observation, policy_id, policy_version,
                  browser_binding_hash, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp() + interval '10 minutes')
             RETURNING expires_at`,
            [
                handoffId, attempt.id, hashSsoSecret(handoffSecret),
                encryptSsoSecret(encodeObservation(observation), this.deps.attemptKey, handoffId),
                attempt.policy_id, attempt.policy_version, attempt.callback_cookie_hash,
            ],
        );
        const consumed = await tx.query(
            `UPDATE student_auth_attempts
             SET status = 'consumed', encrypted_verifier = NULL, nonce = NULL, encrypted_observation = NULL
             WHERE id = $1 AND status = 'ready'`,
            [attempt.id],
        );
        if (consumed.rowCount !== 1) throw invalidAttempt();
        return {
            outcome: 'link_required',
            handoffId,
            handoffSecret,
            expiresAt: inserted.rows[0]!.expires_at.toISOString(),
        };
    }
}

export type StudentSsoCleanupResult = {
    attemptsFailed: number;
    handoffsScrubbed: number;
    attemptsDeleted: number;
    handoffsDeleted: number;
    grantsDeleted: number;
};

/**
 * Scheduled retention for SSO transients (B1 contract): expired attempt and
 * handoff ciphertext is scrubbed within one scheduled hour; non-audit
 * transient records are deleted after seven days. Owner linkage, revocation,
 * and assertion rows are retained under account retention rules and are
 * never deleted here.
 */
export async function cleanupStudentSsoTransients(client: PoolClient): Promise<StudentSsoCleanupResult> {
    const failed = await client.query(
        `UPDATE student_auth_attempts
         SET status = 'failed', encrypted_verifier = NULL, nonce = NULL, encrypted_observation = NULL
         WHERE expires_at <= clock_timestamp() AND status IN ('pending', 'processing', 'ready')`,
    );
    // Handoff ciphertext is NOT NULL by contract, so expiry overwrites it
    // with an inert marker instead of deleting the row before retention age.
    const scrubbed = await client.query(
        `UPDATE student_auth_link_handoffs
         SET encrypted_observation = 'scrubbed'
         WHERE expires_at <= clock_timestamp() AND consumed_at IS NULL AND encrypted_observation <> 'scrubbed'`,
    );
    const handoffs = await client.query(
        `DELETE FROM student_auth_link_handoffs WHERE expires_at <= clock_timestamp() - interval '7 days'`,
    );
    const grants = await client.query(
        `DELETE FROM student_auth_reauth_grants WHERE expires_at <= clock_timestamp() - interval '7 days'`,
    );
    const attempts = await client.query(
        `DELETE FROM student_auth_attempts
         WHERE status IN ('consumed', 'failed')
           AND expires_at <= clock_timestamp() - interval '7 days'
           AND NOT EXISTS (SELECT 1 FROM student_auth_link_handoffs WHERE attempt_id = student_auth_attempts.id)`,
    );
    return {
        attemptsFailed: failed.rowCount ?? 0,
        handoffsScrubbed: scrubbed.rowCount ?? 0,
        attemptsDeleted: attempts.rowCount ?? 0,
        handoffsDeleted: handoffs.rowCount ?? 0,
        grantsDeleted: grants.rowCount ?? 0,
    };
}
