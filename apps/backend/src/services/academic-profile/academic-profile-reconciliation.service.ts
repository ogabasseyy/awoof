/**
 * Academic Profile Restore Reconciliation Service
 *
 * Reconciles live PostgreSQL state against the durable host JSONL deletion
 * ledger after a database backup restoration.
 *
 * When restoring a historical pg_dump, any academic profiles erased between
 * the dump timestamp and the restore point are restored into the live tables.
 * This service identifies and re-purges those stale restored generations
 * while preserving legitimate newly recreated profiles that carry a distinct
 * generation_id.
 */

import type { Pool } from 'pg';
import {
    readDurableLedgerEntries,
    type AcademicProfileLedgerEntry,
} from './academic-profile-ledger.service.js';

export const ACADEMIC_PROFILE_RECONCILIATION_LOCK_ID = 2026101802;

export type ReconciliationOptions = {
    ledgerFilePath?: string | undefined;
    requireLedgerFile?: boolean | undefined;
    dryRun?: boolean | undefined;
};

export type ReconciliationSummary = {
    ledgerEntriesRead: number;
    staleGenerationsPurged: number;
    recreatedGenerationsPreserved: number;
    dbLedgerEntriesRestored: number;
    dryRun: boolean;
    reconciledAt: string;
};

/**
 * Reconcile restored database data against the authoritative host deletion ledger.
 * Fails closed if the ledger is corrupted, unreadable, or missing when required.
 */
export async function reconcileRestoredAcademicProfiles(
    pool: Pick<Pool, 'connect'>,
    options: ReconciliationOptions = {},
): Promise<ReconciliationSummary> {
    const client = await pool.connect();
    let acquiredLock = false;

    try {
        const lockResult = await client.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_lock($1) AS locked',
            [ACADEMIC_PROFILE_RECONCILIATION_LOCK_ID],
        );
        const locked = lockResult.rows[0]?.locked;
        if (locked === false) {
            throw new Error('Academic profile restore reconciliation is already in progress by another worker');
        }
        acquiredLock = locked === true;

        const entries: AcademicProfileLedgerEntry[] = readDurableLedgerEntries(options.ledgerFilePath);
        if (options.requireLedgerFile && entries.length === 0) {
            throw new Error('Durable deletion ledger contains no entries or file is missing');
        }

        let staleGenerationsPurged = 0;
        let recreatedGenerationsPreserved = 0;
        let dbLedgerEntriesRestored = 0;

        for (const entry of entries) {
            const profileRes = await client.query<{ generation_id: string }>(
                `SELECT generation_id FROM student_academic_profiles WHERE user_id = $1 FOR UPDATE`,
                [entry.userId],
            );
            const liveProfile = profileRes.rows[0];

            if (liveProfile) {
                if (liveProfile.generation_id === entry.generationId) {
                    // Stale generation restored from backup: must be purged.
                    if (!options.dryRun) {
                        await client.query(
                            `DELETE FROM student_academic_profiles WHERE user_id = $1 AND generation_id = $2`,
                            [entry.userId, entry.generationId],
                        );
                    }
                    staleGenerationsPurged += 1;
                } else {
                    // Legitimate new recreation carrying a distinct generation_id: preserved.
                    recreatedGenerationsPreserved += 1;
                }
            }

            // Ensure database ledger table also reflects the erasure tombstone
            const dbLedgerRes = await client.query<{ id: string }>(
                `SELECT id FROM academic_profile_deletion_ledger WHERE user_id = $1 AND generation_id = $2 LIMIT 1`,
                [entry.userId, entry.generationId],
            );

            if (dbLedgerRes.rows.length === 0) {
                if (!options.dryRun) {
                    await client.query(
                        `INSERT INTO academic_profile_deletion_ledger (user_id, generation_id, scope, erased_at)
                         VALUES ($1, $2, $3, $4::timestamptz)`,
                        [entry.userId, entry.generationId, entry.scope, entry.erasedAt],
                    );
                }
                dbLedgerEntriesRestored += 1;
            }
        }

        return {
            ledgerEntriesRead: entries.length,
            staleGenerationsPurged,
            recreatedGenerationsPreserved,
            dbLedgerEntriesRestored,
            dryRun: options.dryRun ?? false,
            reconciledAt: new Date().toISOString(),
        };
    } finally {
        if (acquiredLock) {
            await client.query('SELECT pg_advisory_unlock($1)', [ACADEMIC_PROFILE_RECONCILIATION_LOCK_ID]).catch(() => undefined);
        }
        client.release();
    }
}
