import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeOwnAccount } from './account-closure.service.js';

type Row = { role: string; password_hash: string | null; deleted_at: Date | null };

function fakePool(row: Row | null) {
    const calls: { sql: string; params: unknown[] }[] = [];
    return {
        calls,
        async query(sql: string, params: unknown[]) {
            calls.push({ sql, params });
            if (sql.startsWith('SELECT role, password_hash')) {
                return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
            }
            if (sql.startsWith('UPDATE users')) {
                return { rows: [{ deleted_at: new Date('2026-10-20T00:00:00Z') }], rowCount: 1 };
            }
            throw new Error(`unexpected query: ${sql}`);
        },
    };
}

const student: Row = { role: 'student', password_hash: 'hash', deleted_at: null };

test('closes a password account after password verification and revokes sessions', async () => {
    const pool = fakePool(student);
    const result = await closeOwnAccount(pool as never, 'user-1', { password: 'correct' }, async () => true);
    assert.equal(result.closedAt.toISOString(), '2026-10-20T00:00:00.000Z');
    const update = pool.calls.find((call) => call.sql.startsWith('UPDATE users'));
    assert.ok(update);
    assert.match(update.sql, /deleted_at = CURRENT_TIMESTAMP/);
    assert.match(update.sql, /refresh_token_hash = NULL/);
    assert.match(update.sql, /active_session_id = NULL/);
    assert.match(update.sql, /credential_generation = credential_generation \+ 1/);
});

test('rejects a wrong password without updating', async () => {
    const pool = fakePool(student);
    await assert.rejects(
        closeOwnAccount(pool as never, 'user-1', { password: 'wrong' }, async () => false),
        /Password confirmation failed/,
    );
    assert.equal(pool.calls.some((call) => call.sql.startsWith('UPDATE users')), false);
});

test('passwordless accounts require the exact confirmation phrase', async () => {
    const pool = fakePool({ role: 'student', password_hash: null, deleted_at: null });
    await assert.rejects(
        closeOwnAccount(pool as never, 'user-1', { confirmation: 'close' }),
        /CLOSE MY ACCOUNT/,
    );
    const ok = await closeOwnAccount(pool as never, 'user-1', { confirmation: 'CLOSE MY ACCOUNT' });
    assert.ok(ok.closedAt);
});

test('rejects missing, already-closed, and non-student accounts', async () => {
    await assert.rejects(closeOwnAccount(fakePool(null) as never, 'nope', {}), /Account not found/);
    await assert.rejects(
        closeOwnAccount(fakePool({ ...student, deleted_at: new Date() }) as never, 'user-1', { password: 'x' }, async () => true),
        /already closed/,
    );
    await assert.rejects(
        closeOwnAccount(fakePool({ ...student, role: 'vendor' }) as never, 'user-1', { password: 'x' }, async () => true),
        /cannot be closed from settings/,
    );
});
