import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ConflictError } from '../../common/errors/AppError.js';
import { appLogger } from '../../common/logger.js';
import { passwordService } from './password.service.js';
import { sendAccountRecoveryCompletionNotice } from '../email/email.service.js';
import { challengeSubjectDigest, challengeTtlMs, consumeChallenge, databaseNow, requestChallenge } from '../verification/challenge.service.js';
import { revokeSsoSchoolAssertions } from './student-sso-onboarding.service.js';
import { verifyRecoveryCodeDigest } from './student-recovery-code.service.js';

type RecoveryPurpose = 'lost_access' | 'compromise';

type Account = {
    id: string;
    email: string;
    credential_generation: number | string;
    deleted_at: Date | null;
    student_status: 'active' | 'suspended' | 'deleted' | null;
};

type Attempt = {
    id: string;
    user_id: string;
    credential_generation: number | string;
    purpose: RecoveryPurpose;
    // Terminal rows (failed, consumed, superseded) scrub the bearer to
    // NULL: every comparison must null-check first, never Buffer.from it.
    secret_hash: string | null;
    recovery_code_generation: number | string;
    mailbox_challenge_id: string;
    status: 'pending' | 'verified' | 'consumed' | 'failed' | 'expired';
    expires_at: Date;
};

type RecoveryCode = { id: string; generation: number | string; code_digest: string | null; status: string };

export type StudentAccountRecoveryDependencies = {
    pool: Pick<Pool, 'connect'>;
    /** Deployment-held HMAC key shared with recovery-code enrollment. */
    recoveryCodeKey: string;
    /** Retained previous effective key, verification fallback only. */
    previousRecoveryCodeKey?: string;
    deliverOtp?: (email: string, otp: string) => Promise<{ success: boolean }>;
    hashPassword?: (password: string) => Promise<string>;
    validatePassword?: (password: string) => { valid: boolean; errors: string[] };
    notify?: (email: string, purpose: RecoveryPurpose) => Promise<{ success: boolean }>;
};

function unavailable(): ConflictError {
    return new ConflictError('Account recovery is not available');
}

function validPurpose(value: unknown): value is RecoveryPurpose {
    return value === 'lost_access' || value === 'compromise';
}

