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
    const days = typeof value === 'string' ? Number(value.trim()) : value;
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
    now: Date,
): Promise<PurgeSummary> {
    const days = resolveAcademicProfileRetentionDays(retentionDays);
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new Error('Academic profile purge requires a valid reference time');
    }
    const cutoff = new Date(now.getTime() - days * DAY_MS);
    if (!retentionWindowProducesValidCutoff(days, now)) {
        throw new Error(`Academic profile retention window does not produce a valid cutoff (${ACADEMIC_PROFILE_RETENTION_ENV_VAR})`);
    }
    const client = await pool.connect();
    try {
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
