import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeOwnAccount } from './account-closure.service.js';

process.env['ACADEMIC_PROFILE_RETENTION_DAYS'] = '30';

type Row = { role: string; password_hash: string | null; deleted_at: Date | null; active_session_id?: string | null };

function fakePool(row: Row | null) {
    const calls: { sql: string; params: unknown[] }[] = [];
    const client = {
        release() { /* fake */ },
        async query(sql: string, params: unknown[]) {
            calls.push({ sql, params });
            if (sql.startsWith('SELECT role, password_hash')) {
                return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
            }
            if (sql.startsWith('UPDATE users')) {
                return { rows: [{ deleted_at: new Date('2026-10-20T00:00:00Z') }], rowCount: 1 };
            }
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
                return { rows: [], rowCount: 0 };
            }
            throw new Error(`unexpected query: ${sql}`);
        },
    };
    return {
        calls,
        async connect() { return client; },
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
    assert.match(update.sql, /recovery_session_binding_required = true/);
    assert.match(update.sql, /password_reset_otp = NULL/);
    assert.match(update.sql, /student_sso_attempts_not_before = clock_timestamp\(\)/);
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

test('rejects a stale session rotated after authentication', async () => {
    const pool = fakePool({ ...student, active_session_id: 'session-new' });
    await assert.rejects(
        closeOwnAccount(pool as never, 'user-1', { password: 'correct', sessionId: 'session-old' }, async () => true),
        /Session is no longer current/,
    );
    assert.equal(pool.calls.some((call) => call.sql.startsWith('UPDATE users')), false);
    const ok = await closeOwnAccount(pool as never, 'user-1', { password: 'correct', sessionId: 'session-new' }, async () => true);
    assert.ok(ok.closedAt);
});

test('refuses closure when the retention window is not configured', async () => {
    const previous = process.env['ACADEMIC_PROFILE_RETENTION_DAYS'];
    delete process.env['ACADEMIC_PROFILE_RETENTION_DAYS'];
    try {
        const pool = fakePool(student);
        await assert.rejects(
            closeOwnAccount(pool as never, 'user-1', { password: 'correct' }, async () => true),
            /retention window is configured/,
        );
        assert.equal(pool.calls.some((call) => call.sql.startsWith('UPDATE users')), false);
    } finally {
        if (previous !== undefined) process.env['ACADEMIC_PROFILE_RETENTION_DAYS'] = previous;
    }
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
