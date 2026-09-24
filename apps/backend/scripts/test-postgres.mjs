#!/usr/bin/env node
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import pg from 'pg';
import process from 'node:process';
import { cleanupOwnedCluster } from './test-postgres-lifecycle.mjs';
import { selectPostgresTestMode } from './postgres-test-mode.mjs';

const backendRoot = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(tmpdir(), 'awoof-postgres-'));
const dataDirectory = join(scratch, 'data');
const socketDirectory = join(scratch, 'socket');
let cleaned = false;
let startupAttempted = false;
let retainedScratch = false;

function findBinary(name) {
    const candidates = [];
    if (process.env.POSTGRES_BIN_DIR) candidates.push(join(process.env.POSTGRES_BIN_DIR, name));
    candidates.push(name, join('/opt/homebrew/bin', name));
    for (const candidate of candidates) {
        const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 5_000 });
        if (!result.error && result.status === 0) return candidate;
    }
    throw new Error(`Required PostgreSQL binary '${name}' was not found on PATH or POSTGRES_BIN_DIR; install nothing and provide a local PostgreSQL binary directory.`);
}

function requireDiskSpace() {
    const output = execFileSync('df', ['-Pk', tmpdir()], { encoding: 'utf8', timeout: 5_000 });
    const fields = output.trim().split('\n').at(-1)?.trim().split(/\s+/);
    const availableKiB = Number(fields?.[3]);
    if (!Number.isFinite(availableKiB) || availableKiB < 3 * 1024 * 1024) {
        throw new Error('PostgreSQL integration tests require at least 3 GiB free in the OS temporary directory.');
    }
}

async function selectPort() {
    return await new Promise((resolvePort, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: 0 }, () => {
            const address = server.address();
            if (!address || typeof address === 'string') return reject(new Error('Could not select a loopback PostgreSQL port.'));
            server.close((error) => error ? reject(error) : resolvePort(address.port));
        });
    });
}

function run(binary, args, timeout = 30_000) {
    const result = spawnSync(binary, args, { cwd: backendRoot, encoding: 'utf8', timeout });
    if (result.error || result.status !== 0) {
        const detail = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 8_000);
        throw new Error(`${basename(binary)} failed: ${detail}`);
    }
}

function stopAndRemove(pgCtl) {
    if (cleaned) return !retainedScratch;
    cleaned = true;
    const result = cleanupOwnedCluster({
        scratch, dataDirectory, pgCtl, startupAttempted,
        spawn: (binary, args, timeout) => spawnSync(binary, args, { encoding: 'utf8', timeout }),
        remove: (path) => rmSync(path, { recursive: true, force: true, maxRetries: 2 }),
        write: (message) => process.stderr.write(message),
    });
    retainedScratch = result.retained;
    return result.removed;
}

let pgCtlForSignal;
function onSignal(signal) {
    try { stopAndRemove(pgCtlForSignal); } finally { process.exit(signal === 'SIGINT' ? 130 : 143); }
}
process.once('SIGINT', () => onSignal('SIGINT'));
process.once('SIGTERM', () => onSignal('SIGTERM'));

try {
    // Validate the fixed source/compiled test plan before allocating the disposable cluster.
    const mode = selectPostgresTestMode({ backendRoot, environment: process.env, nodeExecutable: process.execPath });
    requireDiskSpace();
    const initdb = findBinary('initdb');
    const pgCtl = findBinary('pg_ctl');
    const createdb = findBinary('createdb');
    pgCtlForSignal = pgCtl;
    mkdirSync(socketDirectory);
    run(initdb, ['-D', dataDirectory, '-U', 'awoof_test', '--auth-local=trust', '--auth-host=trust']);
    const port = await selectPort();
    startupAttempted = true;
    run(pgCtl, ['-D', dataDirectory, '-l', join(scratch, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${socketDirectory} -c listen_addresses=127.0.0.1`, 'start', '-w', '-t', '20']);
    const database = `awoof_test_${randomUUID().replaceAll('-', '_')}`;
    run(createdb, ['-h', '127.0.0.1', '-p', String(port), '-U', 'awoof_test', database]);
    const databaseUrl = `postgresql://awoof_test@127.0.0.1:${port}/${database}`;
    const childEnvironment = {
        ...process.env,
        NODE_ENV: 'test',
        JWT_SECRET: 'test-jwt-secret-at-least-32-characters',
        JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
        DATABASE_URL: databaseUrl,
        AWOOF_TEST_DATABASE_URL: databaseUrl,
        AWOOF_TEST_GUARD: randomBytes(32).toString('hex'),
    };
    const migrate = spawnSync(mode.migration, mode.migrationArgs, { cwd: backendRoot, encoding: 'utf8', timeout: 60_000, env: childEnvironment });
    if (migrate.status !== 0 || migrate.error) throw new Error(`Migration runner failed: ${(migrate.stderr || migrate.error?.message || '').slice(0, 8_000)}`);
    if (mode.label === 'compiled' && process.env.AWOOF_POSTGRES_ARTIFACT_RUNTIME === '1') {
        const metadataPool = new pg.Pool({ connectionString: databaseUrl, max: 1, idleTimeoutMillis: 1_000, connectionTimeoutMillis: 2_000 });
        try {
            const applied = await metadataPool.query('SELECT filename FROM migrations ORDER BY filename');
            const filenames = applied.rows.map((row) => row.filename);
            if (filenames.length === 0 || filenames.some((filename) => typeof filename !== 'string')) throw new Error('Migration metadata query returned no ordered filenames.');
            process.stdout.write(`Applied migration filenames: ${JSON.stringify(filenames)}\n`);
        } finally {
            await metadataPool.end();
        }
    }
    // This budget covers the entire sequential suite, not an individual test.
    // The expanded suite approaches two minutes locally and exceeds it on CI;
    // retain a finite ceiling while allowing for shared-runner variability.
    const result = spawnSync(mode.runner, mode.testArgs, { cwd: backendRoot, encoding: 'utf8', timeout: 300_000, env: childEnvironment });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.status !== 0 || result.error) throw new Error(`Integration tests failed: ${result.error?.message || 'non-zero exit'}`);
    process.stdout.write(`Disposable PostgreSQL ${mode.label} integration suite passed.\n`);
} catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    if (startupAttempted) process.stderr.write('Disposable PostgreSQL server output was withheld to avoid exposing fixture data.\n');
    process.exitCode = 1;
} finally {
    if (!stopAndRemove(pgCtlForSignal)) process.exitCode = 1;
}
