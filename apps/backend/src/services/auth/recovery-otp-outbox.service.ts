import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { challengeSubjectDigest } from '../verification/challenge.service.js';

const AAD_PREFIX = 'awoof:student-email-otp:v1:';
const LEGACY_RECOVERY_AAD_PREFIX = 'awoof:student-account-recovery-otp:v1:';
const LEASE_SECONDS = 90;
const DELIVERY_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 8;
const RETENTION_HOURS = 24;
const BATCH_SIZE = 20;

type Envelope = { keyId: string; ciphertext: Buffer; nonce: Buffer; authTag: Buffer };
type Key = { id: string; value: Buffer };
export type StudentOtpPurpose = 'student_account_recovery' | 'student_sso_signup';
type OutboxJob = { id: string; challenge_id: string; purpose: StudentOtpPurpose; key_id: string; ciphertext: Buffer; nonce: Buffer; auth_tag: Buffer; claim_token: string; attempts: number };

function parseKey(value: string | null | undefined): Key | null {
    if (!value) return null;
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length !== 32 || decoded.toString('base64') !== value) throw new TypeError('Recovery OTP outbox key must be canonical base64 for 32 bytes');
    const fingerprint = createHash('sha256').update(decoded).digest('hex').slice(0, 12);
    return { id: `k-${fingerprint}`, value: decoded };
}

export function hasRecoveryOtpOutboxKey(value: string | null | undefined): boolean {
    try { return parseKey(value) !== null; } catch { return false; }
}

function encryptOtp(purpose: StudentOtpPurpose, challengeId: string, otp: string, key: Key): Envelope {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key.value, nonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(`${AAD_PREFIX}${purpose}:${challengeId}`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(otp, 'utf8'), cipher.final()]);
    return { keyId: key.id, ciphertext, nonce, authTag: cipher.getAuthTag() };
}

function decryptOtp(job: OutboxJob, keys: Key[]): string {
    const key = keys.find((candidate) => candidate.id === job.key_id);
    if (!key) throw new Error('Recovery OTP outbox key id is unavailable');
    const aadValues = [`${AAD_PREFIX}${job.purpose}:${job.challenge_id}`];
    // Migration 084 renames/generalizes the table without rewriting 083
    // ciphertext. Continue opening legacy recovery envelopes until their
    // short challenge TTL and queue retention have drained.
    if (job.purpose === 'student_account_recovery') aadValues.push(`${LEGACY_RECOVERY_AAD_PREFIX}${job.challenge_id}`);
    for (const aad of aadValues) {
        try {
            const decipher = createDecipheriv('aes-256-gcm', key.value, job.nonce, { authTagLength: 16 });
            decipher.setAAD(Buffer.from(aad, 'utf8'));
            decipher.setAuthTag(job.auth_tag);
            const value = Buffer.concat([decipher.update(job.ciphertext), decipher.final()]).toString('utf8');
            if (/^\d{6}$/.test(value)) return value;
        } catch { /* try only the explicitly supported migration-era AAD */ }
    }
    throw new Error('Recovery OTP outbox payload is invalid');
}

/**
 * Must be called inside the transaction that creates the purpose-bound
 * challenge, with that challenge's id and expiry. The outbox row reuses
 * the challenge row's captured created_at instead of clock_timestamp():
 * under database contention the enqueue statement can run arbitrarily
 * later than issuance, and a fresh timestamp would fail the
 * expires_at > created_at check on a nearly-lapsed deadline. Carrying
 * the issue timestamp satisfies the constraint by construction, since
 * the challenge insert already proved created_at < expires_at. A
 * missing challenge row fails loudly on the NOT NULL column.
 */
export async function enqueueStudentOtp(tx: Pick<PoolClient, 'query'>, input: { purpose: StudentOtpPurpose; challengeId: string; otp: string; expiresAt: Date; encryptionKey: string }): Promise<void> {
    const key = parseKey(input.encryptionKey);
    if (!key) throw new TypeError('Recovery OTP outbox key is unavailable');
    const envelope = encryptOtp(input.purpose, input.challengeId, input.otp, key);
    await tx.query(
        `INSERT INTO student_email_otp_outbox
             (challenge_id, purpose, key_id, ciphertext, nonce, auth_tag, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 (SELECT created_at FROM verification_challenges WHERE id = $1))`,
        [input.challengeId, input.purpose, envelope.keyId, envelope.ciphertext, envelope.nonce, envelope.authTag, input.expiresAt],
    );
}

