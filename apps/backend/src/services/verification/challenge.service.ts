import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { config } from '../../config/env.js';

export type ChallengePurpose = 'student_signup' | 'student_sso_signup' | 'student_account_recovery' | 'student_email' | 'account_email' | 'whatsapp' | 'password_reset';
export type ChallengeBindings = Record<string, unknown>;

type Budget = {
    current_challenge_id: string | null;
    window_started_at: Date;
    failed_attempts: number;
    send_count: number;
    resend_available_at: Date;
};

type Challenge = {
    id: string;
    secret_digest: string;
    bindings: ChallengeBindings;
    expires_at: Date;
    consumed_at: Date | null;
    superseded_at: Date | null;
};

const PURPOSES = new Set<ChallengePurpose>(['student_signup', 'student_sso_signup', 'student_account_recovery', 'student_email', 'account_email', 'whatsapp', 'password_reset']);
const WINDOW_MS = 10 * 60 * 1000;
const OTP_MS = 10 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const MAX_FAILURES = 5;
const MAX_SENDS = 10;
// Minimum usable challenge life at issue: the atomic delivery-enqueue
// insert runs a statement later under the same expires_at >
// created_at constraint, so a deadline inside this margin would pass
// here and 500 there. One second dwarfs statement skew and stays far
// below every real flow lifetime (shortest fixture: two seconds).
const MIN_USABLE_LIFETIME_MS = 1000;

function limitsFor(purpose: ChallengePurpose): { failures: number; sends: number; ttlMs: number } {
    // The passwordless handoff is an intentionally narrower mailbox-binding
    // proof: it cannot extend the original ten-minute provider attempt.
    return purpose === 'student_sso_signup' || purpose === 'student_account_recovery'
        ? { failures: 5, sends: 3, ttlMs: 5 * 60 * 1000 }
        : { failures: MAX_FAILURES, sends: MAX_SENDS, ttlMs: OTP_MS };
}

/**
 * Single source of truth for a purpose TTL, so first-start and fallback
 * expiries derive from the same server clock plus TTL on every path.
 */
export function challengeTtlMs(purpose: ChallengePurpose): number {
    return limitsFor(purpose).ttlMs;
}

function digest(label: string, value: string): string {
    return createHmac('sha256', config.jwt.secret).update(`${label}\u0000${value}`).digest('hex');
}

export function challengeSubjectDigest(purpose: ChallengePurpose, subjectKey: string): string {
    return digest('awoof-verification-subject-v1', `${purpose}\u0000${subjectKey}`);
}

function otpDigest(purpose: ChallengePurpose, subject: string, challengeId: string, code: string): string {
    return digest('awoof-verification-otp-v1', `${purpose}\u0000${subject}\u0000${challengeId}\u0000${code}`);
}

