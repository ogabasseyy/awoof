import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { challengeSubjectDigest } from '../verification/challenge.service.js';

const AAD_PREFIX = 'awoof:student-account-recovery-otp:v1:';
const LEASE_SECONDS = 90;
const MAX_ATTEMPTS = 8;
const RETENTION_HOURS = 24;
const BATCH_SIZE = 20;

type Envelope = { keyId: string; ciphertext: Buffer; nonce: Buffer; authTag: Buffer };
type Key = { id: string; value: Buffer };
type OutboxJob = { id: string; challenge_id: string; key_id: string; ciphertext: Buffer; nonce: Buffer; auth_tag: Buffer; claim_token: string; attempts: number };

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

function encryptOtp(challengeId: string, otp: string, key: Key): Envelope {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key.value, nonce);
    cipher.setAAD(Buffer.from(`${AAD_PREFIX}${challengeId}`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(otp, 'utf8'), cipher.final()]);
    return { keyId: key.id, ciphertext, nonce, authTag: cipher.getAuthTag() };
}

function decryptOtp(job: OutboxJob, keys: Key[]): string {
    const key = keys.find((candidate) => candidate.id === job.key_id);
    if (!key) throw new Error('Recovery OTP outbox key id is unavailable');
    const decipher = createDecipheriv('aes-256-gcm', key.value, job.nonce);
    decipher.setAAD(Buffer.from(`${AAD_PREFIX}${job.challenge_id}`, 'utf8'));
    decipher.setAuthTag(job.auth_tag);
    const value = Buffer.concat([decipher.update(job.ciphertext), decipher.final()]).toString('utf8');
    if (!/^\d{6}$/.test(value)) throw new Error('Recovery OTP outbox payload is invalid');
    return value;
}

/** Must be called inside the transaction that creates the recovery attempt/challenge. */
export async function enqueueRecoveryOtp(tx: Pick<PoolClient, 'query'>, input: { challengeId: string; otp: string; expiresAt: Date; encryptionKey: string }): Promise<void> {
    const key = parseKey(input.encryptionKey);
    if (!key) throw new TypeError('Recovery OTP outbox key is unavailable');
    const envelope = encryptOtp(input.challengeId, input.otp, key);
    await tx.query(
        `INSERT INTO student_account_recovery_otp_outbox
             (challenge_id, key_id, ciphertext, nonce, auth_tag, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.challengeId, envelope.keyId, envelope.ciphertext, envelope.nonce, envelope.authTag, input.expiresAt],
    );
}

type Delivery = (email: string, otp: string) => Promise<{ success: boolean }>;
export type DispatchResult = { sent: number; retried: number; scrubbed: number };

async function claim(pool: Pick<Pool, 'connect'>, challengeIds?: string[]): Promise<OutboxJob[]> {
    const tx = await pool.connect();
    try {
        await tx.query('BEGIN');
        const selected = await tx.query<OutboxJob>(
            `SELECT id, challenge_id, key_id, ciphertext, nonce, auth_tag, attempts
             FROM student_account_recovery_otp_outbox
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
                `UPDATE student_account_recovery_otp_outbox
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
                `UPDATE student_account_recovery_otp_outbox
                 SET status = 'pending', next_attempt_at = clock_timestamp() + ($3 * interval '1 second'), lease_until = NULL, claim_token = NULL
                 WHERE id = $1 AND status = 'processing' AND claim_token = $2`, [job.id, job.claim_token, delaySeconds],
            );
        } else {
            const terminal = state === 'sent' ? 'sent' : state === 'cancelled' ? 'cancelled'
                : state === 'failed' || (state === 'retry' && job.attempts >= MAX_ATTEMPTS) ? 'failed' : 'expired';
            if (terminal === 'failed') {
                // Keep the recovery lock order: attempts, challenge, then
                // outbox. A concurrent start holds attempts before inserting
                // a job; reversing this order here could deadlock at exhaustion.
                await tx.query(
                    `SELECT id FROM student_auth_recovery_attempts WHERE mailbox_challenge_id = $1 AND status = 'pending' FOR UPDATE`, [job.challenge_id],
                );
                await tx.query(
                    `SELECT id FROM verification_challenges WHERE id = $1 FOR UPDATE`, [job.challenge_id],
                );
            }
            await tx.query(
                `UPDATE student_account_recovery_otp_outbox
                 SET status = $3, ciphertext = NULL, nonce = NULL, auth_tag = NULL, key_id = NULL,
                     sent_at = CASE WHEN $3 = 'sent' THEN clock_timestamp() ELSE NULL END,
                     terminal_at = clock_timestamp(), lease_until = NULL, claim_token = NULL
                 WHERE id = $1 AND status = 'processing' AND claim_token = $2`, [job.id, job.claim_token, terminal],
            );
            if (terminal === 'failed') {
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
                    `UPDATE student_account_recovery_otp_outbox
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
        try {
            const sent = await deliver(email, otp);
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

/** Expiry and tombstone pruning also run from the retention dispatcher. */
export async function purgeRecoveryOtpOutbox(pool: Pick<Pool, 'connect'>): Promise<number> {
    const tx = await pool.connect();
    try {
        await tx.query('BEGIN');
        const expired = await tx.query(
            `UPDATE student_account_recovery_otp_outbox
             SET status = 'expired', ciphertext = NULL, nonce = NULL, auth_tag = NULL, key_id = NULL,
                 terminal_at = clock_timestamp(), lease_until = NULL, claim_token = NULL
             WHERE id IN (SELECT id FROM student_account_recovery_otp_outbox
                          WHERE status IN ('pending', 'processing') AND expires_at <= clock_timestamp()
                          ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT 500)`
        );
        await tx.query(`DELETE FROM student_account_recovery_otp_outbox
                        WHERE terminal_at < clock_timestamp() - ($1 * interval '1 hour')
                        AND id IN (SELECT id FROM student_account_recovery_otp_outbox
                                   WHERE terminal_at < clock_timestamp() - ($1 * interval '1 hour')
                                   ORDER BY terminal_at FOR UPDATE SKIP LOCKED LIMIT 500)`, [RETENTION_HOURS]);
        await tx.query('COMMIT');
        return expired.rowCount ?? 0;
    } catch (error) { await tx.query('ROLLBACK'); throw error; }
    finally { tx.release(); }
}

export function startRecoveryOtpOutboxDispatcher(input: { pool: Pick<Pool, 'connect'>; key: string; previousKey?: string | null; deliver: Delivery; intervalMs?: number }): void {
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

export async function runRecoveryOtpOutboxDispatcherTick(input: { pool: Pick<Pool, 'connect'>; key: string; previousKey?: string | null; deliver: Delivery }): Promise<void> {
    try { await dispatchRecoveryOtpOutboxBatch(input.pool, input.key, input.deliver, input.previousKey); }
    catch {
        // Provider/database errors can contain message payloads or OTPs; emit only a fixed operational signal.
        console.error('Recovery OTP outbox dispatch failed');
    }
}
