/**
 * Academic Profile Restore Reconciliation CLI
 *
 * Runs immediately following a database backup restore (and before traffic
 * or background jobs are enabled) to reconcile restored academic profiles
 * against the authoritative host deletion ledger.
 *
 * Usage:
 *   npx tsx src/scripts/reconcile-restored-academic-profiles.ts [--dry-run] [--ledger-file <path>] [--require-ledger]
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
    const isDryRun = args.includes('--dry-run');
    const requireLedger = args.includes('--require-ledger');
    let ledgerFilePath: string | undefined;

    const fileArgIdx = args.indexOf('--ledger-file');
    if (fileArgIdx !== -1 && args[fileArgIdx + 1]) {
        ledgerFilePath = args[fileArgIdx + 1];
    }

    try {
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
    }
}

void main();
