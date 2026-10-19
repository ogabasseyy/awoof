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
        // Strict argument validation before any database work: an
        // unrecognized flag must never fall through to the destructive
        // default path (a typo like --dryrun previously ran the purge).
        const args = process.argv.slice(2);
        let isDryRun = false;
        let batchSize = 500;
        try {
            for (let i = 0; i < args.length; i += 1) {
                const arg = args[i] as string;
                if (arg === '--dry-run') {
                    if (isDryRun) throw new Error('duplicate --dry-run argument');
                    isDryRun = true;
                } else if (arg === '--batch-size') {
                    const nextArg = args[i + 1];
                    if (nextArg === undefined || !/^[0-9]+$/.test(nextArg)) throw new Error('--batch-size requires a positive integer value');
                    const parsed = Number(nextArg);
                    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('--batch-size requires a positive integer value');
                    batchSize = parsed;
                    i += 1;
                } else {
                    throw new Error(`unrecognized argument: ${arg}`);
                }
            }
        } catch {
            fail('academic profile purge refused: unrecognized or malformed arguments (expected --dry-run and/or --batch-size <positive integer>)');
            return;
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