export async function enqueueRecoveryOtp(tx: Pick<PoolClient, 'query'>, input: Omit<Parameters<typeof enqueueStudentOtp>[1], 'purpose'>): Promise<void> {
    return enqueueStudentOtp(tx, { ...input, purpose: 'student_account_recovery' });
}

type Delivery = (email: string, otp: string, purpose: StudentOtpPurpose) => Promise<{ success: boolean }>;
export type DispatchResult = { sent: number; retried: number; scrubbed: number };

async function claim(pool: Pick<Pool, 'connect'>, challengeIds?: string[]): Promise<OutboxJob[]> {
    const tx = await pool.connect();
    try {
        await tx.query('BEGIN');
        const selected = await tx.query<OutboxJob>(
            `SELECT id, challenge_id, purpose, key_id, ciphertext, nonce, auth_tag, attempts
             FROM student_email_otp_outbox
             WHERE ($2::uuid[] IS NULL OR challenge_id = ANY($2::uuid[]))
               AND expires_at > clock_timestamp()
               AND ((status = 'pending' AND next_attempt_at <= clock_timestamp())
                 OR (status = 'processing' AND lease_until <= clock_timestamp()))
             ORDER BY next_attempt_at, created_at
             FOR UPDATE SKIP LOCKED LIMIT $1`, [BATCH_SIZE, challengeIds ?? null],
        );
        const jobs: OutboxJob[] = [];
        for (const row of selected.rows) {
            const token = randomUUID();
            const result = await tx.query<{ attempts: number }>(
                `UPDATE student_email_otp_outbox
                 SET status = 'processing', claim_token = $2, lease_until = clock_timestamp() + ($3 * interval '1 second'),
                     attempts = attempts + 1
                 WHERE id = $1 RETURNING attempts`, [row.id, token, LEASE_SECONDS],
            );
            if (result.rows[0]) jobs.push({ ...row, claim_token: token, attempts: result.rows[0].attempts });
        }
        await tx.query('COMMIT');
        return jobs;
    } catch (error) { await tx.query('ROLLBACK'); throw error; }
    finally { tx.release(); }
}

async function resolveRecipient(pool: Pick<Pool, 'connect'>, job: OutboxJob): Promise<string | null> {
    const tx = await pool.connect();
    try {
        await tx.query('BEGIN');
        if (job.purpose === 'student_sso_signup') {
            // A signup OTP is deliverable only while its purpose-specific
            // signup, provider handoff, and challenge are all live. This
            // resolver never consults or authorizes recovery state.
            const result = await tx.query<{ email: string; otp_subject_digest: string }>(
                `SELECT lower(btrim(challenge.bindings->>'email')) AS email, challenge.subject_digest AS otp_subject_digest
                 FROM verification_challenges challenge
                 JOIN student_auth_signup_challenges signup ON signup.mailbox_challenge_id = challenge.id
                 JOIN student_auth_link_handoffs handoff ON handoff.id = signup.handoff_id
                 JOIN student_auth_attempts attempt ON attempt.id = handoff.attempt_id
                 WHERE challenge.id = $1 AND challenge.purpose = 'student_sso_signup'
                   AND challenge.consumed_at IS NULL AND challenge.superseded_at IS NULL
                   AND challenge.purged_at IS NULL AND challenge.expires_at > clock_timestamp()
                   AND signup.status = 'pending' AND signup.terminal_at IS NULL AND signup.expires_at > clock_timestamp()
                   AND handoff.consumed_at IS NULL AND handoff.expires_at > clock_timestamp()
                   AND lower(btrim(challenge.bindings->>'email')) = lower(btrim(attempt.requested_email))`,
                [job.challenge_id],
            );
            const row = result.rows[0];
            await tx.query('COMMIT');
            if (!row) return null;
            return row.otp_subject_digest === challengeSubjectDigest('student_sso_signup', row.email) ? row.email : null;
        }
        // Match recovery's attempt -> challenge order. The user/account state
        // and current mailbox binding are rechecked immediately before send.
        const result = await tx.query<{ email: string; otp_subject_digest: string }>(
            `SELECT u.email, c.subject_digest AS otp_subject_digest
             FROM student_auth_recovery_attempts a
             JOIN users u ON u.id = a.user_id
             JOIN students s ON s.user_id = u.id
             JOIN student_auth_recovery_codes r ON r.user_id = a.user_id
             JOIN verification_challenges c ON c.id = a.mailbox_challenge_id
             WHERE a.mailbox_challenge_id = $1 AND a.status = 'pending'
               AND a.expires_at > clock_timestamp()
               AND u.deleted_at IS NULL AND s.status = 'active'
               AND a.credential_generation = u.credential_generation
               AND r.status = 'active' AND r.generation = a.recovery_code_generation
               AND c.purpose = 'student_account_recovery'
               AND c.consumed_at IS NULL AND c.superseded_at IS NULL
               AND c.purged_at IS NULL AND c.expires_at > clock_timestamp()
             ORDER BY a.created_at DESC LIMIT 1`,
            [job.challenge_id],
        );
        const row = result.rows[0];
        if (!row) { await tx.query('COMMIT'); return null; }
        // This keyed digest is calculated by the challenge module from the
        // deployment JWT key; doing it in application code avoids exposing a
        // normalized mailbox in the outbox schema.
        const expected = challengeSubjectDigest('student_account_recovery', row.email);
        await tx.query('COMMIT');
        return row.otp_subject_digest === expected ? row.email : null;
    } catch (error) { await tx.query('ROLLBACK'); throw error; }
    finally { tx.release(); }
}

