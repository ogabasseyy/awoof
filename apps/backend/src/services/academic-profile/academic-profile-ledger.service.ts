/**
 * Academic Profile Deletion Ledger Service
 *
 * Provides dual-write persistence for academic profile erasure events:
 * 1. PostgreSQL table `academic_profile_deletion_ledger` within the transaction.
 * 2. Host-level append-only JSONL file outside the PostgreSQL container.
 *
 * This dual persistence guarantees that even if a PostgreSQL backup is restored
 * (which rolls back database tables to the backup timestamp), the host ledger
 * retains the record of erasures that occurred after the backup was taken.
 *
 * The ledger stores MINIMAL restricted metadata only:
 * - userId (UUID)
 * - generationId (UUID)
 * - scope ('profile_only' | 'account_closure')
 * - erasedAt (ISO timestamp)
 *
 * It NEVER stores names, emails, academic answers, or PII.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { PoolClient } from 'pg';

export type AcademicProfileDeletionScope = 'profile_only' | 'account_closure';

export type AcademicProfileLedgerEntry = {
    userId: string;
    generationId: string;
    scope: AcademicProfileDeletionScope;
    erasedAt: string;
    reconciledAt?: string | null | undefined;
};

const DEFAULT_LEDGER_FILENAME = 'backups/academic-profile-deletion-ledger.jsonl';

export function getDurableLedgerFilePath(): string {
    const configured = process.env.ACADEMIC_PROFILE_DELETION_LEDGER_FILE;
    if (configured && configured.trim() !== '') {
        return resolve(configured.trim());
    }
    return resolve(process.cwd(), DEFAULT_LEDGER_FILENAME);
}

/**
 * Startup availability gate for the durable deletion ledger. A missing
 * LEDGER FILE with an existing parent directory means no tombstone has
 * been written yet on this host. A missing parent directory means the
 * backups volume or configured path is unavailable (for example after
 * host-volume loss) exactly when reconciliation matters most, so
 * startup fails unless the operator explicitly marks this as a fresh
 * deployment with ACADEMIC_PROFILE_FRESH_DEPLOYMENT=true.
 */
export function assertDurableLedgerAvailableForStartup(options: {
    ledgerFilePath: string;
    freshDeployment?: boolean | undefined;
}): void {
    const targetPath = resolve(options.ledgerFilePath);
    if (existsSync(targetPath)) return;
    const parentDir = dirname(targetPath);
    // Once any tombstone has been appended, the ever-written marker
    // persists on the volume; losing only the ledger file afterwards
    // must fail closed, because reconciliation would be skipped.
    if (existsSync(join(parentDir, LEDGER_EVER_WRITTEN_MARKER))) {
        throw new Error(
            `Durable deletion ledger is missing at ${targetPath} but tombstones were previously written; refusing to start against a possibly restored database. Restore the ledger file from the backups volume.`,
        );
    }
    // An initialized marker records the explicit fresh-deployment
    // decision on the ledger volume itself, so a later restart with no
    // tombstones yet does not need the flag again - and an empty,
    // freshly recreated volume (which has neither ledger nor marker)
    // can never masquerade as that state.
    if (existsSync(join(parentDir, LEDGER_INITIALIZED_MARKER))) return;
    if (options.freshDeployment === true) {
        mkdirSync(parentDir, { recursive: true });
        writeFileSync(join(parentDir, LEDGER_INITIALIZED_MARKER), `${new Date().toISOString()}\n`, { flag: 'wx' });
        return;
    }
    throw new Error(
        `Durable deletion ledger is absent at ${targetPath} and no initialized marker exists; refusing to start against a possibly restored database. Mount the backups volume or set ACADEMIC_PROFILE_FRESH_DEPLOYMENT=true only for a genuinely fresh deployment.`,
    );
}

const LEDGER_INITIALIZED_MARKER = '.academic-profile-ledger-initialized';
const LEDGER_EVER_WRITTEN_MARKER = '.academic-profile-ledger-ever-written';

/**
 * Append a deletion record to the durable host-level JSONL ledger file.
 * Creates parent directory if missing. The append is flushed to stable
 * storage (write + fsync on an append-mode descriptor, plus an fsync of
 * the containing directory and any ancestors this call created) before
 * it is treated as durable: the host file is the recovery authority
 * after a database-volume failure, so an acknowledged tombstone must
 * survive a host crash, including when this append creates the file.
 */