function validOpaque(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validAttemptId(value: unknown): value is string {
    return typeof value === 'string' && UUID.test(value);
}

/**
 * The only password-establishment path for passwordless marker accounts.
 * It deliberately never issues a session: a successful caller must perform a
 * normal password login after the transaction commits.
 */
export class StudentAccountRecoveryService {
    constructor(private readonly deps: StudentAccountRecoveryDependencies) {
        if (deps.recoveryCodeKey.length < 16) throw new TypeError('Recovery-code digest key is invalid');
        if (deps.previousRecoveryCodeKey !== undefined && deps.previousRecoveryCodeKey.length < 16) {
            throw new TypeError('Recovery-code previous digest key is invalid');
        }
    }

    async start(input: { email: unknown; purpose: unknown }): Promise<{ attemptId: string; secret: string; expiresAt: string; serverNow: string }> {
        if (!validPurpose(input.purpose)) throw new TypeError('Recovery purpose is invalid');
        if (typeof input.email !== 'string' || input.email.trim().length === 0 || input.email.length > 255) {
            throw new TypeError('Recovery email is invalid');
        }
        // Narrowed once: the transaction closure would otherwise reset
        // property narrowing on the mutable input binding.
        const purpose = input.purpose;
        const email = input.email.trim().toLowerCase();
        const attemptId = randomUUID();
        const secret = randomBytes(32).toString('base64url');
        // The fallback and committed handles share one server-clock expiry.
        // The mailbox challenge TTL is the binding constraint (the attempt
        // row takes LEAST(server clock + 10m, challenge expiry), and the
        // challenge takes the earlier of its input and server clock + TTL —
        // so both paths derive from the same clock read plus the shared TTL.
        // A generic client-clock +10m expiry would mark real attempts by
        // clock skew and by the shorter mailbox TTL.
        const ttlMs = challengeTtlMs('student_account_recovery');
        const started = await this.transaction(async (tx) => {
            const serverNow = await databaseNow(tx);
            const serverExpiry = new Date(serverNow.getTime() + ttlMs);
            const account = await this.findRecoverableAccount(tx, email);
            const active = account ? await this.lockActiveCode(tx, account.id) : await this.lockActiveCode(tx, randomUUID());
            if (!account || !active) {
                return this.decoyStart(tx, { email, attemptId, purpose, serverExpiry, serverNow });
            }
            // Locked before challenge issuance so concurrent starts and
            // verifications serialize on the attempt row in one order
            // (attempt before budget/challenge, matching verify) instead
            // of deadlocking budget-against-attempt.
            const live = await this.lockLiveAttempt(tx, account.id, purpose);
            const challenge = await requestChallenge(tx, {
                purpose: 'student_account_recovery', subjectKey: account.email,
                bindings: { recoveryAttemptId: attemptId, recoveryPurpose: input.purpose },
                expiresAt: serverExpiry,
            });
            if (challenge.status !== 'issued') {
                // Cooldown with a live pending attempt: the first start
                // committed but its 202 was lost. Supersede onto a rebound
                // handle against the same unconsumed challenge instead of
                // stranding the delivered OTP behind a decoy. The expiry
                // stays bounded by the original challenge, so retries can
                // never stretch the OTP window, and no OTP is re-sent.
                if (!live) {
                    // No resumable attempt, but the frozen budget-challenge
                    // expiry still applies: a fresh deadline here would mark
                    // committed handles against decoy retries, which return
                    // the same frozen value. Fresh only when none is live.
                    const current = await this.liveBudgetChallengeExpiry(tx, challengeSubjectDigest('student_account_recovery', account.email));
                    return { expiresAt: (current ?? serverExpiry).toISOString(), serverNow: serverNow.toISOString() };
                }
                await this.failPriorAttempts(tx, account.id);
                // Rebind the shared challenge to the rebound handle: verify
                // pins consumption to exactly one live attempt, and the
                // failed predecessor must not keep the binding. Same
                // transaction, same row lock — exactly one live attempt can
                // ever present this challenge.
                const reboundBinding = await tx.query(
                    `UPDATE verification_challenges
                     SET bindings = jsonb_set(bindings, '{recoveryAttemptId}', to_jsonb($2::text))
                     WHERE id = $1 AND consumed_at IS NULL AND superseded_at IS NULL`,
                    [live.mailbox_challenge_id, attemptId],
                );
                if (reboundBinding.rowCount !== 1) throw unavailable();
                const rebound = await tx.query<{ expires_at: Date }>(
                    `INSERT INTO student_auth_recovery_attempts
                         (id, user_id, credential_generation, purpose, secret_hash, recovery_code_generation,
                          mailbox_challenge_id, expires_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, LEAST(clock_timestamp() + interval '10 minutes', $8::timestamptz))
                     RETURNING expires_at`,
                    [attemptId, account.id, Number(account.credential_generation), input.purpose, this.secretDigest(secret), Number(active.generation), live.mailbox_challenge_id, live.challenge_expires_at],
                );
                return { expiresAt: rebound.rows[0]!.expires_at.toISOString(), serverNow: serverNow.toISOString() };
            }
            await this.failPriorAttempts(tx, account.id);
            const inserted = await tx.query<{ expires_at: Date }>(
                `INSERT INTO student_auth_recovery_attempts
                     (id, user_id, credential_generation, purpose, secret_hash, recovery_code_generation,
                      mailbox_challenge_id, expires_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, LEAST(clock_timestamp() + interval '10 minutes', $8::timestamptz))
                 RETURNING expires_at`,
                [attemptId, account.id, Number(account.credential_generation), input.purpose, this.secretDigest(secret), Number(active.generation), challenge.challengeId, challenge.expiresAt],
            );
            return { email: account.email, otp: challenge.code, challengeId: challenge.challengeId, expiresAt: inserted.rows[0]!.expires_at.toISOString(), serverNow: serverNow.toISOString() };
        });
        // Always provide an indistinguishable browser handle. A non-existent,
        // suspended, or code-less account receives a handle that cannot verify.
        // Delivery is never awaited: transport latency would otherwise mark
        // real accounts by response timing. Definitive delivery failures
        // retire the challenge asynchronously (see deliverAndCompensate) so
        // cooldown retries cannot rebound to an OTP that was never emailed.
        if ('challengeId' in started) void this.deliverAndCompensate(started.challengeId, started.email, started.otp);
        return { attemptId, secret, expiresAt: started.expiresAt, serverNow: started.serverNow };
    }

    /**
     * Fire-and-forget OTP delivery with post-commit compensation. A
     * rejected transport is ambiguous (the mail may still have been
     * sent), so the challenge stays usable; but a resolved `{ success:
     * false }` is definitive non-delivery, and the challenge is
     * superseded while whichever pending attempt currently owns it —
     * the original or a rebound successor created while delivery was
     * in flight — is terminalized. Keying by the attempt would miss
     * the rebound holder and leave it usable against an OTP that was
     * never emailed. A consumed challenge is left alone: consumption
     * proves the OTP reached its mailbox. Attempts lock before the
     * challenge, matching verify, so compensation cannot deadlock a
     * concurrent proof.
     */
    private async deliverAndCompensate(challengeId: string, email: string, otp: string): Promise<void> {
        const deliver = this.deps.deliverOtp;
        if (!deliver) return;
        let result: { success: boolean };
        try {
            result = await deliver(email, otp);
        } catch {
            return;
        }
        if (result.success) return;
        try {
            await this.transaction(async (tx) => {
                await tx.query(
                    `SELECT id FROM student_auth_recovery_attempts
                     WHERE mailbox_challenge_id = $1 AND status = 'pending' FOR UPDATE`,
                    [challengeId],
                );
                const challenge = await tx.query<{ id: string }>(
                    `SELECT id FROM verification_challenges WHERE id = $1 AND consumed_at IS NULL FOR UPDATE`,
                    [challengeId],
                );
                if (!challenge.rows[0]) return;
                await tx.query(
                    `UPDATE student_auth_recovery_attempts SET status = 'failed', secret_hash = NULL
                     WHERE mailbox_challenge_id = $1 AND status = 'pending'`,
                    [challengeId],
                );
                await tx.query(
                    `UPDATE verification_challenges SET superseded_at = clock_timestamp()
                     WHERE id = $1 AND superseded_at IS NULL`,
                    [challengeId],
                );
            });
        } catch {
            // Best-effort compensation; the 202 response stands either way.
        }
    }

    async verify(input: { attemptId: unknown; secret: unknown; code: unknown; otp: unknown }): Promise<void> {
        if (!validAttemptId(input.attemptId) || !validOpaque(input.secret) || !validOpaque(input.code)
            || typeof input.otp !== 'string' || !/^\d{6}$/.test(input.otp)) throw unavailable();
        const { attemptId, secret, code: recoveryCode, otp: mailboxOtp } = input;
        const verified = await this.transaction(async (tx) => {
            const owner = await tx.query<{ user_id: string }>('SELECT user_id FROM student_auth_recovery_attempts WHERE id = $1', [attemptId]);
            const userId = owner.rows[0]?.user_id;
            if (!userId) {
                await this.probeVerifyDecoys(tx, attemptId);
                return false;
            }
            const account = await this.lockAccount(tx, userId);
            const attempt = await this.lockAttempt(tx, attemptId);
            if (!attempt || attempt.expires_at <= await this.now(tx)
                || !attempt.secret_hash || !this.matchesDigest(attempt.secret_hash, this.secretDigest(secret))) return false;
            // Idempotent retry: the verification commit landed but its 204
            // was lost. The mailbox OTP was already proven and its
            // challenge consumed, so revalidate the still-checkable proofs
            // (attempt bearer, live recovery code, pinned generations)
            // instead of consuming the OTP twice. A mismatch returns false
            // without failing the attempt: a mistyped retry must not
            // destroy a verified attempt the user already earned.
            if (attempt.status === 'verified') {
                const code = await this.lockActiveCode(tx, userId);
                if (!account || !code || Number(account.credential_generation) !== Number(attempt.credential_generation)
                    || Number(code.generation) !== Number(attempt.recovery_code_generation)
                    || !this.matchesRecoveryCode(code.code_digest, recoveryCode)) return false;
                return true;
            }
            if (attempt.status !== 'pending') return false;
            const code = await this.lockActiveCode(tx, userId);
            // Stale account/code state terminalizes the attempt: the pinned
            // generations can never match again. An ordinary code typo
            // stays pending so correcting it and resubmitting the
            // still-valid OTP works, exactly like an incorrect OTP within
            // its failure budget.
            if (!account || !code || Number(account.credential_generation) !== Number(attempt.credential_generation)
                || Number(code.generation) !== Number(attempt.recovery_code_generation)) {
                await tx.query("UPDATE student_auth_recovery_attempts SET status = 'failed', secret_hash = NULL WHERE id = $1 AND status = 'pending'", [attempt.id]);
                return false;
            }
            if (!this.matchesRecoveryCode(code.code_digest, recoveryCode)) return false;
            const otp = await consumeChallenge(tx, {
                purpose: 'student_account_recovery', subjectKey: account.email,
                challengeId: attempt.mailbox_challenge_id, code: mailboxOtp,
            });
            if (otp.status !== 'verified'
                || otp.bindings.recoveryAttemptId !== attempt.id
                || otp.bindings.recoveryPurpose !== attempt.purpose) return false;
            const updated = await tx.query(
                `UPDATE student_auth_recovery_attempts
                 SET status = 'verified', verified_at = clock_timestamp()
                 WHERE id = $1 AND status = 'pending'`, [attempt.id],
            );
            return updated.rowCount === 1;
        });
        if (!verified) throw unavailable();
    }

    async complete(input: { attemptId: unknown; secret: unknown; password: unknown }): Promise<void> {
        // The published contract caps passwords at 1024 characters;
        // validatePassword() enforces only the complexity floor, so the
        // ceiling is enforced here to keep runtime and schema in agreement.
        if (!validAttemptId(input.attemptId) || !validOpaque(input.secret) || typeof input.password !== 'string' || input.password.length > 1024) throw unavailable();
        const { attemptId, secret, password } = input;
        const validation = (this.deps.validatePassword ?? ((candidate: string) => passwordService.validatePassword(candidate)))(password);
        if (!validation.valid) throw new ConflictError(validation.errors.join(', '));
        // Cheap credential check before the expensive password hash; the
        // transaction below rechecks everything under lock against the
        // database clock. Expiry is deliberately not previewed here: an
        // application clock ahead of PostgreSQL must not reject an
        // attempt the database still considers live.
        const candidate = await this.previewAttempt(attemptId);
        if (!candidate || candidate.status !== 'verified'
            || !candidate.secret_hash || !this.matchesDigest(candidate.secret_hash, this.secretDigest(secret))) throw unavailable();
        const hash = await (this.deps.hashPassword ?? ((candidate: string) => passwordService.hashPassword(candidate)))(password);
        const committed = await this.transaction(async (tx) => {
            // Read only to establish the owner, then acquire the canonical user
            // lock before taking mutable attempt/code/identity locks.
            const owner = await tx.query<{ user_id: string }>('SELECT user_id FROM student_auth_recovery_attempts WHERE id = $1', [attemptId]);
            const userId = owner.rows[0]?.user_id;
            if (!userId) throw unavailable();
            const account = await this.lockAccount(tx, userId);
            const attempt = await this.lockAttempt(tx, attemptId);
            const code = await this.lockActiveCode(tx, userId);
            if (!account || !attempt || !code || attempt.status !== 'verified' || attempt.expires_at <= await this.now(tx)
                || !attempt.secret_hash || !this.matchesDigest(attempt.secret_hash, this.secretDigest(secret))
                || Number(account.credential_generation) !== Number(attempt.credential_generation)
                || Number(code.generation) !== Number(attempt.recovery_code_generation)) throw unavailable();

            if (attempt.purpose === 'compromise') {
                const identities = await tx.query<{ id: string }>('SELECT id FROM student_auth_identities WHERE user_id = $1 AND revoked_at IS NULL FOR UPDATE', [userId]);
                for (const identity of identities.rows) {
                    await tx.query('UPDATE student_auth_identities SET revoked_at = clock_timestamp() WHERE id = $1 AND revoked_at IS NULL', [identity.id]);
                    await revokeSsoSchoolAssertions(tx, identity.id);
                }
            }
            await tx.query(
                `UPDATE student_auth_recovery_codes
                 SET status = CASE WHEN status = 'active' THEN 'consumed' ELSE 'revoked' END,
                     code_digest = NULL, expires_at = NULL,
                     consumed_at = CASE WHEN status = 'active' THEN clock_timestamp() ELSE NULL END,
                     revoked_at = CASE WHEN status = 'pending' THEN clock_timestamp() ELSE NULL END,
                     pending_sid = NULL, pending_credential_generation = NULL, pending_proof_identity_id = NULL
                 WHERE user_id = $1 AND status IN ('active', 'pending')`, [userId],
            );
            await tx.query(
                `UPDATE users SET password_hash = $2, password_reset_otp = NULL, password_reset_otp_expires_at = NULL,
                     refresh_token_hash = NULL, refresh_token_expires_at = NULL, active_session_id = NULL,
                     active_session_issued_at = NULL, active_session_auth_identity_id = NULL,
                     credential_generation = credential_generation + 1,
                     recovery_reenrollment_requires_password = true, recovery_session_binding_required = true,
                     updated_at = clock_timestamp()
                 WHERE id = $1`, [userId, hash],
            );
            await tx.query("UPDATE student_auth_action_grants SET revoked_at = clock_timestamp(), secret_hash = 'scrubbed' WHERE user_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL", [userId]);
            await tx.query("UPDATE student_auth_reauth_grants SET consumed_at = clock_timestamp(), secret_hash = 'scrubbed' WHERE user_id = $1 AND consumed_at IS NULL", [userId]);
            await tx.query(
                `UPDATE student_auth_reauth_attempts
                 SET status = 'failed', consumed_at = clock_timestamp(), state_hash = NULL, callback_cookie_hash = NULL,
                     encrypted_verifier = NULL, nonce = NULL
                 WHERE user_id = $1 AND status IN ('pending', 'processing', 'ready')`,
                [userId],
            );
            // A ready provider callback is not yet a session. Invalidate every
            // same-mailbox attempt before releasing the account lock so a
            // pre-recovery callback cannot mint a post-recovery session.
            // The comparison is normalized: a legacy stored email may carry
            // case or whitespace the normalized attempt mailboxes do not.
            // Terminal binding digests are scrubbed immediately, matching
            // the reauthentication and recovery terminalization above.
            await tx.query(
                `UPDATE student_auth_attempts
                 SET status = 'failed', state_hash = NULL, callback_cookie_hash = NULL, finish_secret_hash = NULL,
                     encrypted_verifier = NULL, nonce = NULL, encrypted_observation = NULL
                 WHERE lower(btrim(requested_email)) = lower(btrim($1)) AND status IN ('pending', 'processing', 'ready')`,
                [account.email],
            );
            await tx.query(
                `UPDATE student_auth_recovery_attempts
                 SET status = 'failed', secret_hash = NULL
                 WHERE user_id = $1 AND id <> $2 AND status IN ('pending', 'verified')`,
                [userId, attempt.id],
            );
            const consumed = await tx.query(
                `UPDATE student_auth_recovery_attempts SET status = 'consumed', consumed_at = clock_timestamp(), secret_hash = NULL
                 WHERE id = $1 AND status = 'verified'`, [attempt.id],
            );
            if (consumed.rowCount !== 1) throw unavailable();
            return { email: account.email, purpose: attempt.purpose };
        });
        await this.sendCompletionNotice(committed.email, committed.purpose);
    }

    private async transaction<T>(operation: (tx: PoolClient) => Promise<T>): Promise<T> {
        const tx = await this.deps.pool.connect();
        try { await tx.query('BEGIN'); const result = await operation(tx); await tx.query('COMMIT'); return result; }
        catch (error) { await tx.query('ROLLBACK').catch(() => undefined); throw error; }
        finally { tx.release(); }
    }

    // Both lookups lock the user row, then recheck status from a
    // separately locked student row: the active-status check must serialize
    // with a concurrent suspension, or recovery could replace the password
    // for an account suspended for suspected compromise and leave a usable
    // credential on reactivation. FOR UPDATE cannot target the nullable
    // side of the outer join, hence the second keyed lock; order follows
    // users → students.
    private async findRecoverableAccount(tx: PoolClient, email: string): Promise<Account | null> {
        const result = await tx.query<Account>(
            `SELECT u.id, u.email, u.credential_generation, u.deleted_at, s.status AS student_status
             FROM users u LEFT JOIN students s ON s.user_id = u.id
             WHERE lower(btrim(u.email)) = $1 AND u.role = 'student' FOR UPDATE OF u`, [email],
        );
        const account = result.rows[0];
        if (!account || account.deleted_at !== null) return null;
        return (await this.lockedStudentStatus(tx, account.id)) === 'active' ? account : null;
    }

    private async lockAccount(tx: PoolClient, userId: string): Promise<Account | null> {
        const result = await tx.query<Account>(
            `SELECT u.id, u.email, u.credential_generation, u.deleted_at, s.status AS student_status
             FROM users u LEFT JOIN students s ON s.user_id = u.id WHERE u.id = $1 FOR UPDATE OF u`, [userId],
        );
        const account = result.rows[0];
        if (!account || account.deleted_at !== null) return null;
        return (await this.lockedStudentStatus(tx, account.id)) === 'active' ? account : null;
    }

    private async lockedStudentStatus(tx: PoolClient, userId: string): Promise<string | null> {
        const student = await tx.query<{ status: string }>(
            'SELECT status FROM students WHERE user_id = $1 FOR UPDATE', [userId],
        );
        return student.rows[0]?.status ?? null;
    }

    /**
     * Anti-enumeration decoy start for unknown, deleted, suspended, and
     * code-less addresses. The decoy issues a real mailbox challenge keyed
     * by the normalized email so retry deadlines are stable exactly like
     * committed handles: a fresh `serverNow + TTL` on every decoy retry
     * would be a deterministic response-field oracle against the frozen
     * rebound expiry. The challenge can never verify — verify requires an
     * attempt row, and none is written here — and nothing is delivered.
     * Storage is bounded, not unbounded: one budget row per subject
     * (upserted), at most three challenges per ten-minute window per
     * subject (budget-enforced), plus the route's per-IP limiter — the
     * same issuance signup already performs for unknown addresses. Aged
     * tombstones and stale budgets are deleted by the retention
     * dispatcher, so rotating addresses cannot grow the tables. The
     * budget is shared with the committed path (one subject, one cap):
     * a state transition inside the cooldown — reactivation, code
     * enrollment — simply delays the first committed attempt row until
     * the caller's retry past the cooldown.
     */
    private async decoyStart(tx: PoolClient, handle: { email: string; attemptId: string; purpose: RecoveryPurpose; serverExpiry: Date; serverNow: Date }): Promise<{ expiresAt: string; serverNow: string }> {
        const decoy = await requestChallenge(tx, {
            purpose: 'student_account_recovery', subjectKey: handle.email,
            bindings: { recoveryAttemptId: handle.attemptId, recoveryPurpose: handle.purpose },
            expiresAt: handle.serverExpiry,
        });
        if (decoy.status === 'issued') {
            return { expiresAt: decoy.expiresAt.toISOString(), serverNow: handle.serverNow.toISOString() };
        }
        // Cooldown/locked: the live current challenge's frozen expiry,
        // mirroring the committed rebound; fresh only when none is live.
        const live = await this.liveBudgetChallengeExpiry(tx, challengeSubjectDigest('student_account_recovery', handle.email));
        return { expiresAt: (live ?? handle.serverExpiry).toISOString(), serverNow: handle.serverNow.toISOString() };
    }

    /**
     * Frozen expiry of the budget's live current challenge, if any. The
     * committed no-live-attempt branch and the decoy cooldown/locked branch
     * share this so retry deadlines are indistinguishable on both paths.
     */
    private async liveBudgetChallengeExpiry(tx: PoolClient, subject: string): Promise<Date | null> {
        const result = await tx.query<{ expires_at: Date }>(
            `SELECT challenge.expires_at
             FROM verification_challenge_budgets budget
             JOIN verification_challenges challenge ON challenge.id = budget.current_challenge_id
             WHERE budget.purpose = 'student_account_recovery' AND budget.subject_digest = $1
               AND challenge.consumed_at IS NULL AND challenge.superseded_at IS NULL
               AND challenge.expires_at > clock_timestamp()`,
            [subject],
        );
        return result.rows[0]?.expires_at ?? null;
    }

    /**
     * Newest pending same-purpose attempt whose mailbox challenge is still
     * consumable, locked for a rebound handle. Verified rows never
     * resume: their holder already proved the OTP and keeps working.
     */
    private async lockLiveAttempt(tx: PoolClient, userId: string, purpose: RecoveryPurpose): Promise<{ id: string; mailbox_challenge_id: string; challenge_expires_at: Date } | null> {
        const result = await tx.query<{ id: string; mailbox_challenge_id: string; challenge_expires_at: Date }>(
            `SELECT attempt.id, attempt.mailbox_challenge_id, challenge.expires_at AS challenge_expires_at
             FROM student_auth_recovery_attempts attempt
             JOIN verification_challenges challenge ON challenge.id = attempt.mailbox_challenge_id
             WHERE attempt.user_id = $1 AND attempt.purpose = $2 AND attempt.status = 'pending'
               AND attempt.expires_at > clock_timestamp()
               AND challenge.consumed_at IS NULL AND challenge.superseded_at IS NULL AND challenge.expires_at > clock_timestamp()
             ORDER BY attempt.created_at DESC LIMIT 1 FOR UPDATE`,
            [userId, purpose],
        );
        return result.rows[0] ?? null;
    }

    private async failPriorAttempts(tx: PoolClient, userId: string): Promise<void> {
        await tx.query(
            `UPDATE student_auth_recovery_attempts
             SET status = 'failed', secret_hash = NULL
             WHERE user_id = $1 AND status IN ('pending', 'verified')`,
            [userId],
        );
    }

    private async lockActiveCode(tx: PoolClient, userId: string): Promise<RecoveryCode | null> {
        const result = await tx.query<RecoveryCode>(
            "SELECT id, generation, code_digest, status FROM student_auth_recovery_codes WHERE user_id = $1 AND status = 'active' FOR UPDATE", [userId],
        );
        return result.rows[0] ?? null;
    }

    /**
     * Anti-enumeration decoy reads mirroring the committed verify path's
     * shapes (users, students, attempt, clock, code) for handles with no
     * attempt row. Without this, a decoy verification exits after one
     * lookup while a recoverable address runs five more queries before
     * the same 409, a latency oracle over repeated bogus proofs. Random
     * ids miss every lock in the same order, so no lock is ever held,
     * and the digest comparison runs over dummy material.
     */
    private async probeVerifyDecoys(tx: PoolClient, attemptId: string): Promise<void> {
        await this.lockAccount(tx, randomUUID());
        await this.lockedStudentStatus(tx, randomUUID());
        await this.lockAttempt(tx, attemptId);
        await this.now(tx);
        await this.lockActiveCode(tx, randomUUID());
        this.matchesDigest('decoy-expected-digest', this.secretDigest('decoy-verify-probe'));
    }

    private async lockAttempt(tx: PoolClient, id: string): Promise<Attempt | null> {
        const result = await tx.query<Attempt>('SELECT * FROM student_auth_recovery_attempts WHERE id = $1 FOR UPDATE', [id]);
        return result.rows[0] ?? null;
    }

    private async sendCompletionNotice(email: string, purpose: RecoveryPurpose): Promise<void> {
        try {
            const delivery = await (this.deps.notify ?? sendAccountRecoveryCompletionNotice)(email, purpose);
            if (!delivery.success) appLogger.error('Account recovery completion notice delivery failed');
        } catch {
            // Credential state has already committed. A transport failure must
            // not reopen or roll back a consumed recovery.
            appLogger.error('Account recovery completion notice transport failed');
        }
    }

    private async previewAttempt(id: string): Promise<{ status: string; secret_hash: string | null; expires_at: Date } | null> {
        const conn = await this.deps.pool.connect();
        try {
            const result = await conn.query<{ status: string; secret_hash: string | null; expires_at: Date }>(
                'SELECT status, secret_hash, expires_at FROM student_auth_recovery_attempts WHERE id = $1', [id],
            );
            return result.rows[0] ?? null;
        } finally { conn.release(); }
    }

    private async now(tx: PoolClient): Promise<Date> {
        const result = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
        return result.rows[0]!.now;
    }

    private secretDigest(secret: string): string { return createHmac('sha256', this.deps.recoveryCodeKey).update(`attempt\u0000${secret}`).digest('base64url'); }
    private matchesRecoveryCode(expected: string | null, supplied: string): boolean {
        return verifyRecoveryCodeDigest(expected, supplied, this.deps.recoveryCodeKey, this.deps.previousRecoveryCodeKey);
    }
    private matchesDigest(expected: string, candidate: string): boolean {
        const actual = Buffer.from(candidate); const wanted = Buffer.from(expected);
        return actual.length === wanted.length && timingSafeEqual(actual, wanted);
    }
}
