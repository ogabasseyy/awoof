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
    assert.equal(pool.statements.length, 2);
    assert.ok(pool.statements[0]?.text.includes('clock_timestamp()'), 'cutoff must derive from the database clock');
    const statement = pool.statements[1];
    assert.ok(statement?.text.startsWith('DELETE FROM student_academic_profiles'));
    assert.ok(statement?.text.includes('deleted_at IS NOT NULL'));
    assert.ok(statement?.text.includes('deleted_at <= $1'), 'cutoff must be a bound param');
    assert.ok(!statement?.text.includes('2026'), 'statement text must not interpolate the cutoff');
    assert.deepEqual(statement?.params, [new Date(NOW.getTime() - 90 * DAY_MS)]);
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