async function settle(pool: Pick<Pool, 'connect'>, job: OutboxJob, state: 'sent' | 'retry' | 'cancelled' | 'failed'): Promise<void> {
    const tx = await pool.connect();
    try {
        await tx.query('BEGIN');
        if (state === 'retry' && job.attempts < MAX_ATTEMPTS) {
            const delaySeconds = Math.min(300, 5 * (2 ** Math.min(job.attempts - 1, 6)));
            await tx.query(
                `UPDATE student_email_otp_outbox
                 SET status = 'pending', next_attempt_at = clock_timestamp() + ($3 * interval '1 second'), lease_until = NULL, claim_token = NULL
                 WHERE id = $1 AND status = 'processing' AND claim_token = $2`, [job.id, job.claim_token, delaySeconds],
            );
        } else {
            const terminal = state === 'sent' ? 'sent' : state === 'cancelled' ? 'cancelled'
                : state === 'failed' || (state === 'retry' && job.attempts >= MAX_ATTEMPTS) ? 'failed' : 'expired';
            if (terminal === 'failed' && job.purpose === 'student_account_recovery') {
                // Keep the recovery lock order: attempts, challenge, then
                // outbox. A concurrent start holds attempts before inserting
                // a job; reversing this order here could deadlock at exhaustion.
                await tx.query(
                    `SELECT id FROM student_auth_recovery_attempts WHERE mailbox_challenge_id = $1 AND status = 'pending' FOR UPDATE`, [job.challenge_id],
                );
                await tx.query(
                    `SELECT id FROM verification_challenges WHERE id = $1 FOR UPDATE`, [job.challenge_id],
                );
            } else if (terminal === 'failed' && job.purpose === 'student_sso_signup') {
                // Signup issuance locks the signup row, then its OTP
                // challenge, then inserts the outbox row. Preserve that
                // order at retry exhaustion so the bound-but-undeliverable
                // OTP cannot remain advertised as a resumable challenge.
                await tx.query(
                    `SELECT id FROM student_auth_signup_challenges
                     WHERE mailbox_challenge_id = $1 AND status = 'pending' FOR UPDATE`, [job.challenge_id],
                );
                await tx.query(
                    `SELECT id FROM verification_challenges WHERE id = $1 FOR UPDATE`, [job.challenge_id],
                );
            }
            const settled = await tx.query(
                `UPDATE student_email_otp_outbox
                 SET status = $3, ciphertext = NULL, nonce = NULL, auth_tag = NULL, key_id = NULL,
                     sent_at = CASE WHEN $3 = 'sent' THEN clock_timestamp() ELSE NULL END,
                     terminal_at = clock_timestamp(), lease_until = NULL, claim_token = NULL
                 WHERE id = $1 AND status = 'processing' AND claim_token = $2`, [job.id, job.claim_token, terminal],
            );
            // Only the lease holder terminalizes: a zero-row update means
            // the lease lapsed and another worker reclaimed the job, and
            // that claimant owns its retry and terminalization. Settling
            // the attempt and challenge here would burn the replacement
            // delivery the new holder is about to make.
            const holdsLease = (settled.rowCount ?? 0) === 1;
            if (holdsLease && terminal === 'failed' && job.purpose === 'student_account_recovery') {
                // Exhausted ambiguous delivery leaves no usable cooldown
                // handle. Terminalize the active owner and challenge after
                // the ordered locks taken above.
                await tx.query(
                    `UPDATE student_auth_recovery_attempts SET status = 'failed', secret_hash = NULL, idempotency_key = NULL
                     WHERE mailbox_challenge_id = $1 AND status = 'pending'`, [job.challenge_id],
                );
                await tx.query(
                    `UPDATE verification_challenges SET superseded_at = clock_timestamp()
                     WHERE id = $1 AND consumed_at IS NULL AND superseded_at IS NULL`, [job.challenge_id],
                );
            } else if (holdsLease && terminal === 'failed' && job.purpose === 'student_sso_signup') {
                await tx.query(
                    `UPDATE student_auth_signup_challenges
                     SET status = 'cancelled', terminal_at = clock_timestamp(), secret_hash = NULL, browser_binding_hash = NULL
                     WHERE mailbox_challenge_id = $1 AND status = 'pending'`, [job.challenge_id],
                );
                await tx.query(
                    `UPDATE verification_challenges SET superseded_at = clock_timestamp()
                     WHERE id = $1 AND consumed_at IS NULL AND superseded_at IS NULL`, [job.challenge_id],
                );
            }
        }
        await tx.query('COMMIT');
    } catch (error) { await tx.query('ROLLBACK'); throw error; }
    finally { tx.release(); }
}

