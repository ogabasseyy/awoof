import assert from 'node:assert/strict';
import test from 'node:test';
import { MicrosoftRetentionService } from './microsoft-retention.service.js';

type Query = { sql: string; values?: unknown[] };

const databaseNow = new Date('2026-09-13T12:00:00.000Z');

function fixture(): { service: MicrosoftRetentionService; queries: Query[] } {
    const queries: Query[] = [];
    const client = {
        query: async (sql: string, values?: unknown[]) => {
            queries.push({ sql, values });
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
            if (sql.includes('SELECT clock_timestamp() AS now')) return { rowCount: 1, rows: [{ now: databaseNow }] };
            return { rowCount: sql.includes('microsoft_verification_attempts') ? 3 : 2, rows: [] };
        },
        release: () => undefined,
    };
    return {
        service: new MicrosoftRetentionService({ pool: { connect: async () => client } as never }),
        queries,
    };
}

test('retention is bounded, preserves a current completed receipt, and reads its cutoff from the database clock', async () => {
    const { service, queries } = fixture();
    assert.deepEqual(await service.cleanup(), { attempts: 3, diagnostics: 2 });
    const clockIndex = queries.findIndex((query) => query.sql.includes('SELECT clock_timestamp() AS now'));
    const attemptsIndex = queries.findIndex((query) => query.sql.includes('UPDATE microsoft_verification_attempts'));
    assert.ok(clockIndex >= 0 && clockIndex < attemptsIndex, 'the database cutoff must precede the cleanup writes');
    const attempts = queries[attemptsIndex]!;
    assert.match(attempts.sql, /LIMIT 500/);
    assert.match(attempts.sql, /status = 'completed'/);
    assert.match(attempts.sql, /candidate\.expires_at <= \$1::timestamptz/);
    assert.match(attempts.sql, /ELSE attempt\.finish_secret_hash/);
    assert.match(attempts.sql, /ELSE attempt\.result/);
    assert.deepEqual(attempts.values, [databaseNow]);
});

test('retention terminalizes expired unfinished attempts and removes only diagnostics beyond 30 days', async () => {
    const { service, queries } = fixture();
    await service.cleanup();
    const attempts = queries.find((query) => query.sql.includes('UPDATE microsoft_verification_attempts'))!;
    const diagnostics = queries.find((query) => query.sql.includes('DELETE FROM verification_diagnostic_events'))!;
    assert.match(attempts.sql, /status IN \('pending', 'processing', 'ready'\) AND expires_at <= \$1::timestamptz/);
    assert.match(attempts.sql, /THEN 'failed'/);
    assert.match(attempts.sql, /state_hash = NULL/);
    assert.match(attempts.sql, /browser_secret_hash = NULL/);
    assert.match(attempts.sql, /encrypted_verifier = NULL/);
    assert.match(attempts.sql, /nonce = NULL/);
    assert.match(diagnostics.sql, /recorded_at < \$1::timestamptz - interval '30 days'/);
    assert.match(diagnostics.sql, /FOR UPDATE SKIP LOCKED/);
    assert.match(diagnostics.sql, /LIMIT 500/);
});

function scriptedFixture(
    counts: Array<{ attempts: number; diagnostics: number }>,
    remaining: Array<{ attempts: number; diagnostics: number }> = [{ attempts: 0, diagnostics: 0 }],
): { service: MicrosoftRetentionService; queries: Query[] } {
    const queries: Query[] = [];
    let pass = 0;
    let remainingIndex = 0;
    const client = {
        query: async (sql: string, values?: unknown[]) => {
            queries.push({ sql, values });
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
            if (sql.includes('SELECT clock_timestamp() AS now')) return { rowCount: 1, rows: [{ now: databaseNow }] };
            if (sql.includes('SELECT COUNT(*)')) {
                // The attempts count always precedes the diagnostics count;
                // both belong to one remaining-work check.
                const entry = remaining[Math.min(remainingIndex, remaining.length - 1)]!;
                const count = sql.includes('microsoft_verification_attempts') ? entry.attempts : entry.diagnostics;
                if (!sql.includes('microsoft_verification_attempts')) remainingIndex += 1;
                return { rowCount: 1, rows: [{ count: String(count) }] };
            }
            const current = counts[Math.min(pass, counts.length - 1)]!;
            const rowCount = sql.includes('microsoft_verification_attempts') ? current.attempts : current.diagnostics;
            if (sql.includes('DELETE FROM verification_diagnostic_events')) pass += 1;
            return { rowCount, rows: [] };
        },
        release: () => undefined,
    };
    return {
        service: new MicrosoftRetentionService({ pool: { connect: async () => client } as never }),
        queries,
    };
}

test('cleanupAll drains full batches across passes and totals every row', async () => {
    const { service, queries } = scriptedFixture([
        { attempts: 500, diagnostics: 500 },
        { attempts: 500, diagnostics: 3 },
        { attempts: 2, diagnostics: 0 },
    ]);
    assert.deepEqual(await service.cleanupAll(), { attempts: 1002, diagnostics: 503, passes: 3, complete: true });
    assert.equal(queries.filter((query) => query.sql === 'BEGIN').length, 3, 'each pass must stay in its own bounded transaction');
});

test('cleanupAll reports incomplete instead of looping forever under continuous backlog', async () => {
    const { service } = scriptedFixture([{ attempts: 500, diagnostics: 500 }]);
    assert.deepEqual(await service.cleanupAll(2), { attempts: 1000, diagnostics: 1000, passes: 2, complete: false });
});

test('cleanupAll reports incomplete when lock-skipped rows survive a short pass', async () => {
    const { service, queries } = scriptedFixture(
        [{ attempts: 3, diagnostics: 2 }],
        [{ attempts: 4, diagnostics: 0 }],
    );
    assert.deepEqual(await service.cleanupAll(), { attempts: 3, diagnostics: 2, passes: 1, complete: false });
    const counts = queries.filter((query) => query.sql.includes('SELECT COUNT(*)'));
    assert.equal(counts.length, 2);
    assert.ok(!counts.some((query) => query.sql.includes('FOR UPDATE')), 'the remaining-work check must not take row locks');
});

test('unknown stored statuses are not selected for destructive cleanup', async () => {
    const { service, queries } = fixture();
    await service.cleanup();
    const attempts = queries.find((query) => query.sql.includes('UPDATE microsoft_verification_attempts'))!;
    assert.doesNotMatch(attempts.sql, /status NOT IN/);
    assert.match(attempts.sql, /status IN \('pending', 'processing', 'ready'\)/);
    assert.match(attempts.sql, /status = 'failed'/);
    assert.match(attempts.sql, /status = 'completed'/);
});