function isPlainObject(value: unknown): value is ChallengeBindings {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function copiedBindings(value: ChallengeBindings): ChallengeBindings {
    if (!isPlainObject(value)) throw new TypeError('Challenge bindings must be a plain JSON object');
    let json: string;
    try {
        json = JSON.stringify(value);
    } catch {
        throw new TypeError('Challenge bindings must be JSON serializable');
    }
    // PostgreSQL renders JSONB with canonical separator whitespace; keep the
    // application limit below the schema's 4 KiB storage ceiling so a valid
    // compact payload cannot fail later solely because of JSONB formatting.
    if (!json || Buffer.byteLength(json, 'utf8') > 4096) {
        throw new RangeError('Challenge bindings exceed the 4 KiB limit');
    }
    const parsed: unknown = JSON.parse(json);
    if (!isPlainObject(parsed)) throw new TypeError('Challenge bindings must be a plain JSON object');
    return parsed;
}

function validInput(purpose: ChallengePurpose, subjectKey: string): void {
    if (!PURPOSES.has(purpose)) throw new TypeError('Unsupported challenge purpose');
    if (typeof subjectKey !== 'string' || subjectKey.length === 0 || subjectKey.length > 1024) {
        throw new TypeError('Challenge subject key is invalid');
    }
}

function fixedWindowEnd(start: Date): Date {
    return new Date(start.getTime() + WINDOW_MS);
}

async function lockedBudget(tx: PoolClient, purpose: ChallengePurpose, subject: string): Promise<Budget> {
    const result = await tx.query<Budget>(
        `INSERT INTO verification_challenge_budgets
             (purpose, subject_digest, window_started_at, resend_available_at)
         VALUES ($1, $2, clock_timestamp(), clock_timestamp())
         ON CONFLICT (purpose, subject_digest) DO UPDATE
             SET purpose = EXCLUDED.purpose
         RETURNING current_challenge_id, window_started_at, failed_attempts, send_count, resend_available_at`,
        [purpose, subject],
    );
    const budget = result.rows[0];
    if (!budget) throw new Error('Challenge budget was not returned');
    return budget;
}

export async function databaseNow(tx: PoolClient): Promise<Date> {
    const result = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const now = result.rows[0]?.now;
    if (!now) throw new Error('Database clock was not returned');
    return now;
}

async function resetWindowIfNeeded(tx: PoolClient, purpose: ChallengePurpose, subject: string, budget: Budget, now: Date): Promise<Budget> {
    if (now < fixedWindowEnd(budget.window_started_at)) return budget;
    const result = await tx.query<Budget>(
        `UPDATE verification_challenge_budgets
         SET window_started_at = $3, failed_attempts = 0, send_count = 0
         WHERE purpose = $1 AND subject_digest = $2
         RETURNING current_challenge_id, window_started_at, failed_attempts, send_count, resend_available_at`,
        [purpose, subject, now],
    );
    const reset = result.rows[0];
    if (!reset) throw new Error('Challenge budget reset was not returned');
    return reset;
}

async function recordFailure(tx: PoolClient, purpose: ChallengePurpose, subject: string): Promise<void> {
    await tx.query(
        `UPDATE verification_challenge_budgets
         SET failed_attempts = failed_attempts + 1
         WHERE purpose = $1 AND subject_digest = $2`,
        [purpose, subject],
    );
}

async function assertCanonicalBindingsSize(tx: PoolClient, bindings: ChallengeBindings): Promise<string> {
    const json = JSON.stringify(bindings);
    const result = await tx.query<{ bytes: number }>('SELECT octet_length($1::jsonb::text) AS bytes', [json]);
    if ((result.rows[0]?.bytes ?? Infinity) > 4096) {
        throw new RangeError('Challenge bindings exceed the canonical JSONB size limit');
    }
    return json;
}

function constantTimeDigestEquals(expected: string, actual: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(actual)) return false;
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

export async function requestChallenge(tx: PoolClient, input: {
    purpose: ChallengePurpose;
    subjectKey: string;
    bindings: ChallengeBindings;
    expiresAt?: Date;
}): Promise<{ status: 'issued'; challengeId: string; code: string; expiresAt: Date } | { status: 'cooldown' | 'locked' | 'expired'; retryAt: Date }> {
    validInput(input.purpose, input.subjectKey);
    const bindings = copiedBindings(input.bindings);
    const subject = challengeSubjectDigest(input.purpose, input.subjectKey);
    let budget = await lockedBudget(tx, input.purpose, subject);
    const now = await databaseNow(tx);
    const limits = limitsFor(input.purpose);
    // A caller-supplied deadline (a signup handoff window) can lapse
    // between the caller's check and this issue. Issuing anyway would
    // violate the expires_at > created_at constraint and surface a 500;
    // worse, a barely-future deadline would pass this insert but fail
    // the atomic outbox insert a statement later. Refuse before burning
    // budget allowance when the resolved deadline lacks a usable
    // lifetime. This check must stay after the budget upsert: a fresh
    // row's resend_available_at is stamped at insert, and reading the
    // clock first would make every first issuance look like a cooldown.
    // retryAt is now: nothing is scheduled — the caller maps expired to
    // its restart flow rather than a cooldown resume.
    const requestedExpiry = input.expiresAt ?? new Date(now.getTime() + limits.ttlMs);
    const defaultExpiry = new Date(now.getTime() + limits.ttlMs);
    const expiresAt = requestedExpiry < defaultExpiry ? requestedExpiry : defaultExpiry;
    if (expiresAt.getTime() <= now.getTime() + MIN_USABLE_LIFETIME_MS) return { status: 'expired', retryAt: now };
    budget = await resetWindowIfNeeded(tx, input.purpose, subject, budget, now);
    const windowEnd = fixedWindowEnd(budget.window_started_at);

    if (budget.failed_attempts >= limits.failures || budget.send_count >= limits.sends) {
        return { status: 'locked', retryAt: windowEnd };
    }
    if (now < budget.resend_available_at) return { status: 'cooldown', retryAt: budget.resend_available_at };

    if (budget.current_challenge_id) {
        await tx.query(
            `UPDATE verification_challenges SET superseded_at = $2
             WHERE id = $1 AND consumed_at IS NULL AND superseded_at IS NULL`,
            [budget.current_challenge_id, now],
        );
    }

    const challengeId = randomUUID();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const bindingsJson = await assertCanonicalBindingsSize(tx, bindings);
    await tx.query(
        `INSERT INTO verification_challenges
             (id, purpose, subject_digest, secret_digest, bindings, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [challengeId, input.purpose, subject, otpDigest(input.purpose, subject, challengeId, code), bindingsJson, now, expiresAt],
    );
    await tx.query(
        `UPDATE verification_challenge_budgets
         SET current_challenge_id = $3, send_count = send_count + 1, resend_available_at = $4
         WHERE purpose = $1 AND subject_digest = $2`,
        [input.purpose, subject, challengeId, new Date(now.getTime() + COOLDOWN_MS)],
    );
    return { status: 'issued', challengeId, code, expiresAt };
}

/**
 * Rejections are ordinary results so callers can commit failed-attempt updates before
 * returning a generic error. Only infrastructure or programming failures throw.
 * A caller must consume, validate/apply bindings, and create proof in this same
 * transaction; a later rollback makes the challenge consumable again.
 */
export async function consumeChallenge(tx: PoolClient, input: {
    purpose: ChallengePurpose;
    subjectKey: string;
    challengeId: string;
    code: string;
}): Promise<{ status: 'verified'; challengeId: string; bindings: ChallengeBindings } | { status: 'invalid' | 'expired' | 'locked' }> {
    validInput(input.purpose, input.subjectKey);
    const subject = challengeSubjectDigest(input.purpose, input.subjectKey);
    const budgetResult = await tx.query<Budget>(
        `SELECT current_challenge_id, window_started_at, failed_attempts, send_count, resend_available_at
         FROM verification_challenge_budgets WHERE purpose = $1 AND subject_digest = $2 FOR UPDATE`,
        [input.purpose, subject],
    );
    let budget = budgetResult.rows[0];
    if (!budget) return { status: 'invalid' };
    const now = await databaseNow(tx);
    budget = await resetWindowIfNeeded(tx, input.purpose, subject, budget, now);
    if (budget.failed_attempts >= limitsFor(input.purpose).failures) return { status: 'locked' };

    let challenge: Challenge | undefined;
    if (budget.current_challenge_id === input.challengeId) {
        const challengeResult = await tx.query<Challenge>(
            `SELECT id, secret_digest, bindings, expires_at, consumed_at, superseded_at
             FROM verification_challenges WHERE id = $1 FOR UPDATE`,
            [input.challengeId],
        );
        challenge = challengeResult.rows[0];
    }
    if (!challenge || challenge.consumed_at || challenge.superseded_at) {
        await recordFailure(tx, input.purpose, subject);
        return { status: 'invalid' };
    }
    if (challenge.expires_at <= now) return { status: 'expired' };
    if (typeof input.code !== 'string' || !/^\d{6}$/.test(input.code) ||
        !constantTimeDigestEquals(challenge.secret_digest, otpDigest(input.purpose, subject, input.challengeId, input.code))) {
        await recordFailure(tx, input.purpose, subject);
        return { status: 'invalid' };
    }
    // New passwordless flows retain only the consumed challenge binding, not
    // an OTP digest that can no longer authorize anything. Legacy purposes
    // keep their established retention contract unchanged.
    const consumed = await tx.query(
        `UPDATE verification_challenges
         SET consumed_at = $2,
             secret_digest = CASE WHEN purpose IN ('student_sso_signup', 'student_account_recovery')
                                  THEN repeat('0', 64) ELSE secret_digest END
         WHERE id = $1 AND consumed_at IS NULL AND superseded_at IS NULL`,
        [challenge.id, now],
    );
    if (consumed.rowCount !== 1) return { status: 'invalid' };
    return { status: 'verified', challengeId: challenge.id, bindings: copiedBindings(challenge.bindings) };
}
