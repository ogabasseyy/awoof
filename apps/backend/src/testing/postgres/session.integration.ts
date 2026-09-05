import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import { db } from '../../config/database.js';
import { issueSession, refreshSession, revokeSession } from '../../services/auth/session.service.js';
import { jwtService, type TokenPayload } from '../../services/auth/jwt.service.js';
import { assertFixtureDatabase, createTestPool, withTestClient } from './test-database.js';

type Profile = { userId: string; email: string; role: TokenPayload['role']; passwordHash: string };

async function createProfile(client: PoolClient, role: 'student' | 'vendor', status: string = 'active'): Promise<Profile> {
    const userId = randomUUID();
    const email = `${role}-${randomUUID()}@example.invalid`;
    const passwordHash = `password-hash-${randomUUID()}`;
    await client.query('INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, $4)', [userId, email, passwordHash, role]);
    if (role === 'student') {
        await client.query('INSERT INTO students (user_id, name, status) VALUES ($1, $2, $3)', [userId, 'Synthetic Student', status]);
    } else {
        await client.query('INSERT INTO vendors (user_id, name, status) VALUES ($1, $2, $3)', [userId, 'Synthetic Vendor', status]);
    }
    return { userId, email, role, passwordHash };
}

async function assertIssueRejected(profile: Profile): Promise<void> {
    await assert.rejects(issueSession(profile, false, profile.passwordHash), /User session could not be issued/);
}

