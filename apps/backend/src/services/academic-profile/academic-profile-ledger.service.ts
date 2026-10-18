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

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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
 * Creates parent directory if missing.
 */
export function appendDurableLedgerEntry(
    entry: AcademicProfileLedgerEntry,
    customPath?: string | undefined,
): void {
    const targetPath = customPath ? resolve(customPath) : getDurableLedgerFilePath();
    mkdirSync(dirname(targetPath), { recursive: true });
    const payload = JSON.stringify({
        userId: entry.userId,
        generationId: entry.generationId,
        scope: entry.scope,
        erasedAt: entry.erasedAt,
    }) + '\n';
    appendFileSync(targetPath, payload, { encoding: 'utf8', mode: 0o600 });
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
