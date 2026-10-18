/**
 * Academic Profile Data Cleanup
 *
 * Narrow scheduled purge for academic-profile rows of soft-deleted accounts.
 * DO NOT RUN until owner/legal approval and an operational schedule exist;
 * collection stays disabled until then. The command fails closed when
 * ACADEMIC_PROFILE_RETENTION_DAYS is unset or invalid, and prints
 * counts/outcomes only — never deleted values, emails, or identifiers.
 *
 * Usage (after approval): npm run academic-profile:purge for a source
 * checkout, npm run academic-profile:purge:prod against a built artifact.
 */
import pg from 'pg';
import dotenv from 'dotenv';
import {
    ACADEMIC_PROFILE_PURGE_LOCK_ID,
    ACADEMIC_PROFILE_RETENTION_ENV_VAR,
    purgeSoftDeletedAcademicProfiles,
    resolveAcademicProfileRetentionDays,
} from '../services/academic-profile/academic-profile-retention.service.js';

dotenv.config({ override: false, quiet: true });

function cleanupPool(): pg.Pool {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl) {
        return new pg.Pool({ connectionString: databaseUrl, max: 1, idleTimeoutMillis: 1_000, connectionTimeoutMillis: 2_000 });
    }
    if (!process.env.DB_HOST || !process.env.DB_NAME || !process.env.DB_USER) throw new Error('Database connection configuration is unavailable');
    return new pg.Pool({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        max: 1,
        idleTimeoutMillis: 1_000,
        connectionTimeoutMillis: 2_000,
    });
}

async function main(): Promise<void> {
    let pool: pg.Pool | undefined;
    let reported = false;
    const fail = (message: string): void => {
        if (!reported) process.stderr.write(`${message}\n`);
        reported = true;
        process.exitCode = 1;
    };
    try {
        const args = process.argv.slice(2);
        const isDryRun = args.includes('--dry-run');
        let batchSize = 500;
        const batchSizeIdx = args.indexOf('--batch-size');
        const nextArg = batchSizeIdx !== -1 ? args[batchSizeIdx + 1] : undefined;
        if (nextArg !== undefined) {
            const parsed = parseInt(nextArg, 10);
            if (!Number.isNaN(parsed) && parsed > 0) {
                batchSize = parsed;
            }
        }

        let retentionDays: number;
        try {
            retentionDays = resolveAcademicProfileRetentionDays(process.env[ACADEMIC_PROFILE_RETENTION_ENV_VAR] ?? null);
        } catch {
            fail('academic profile purge refused: retention window is not set to an approved positive value');
            return;
        }
        pool = cleanupPool();
        // pg can surface an idle client error outside a query promise. Never
        // forward that object because it may include a connection URL/value.
        pool.on('error', () => fail('academic profile purge failed'));
        const summary = await purgeSoftDeletedAcademicProfiles(pool, retentionDays, {
            dryRun: isDryRun,
            batchSize,
            useAdvisoryLock: true,
        });

        if (summary.skippedDueToLock) {
            process.stdout.write(
                `academic profile purge skipped: another purge process holds advisory lock ${ACADEMIC_PROFILE_PURGE_LOCK_ID}\n`,
            );
            return;
        }

        if (summary.dryRun) {
            process.stdout.write(
                `academic profile purge dry-run complete: eligibleProfiles=${summary.scannedProfiles ?? 0} cutoff=${summary.cutoff}\n`,
            );
            return;
        }

        process.stdout.write(
            `academic profile purge complete: deletedProfiles=${summary.deletedProfiles} cutoff=${summary.cutoff} batchesProcessed=${summary.batchesProcessed ?? 1}\n`,
        );
    } catch {
        fail('academic profile purge failed');
    } finally {
        if (pool) {
            try { await pool.end(); }
            catch { fail('academic profile purge failed'); }
        }
    }
}

void main();
