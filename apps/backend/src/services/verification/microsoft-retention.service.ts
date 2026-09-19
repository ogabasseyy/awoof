import type { Pool } from 'pg';

export const MICROSOFT_RETENTION_BATCH_SIZE = 500;
export const MICROSOFT_DIAGNOSTIC_RETENTION_DAYS = 30;

export type MicrosoftRetentionResult = {
    attempts: number;
    diagnostics: number;
};

export type MicrosoftRetentionDependencies = {
    pool: Pick<Pool, 'connect'>;
};

/**
 * Scrubs only retry/callback material. Attempt, email, merchant, proof, and
 * audit rows stay in place so durable provenance and tombstone protections
 * remain enforceable. A completed receipt stays available through its original
 * expiration deadline; no caller supplies that deadline.
 */
export class MicrosoftRetentionService {
    constructor(private readonly deps: MicrosoftRetentionDependencies) {}

    async cleanup(): Promise<MicrosoftRetentionResult> {
        const tx = await this.deps.pool.connect();
        try {
            await tx.query('BEGIN');
            // Attempt expiries and diagnostic timestamps are written with
            // PostgreSQL clock_timestamp(), so the cutoff must come from the
            // same database clock. An application-host clock running ahead
            // would terminalize live attempts and delete diagnostics early,
            // which matters because the cleanup CLI can run on a separate
            // operational host.
            const cutoff = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
            const attempts = await tx.query(
                `WITH candidates AS (
                    SELECT id, status, expires_at
                    FROM microsoft_verification_attempts
                    WHERE (
                        status IN ('pending', 'processing', 'ready') AND expires_at <= $1::timestamptz
                    ) OR (
                        status = 'failed' AND (
                            state_hash IS NOT NULL OR browser_secret_hash IS NOT NULL OR finish_secret_hash IS NOT NULL
                            OR encrypted_verifier IS NOT NULL OR nonce IS NOT NULL OR result IS NOT NULL
                        )
                    ) OR (
                        status = 'completed' AND (
                            state_hash IS NOT NULL OR browser_secret_hash IS NOT NULL
                            OR encrypted_verifier IS NOT NULL OR nonce IS NOT NULL
                            OR (expires_at <= $1::timestamptz AND (finish_secret_hash IS NOT NULL OR result IS NOT NULL))
                        )
                    )
                    ORDER BY expires_at, id
                    FOR UPDATE SKIP LOCKED
                    LIMIT ${MICROSOFT_RETENTION_BATCH_SIZE}
                )
                UPDATE microsoft_verification_attempts attempt
                SET status = CASE WHEN candidate.status IN ('pending', 'processing', 'ready') THEN 'failed' ELSE attempt.status END,
                    state_hash = NULL,
                    browser_secret_hash = NULL,
                    encrypted_verifier = NULL,
                    nonce = NULL,
                    finish_secret_hash = CASE
                        WHEN candidate.status IN ('pending', 'processing', 'ready') OR candidate.status = 'failed'
                            OR candidate.expires_at <= $1::timestamptz THEN NULL
                        ELSE attempt.finish_secret_hash
                    END,
                    result = CASE
                        WHEN candidate.status IN ('pending', 'processing', 'ready') OR candidate.status = 'failed'
                            OR candidate.expires_at <= $1::timestamptz THEN NULL
                        ELSE attempt.result
                    END
                FROM candidates candidate
                WHERE attempt.id = candidate.id`,
                [cutoff],
            );
            const diagnostics = await tx.query(
                `WITH candidates AS (
                    SELECT id
                    FROM verification_diagnostic_events
                    WHERE recorded_at < $1::timestamptz - interval '${MICROSOFT_DIAGNOSTIC_RETENTION_DAYS} days'
                    ORDER BY recorded_at, id
                    FOR UPDATE SKIP LOCKED
                    LIMIT ${MICROSOFT_RETENTION_BATCH_SIZE}
                )
                DELETE FROM verification_diagnostic_events event
                USING candidates
                WHERE event.id = candidates.id`,
                [cutoff],
            );
            await tx.query('COMMIT');
            return { attempts: attempts.rowCount ?? 0, diagnostics: diagnostics.rowCount ?? 0 };
        } catch (error) {
            await tx.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            tx.release();
        }
    }
}
