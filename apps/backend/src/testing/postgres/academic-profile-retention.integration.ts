import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import type { PoolClient } from 'pg';
import { db } from '../../config/database.js';
import {
    purgeSoftDeletedAcademicProfiles,
    resolveAcademicProfileRetentionDays,
} from '../../services/academic-profile/academic-profile-retention.service.js';
import { withTestClient } from './test-database.js';

after(() => db.close());

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 90;

function uniqueLabel(): string {
    return randomUUID().replaceAll('-', '').slice(0, 12);
}

async function createProfile(client: PoolClient, deletedAt: Date | null): Promise<{ userId: string; studentId: string }> {
    const label = uniqueLabel();
    const userId = (await client.query<{ id: string }>(
        `INSERT INTO users (email, role) VALUES ($1, 'student') RETURNING id`,
        [`academic-retention-${label}@example.invalid`],
    )).rows[0]?.id;
    assert.ok(userId);
    const studentId = (await client.query<{ id: string }>(
        `INSERT INTO students (user_id, name, university_id, registration_number) VALUES ($1, $2, null, null) RETURNING id`,
        [userId, `Retention Student ${label}`],
    )).rows[0]?.id;
    assert.ok(studentId);
    await client.query(
        `INSERT INTO student_academic_profiles (user_id, student_id, observed_identity_version, entry_year_state, entry_year)
         VALUES ($1, $2, 1, 'supplied', 2022)`,
        [userId, studentId],
    );
    if (deletedAt !== null) {
        await client.query(`UPDATE users SET deleted_at = $1 WHERE id = $2`, [deletedAt, userId]);
    }
    return { userId, studentId };
}

async function profileCount(client: PoolClient, userId: string): Promise<number> {
    const counted = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM student_academic_profiles WHERE user_id = $1`,
        [userId],
    );
    return Number(counted.rows[0]?.count ?? '0');
}

test('purge removes due soft-deleted academic rows and keeps all other data', async () => {
    await withTestClient(async (client) => {
        const now = new Date();
        const due = await createProfile(client, new Date(now.getTime() - 100 * DAY_MS));
        const recent = await createProfile(client, new Date(now.getTime() - DAY_MS));
        const active = await createProfile(client, null);

        const summary = await purgeSoftDeletedAcademicProfiles(db.getPool(), RETENTION_DAYS, now);
        assert.equal(summary.deletedProfiles >= 1, true);
        assert.deepEqual(Object.keys(summary).sort(), ['cutoff', 'deletedProfiles']);

        assert.equal(await profileCount(client, due.userId), 0);
        assert.equal(await profileCount(client, recent.userId), 1);
        assert.equal(await profileCount(client, active.userId), 1);

        const users = await client.query<{ count: string }>(
            `SELECT COUNT(*) AS count FROM users WHERE id = ANY($1)`,
            [[due.userId, recent.userId, active.userId]],
        );
        assert.equal(Number(users.rows[0]?.count ?? '0'), 3);
        const students = await client.query<{ count: string }>(
            `SELECT COUNT(*) AS count FROM students WHERE id = ANY($1)`,
            [[due.studentId, recent.studentId, active.studentId]],
        );
        assert.equal(Number(students.rows[0]?.count ?? '0'), 3);

        const rerun = await purgeSoftDeletedAcademicProfiles(db.getPool(), RETENTION_DAYS, now);
        assert.equal(rerun.deletedProfiles, 0);
    });
});

test('purge refuses to run without an approved positive retention window', async () => {
    await withTestClient(async (client) => {
        const now = new Date();
        const due = await createProfile(client, new Date(now.getTime() - 100 * DAY_MS));
        try {
            assert.throws(() => resolveAcademicProfileRetentionDays(null), /not configured/);
            await assert.rejects(purgeSoftDeletedAcademicProfiles(db.getPool(), 0, now), /positive integer/);
            assert.equal(await profileCount(client, due.userId), 1);
        } finally {
            await client.query(`UPDATE users SET deleted_at = NULL WHERE id = $1`, [due.userId]);
        }
    });
});

test('soft-deleted users without academic rows contribute nothing to the purge', async () => {
    await withTestClient(async (client) => {
        const now = new Date();
        const label = uniqueLabel();
        const userId = (await client.query<{ id: string }>(
            `INSERT INTO users (email, role, deleted_at) VALUES ($1, 'student', $2) RETURNING id`,
            [`academic-retention-empty-${label}@example.invalid`, new Date(now.getTime() - 100 * DAY_MS)],
        )).rows[0]?.id;
        assert.ok(userId);
        const summary = await purgeSoftDeletedAcademicProfiles(db.getPool(), RETENTION_DAYS, now);
        assert.deepEqual(Object.keys(summary).sort(), ['cutoff', 'deletedProfiles']);
        const users = await client.query<{ count: string }>(`SELECT COUNT(*) AS count FROM users WHERE id = $1`, [userId]);
        assert.equal(Number(users.rows[0]?.count ?? '0'), 1);
    });
});
