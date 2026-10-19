/**
 * Academic Profile Restore Reconciliation CLI
 *
 * Runs immediately following a database backup restore (and before traffic
 * or background jobs are enabled) to reconcile restored academic profiles
 * against the authoritative host deletion ledger.
 *
 * Usage:
 *   npx tsx src/scripts/reconcile-restored-academic-profiles.ts [--dry-run] [--ledger-file <path>] [--allow-missing-ledger]
 * A ledger file is required by default; --allow-missing-ledger opts out explicitly.
 */

import pg from 'pg';
import dotenv from 'dotenv';
import {
    reconcileRestoredAcademicProfiles,
    type ReconciliationSummary,
} from '../services/academic-profile/academic-profile-reconciliation.service.js';

dotenv.config({ override: false, quiet: true });

function createPool(): pg.Pool {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl) {
        return new pg.Pool({ connectionString: databaseUrl, max: 1, idleTimeoutMillis: 1_000, connectionTimeoutMillis: 2_000 });
    }
    if (!process.env.DB_HOST || !process.env.DB_NAME || !process.env.DB_USER) {
        throw new Error('Database connection configuration is unavailable');
    }
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
    const args = process.argv.slice(2);
    // Validate the entire argument list before opening the database: an
    // unrecognized flag such as `--dryrun` must refuse here instead of
    // silently falling through to the destructive reconciliation path.
    let isDryRun = false;
    let allowMissingLedger = false;
    let ledgerFilePath: string | undefined;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i] ?? '';
        if (arg === '--dry-run' && !isDryRun) {
            isDryRun = true;
        } else if (arg === '--allow-missing-ledger' && !allowMissingLedger) {
            allowMissingLedger = true;
        } else if (arg === '--ledger-file' && ledgerFilePath === undefined) {
            const nextArg = args[i + 1];
            if (!nextArg || nextArg.startsWith('--')) {
                throw new Error('--ledger-file requires a non-empty file path argument');
            }
            ledgerFilePath = nextArg;
            i += 1;
        } else {
            throw new Error(`Unrecognized or duplicate argument: ${arg}`);
        }
    }
    const requireLedger = !allowMissingLedger;

    try {
        // A quarantined manual run can target a dump restored from
        // before the academic-profile migrations (088/089); run pending
        // migrations first, exactly as application startup does, so the
        // reconciliation queries see the current schema.
        const { db } = await import('../config/database.js');
        db.initialize();
        const { runMigrations } = await import('../database/migrations/run.js');
        await runMigrations();

        pool = createPool();
        pool.on('error', () => {
            process.stderr.write('academic profile reconciliation: database error\n');
            process.exitCode = 1;
        });

        const summary: ReconciliationSummary = await reconcileRestoredAcademicProfiles(pool, {
            dryRun: isDryRun,
            ledgerFilePath,
            requireLedgerFile: requireLedger,
        });

        const prefix = isDryRun ? 'academic profile reconciliation dry-run complete' : 'academic profile reconciliation complete';
        process.stdout.write(
            `${prefix}: entriesRead=${summary.ledgerEntriesRead} stalePurged=${summary.staleGenerationsPurged} recreatedPreserved=${summary.recreatedGenerationsPreserved} dbLedgerRestored=${summary.dbLedgerEntriesRestored}\n`,
        );
    } catch (error) {
        process.stderr.write(`academic profile reconciliation failed: ${(error as Error).message}\n`);
        process.exitCode = 1;
    } finally {
        if (pool) {
            try { await pool.end(); } catch { /* ignore */ }
        }
        try {
            const { db } = await import('../config/database.js');
            await db.close();
        } catch { /* ignore */ }
    }
}

void main();
