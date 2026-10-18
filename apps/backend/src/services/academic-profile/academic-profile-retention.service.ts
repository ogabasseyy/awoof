/**
 * Academic Profile Retention Service
 *
 * Narrow, authorized erasure for academic-profile rows belonging to
 * soft-deleted accounts. The retention window comes from exactly one
 * owner/legal-approved positive day value
 * (`ACADEMIC_PROFILE_RETENTION_DAYS`); no duration is invented here. An
 * unset or invalid window fails closed: the purge refuses to run and
 * collection stays disabled (see `isAcademicProfileCollectionEnabled`).
 *
 * The purge deletes due academic rows only — user and student rows are left
 * for the account lifecycle owner — and records minimal counts/outcomes,
 * never deleted values. It is idempotent, so a transient failure is
 * recovered by rerunning it through the operational schedule.
 */

import type { Pool } from 'pg';
import { recordDeletionInDatabase, appendDurableLedgerEntry } from './academic-profile-ledger.service.js';

export const ACADEMIC_PROFILE_RETENTION_ENV_VAR = 'ACADEMIC_PROFILE_RETENTION_DAYS';
export const ACADEMIC_PROFILE_PURGE_LOCK_ID = 2026101801;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DATE_MS = 8_640_000_000_000_000;

export type PurgeOptions = {
    dryRun?: boolean | undefined;
    batchSize?: number | undefined;
    ledgerFilePath?: string | undefined;
    useAdvisoryLock?: boolean | undefined;
};

export type PurgeSummary = {
    deletedProfiles: number;
    cutoff: string;
    dryRun?: boolean;
    scannedProfiles?: number;
    batchesProcessed?: number;
    skippedDueToLock?: boolean;
};

/**
 * A retention window is usable only when it is a positive integer and the
 * resulting cutoff stays inside JavaScript's valid date range. This is a
 * representability check, not a policy duration: no approved window is
 * invented or narrowed here.
 */
export function retentionWindowProducesValidCutoff(days: number, now: Date): boolean {
    if (typeof days !== 'number' || !Number.isInteger(days) || days <= 0) return false;
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return false;
    const cutoffMs = now.getTime() - days * DAY_MS;
    return Number.isFinite(cutoffMs) && Math.abs(cutoffMs) <= MAX_DATE_MS;
}

/**
 * Resolve the single approved retention window. Unset fails closed with a
 * not-configured error; anything that is not a strictly positive integer
 * fails closed as invalid. No default duration is assumed.
 */
export function resolveAcademicProfileRetentionDays(value: unknown): number {
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
        throw new Error(`Academic profile retention is not configured: set ${ACADEMIC_PROFILE_RETENTION_ENV_VAR} to an approved positive value`);
    }
    // Mirror the startup schema exactly: it validates the raw string, so
    // whitespace-padded values like ' 30 ' are invalid there and must be
    // invalid here too, or the purge CLI would delete rows on a value the
    // application itself rejects.
    if (typeof value === 'string' && !/^\d+$/.test(value)) {
        throw new Error(`Academic profile retention must be a positive integer number of days (${ACADEMIC_PROFILE_RETENTION_ENV_VAR})`);
    }
    const days = typeof value === 'string' ? Number(value) : value;
    if (typeof days !== 'number' || !Number.isInteger(days) || days <= 0) {
        throw new Error(`Academic profile retention must be a positive integer number of days (${ACADEMIC_PROFILE_RETENTION_ENV_VAR})`);
    }
    return days;
}

/**
 * Delete academic-profile rows whose accounts were soft-deleted at or before
 * the retention cutoff. Returns counts only. Soft-deleted accounts without
 * academic rows contribute nothing; active and recently deleted accounts are
 * untouched.
 */
