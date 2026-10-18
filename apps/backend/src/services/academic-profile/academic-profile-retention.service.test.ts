import assert from 'node:assert/strict';
import test from 'node:test';
import {
    purgeSoftDeletedAcademicProfiles,
    resolveAcademicProfileRetentionDays,
} from './academic-profile-retention.service.js';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

test('retention resolution fails closed when the approved window is unset', () => {
    for (const value of [null, undefined, '']) {
        assert.throws(
            () => resolveAcademicProfileRetentionDays(value),
            /not configured/,
            JSON.stringify(value) || 'undefined',
        );
    }
});

test('retention resolution rejects non-positive or non-integer windows', () => {
    for (const value of [0, -30, 1.5, Number.NaN, 'abc', '10x', '0', '-7', '9.5', '1e3', '+30', '0x10', '  1e3  ', ' 30 ', '30 ', true, {}, []]) {
        assert.throws(
            () => resolveAcademicProfileRetentionDays(value),
            /positive integer/,
            JSON.stringify(value) ?? String(value),
        );
    }
});

test('retention resolution accepts an approved positive integer window', () => {
    assert.equal(resolveAcademicProfileRetentionDays(90), 90);
    assert.equal(resolveAcademicProfileRetentionDays('90'), 90);
    assert.equal(resolveAcademicProfileRetentionDays(1), 1);
});

function createPurgePool(options: { rowCount: number | null; failTimes?: number; clock?: Date | null }): {
    connect: () => Promise<unknown>;
    statements: Array<{ text: string; params: unknown[] }>;
} {
    const statements: Array<{ text: string; params: unknown[] }> = [];
    let failures = options.failTimes ?? 0;
    const clock = options.clock === undefined ? NOW : options.clock;
    let pendingRows = options.rowCount ?? 0;
    const client = {
        query: async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number | null }> => {
            const normalized = text.replace(/\s+/g, ' ').trim();
            if (failures > 0) {
                failures -= 1;
                throw new Error('transient connection failure');
            }
            statements.push({ text: normalized, params });
            if (normalized.includes('clock_timestamp()')) {
                return { rows: clock === null ? [] : [{ now: clock }], rowCount: 1 };
            }
            if (normalized.startsWith('SELECT sap.user_id, sap.generation_id')) {
                if (pendingRows <= 0) return { rows: [], rowCount: 0 };
                const count = pendingRows;
                pendingRows = 0;
                const rows = Array.from({ length: count }, (_, i) => ({
                    user_id: `22222222-2222-4222-8222-${String(i + 1).padStart(12, '0')}`,
                    generation_id: `33333333-3333-4333-8333-${String(i + 1).padStart(12, '0')}`,
                }));
                return { rows, rowCount: count };
            }
            if (normalized.startsWith('INSERT INTO academic_profile_deletion_ledger')) {
                return { rows: [{ id: '00000000-0000-4000-8000-000000000099', erased_at: NOW }], rowCount: 1 };
            }
            return { rows: [], rowCount: options.rowCount };
        },
        release: (): void => undefined,
    };
    return { connect: async () => client, statements };
}

test('purge derives the cutoff from the database clock, not the scheduler host', async () => {
    const pool = createPurgePool({ rowCount: 2 });
    const summary = await purgeSoftDeletedAcademicProfiles(pool, 90);
    assert.deepEqual(summary, { deletedProfiles: 2, cutoff: new Date(NOW.getTime() - 90 * DAY_MS).toISOString() });
    assert.deepEqual(Object.keys(summary).sort(), ['cutoff', 'deletedProfiles']);
    assert.ok(pool.statements[0]?.text.includes('clock_timestamp()'), 'cutoff must derive from the database clock');
    const selectStatement = pool.statements.find((s) => s.text.startsWith('SELECT sap.user_id'));
    assert.ok(selectStatement?.text.includes('deleted_at IS NOT NULL'));
    assert.ok(selectStatement?.text.includes('deleted_at <= $1'), 'cutoff must be a bound param');
    assert.ok(!selectStatement?.text.includes('2026'), 'statement text must not interpolate the cutoff');
    assert.deepEqual(selectStatement?.params[0], new Date(NOW.getTime() - 90 * DAY_MS));
    const deleteStatement = pool.statements.find((s) => s.text.startsWith('DELETE FROM student_academic_profiles'));
    assert.ok(deleteStatement);
});

test('purge reports zero when nothing is due without touching other rows', async () => {
    const empty = createPurgePool({ rowCount: 0 });
    assert.deepEqual(await purgeSoftDeletedAcademicProfiles(empty, 90), {
        deletedProfiles: 0,
        cutoff: new Date(NOW.getTime() - 90 * DAY_MS).toISOString(),
    });
    const nullCount = createPurgePool({ rowCount: null });
    assert.equal((await purgeSoftDeletedAcademicProfiles(nullCount, 90)).deletedProfiles, 0);
});

test('purge refuses invalid windows and clocks without issuing a delete', async () => {
    for (const retentionDays of [0, -30, 1.5, Number.NaN]) {
        const pool = createPurgePool({ rowCount: 5 });
        await assert.rejects(purgeSoftDeletedAcademicProfiles(pool, retentionDays), /positive integer/);
        assert.deepEqual(pool.statements, []);
    }
    const brokenClock = createPurgePool({ rowCount: 5, clock: null });
    await assert.rejects(purgeSoftDeletedAcademicProfiles(brokenClock, 90), /valid database clock/);
    assert.ok(brokenClock.statements.every((statement) => !statement.text.startsWith('DELETE')));
    const unrepresentable = createPurgePool({ rowCount: 5 });
    await assert.rejects(purgeSoftDeletedAcademicProfiles(unrepresentable, 1e308), /valid cutoff/);
    assert.ok(unrepresentable.statements.every((statement) => !statement.text.startsWith('DELETE')));
});

