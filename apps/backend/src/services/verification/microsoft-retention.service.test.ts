import assert from 'node:assert/strict';
import test from 'node:test';
import { MicrosoftRetentionService } from './microsoft-retention.service.js';

type Query = { sql: string; values?: unknown[] };

function fixture(): { service: MicrosoftRetentionService; queries: Query[] } {
    const queries: Query[] = [];
    const client = {
        query: async (sql: string, values?: unknown[]) => {
            queries.push({ sql, values });
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
            return { rowCount: sql.includes('microsoft_verification_attempts') ? 3 : 2, rows: [] };
        },
        release: () => undefined,
    };
    return {
        service: new MicrosoftRetentionService({ pool: { connect: async () => client } as never, now: () => new Date('2026-09-13T12:00:00.000Z') }),
        queries,
    };
}

test('retention is bounded, preserves a current completed receipt, and uses only its injected clock', async () => {
    const { service, queries } = fixture();
    assert.deepEqual(await service.cleanup(), { attempts: 3, diagnostics: 2 });
    const attempts = queries.find((query) => query.sql.includes('UPDATE microsoft_verification_attempts'))!;
    assert.match(attempts.sql, /LIMIT 500/);
    assert.match(attempts.sql, /status = 'completed'/);
    assert.match(attempts.sql, /candidate\.expires_at <= \$1::timestamptz/);
    assert.match(attempts.sql, /ELSE attempt\.finish_secret_hash/);
    assert.match(attempts.sql, /ELSE attempt\.result/);
    assert.deepEqual(attempts.values, [new Date('2026-09-13T12:00:00.000Z')]);
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

test('unknown stored statuses are not selected for destructive cleanup', async () => {
    const { service, queries } = fixture();
    await service.cleanup();
    const attempts = queries.find((query) => query.sql.includes('UPDATE microsoft_verification_attempts'))!;
    assert.doesNotMatch(attempts.sql, /status NOT IN/);
    assert.match(attempts.sql, /status IN \('pending', 'processing', 'ready'\)/);
    assert.match(attempts.sql, /status = 'failed'/);
    assert.match(attempts.sql, /status = 'completed'/);
});