export async function dispatchRecoveryOtpOutboxBatch(
    pool: Pick<Pool, 'connect'>,
    encryptionKey: string,
    deliver: Delivery,
    previousEncryptionKey?: string | null,
    challengeIds?: string[],
    deliverTimeoutMs: number = DELIVERY_TIMEOUT_MS,
): Promise<DispatchResult> {
    const current = parseKey(encryptionKey);
    if (!current) throw new TypeError('Recovery OTP outbox key is unavailable');
    const previous = parseKey(previousEncryptionKey);
    const jobs = await claim(pool, challengeIds);
    const result: DispatchResult = { sent: 0, retried: 0, scrubbed: 0 };
    for (const job of jobs) {
        const email = await resolveRecipient(pool, job);
        if (job.attempts > MAX_ATTEMPTS || !email) {
            await settle(pool, job, job.attempts > MAX_ATTEMPTS ? 'failed' : 'cancelled');
            result.scrubbed++;
            continue;
        }
        const availableKeys = previous ? [current, previous] : [current];
        if (!availableKeys.some((key) => key.id === job.key_id)) {
            // A rolling key rotation may briefly omit the decrypt-only key.
            // Preserve ciphertext and retry until the challenge deadline;
            // never destroy recoverable work because configuration lagged.
            const tx = await pool.connect();
            try {
                await tx.query(
                    `UPDATE student_email_otp_outbox
                     SET status = 'pending', attempts = GREATEST(attempts - 1, 0),
                         next_attempt_at = clock_timestamp() + interval '30 seconds',
                         lease_until = NULL, claim_token = NULL
                     WHERE id = $1 AND status = 'processing' AND claim_token = $2`, [job.id, job.claim_token],
                );
            } finally { tx.release(); }
            result.retried++;
            continue;
        }
        let otp: string;
        try { otp = decryptOtp(job, availableKeys); }
        catch {
            await settle(pool, job, 'failed');
            result.scrubbed++;
            continue;
        }
        // The batch claims every lease up front but delivers sequentially
        // with up to 30s per job: renew this job's lease immediately
        // before its own delivery so a slow batch cannot send on an
        // expired lease another worker already reclaimed. A lost race
        // skips the job silently — the new holder owns its outcome.
        if (!await renewOutboxLease(pool, job)) continue;
        try {
            const sent = await deliverWithTimeout(deliver, email, otp, job.purpose, deliverTimeoutMs);
            if (sent.success) { await settle(pool, job, 'sent'); result.sent++; }
            else {
                await settle(pool, job, 'retry');
                if (job.attempts >= MAX_ATTEMPTS) result.scrubbed++;
                else result.retried++;
            }
        } catch {
            await settle(pool, job, 'retry');
            if (job.attempts >= MAX_ATTEMPTS) result.scrubbed++;
            else result.retried++;
        } finally {
            otp = '';
        }
    }
    result.scrubbed += await purgeRecoveryOtpOutbox(pool);
    return result;
}

