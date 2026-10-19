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

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
    const fd = openSync(targetPath, 'a', 0o600);
    try {
        writeSync(fd, payload, null, 'utf8');
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
        for (const dir of [...createdDirs, cursor]) {
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
