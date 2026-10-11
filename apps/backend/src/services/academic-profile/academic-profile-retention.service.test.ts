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
    for (const value of [0, -30, 1.5, Number.NaN, 'abc', '10x', '0', '-7', '9.5', '1e3', '+30', '0x10', '  1e3  ', true, {}, []]) {
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
    assert.equal(resolveAcademicProfileRetentionDays('  30  '), 30);
    assert.equal(resolveAcademicProfileRetentionDays(1), 1);
});

function createPurgePool(options: { rowCount: number | null; failTimes?: number }): {
    connect: () => Promise<unknown>;
    statements: Array<{ text: string; params: unknown[] }>;
} {
    const statements: Array<{ text: string; params: unknown[] }> = [];
    let failures = options.failTimes ?? 0;
    const client = {
        query: async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number | null }> => {
            const normalized = text.replace(/\s+/g, ' ').trim();
            if (failures > 0) {
                failures -= 1;
                throw new Error('transient connection failure');
            }
            statements.push({ text: normalized, params });
            return { rows: [], rowCount: options.rowCount };
        },
        release: (): void => undefined,
    };
    return { connect: async () => client, statements };
}

test('purge deletes only due soft-deleted rows through one parameterized statement', async () => {
    const pool = createPurgePool({ rowCount: 2 });
    const summary = await purgeSoftDeletedAcademicProfiles(pool, 90, NOW);
    assert.deepEqual(summary, { deletedProfiles: 2, cutoff: new Date(NOW.getTime() - 90 * DAY_MS).toISOString() });
    assert.deepEqual(Object.keys(summary).sort(), ['cutoff', 'deletedProfiles']);
    assert.equal(pool.statements.length, 1);
    const statement = pool.statements[0];
    assert.ok(statement?.text.startsWith('DELETE FROM student_academic_profiles'));
    assert.ok(statement?.text.includes('deleted_at IS NOT NULL'));
    assert.ok(statement?.text.includes('deleted_at <= $1'), 'cutoff must be a bound param');
    assert.ok(!statement?.text.includes('2026'), 'statement text must not interpolate the cutoff');
    assert.deepEqual(statement?.params, [new Date(NOW.getTime() - 90 * DAY_MS)]);
});

test('purge reports zero when nothing is due without touching other rows', async () => {
    const empty = createPurgePool({ rowCount: 0 });
    assert.deepEqual(await purgeSoftDeletedAcademicProfiles(empty, 90, NOW), {
        deletedProfiles: 0,
        cutoff: new Date(NOW.getTime() - 90 * DAY_MS).toISOString(),
    });
    const nullCount = createPurgePool({ rowCount: null });
    assert.equal((await purgeSoftDeletedAcademicProfiles(nullCount, 90, NOW)).deletedProfiles, 0);
});

test('purge refuses invalid windows and clocks without issuing a delete', async () => {
    for (const retentionDays of [0, -30, 1.5, Number.NaN]) {
        const pool = createPurgePool({ rowCount: 5 });
        await assert.rejects(purgeSoftDeletedAcademicProfiles(pool, retentionDays, NOW), /positive integer/);
        assert.deepEqual(pool.statements, []);
    }
    const pool = createPurgePool({ rowCount: 5 });
    await assert.rejects(purgeSoftDeletedAcademicProfiles(pool, 90, new Date('invalid')), /valid/);
    assert.deepEqual(pool.statements, []);
    const unrepresentable = createPurgePool({ rowCount: 5 });
    await assert.rejects(purgeSoftDeletedAcademicProfiles(unrepresentable, 1e308, NOW), /valid cutoff/);
    assert.deepEqual(unrepresentable.statements, []);
});

test('purge failures propagate so the scheduler retries; reruns are idempotent', async () => {
    const flaky = createPurgePool({ rowCount: 1, failTimes: 1 });
    await assert.rejects(purgeSoftDeletedAcademicProfiles(flaky, 90, NOW), /transient connection failure/);
    const summary = await purgeSoftDeletedAcademicProfiles(flaky, 90, NOW);
    assert.equal(summary.deletedProfiles, 1);
    const drained = createPurgePool({ rowCount: 0 });
    assert.equal((await purgeSoftDeletedAcademicProfiles(drained, 90, NOW)).deletedProfiles, 0);
});

test('purge summaries and statements never carry deleted values', async () => {
    const pool = createPurgePool({ rowCount: 1 });
    const summary = await purgeSoftDeletedAcademicProfiles(pool, 90, NOW);
    const serialized = JSON.stringify({ summary, statements: pool.statements });
    assert.ok(!serialized.includes('@'), 'no emails in purge audit material');
    assert.ok(!serialized.includes('11111111'), 'no user ids in purge audit material');
    assert.ok(!/RETURNING/.test(pool.statements[0]?.text ?? ''), 'purge must not read back deleted values');
});