test('purge failures propagate so the scheduler retries; reruns are idempotent', async () => {
    const flaky = createPurgePool({ rowCount: 1, failTimes: 1 });
    await assert.rejects(purgeSoftDeletedAcademicProfiles(flaky, 90), /transient connection failure/);
    const summary = await purgeSoftDeletedAcademicProfiles(flaky, 90);
    assert.equal(summary.deletedProfiles, 1);
    const drained = createPurgePool({ rowCount: 0 });
    assert.equal((await purgeSoftDeletedAcademicProfiles(drained, 90)).deletedProfiles, 0);
});

test('purge summaries and statements never carry deleted values', async () => {
    const pool = createPurgePool({ rowCount: 1 });
    const summary = await purgeSoftDeletedAcademicProfiles(pool, 90);
    const serialized = JSON.stringify({ summary, statements: pool.statements });
    assert.ok(!serialized.includes('@'), 'no emails in purge audit material');
    assert.ok(!serialized.includes('11111111'), 'no user ids in purge audit material');
    const statement = pool.statements.find((candidate) => candidate.text.startsWith('DELETE'));
    assert.ok(!/RETURNING/.test(statement?.text ?? ''), 'purge must not read back deleted values');
});

test('dryRun counts candidate profiles without issuing DELETE', async () => {
    const statements: Array<{ text: string; params: unknown[] }> = [];
    const client = {
        query: async (text: string, params: unknown[] = []): Promise<unknown> => {
            const normalized = text.replace(/\s+/g, ' ').trim();
            statements.push({ text: normalized, params });
            if (normalized.includes('clock_timestamp()')) {
                return { rows: [{ now: NOW }], rowCount: 1 };
            }
            if (normalized.startsWith('SELECT COUNT(*)')) {
                return { rows: [{ count: '7' }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        },
        release: (): void => undefined,
    };
    const pool = { connect: async () => client };
    const summary = await purgeSoftDeletedAcademicProfiles(pool, 90, { dryRun: true });
    assert.deepEqual(summary, {
        deletedProfiles: 0,
        scannedProfiles: 7,
        cutoff: new Date(NOW.getTime() - 90 * DAY_MS).toISOString(),
        dryRun: true,
        batchesProcessed: 0,
    });
    assert.ok(statements.every((s) => !s.text.startsWith('DELETE')));
});

test('advisory lock contention skips purge safely', async () => {
    const statements: Array<{ text: string; params: unknown[] }> = [];
    const client = {
        query: async (text: string, params: unknown[] = []): Promise<unknown> => {
            const normalized = text.replace(/\s+/g, ' ').trim();
            statements.push({ text: normalized, params });
            if (normalized.includes('pg_try_advisory_lock')) {
                return { rows: [{ locked: false }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        },
        release: (): void => undefined,
    };
    const pool = { connect: async () => client };
    const summary = await purgeSoftDeletedAcademicProfiles(pool, 90, { useAdvisoryLock: true });
    assert.equal(summary.deletedProfiles, 0);
    assert.equal(summary.skippedDueToLock, true);
    assert.ok(statements.every((s) => !s.text.startsWith('DELETE')));
});

test('batching processes candidates and records in deletion ledger', async () => {
    const statements: Array<{ text: string; params: unknown[] }> = [];
    let selectBatchCalled = false;
    const client = {
        query: async (text: string, params: unknown[] = []): Promise<unknown> => {
            const normalized = text.replace(/\s+/g, ' ').trim();
            statements.push({ text: normalized, params });
            if (normalized.includes('clock_timestamp()')) {
                return { rows: [{ now: NOW }], rowCount: 1 };
            }
            if (normalized.startsWith('SELECT sap.user_id')) {
                if (!selectBatchCalled) {
                    selectBatchCalled = true;
                    return {
                        rows: [
                            { user_id: '00000000-0000-4000-8000-000000000001', generation_id: '11111111-1111-4111-8111-111111111111' },
                        ],
                        rowCount: 1,
                    };
                }
                return { rows: [], rowCount: 0 };
            }
            if (normalized.includes('academic_profile_deletion_ledger')) {
                return { rows: [{ id: 'ledger-entry-1', erased_at: new Date(NOW) }], rowCount: 1 };
            }
            if (normalized.startsWith('DELETE FROM student_academic_profiles')) {
                return { rows: [], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        },
        release: (): void => undefined,
    };
    const pool = { connect: async () => client };
    const summary = await purgeSoftDeletedAcademicProfiles(pool, 90, { batchSize: 10, ledgerFilePath: 'backups/test-ledger.jsonl' });
    assert.equal(summary.deletedProfiles, 1);
    assert.equal(summary.batchesProcessed, 1);
    assert.ok(statements.some((s) => s.text.includes('academic_profile_deletion_ledger')));
    assert.ok(statements.some((s) => s.text.startsWith('DELETE FROM student_academic_profiles WHERE user_id = ANY')));
});

