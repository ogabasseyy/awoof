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
 *
 * All database work is set-based: one profile lookup, one ledger lookup,
 * one batched delete, and one batched insert for the whole ledger, so
 * startup cost does not grow per-tombstone query round-trips.
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

function entryKey(entry: AcademicProfileLedgerEntry): string {
    return `${entry.userId}|${entry.generationId}`;
}

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

        const requireLedger = options.requireLedgerFile ?? true;
        const entries: AcademicProfileLedgerEntry[] = readDurableLedgerEntries(options.ledgerFilePath);
        if (requireLedger && entries.length === 0) {
            throw new Error('Durable deletion ledger contains no entries or file is missing');
        }

        const userIds = [...new Set(entries.map((entry) => entry.userId))];
        const profileRes = userIds.length === 0
            ? { rows: [] as Array<{ user_id: string; generation_id: string }> }
            : await client.query<{ user_id: string; generation_id: string }>(
                `SELECT user_id, generation_id FROM student_academic_profiles WHERE user_id = ANY($1::uuid[]) FOR UPDATE`,
                [userIds],
            );
        const liveByUser = new Map(profileRes.rows.map((row) => [row.user_id, row.generation_id]));

        const dbLedgerRes = userIds.length === 0
            ? { rows: [] as Array<{ user_id: string; generation_id: string }> }
            : await client.query<{ user_id: string; generation_id: string }>(
                `SELECT user_id, generation_id FROM academic_profile_deletion_ledger WHERE user_id = ANY($1::uuid[])`,
                [userIds],
            );
        const dbKeys = new Set(dbLedgerRes.rows.map((row) => `${row.user_id}|${row.generation_id}`));

        const stale = entries.filter((entry) => liveByUser.get(entry.userId) === entry.generationId);
        const recreatedGenerationsPreserved = entries.filter(
            (entry) => liveByUser.has(entry.userId) && liveByUser.get(entry.userId) !== entry.generationId,
        ).length;
        const missingDb = entries.filter((entry) => !dbKeys.has(entryKey(entry)));

        if (!options.dryRun && stale.length > 0) {
            await client.query(
                `DELETE FROM student_academic_profiles sap
                 USING (SELECT UNNEST($1::uuid[]) AS user_id, UNNEST($2::uuid[]) AS generation_id) AS stale
                 WHERE sap.user_id = stale.user_id AND sap.generation_id = stale.generation_id`,
                [stale.map((entry) => entry.userId), stale.map((entry) => entry.generationId)],
            );
        }
        if (!options.dryRun && missingDb.length > 0) {
            await client.query(
                `INSERT INTO academic_profile_deletion_ledger (user_id, generation_id, scope, erased_at)
                 SELECT UNNEST($1::uuid[]), UNNEST($2::uuid[]), UNNEST($3::text[]), UNNEST($4::timestamptz[])`,
                [
                    missingDb.map((entry) => entry.userId),
                    missingDb.map((entry) => entry.generationId),
                    missingDb.map((entry) => entry.scope),
                    missingDb.map((entry) => entry.erasedAt),
                ],
            );
        }

        return {
            ledgerEntriesRead: entries.length,
            staleGenerationsPurged: stale.length,
            recreatedGenerationsPreserved,
            dbLedgerEntriesRestored: missingDb.length,
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