/**
 * Extend a claimed job's lease just before its delivery. The
 * claim-token compare-and-swap reports a lost race: another worker
 * reclaimed the expired lease and owns the job, so the caller skips it
 * instead of double-sending on a stale claim.
 */
async function renewOutboxLease(pool: Pick<Pool, 'connect'>, job: OutboxJob): Promise<boolean> {
    const tx = await pool.connect();
    try {
        const renewed = await tx.query(
            `UPDATE student_email_otp_outbox
             SET lease_until = clock_timestamp() + ($3 * interval '1 second')
             WHERE id = $1 AND status = 'processing' AND claim_token = $2`,
            [job.id, job.claim_token, LEASE_SECONDS],
        );
        return (renewed.rowCount ?? 0) === 1;
    } finally { tx.release(); }
}

/**
 * Bound one provider delivery well inside the 90s claim lease: a mail
 * promise that never settles must time out into the ordinary retry path
 * instead of wedging the batch — and the dispatcher's running flag —
 * forever. A late provider success after the timeout can double-send on
 * retry, the same ambiguity ordinary redelivery already accepts.
 */
async function deliverWithTimeout(deliver: Delivery, email: string, otp: string, purpose: StudentOtpPurpose, timeoutMs: number): Promise<{ success: boolean }> {
    const pending = deliver(email, otp, purpose);
    // A timeout leaves the provider promise dangling: a late failure
    // must not surface as an unhandled rejection once nobody awaits it.
    pending.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            pending,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('Recovery OTP delivery timed out')), timeoutMs);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/** Expiry and tombstone pruning also run from the retention dispatcher. */
export async function purgeRecoveryOtpOutbox(pool: Pick<Pool, 'connect'>): Promise<number> {
    const tx = await pool.connect();
    try {
        await tx.query('BEGIN');
        const expired = await tx.query(
            `UPDATE student_email_otp_outbox
             SET status = 'expired', ciphertext = NULL, nonce = NULL, auth_tag = NULL, key_id = NULL,
                 terminal_at = clock_timestamp(), lease_until = NULL, claim_token = NULL
             WHERE id IN (SELECT id FROM student_email_otp_outbox
                          WHERE status IN ('pending', 'processing') AND expires_at <= clock_timestamp()
                          ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT 500)`
        );
        await tx.query(`DELETE FROM student_email_otp_outbox
                        WHERE terminal_at < clock_timestamp() - ($1 * interval '1 hour')
                        AND id IN (SELECT id FROM student_email_otp_outbox
                                   WHERE terminal_at < clock_timestamp() - ($1 * interval '1 hour')
                                   ORDER BY terminal_at FOR UPDATE SKIP LOCKED LIMIT 500)`, [RETENTION_HOURS]);
        await tx.query('COMMIT');
        return expired.rowCount ?? 0;
    } catch (error) { await tx.query('ROLLBACK'); throw error; }
    finally { tx.release(); }
}

export function startRecoveryOtpOutboxDispatcher(input: { pool: Pick<Pool, 'connect'>; key: string; previousKey?: string | null; deliver: Delivery; intervalMs?: number; deliverTimeoutMs?: number }): void {
    if (!hasRecoveryOtpOutboxKey(input.key)) throw new TypeError('Recovery OTP outbox key is unavailable');
    if (input.previousKey) parseKey(input.previousKey);
    let running = false;
    const run = async () => {
        if (running) return;
        running = true;
        try { await runRecoveryOtpOutboxDispatcherTick(input); }
        finally { running = false; }
    };
    void run();
    setInterval(() => void run(), input.intervalMs ?? 5_000).unref();
}

export async function runRecoveryOtpOutboxDispatcherTick(input: { pool: Pick<Pool, 'connect'>; key: string; previousKey?: string | null; deliver: Delivery; deliverTimeoutMs?: number }): Promise<void> {
    try { await dispatchRecoveryOtpOutboxBatch(input.pool, input.key, input.deliver, input.previousKey, undefined, input.deliverTimeoutMs ?? DELIVERY_TIMEOUT_MS); }
    catch {
        // Provider/database errors can contain message payloads or OTPs; emit only a fixed operational signal.
        console.error('Recovery OTP outbox dispatch failed');
    }
}
