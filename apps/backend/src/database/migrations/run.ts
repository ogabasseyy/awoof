/**
 * Database Migration Runner
 * 
 * Runs SQL migration files in order
 * Follows Single Responsibility Principle - only handles migrations
 */

import { db } from '../../config/database.js';
import { appLogger } from '../../common/logger.js';
import { readFileSync, readdirSync } from 'fs';
import { dirname, basename, resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * Migration record in database
 */
interface Migration {
    id: string;
    filename: string;
    executed_at: Date;
}

/** Resolved migrations directory (single source of truth for path checks). */
const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)));

/**
 * Get all migration file paths (resolved, under MIGRATIONS_DIR) sorted by basename.
 * Filenames come from readdirSync only (filesystem), not HTTP/user input.
 */
function getMigrationFiles(): string[] {
    const files = readdirSync(MIGRATIONS_DIR)
        .filter((file): file is string =>
            file.endsWith('.sql') && !file.startsWith('clear_')
        )
        .sort();
    // semgrep: files are from readdirSync (filesystem), not user input; path constrained to MIGRATIONS_DIR
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    return files.map((f) => resolve(MIGRATIONS_DIR, f));
}

/**
 * Check if migration table exists, create if not
 */
async function ensureMigrationTable(): Promise<void> {
    // Enable UUID extension first
    await db.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS migrations (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            filename VARCHAR(255) UNIQUE NOT NULL,
            executed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `;

    await db.query(createTableQuery);
    appLogger.info('Migration table ready');
}

/**
 * Get executed migrations from database
 */
async function getExecutedMigrations(): Promise<Migration[]> {
    try {
        const result = await db.query<Migration>(
            'SELECT id, filename, executed_at FROM migrations ORDER BY filename'
        );
        return result.rows;
    } catch (error) {
        // Table doesn't exist yet, return empty array
        return [];
    }
}

/**
 * Execute a single migration file by its full path.
 * fullPath must be a path returned by getMigrationFiles() (under MIGRATIONS_DIR); no join with user input.
 */
async function executeMigration(fullPath: string): Promise<void> {
    const base = basename(fullPath);
    if (!fullPath.startsWith(MIGRATIONS_DIR) || fullPath === MIGRATIONS_DIR || fullPath.includes('..')) {
        throw new Error(`Invalid migration path: ${fullPath}`);
    }
    const sql = readFileSync(fullPath, 'utf-8');

    appLogger.info(`📄 Running migration: ${base}`);

    const client = await db.getPool().connect();
    try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
            'INSERT INTO migrations (filename) VALUES ($1)',
            [base]
        );
        await client.query('COMMIT');
        appLogger.info(`Migration ${base} executed successfully`);
    } catch (error) {
        await client.query('ROLLBACK').catch((rollbackError) => {
            appLogger.error(`Migration ${base} rollback failed:`, rollbackError);
        });
        appLogger.error(`Migration ${base} failed:`, error);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Run all pending migrations
 */
export async function runMigrations(): Promise<void> {
    appLogger.info('Starting database migrations...\n');

    try {
        // Ensure migration table exists
        await ensureMigrationTable();

        // Get all migration file paths and executed migrations (stored by basename)
        const migrationFilePaths = getMigrationFiles();
        const executedMigrations = await getExecutedMigrations();
        const executedFilenames = new Set(executedMigrations.map(m => m.filename));

        // Filter out already executed migrations (compare by basename)
        const pendingMigrations = migrationFilePaths.filter(
            fullPath => !executedFilenames.has(basename(fullPath))
        );

        if (pendingMigrations.length === 0) {
            appLogger.info('All migrations are up to date');
            return;
        }

        appLogger.info(`Found ${pendingMigrations.length} pending migration(s)\n`);

        // Execute pending migrations in order
        for (const fullPath of pendingMigrations) {
            await executeMigration(fullPath);
            appLogger.info('');
        }

        appLogger.info('All migrations completed successfully');
    } catch (error) {
        appLogger.error('Migration failed:', error);
        process.exit(1);
    }
}

// Run migrations if called directly (normalize paths so spaces / URL encoding match)
const isDirectRun =
    !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
    runMigrations()
        .then(() => {
            process.exit(0);
        })
        .catch((error) => {
            appLogger.error(error);
            process.exit(1);
        });
}
