import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { PoolClient } from 'pg';
import { db } from '../../config/database.js';
import { jwtService } from './jwt.service.js';
import { issueSession, issueSessionInTransaction, refreshSession, revokeSession } from './session.service.js';

const userId = '11111111-1111-4111-8111-111111111111';
const student = { userId, email: 'student@example.invalid', role: 'student' as const };

type RecordedCall = { text: string; params: unknown[] | undefined };

function stubPool(t: TestContext, handler: (text: string, params?: unknown[]) => unknown): { calls: RecordedCall[]; releases: number } {
    const calls: RecordedCall[] = [];
    let releases = 0;
    const client = {
        query: async (text: string, params?: unknown[]) => {
            calls.push({ text, params });
            return handler(text, params) as never;
        },
        release: () => { releases += 1; },
    };
    t.mock.method(db, 'getPool', (() => ({ connect: async () => client })) as never);
    return { calls, get releases() { return releases; } } as { calls: RecordedCall[]; releases: number };
}

test('issues a distinct refresh token and persists its hash, expiry, and checked password hash', async (t) => {
    const pool = stubPool(t, (text) => {
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
        return { rows: [{ id: userId }], rowCount: 1 };
    });

    const before = Math.floor(Date.now() / 1000);
    const first = await issueSession(student, false, 'checked-password-hash');
    const second = await issueSession(student, false, 'checked-password-hash');

    assert.notEqual(first.refreshToken, second.refreshToken);
    const firstSessionId = jwtService.verifyAccessToken(first.accessToken).sid;
    const secondSessionId = jwtService.verifyAccessToken(second.accessToken).sid;
    assert.match(firstSessionId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.match(secondSessionId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.notEqual(firstSessionId, secondSessionId);
    assert.equal(jwtService.verifyRefreshToken(first.refreshToken).sid, firstSessionId);
    // Each password sign-in opens and commits its own transaction around one session write.
    assert.deepEqual(pool.calls.map((call) => call.text === 'BEGIN' || call.text === 'COMMIT' || call.text === 'ROLLBACK' ? call.text : 'UPDATE'), [
        'BEGIN', 'UPDATE', 'COMMIT',
        'BEGIN', 'UPDATE', 'COMMIT',
    ]);
    assert.equal(pool.releases, 2);
    const firstExpiry = jwtService.verifyRefreshToken(first.refreshToken).exp;
    assert.equal(typeof firstExpiry, 'number');
    assert.ok(firstExpiry! >= before + (7 * 24 * 60 * 60) - 1);
    assert.ok(firstExpiry! <= before + (7 * 24 * 60 * 60) + 1);
    const firstUpdate = pool.calls[1]!;
    assert.deepEqual(firstUpdate.params, [
        userId,
        createHash('sha256').update(first.refreshToken).digest('hex'),
        new Date(firstExpiry! * 1000),
        'checked-password-hash',
        'student',
        firstSessionId,
    ]);
    assert.match(firstUpdate.text, /active_session_auth_identity_id = NULL/);
});

test('issues a thirty-day refresh token when remember me is selected', async (t) => {
    stubPool(t, (text) => {
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
        return { rows: [{ id: userId }], rowCount: 1 };
    });
    const before = Math.floor(Date.now() / 1000);

    const tokens = await issueSession(student, true);
    const expiry = jwtService.verifyRefreshToken(tokens.refreshToken).exp;

    assert.ok(expiry);
    assert.ok(expiry >= before + (30 * 24 * 60 * 60) - 1);
    assert.ok(expiry <= before + (30 * 24 * 60 * 60) + 1);
});

test('refuses to issue a session when the checked password no longer matches', async (t) => {
    const pool = stubPool(t, (text) => {
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
    });

    await assert.rejects(
        issueSession(student, false, 'password-hash-checked-before-race'),
        /User session could not be issued/,
    );
    assert.deepEqual(pool.calls.map((call) => call.text), ['BEGIN', pool.calls[1]!.text, 'ROLLBACK']);
    assert.equal(pool.releases, 1);
});

test('transaction writer uses only the supplied client and never the global pool', async (t) => {
    t.mock.method(db, 'query', async () => { throw new Error('global pool must not be touched'); });
    t.mock.method(db, 'getPool', (() => { throw new Error('global pool must not be touched'); }) as never);
    const calls: RecordedCall[] = [];
    const tx = {
        query: async (text: string, params?: unknown[]) => {
            calls.push({ text, params });
            return { rows: [{ id: userId }], rowCount: 1 } as never;
        },
    } as unknown as PoolClient;

    const tokens = await issueSessionInTransaction(tx, student, false, 'checked-password-hash');

    assert.equal(calls.length, 1);
    assert.match(calls[0]!.text, /UPDATE users/);
    assert.match(calls[0]!.text, /active_session_auth_identity_id = NULL/);
    assert.ok(tokens.accessToken);
    assert.ok(tokens.refreshToken);
});

test('refreshes from current database identity rather than stale token claims', async (t) => {
    const sid = '11111111-1111-4111-8111-111111111111';
    const token = jwtService.generateRefreshToken({ ...student, sid });
    const calls: Array<{ text: string; params: unknown[] | undefined }> = [];
    t.mock.method(db, 'query', async (text: string, params?: unknown[]) => {
        calls.push({ text, params });
        return {
            rows: [{ id: userId, email: 'new-admin@example.invalid', role: 'admin' }],
            rowCount: 1,
        } as never;
    });

    const accessToken = await refreshSession(token);

    const decoded = jwtService.verifyAccessToken(accessToken);
    assert.equal(decoded.userId, userId);
    assert.equal(decoded.email, 'new-admin@example.invalid');
    assert.equal(decoded.role, 'admin');
    assert.equal(decoded.sid, sid);
    assert.deepEqual(calls[0]!.params, [
        userId,
        createHash('sha256').update(token).digest('hex'),
        sid,
    ]);
});

test('refreshes a pending vendor session when durable authority permits it', async (t) => {
    const vendor = {
        userId,
        email: 'vendor@example.invalid',
        role: 'vendor' as const,
    };
    const token = jwtService.generateRefreshToken(vendor);
    t.mock.method(db, 'query', async () => ({
        rows: [{ id: userId, email: vendor.email, role: 'vendor' }],
        rowCount: 1,
    }) as never);

    const accessToken = await refreshSession(token);

    assert.equal(jwtService.verifyAccessToken(accessToken).role, 'vendor');
});

test('rejects unregistered, revoked, deleted, suspended, or rejected refresh sessions', async (t) => {
    const token = jwtService.generateRefreshToken(student);
    const unavailableStates = ['unregistered', 'revoked', 'deleted', 'suspended student', 'rejected vendor'];
    let queryCount = 0;
    t.mock.method(db, 'query', async () => {
        queryCount += 1;
        return { rows: [], rowCount: 0 } as never;
    });

    for (const state of unavailableStates) {
        await assert.rejects(refreshSession(token), /Refresh token not found or invalid/, state);
    }
    assert.equal(queryCount, unavailableStates.length);
});

test('rejects an expired refresh token before querying durable authority', async (t) => {
    const expired = jwtService.generateRefreshToken(student, '-1s');
    let queryCount = 0;
    t.mock.method(db, 'query', async () => {
        queryCount += 1;
        return { rows: [{ id: userId, email: student.email, role: 'student' }], rowCount: 1 } as never;
    });

    await assert.rejects(refreshSession(expired), /Invalid or expired refresh token/);
    assert.equal(queryCount, 0);
});

test('propagates durable authority failures without issuing an access token', async (t) => {
    const token = jwtService.generateRefreshToken(student);
    t.mock.method(db, 'query', async () => { throw new Error('database unavailable'); });

    await assert.rejects(refreshSession(token), /database unavailable/);
});

test('clears a durable refresh session regardless of Redis availability', async (t) => {
    const calls: Array<{ text: string; params: unknown[] | undefined }> = [];
    t.mock.method(db, 'query', async (text: string, params?: unknown[]) => {
        calls.push({ text, params });
        return { rows: [], rowCount: 1 } as never;
    });

    await revokeSession(userId);

    assert.deepEqual(calls[0]!.params, [userId]);
    assert.match(calls[0]!.text, /refresh_token_hash = NULL/);
    assert.match(calls[0]!.text, /refresh_token_expires_at = NULL/);
    assert.match(calls[0]!.text, /active_session_id = NULL/);
    assert.match(calls[0]!.text, /active_session_auth_identity_id = NULL/);
});