async function assertBlockedUserUpdate(observer: PoolClient): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const result = await observer.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity
             WHERE query LIKE 'UPDATE users%' AND cardinality(pg_blocking_pids(pid)) > 0`,
        );
        if (result.rowCount === 1) return;
        await delay(10);
    }
    throw new Error('Expected session issuance UPDATE to be blocked before releasing password-reset lock');
}

test('uses durable profile authority, stored hashes, and current database claims', async (t) => {
    const pool = createTestPool();
    t.after(async () => { await db.close(); await pool.end(); });
    const client = await pool.connect();
    try {
        await assertFixtureDatabase(client);
        const student = await createProfile(client, 'student');
        const pendingVendor = await createProfile(client, 'vendor', 'pending');
        const activeVendor = await createProfile(client, 'vendor');
        const studentTokens = await issueSession(student, false, student.passwordHash);
        const stored = await client.query<{ refresh_token_hash: string; refresh_token_expires_at: Date }>(
            'SELECT refresh_token_hash, refresh_token_expires_at FROM users WHERE id = $1', [student.userId],
        );
        assert.equal(stored.rows[0]?.refresh_token_hash, createHash('sha256').update(studentTokens.refreshToken).digest('hex'));
        assert.ok(stored.rows[0]?.refresh_token_expires_at instanceof Date);
        assert.equal(stored.rows[0]?.refresh_token_expires_at.getTime(), jwtService.verifyRefreshToken(studentTokens.refreshToken).exp! * 1000);
        assert.equal(jwtService.verifyAccessToken(await refreshSession(studentTokens.refreshToken)).email, student.email);
        const pendingTokens = await issueSession(pendingVendor, false, pendingVendor.passwordHash);
        const activeTokens = await issueSession(activeVendor, false, activeVendor.passwordHash);
        assert.equal(jwtService.verifyAccessToken(await refreshSession(pendingTokens.refreshToken)).role, 'vendor');
        assert.equal(jwtService.verifyAccessToken(await refreshSession(activeTokens.refreshToken)).role, 'vendor');

        const second = await issueSession(student, false, student.passwordHash);
        await assert.rejects(refreshSession(studentTokens.refreshToken), /Refresh token not found or invalid/);
        assert.equal(jwtService.verifyAccessToken(await refreshSession(second.refreshToken)).role, 'student');
        await revokeSession(student.userId);
        await assert.rejects(refreshSession(second.refreshToken), /Refresh token not found or invalid/);

        const staleStudent = await createProfile(client, 'student');
        const staleToken = await issueSession(staleStudent, false, staleStudent.passwordHash);
        await client.query('UPDATE users SET email = $2, role = $3 WHERE id = $1', [staleStudent.userId, `renamed-${randomUUID()}@example.invalid`, 'admin']);
        const current = jwtService.verifyAccessToken(await refreshSession(staleToken.refreshToken));
        assert.equal(current.email.startsWith('renamed-'), true);
        assert.equal(current.role, 'admin');
    } finally {
        client.release();
    }
});

test('denies suspended, rejected, deleted, and password-mismatched durable identities', async (t) => {
    t.after(async () => { await db.close(); });
    await withTestClient(async (client) => {
        const suspendedStudent = await createProfile(client, 'student', 'suspended');
        const deletedStudent = await createProfile(client, 'student', 'deleted');
        const suspendedVendor = await createProfile(client, 'vendor', 'suspended');
        const rejectedVendor = await createProfile(client, 'vendor', 'rejected');
        for (const profile of [suspendedStudent, deletedStudent, suspendedVendor, rejectedVendor]) await assertIssueRejected(profile);
        const deletedUser = await createProfile(client, 'student');
        await client.query('UPDATE users SET deleted_at = clock_timestamp() WHERE id = $1', [deletedUser.userId]);
        await assertIssueRejected(deletedUser);
        const deletedVendorAtIssue = await createProfile(client, 'vendor');
        await client.query('UPDATE vendors SET deleted_at = clock_timestamp() WHERE user_id = $1', [deletedVendorAtIssue.userId]);
        await assertIssueRejected(deletedVendorAtIssue);
        const mismatch = await createProfile(client, 'student');
        await assert.rejects(issueSession(mismatch, false, 'not-the-current-password-hash'), /User session could not be issued/);

        const token = jwtService.generateRefreshToken({ userId: randomUUID(), email: 'unregistered@example.invalid', role: 'student' });
        await assert.rejects(refreshSession(token), /Refresh token not found or invalid/);

        const activeStudent = await createProfile(client, 'student');
        const activeVendor = await createProfile(client, 'vendor');
        const studentSession = await issueSession(activeStudent, false, activeStudent.passwordHash);
        const vendorSession = await issueSession(activeVendor, false, activeVendor.passwordHash);
        await client.query('UPDATE students SET status = $2 WHERE user_id = $1', [activeStudent.userId, 'suspended']);
        await client.query('UPDATE vendors SET status = $2 WHERE user_id = $1', [activeVendor.userId, 'rejected']);
        await assert.rejects(refreshSession(studentSession.refreshToken), /Refresh token not found or invalid/);
        await assert.rejects(refreshSession(vendorSession.refreshToken), /Refresh token not found or invalid/);

        const newlyDeletedStudent = await createProfile(client, 'student');
        const newlyDeletedVendor = await createProfile(client, 'vendor');
        const deletedStudentSession = await issueSession(newlyDeletedStudent, false, newlyDeletedStudent.passwordHash);
        const deletedVendorSession = await issueSession(newlyDeletedVendor, false, newlyDeletedVendor.passwordHash);
        await client.query('UPDATE students SET status = $2 WHERE user_id = $1', [newlyDeletedStudent.userId, 'deleted']);
        await client.query('UPDATE vendors SET deleted_at = clock_timestamp() WHERE user_id = $1', [newlyDeletedVendor.userId]);
        await assert.rejects(refreshSession(deletedStudentSession.refreshToken), /Refresh token not found or invalid/);
        await assert.rejects(refreshSession(deletedVendorSession.refreshToken), /Refresh token not found or invalid/);

        const removedUser = await createProfile(client, 'student');
        const removedSession = await issueSession(removedUser, false, removedUser.passwordHash);
        await client.query('UPDATE users SET deleted_at = clock_timestamp() WHERE id = $1', [removedUser.userId]);
        await assert.rejects(refreshSession(removedSession.refreshToken), /Refresh token not found or invalid/);
    });
});

test('rejects a formerly checked password when reset commits before session issuance', async (t) => {
    const pool = createTestPool();
    t.after(async () => { await db.close(); await pool.end(); });
    const lockClient = await pool.connect();
    const observer = await pool.connect();
    try {
        await assertFixtureDatabase(lockClient);
        await assertFixtureDatabase(observer);
        const profile = await createProfile(lockClient, 'student');
        await lockClient.query('BEGIN');
        await lockClient.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [profile.userId]);
        await lockClient.query(
            `UPDATE users SET password_hash = $2, refresh_token_hash = NULL, refresh_token_expires_at = NULL WHERE id = $1`,
            [profile.userId, `reset-password-${randomUUID()}`],
        );
        const blockedIssue = issueSession(profile, false, profile.passwordHash);
        await assertBlockedUserUpdate(observer);
        await lockClient.query('COMMIT');
        await assert.rejects(blockedIssue, /User session could not be issued/);
    } finally {
        await lockClient.query('ROLLBACK').catch(() => undefined);
        lockClient.release();
        observer.release();
    }
});