export function appendDurableLedgerEntry(
    entry: AcademicProfileLedgerEntry,
    customPath?: string | undefined,
): void {
    const targetPath = customPath ? resolve(customPath) : getDurableLedgerFilePath();
    const parentDir = dirname(targetPath);
    // Collect directories this call is about to create: fsyncing the file
    // persists its contents, but a newly created directory entry (and the
    // entries of any newly created ancestors) also need a directory fsync
    // or a host power loss can still drop the acknowledged tombstone.
    const createdDirs: string[] = [];
    let cursor = parentDir;
    while (!existsSync(cursor)) {
        createdDirs.push(cursor);
        const parent = dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
    }
    mkdirSync(parentDir, { recursive: true });
    const payload = JSON.stringify({
        userId: entry.userId,
        generationId: entry.generationId,
        scope: entry.scope,
        erasedAt: entry.erasedAt,
    }) + '\n';
    // Serialize appends across processes: with the complete-write loop,
    // a short write followed by another process's record could otherwise
    // interleave fragments into malformed JSONL lines. The lock file is
    // fenced with a random owner token so a reclaimed stale lock cannot
    // be released by its old owner.
    const lock = acquireLedgerAppendLock(targetPath);
    try {
        appendDurableLedgerPayload(targetPath, parentDir, createdDirs, cursor, payload, lock.assertOwned);
        ensureLedgerEverWrittenMarker(parentDir);
    } finally {
        lock.release();
    }
}

const LEDGER_LOCK_TIMEOUT_MS = 10_000;
const LEDGER_LOCK_STALE_MS = 30_000;

function acquireLedgerAppendLock(targetPath: string): { release: () => void; assertOwned: () => void } {
    const lockPath = `${targetPath}.lock`;
    const owner = `${process.pid}:${processStartTicks(process.pid) ?? 'na'}:${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    const deadline = Date.now() + LEDGER_LOCK_TIMEOUT_MS;
    const spin = new Int32Array(new SharedArrayBuffer(4));
    const assertOwned = (): void => {
        let current = '';
        try {
            current = readFileSync(lockPath, 'utf8').trim();
        } catch {
            current = '';
        }
        if (current !== owner) {
            throw new Error(`Lost durable ledger append lock at ${lockPath}`);
        }
    };
    for (;;) {
        try {
            const fd = openSync(lockPath, 'wx', 0o600);
            writeSync(fd, `${owner}\n`);
            return {
                assertOwned,
                release: () => {
                    try { closeSync(fd); } catch { /* already closed */ }
                    // Fencing: unlink only the lock we still own. If our
                    // stale lock was reclaimed and replaced, leave the
                    // replacement owner's lock untouched.
                    try {
                        if (readFileSync(lockPath, 'utf8').trim() === owner) {
                            unlinkSync(lockPath);
                        }
                    } catch { /* already removed or replaced */ }
                },
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            try {
                if (Date.now() - statSync(lockPath).mtimeMs > LEDGER_LOCK_STALE_MS && !ledgerLockOwnerAlive(lockPath)) {
                    unlinkSync(lockPath);
                    continue;
                }
            } catch {
                continue;
            }
            if (Date.now() > deadline) {
                throw new Error(`Timed out acquiring durable ledger append lock at ${lockPath}`);
            }
            Atomics.wait(spin, 0, 0, 10);
        }
    }
}

function processStartTicks(pid: number): string | null {
    // Linux process-instance identity: PID alone is reused (notably
    // PID 1 across container restarts), while the start-time ticks in
    // /proc/<pid>/stat distinguish the former owner from the new one.
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return afterComm[19] ?? null;
    } catch {
        return null;
    }
}

function ensureLedgerEverWrittenMarker(parentDir: string): void {
    // Record on the volume that tombstones now exist, so a later loss
    // of only the ledger file fails the startup gate closed instead of
    // silently skipping reconciliation.
    const everWrittenPath = join(parentDir, LEDGER_EVER_WRITTEN_MARKER);
    if (existsSync(everWrittenPath)) return;
    try {
        writeFileSync(everWrittenPath, `${new Date().toISOString()}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const dfd = openSync(parentDir, 'r');
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
}

