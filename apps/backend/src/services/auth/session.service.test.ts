import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { db } from '../../config/database.js';
import { jwtService } from './jwt.service.js';
import { issueSession, refreshSession, revokeSession } from './session.service.js';

const userId = '11111111-1111-4111-8111-111111111111';
const student = { userId, email: 'student@example.invalid', role: 'student' as const };

test('issues a distinct refresh token and persists its hash, expiry, and checked password hash', async (t) => {
    const calls: Array<{ text: string; params: unknown[] | undefined }> = [];
    t.mock.method(db, 'query', async (text: string, params?: unknown[]) => {
        calls.push({ text, params });
        return { rows: [{ id: userId }], rowCount: 1 } as never;
    });

    const before = Math.floor(Date.now() / 1000);
    const first = await issueSession(student, false, 'checked-password-hash');
    const second = await issueSession(student, false, 'checked-password-hash');

    assert.notEqual(first.refreshToken, second.refreshToken);
    assert.equal(calls.length, 2);
    const firstExpiry = jwtService.verifyRefreshToken(first.refreshToken).exp;
    assert.equal(typeof firstExpiry, 'number');
    assert.ok(firstExpiry! >= before + (7 * 24 * 60 * 60) - 1);
    assert.ok(firstExpiry! <= before + (7 * 24 * 60 * 60) + 1);
    assert.deepEqual(calls[0].params, [
        userId,
        createHash('sha256').update(first.refreshToken).digest('hex'),
        new Date(firstExpiry! * 1000),
        'checked-password-hash',
        'student',
    ]);
});

test('issues a thirty-day refresh token when remember me is selected', async (t) => {
    t.mock.method(db, 'query', async () => ({ rows: [{ id: userId }], rowCount: 1 }) as never);
    const before = Math.floor(Date.now() / 1000);

    const tokens = await issueSession(student, true);
    const expiry = jwtService.verifyRefreshToken(tokens.refreshToken).exp;

    assert.ok(expiry);
    assert.ok(expiry >= before + (30 * 24 * 60 * 60) - 1);
    assert.ok(expiry <= before + (30 * 24 * 60 * 60) + 1);
});

test('refuses to issue a session when the checked password no longer matches', async (t) => {
    t.mock.method(db, 'query', async () => ({ rows: [], rowCount: 0 }) as never);

    await assert.rejects(
        issueSession(student, false, 'password-hash-checked-before-race'),
        /User session could not be issued/,
    );
});

test('refreshes from current database identity rather than stale token claims', async (t) => {
    const token = jwtService.generateRefreshToken(student);
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
    assert.deepEqual(calls[0].params, [
        userId,
        createHash('sha256').update(token).digest('hex'),
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

    assert.deepEqual(calls[0].params, [userId]);
    assert.match(calls[0].text, /refresh_token_hash = NULL/);
    assert.match(calls[0].text, /refresh_token_expires_at = NULL/);
});
