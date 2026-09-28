import type { Pool } from 'pg';
import { db } from '../../config/database.js';
import { appLogger } from '../../common/logger.js';

/** Expired challenge payloads are scrubbed at most 24 hours after expiry, plus dispatcher lag.
 * Passwordless signup OTPs have the stricter one-hour secret bound; recovery
 * OTPs scrub at expiry. Signup bindings additionally survive their OTP
 * deadline: completion runs against the longer-lived handoff and still
 * needs bindings.email.
 * Scrubbed tombstones and stale budgets are then deleted, so the tables
 * stay bounded under rotating unauthenticated subjects: tombstones older
 * than 24 hours with no referencing row (budget pointer, email proof,
 * evidence, signup or recovery attempt) are removed, as are budgets with
 * no live challenge pointer and a window older than 24 hours. Tombstone
 * IDs referenced by immutable evidence FKs are kept; no names, email, or
 * OTP digests remain on any tombstone. A deleted budget is equivalent to
 * a post-reset one: the next request recreates it via upsert with a fresh
 * window, and the 60-second resend cooldown lapsed long before.
 */
export async function purgeExpiredChallenges(pool: Pick<Pool, 'connect'>): Promise<number> {
    const tx = await pool.connect();
    try {
        await tx.query('BEGIN');
        // Pointer clearing and scrubbing derive from one selected ID set:
        // two independently capped batches could otherwise scrub a
        // challenge its budget still points to, stranding the pair
        // forever (later passes exclude purged rows, and deletion refuses
        // referenced ones). Challenge issuance locks budgets before
        // challenges; the pointer update precedes the row locks to
        // preserve that order, and the scrub yields with SKIP LOCKED to
        // concurrent issuance and consumption. A skipped challenge keeps
        // purged_at NULL and is re-selected next pass, so yielding here
        // cannot strand anything.
        await tx.query('CREATE TEMPORARY TABLE purge_expired_challenges (id uuid PRIMARY KEY) ON COMMIT DROP');
        await tx.query(`INSERT INTO purge_expired_challenges
            SELECT id FROM verification_challenges
            WHERE purged_at IS NULL AND (
                expires_at < clock_timestamp() - interval '24 hours'
                OR (purpose = 'student_account_recovery'
                    AND expires_at <= clock_timestamp())
                OR (purpose = 'student_sso_signup'
                    AND expires_at <= clock_timestamp() - interval '1 hour')
            )
            ORDER BY expires_at LIMIT 500`);
        await tx.query(`UPDATE verification_challenge_budgets b SET current_challenge_id = NULL
            FROM purge_expired_challenges e WHERE b.current_challenge_id = e.id`);
        const result = await tx.query(`WITH lockable AS (
            SELECT c.id FROM verification_challenges c
            JOIN purge_expired_challenges e ON e.id = c.id
            ORDER BY c.expires_at FOR UPDATE OF c SKIP LOCKED
        ) UPDATE verification_challenges c
          SET bindings = '{}'::jsonb, secret_digest = repeat('0', 64),
              subject_digest = repeat('0', 64), purged_at = clock_timestamp()
          FROM lockable l WHERE c.id = l.id`);
        // Lifecycle deletion, budget-first like issuance: stale budgets
        // with no live challenge pointer, then tombstones nothing
        // references. Issuance only ever points budgets at newly inserted
        // challenges and consumes only unexpired ones, so neither delete
        // can strand a live flow; SKIP LOCKED yields to concurrent
        // issuance and consumption.
        await tx.query(`WITH stale AS (
            SELECT purpose, subject_digest FROM verification_challenge_budgets
            WHERE current_challenge_id IS NULL
              AND window_started_at < clock_timestamp() - interval '24 hours'
            ORDER BY window_started_at FOR UPDATE SKIP LOCKED LIMIT 500
        ) DELETE FROM verification_challenge_budgets b
          USING stale s WHERE b.purpose = s.purpose AND b.subject_digest = s.subject_digest`);
        await tx.query(`WITH dead AS (
            SELECT c.id FROM verification_challenges c
            WHERE c.purged_at IS NOT NULL
              AND c.purged_at < clock_timestamp() - interval '24 hours'
              AND NOT EXISTS (SELECT 1 FROM verification_challenge_budgets b WHERE b.current_challenge_id = c.id)
              AND NOT EXISTS (SELECT 1 FROM user_email_proofs p WHERE p.challenge_id = c.id)
              AND NOT EXISTS (SELECT 1 FROM eligibility_evidence e WHERE e.challenge_id = c.id)
              AND NOT EXISTS (SELECT 1 FROM student_auth_signup_challenges s WHERE s.mailbox_challenge_id = c.id)
              AND NOT EXISTS (SELECT 1 FROM student_auth_recovery_attempts a WHERE a.mailbox_challenge_id = c.id)
            ORDER BY c.purged_at FOR UPDATE OF c SKIP LOCKED LIMIT 500
        ) DELETE FROM verification_challenges c USING dead d WHERE c.id = d.id`);
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