function ledgerLockOwnerAlive(lockPath: string): boolean {
    try {
        const [pidText, startTicks] = readFileSync(lockPath, 'utf8').trim().split(':');
        const pid = Number(pidText);
        if (!Number.isInteger(pid) || pid <= 0) return false;
        try {
            process.kill(pid, 0);
        } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'EPERM';
        }
        if (startTicks && startTicks !== 'na') {
            const currentTicks = processStartTicks(pid);
            if (currentTicks !== null && currentTicks !== startTicks) return false;
        }
        return true;
    } catch {
        return false;
    }
}

function appendDurableLedgerPayload(
    targetPath: string,
    parentDir: string,
    createdDirs: string[],
    existingAncestor: string,
    payload: string,
    assertOwned: () => void,
): void {
    const fd = openSync(targetPath, 'a', 0o600);
    try {
        // Loop until the whole payload is on the descriptor: a short
        // write fsynced as-is would persist a truncated JSON record and
        // fail every later reconciliation closed, with no retry signal.
        const buffer = Buffer.from(payload, 'utf8');
        let written = 0;
        while (written < buffer.length) {
            assertOwned();
            const count = writeSync(fd, buffer, written, buffer.length - written);
            if (count <= 0) {
                throw new Error(`Short write appending to durable ledger at ${targetPath}: wrote ${written} of ${buffer.length} bytes`);
            }
            written += count;
        }
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    const syncDir = (dir: string): void => {
        const dfd = openSync(dir, 'r');
        try {
            fsyncSync(dfd);
        } finally {
            closeSync(dfd);
        }
    };
    if (createdDirs.length === 0) {
        syncDir(parentDir);
    } else {
        for (const dir of [...createdDirs, existingAncestor]) {
            syncDir(dir);
        }
    }
}

/**
 * Record a deletion event in the PostgreSQL ledger table.
 */
export async function recordDeletionInDatabase(
    client: PoolClient,
    entry: {
        userId: string;
        generationId: string;
        scope: AcademicProfileDeletionScope;
        erasedAt?: Date | undefined;
    },
): Promise<{ id: string; erasedAt: Date }> {
    const result = await client.query<{ id: string; erased_at: Date }>(
        `INSERT INTO academic_profile_deletion_ledger (user_id, generation_id, scope, erased_at)
         VALUES ($1, $2, $3, COALESCE($4, clock_timestamp()))
         RETURNING id, erased_at`,
        [entry.userId, entry.generationId, entry.scope, entry.erasedAt ?? null],
    );
    const row = result.rows[0];
    if (!row) {
        throw new Error('Failed to record academic profile deletion in database ledger');
    }
    const erasedAtDate = row.erased_at instanceof Date
        ? row.erased_at
        : (row.erased_at ? new Date(row.erased_at) : new Date());
    return { id: row.id, erasedAt: erasedAtDate };
}

/**
 * Record an academic profile erasure atomically in both the database ledger
 * and the durable host JSONL file.
 */
export async function recordAcademicProfileErasure(
    client: PoolClient,
    entry: {
        userId: string;
        generationId: string;
        scope: AcademicProfileDeletionScope;
        ledgerFilePath?: string | undefined;
    },
): Promise<{ dbLedgerId: string; erasedAt: string }> {
    const dbRecord = await recordDeletionInDatabase(client, {
        userId: entry.userId,
        generationId: entry.generationId,
        scope: entry.scope,
    });
    const erasedAtIso = dbRecord.erasedAt.toISOString();
    appendDurableLedgerEntry(
        {
            userId: entry.userId,
            generationId: entry.generationId,
            scope: entry.scope,
            erasedAt: erasedAtIso,
        },
        entry.ledgerFilePath,
    );
    return { dbLedgerId: dbRecord.id, erasedAt: erasedAtIso };
}

/**
 * Read committed erasure records from the database ledger table. The
 * database insert commits atomically with the profile deletion, so
 * these rows are the transactional outbox for the host tombstone file:
 * a post-commit host append failure leaves a committed row that a
 * later retry can republish instead of a permanently missing tombstone.
 */
export async function readDatabaseLedgerEntries(
    client: PoolClient,
    userId?: string | undefined,
): Promise<AcademicProfileLedgerEntry[]> {
    const result = userId
        ? await client.query<{ user_id: string; generation_id: string; scope: string; erased_at: Date | string }>(
            `SELECT user_id, generation_id, scope, erased_at
             FROM academic_profile_deletion_ledger
             WHERE user_id = $1
             ORDER BY erased_at ASC`,
            [userId],
        )
        : await client.query<{ user_id: string; generation_id: string; scope: string; erased_at: Date | string }>(
            `SELECT user_id, generation_id, scope, erased_at
             FROM academic_profile_deletion_ledger
             ORDER BY erased_at ASC`,
        );
    const entries: AcademicProfileLedgerEntry[] = [];
    for (const row of result.rows) {
        if (
            typeof row.user_id !== 'string' ||
            typeof row.generation_id !== 'string' ||
            (row.scope !== 'profile_only' && row.scope !== 'account_closure')
        ) {
            continue;
        }
        const erasedAt = row.erased_at instanceof Date ? row.erased_at : new Date(row.erased_at);
        if (Number.isNaN(erasedAt.getTime())) {
            continue;
        }
        entries.push({
            userId: row.user_id,
            generationId: row.generation_id,
            scope: row.scope,
            erasedAt: erasedAt.toISOString(),
        });
    }
    return entries;
}

function ledgerEntryKey(entry: AcademicProfileLedgerEntry): string {
    return `${entry.userId}|${entry.generationId}|${entry.scope}|${entry.erasedAt}`;
}

/**
 * Republish committed database-ledger erasures that are missing from
 * the durable host file. This is the retry half of the erasure
 * protocol: the initial erase publishes after COMMIT on a best-effort
 * one-shot basis, and any failure (full/read-only/unavailable volume)
 * is recovered by calling this again from an erase retry or the
 * retention purge instead of losing the tombstone permanently.
 */
export async function republishMissingDurableLedgerEntries(
    client: PoolClient,
    options?: { userId?: string | undefined; ledgerFilePath?: string | undefined },
): Promise<{ republished: number; latest: AcademicProfileLedgerEntry | null }> {
    const dbEntries = await readDatabaseLedgerEntries(client, options?.userId);
    if (dbEntries.length === 0) {
        return { republished: 0, latest: null };
    }
    const hostEntries = readDurableLedgerEntries(options?.ledgerFilePath);
    if (hostEntries.length > 0) {
        // Repair a missing ever-written marker (for example when the
        // first append wrote its payload but failed before creating
        // the marker): retries must not skip this just because the
        // payload key is already present.
        const targetPath = options?.ledgerFilePath ? resolve(options.ledgerFilePath) : getDurableLedgerFilePath();
        ensureLedgerEverWrittenMarker(dirname(targetPath));
    }
    const hostKeys = new Set(hostEntries.map(ledgerEntryKey));
    let republished = 0;
    for (const entry of dbEntries) {
        if (!hostKeys.has(ledgerEntryKey(entry))) {
            appendDurableLedgerEntry(entry, options?.ledgerFilePath);
            hostKeys.add(ledgerEntryKey(entry));
            republished += 1;
        }
    }
    return { republished, latest: dbEntries[dbEntries.length - 1] ?? null };
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read and validate all entries from the durable host JSONL ledger.
 * Fails closed if any line is malformed or unparseable.
 */
export function readDurableLedgerEntries(customPath?: string | undefined): AcademicProfileLedgerEntry[] {
    const targetPath = customPath ? resolve(customPath) : getDurableLedgerFilePath();
    if (!existsSync(targetPath)) {
        return [];
    }
    const content = readFileSync(targetPath, 'utf8');
    const lines = content.split('\n').filter((line) => line.trim() !== '');
    const entries: AcademicProfileLedgerEntry[] = [];

    for (const [index, line] of lines.entries()) {
        try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            if (
                typeof parsed.userId !== 'string' || !UUID_REGEX.test(parsed.userId) ||
                typeof parsed.generationId !== 'string' || !UUID_REGEX.test(parsed.generationId) ||
                (parsed.scope !== 'profile_only' && parsed.scope !== 'account_closure') ||
                typeof parsed.erasedAt !== 'string' || Number.isNaN(Date.parse(parsed.erasedAt))
            ) {
                throw new Error(`Invalid ledger entry structure at line ${index + 1}`);
            }
            entries.push({
                userId: parsed.userId,
                generationId: parsed.generationId,
                scope: parsed.scope,
                erasedAt: parsed.erasedAt,
            });
        } catch (error) {
            throw new Error(`Durable deletion ledger is corrupt or invalid at line ${index + 1}: ${(error as Error).message}`);
        }
    }
    return entries;
}
