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

export const ACADEMIC_PROFILE_RETENTION_ENV_VAR = 'ACADEMIC_PROFILE_RETENTION_DAYS';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DATE_MS = 8_640_000_000_000_000;

export type PurgeSummary = {
    deletedProfiles: number;
    cutoff: string;
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
): Promise<PurgeSummary> {
    const days = resolveAcademicProfileRetentionDays(retentionDays);
    const client = await pool.connect();
    try {
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
        const deleted = await client.query(
            `DELETE FROM student_academic_profiles
             WHERE user_id IN (
                 SELECT id FROM users WHERE deleted_at IS NOT NULL AND deleted_at <= $1::timestamptz
             )`,
            [cutoff],
        );
        return { deletedProfiles: deleted.rowCount ?? 0, cutoff: cutoff.toISOString() };
    } finally {
        client.release();
    }
}