export async function purgeSoftDeletedAcademicProfiles(
    pool: Pick<Pool, 'connect'>,
    retentionDays: number,
    options?: PurgeOptions,
): Promise<PurgeSummary> {
    const days = resolveAcademicProfileRetentionDays(retentionDays);
    const client = await pool.connect();
    let acquiredLock = false;
    try {
        if (options?.useAdvisoryLock) {
            const lockResult = await client.query<{ locked: boolean }>(
                'SELECT pg_try_advisory_lock($1) AS locked',
                [ACADEMIC_PROFILE_PURGE_LOCK_ID],
            );
            const locked = lockResult.rows[0]?.locked;
            if (locked === false) {
                return {
                    deletedProfiles: 0,
                    cutoff: new Date().toISOString(),
                    skippedDueToLock: true,
                };
            }
            acquiredLock = locked === true;
        }

        // deleted_at is written from PostgreSQL timestamps: deriving the
        // cutoff from the database clock on this same connection means a
        // scheduler host running ahead can never delete rows early.
        const clock = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
        const dbNow = clock.rows[0]?.now;
        if (!(dbNow instanceof Date) || Number.isNaN(dbNow.getTime())) {
            throw new Error('Academic profile purge requires a valid database clock reading');
        }
        const cutoff = new Date(dbNow.getTime() - days * DAY_MS);
        if (!retentionWindowProducesValidCutoff(days, dbNow)) {
            throw new Error(`Academic profile retention window does not produce a valid cutoff (${ACADEMIC_PROFILE_RETENTION_ENV_VAR})`);
        }

        if (options?.dryRun) {
            const countResult = await client.query<{ count: string }>(
                `SELECT COUNT(*)::text AS count
                 FROM student_academic_profiles sap
                 JOIN users u ON u.id = sap.user_id
                 WHERE u.deleted_at IS NOT NULL AND u.deleted_at <= $1::timestamptz`,
                [cutoff],
            );
            return {
                deletedProfiles: 0,
                scannedProfiles: Number(countResult.rows[0]?.count ?? '0'),
                cutoff: cutoff.toISOString(),
                dryRun: true,
                batchesProcessed: 0,
            };
        }

        const batchSize = options?.batchSize && options.batchSize > 0
            ? Math.min(options.batchSize, 5000)
            : 500;
        let totalDeleted = 0;
        let batchesProcessed = 0;
        while (true) {
            const batch = await client.query<{ user_id: string; generation_id: string }>(
                `SELECT sap.user_id, sap.generation_id
                 FROM student_academic_profiles sap
                 JOIN users u ON u.id = sap.user_id
                 WHERE u.deleted_at IS NOT NULL AND u.deleted_at <= $1::timestamptz
                 ORDER BY sap.user_id
                 LIMIT $2`,
                [cutoff, batchSize],
            );
            if (batch.rows.length === 0) {
                break;
            }
            batchesProcessed += 1;
            const toAppend: Array<() => void> = [];
            await client.query('BEGIN');
            try {
                for (const row of batch.rows) {
                    if (row.generation_id) {
                        const dbRecord = await recordDeletionInDatabase(client, {
                            userId: row.user_id,
                            generationId: row.generation_id,
                            scope: 'account_closure',
                        });
                        const erasedAtIso = dbRecord.erasedAt.toISOString();
                        toAppend.push(() => {
                            appendDurableLedgerEntry(
                                {
                                    userId: row.user_id,
                                    generationId: row.generation_id,
                                    scope: 'account_closure',
                                    erasedAt: erasedAtIso,
                                },
                                options?.ledgerFilePath,
                            );
                        });
                    }
                }
                const userIds = batch.rows.map((r) => r.user_id);
                const deleted = await client.query(
                    `DELETE FROM student_academic_profiles WHERE user_id = ANY($1::uuid[])`,
                    [userIds],
                );
                totalDeleted += deleted.rowCount ?? 0;
                await client.query('COMMIT');
                // Publish to durable host ledger only after DB transaction commits
                for (const append of toAppend) {
                    append();
                }
            } catch (err) {
                await client.query('ROLLBACK').catch(() => undefined);
                throw err;
            }
            if (batch.rows.length < batchSize) {
                break;
            }
        }
        const result: PurgeSummary = {
            deletedProfiles: totalDeleted,
            cutoff: cutoff.toISOString(),
        };
        if (options?.batchSize !== undefined) {
            result.batchesProcessed = batchesProcessed;
        }
        return result;
    } finally {
        if (acquiredLock) {
            await client.query('SELECT pg_advisory_unlock($1)', [ACADEMIC_PROFILE_PURGE_LOCK_ID]).catch(() => undefined);
        }
        client.release();
    }
}
