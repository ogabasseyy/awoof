import type { Pool } from 'pg';
import { db } from '../../config/database.js';
import { appLogger } from '../../common/logger.js';

/** Expired challenge payloads are retained at most 24 hours, plus dispatcher lag.
 * Keep tombstone IDs for immutable evidence FKs; no names/email/OTP digests remain.
 */
export async function purgeExpiredChallenges(pool: Pick<Pool, 'connect'>): Promise<number> {
    const tx = await pool.connect();
    try {
        await tx.query('BEGIN');
        // Challenge issuance locks budgets before challenges. Preserve that order.
        await tx.query(`WITH expired AS (
            SELECT b.purpose, b.subject_digest FROM verification_challenge_budgets b
            JOIN verification_challenges c ON c.id = b.current_challenge_id
            WHERE c.expires_at < clock_timestamp() - interval '24 hours'
            ORDER BY b.purpose, b.subject_digest FOR UPDATE OF b SKIP LOCKED LIMIT 500
        ) UPDATE verification_challenge_budgets b SET current_challenge_id = NULL
          FROM expired e WHERE b.purpose = e.purpose AND b.subject_digest = e.subject_digest`);
        const result = await tx.query(`WITH expired AS (
            SELECT id FROM verification_challenges
            WHERE expires_at < clock_timestamp() - interval '24 hours' AND purged_at IS NULL
            ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT 500
        ) UPDATE verification_challenges c
          SET bindings = '{}'::jsonb, secret_digest = repeat('0', 64),
              subject_digest = repeat('0', 64), purged_at = clock_timestamp()
          FROM expired e WHERE c.id = e.id`);
        await tx.query('COMMIT');
        return result.rowCount ?? 0;
    } catch (error) { await tx.query('ROLLBACK'); throw error; }
    finally { tx.release(); }
}

export function startChallengeRetentionDispatcher(): void {
    let running = false;
    const run = async () => {
        if (running) return;
        running = true;
        try { await purgeExpiredChallenges(db.getPool()); }
        catch (error) { appLogger.error('Challenge retention cleanup failed', error); }
        finally { running = false; }
    };
    void run();
    setInterval(() => void run(), 60_000).unref();
}
