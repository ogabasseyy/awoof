import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { beforeEach, afterEach } from 'node:test';
import {
    reconcileRestoredAcademicProfiles,
} from './academic-profile-reconciliation.service.js';

let testDir: string;
let ledgerPath: string;

beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'awoof-reconcile-test-'));
    ledgerPath = join(testDir, 'test-ledger.jsonl');
});

afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
});

test('reconcileRestoredAcademicProfiles purges stale generation and restores db ledger tombstone', async () => {
    const entry = {
        userId: '00000000-0000-4000-8000-000000000001',
        generationId: '11111111-1111-4111-8111-111111111111',
        scope: 'profile_only',
        erasedAt: '2026-10-18T10:00:00.000Z',
    };
    writeFileSync(ledgerPath, JSON.stringify(entry) + '\n', 'utf8');

    const statements: Array<{ text: string; params: unknown[] }> = [];
    const client = {
        query: async (text: string, params: unknown[] = []): Promise<unknown> => {
            const normalized = text.replace(/\s+/g, ' ').trim();
            statements.push({ text: normalized, params });
            if (normalized.includes('pg_try_advisory_lock')) {
                return { rows: [{ locked: true }], rowCount: 1 };
            }
            if (normalized.startsWith('SELECT generation_id FROM student_academic_profiles')) {
                return { rows: [{ generation_id: entry.generationId }], rowCount: 1 };
            }
            if (normalized.startsWith('SELECT id FROM academic_profile_deletion_ledger')) {
                return { rows: [], rowCount: 0 };
            }
            if (normalized.startsWith('DELETE FROM student_academic_profiles')) {
                return { rows: [], rowCount: 1 };
            }
            if (normalized.startsWith('INSERT INTO academic_profile_deletion_ledger')) {
                return { rows: [{ id: 'restored-db-ledger-id' }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        },
        release: (): void => undefined,
    };
    const pool = { connect: async () => client };

    const summary = await reconcileRestoredAcademicProfiles(pool, { ledgerFilePath: ledgerPath });
    assert.equal(summary.ledgerEntriesRead, 1);
    assert.equal(summary.staleGenerationsPurged, 1);
    assert.equal(summary.recreatedGenerationsPreserved, 0);
    assert.equal(summary.dbLedgerEntriesRestored, 1);
    assert.equal(summary.dryRun, false);

    assert.ok(statements.some((s) => s.text.startsWith('DELETE FROM student_academic_profiles WHERE user_id = $1 AND generation_id = $2')));
    assert.ok(statements.some((s) => s.text.startsWith('INSERT INTO academic_profile_deletion_ledger')));
    assert.ok(statements.some((s) => s.text.includes('pg_advisory_unlock')));
});

test('reconcileRestoredAcademicProfiles preserves legitimate newly recreated generation', async () => {
    const entry = {
        userId: '00000000-0000-4000-8000-000000000001',
        generationId: '11111111-1111-4111-8111-111111111111',
        scope: 'profile_only',
        erasedAt: '2026-10-18T10:00:00.000Z',
    };
    writeFileSync(ledgerPath, JSON.stringify(entry) + '\n', 'utf8');

    const statements: Array<{ text: string; params: unknown[] }> = [];
    const client = {
        query: async (text: string, params: unknown[] = []): Promise<unknown> => {
            const normalized = text.replace(/\s+/g, ' ').trim();
            statements.push({ text: normalized, params });
            if (normalized.includes('pg_try_advisory_lock')) {
                return { rows: [{ locked: true }], rowCount: 1 };
            }
            if (normalized.startsWith('SELECT generation_id FROM student_academic_profiles')) {
                // Different generation ID: legitimate recreation!
                return { rows: [{ generation_id: '22222222-2222-4222-8222-222222222222' }], rowCount: 1 };
            }
            if (normalized.startsWith('SELECT id FROM academic_profile_deletion_ledger')) {
                return { rows: [{ id: 'existing-id' }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        },
        release: (): void => undefined,
    };
    const pool = { connect: async () => client };

    const summary = await reconcileRestoredAcademicProfiles(pool, { ledgerFilePath: ledgerPath });
    assert.equal(summary.ledgerEntriesRead, 1);
    assert.equal(summary.staleGenerationsPurged, 0);
    assert.equal(summary.recreatedGenerationsPreserved, 1);
    assert.equal(summary.dbLedgerEntriesRestored, 0);

    // DELETE must NOT have been called!
    assert.ok(statements.every((s) => !s.text.startsWith('DELETE')));
});

test('reconcileRestoredAcademicProfiles dry-run reports counts without mutating data', async () => {
    const entry = {
        userId: '00000000-0000-4000-8000-000000000001',
        generationId: '11111111-1111-4111-8111-111111111111',
        scope: 'profile_only',
        erasedAt: '2026-10-18T10:00:00.000Z',
    };
    writeFileSync(ledgerPath, JSON.stringify(entry) + '\n', 'utf8');

    const statements: Array<{ text: string; params: unknown[] }> = [];
    const client = {
        query: async (text: string, params: unknown[] = []): Promise<unknown> => {
            const normalized = text.replace(/\s+/g, ' ').trim();
            statements.push({ text: normalized, params });
            if (normalized.includes('pg_try_advisory_lock')) {
                return { rows: [{ locked: true }], rowCount: 1 };
            }
            if (normalized.startsWith('SELECT generation_id FROM student_academic_profiles')) {
                return { rows: [{ generation_id: entry.generationId }], rowCount: 1 };
            }
            if (normalized.startsWith('SELECT id FROM academic_profile_deletion_ledger')) {
                return { rows: [], rowCount: 0 };
            }
            return { rows: [], rowCount: 0 };
        },
        release: (): void => undefined,
    };
    const pool = { connect: async () => client };

    const summary = await reconcileRestoredAcademicProfiles(pool, { ledgerFilePath: ledgerPath, dryRun: true });
    assert.equal(summary.ledgerEntriesRead, 1);
    assert.equal(summary.staleGenerationsPurged, 1);
    assert.equal(summary.recreatedGenerationsPreserved, 0);
    assert.equal(summary.dbLedgerEntriesRestored, 1);
    assert.equal(summary.dryRun, true);

    // No mutations executed in dry run
    assert.ok(statements.every((s) => !s.text.startsWith('DELETE')));
    assert.ok(statements.every((s) => !s.text.startsWith('INSERT')));
});

test('reconcileRestoredAcademicProfiles throws on lock contention', async () => {
    const client = {
        query: async (text: string): Promise<unknown> => {
            const normalized = text.replace(/\s+/g, ' ').trim();
            if (normalized.includes('pg_try_advisory_lock')) {
                return { rows: [{ locked: false }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        },
        release: (): void => undefined,
    };
    const pool = { connect: async () => client };

    await assert.rejects(
        () => reconcileRestoredAcademicProfiles(pool, { ledgerFilePath: ledgerPath }),
        /already in progress/,
    );
});
