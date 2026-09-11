import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { purgeExpiredChallenges } from '../../services/verification/challenge-retention.service.js';
import { assertFixtureDatabase, createTestPool } from './test-database.js';

test('retention removes expired PII and secrets, clears stale budget pointers and preserves active challenges', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        await assertFixtureDatabase(client);
        const expired = randomUUID(); const active = randomUUID(); const digest = randomUUID().replaceAll('-', '').repeat(2);
        for (const [id, old] of [[expired, true], [active, false]] as const) {
            await client.query(`INSERT INTO verification_challenges (id,purpose,subject_digest,secret_digest,bindings,created_at,expires_at)
                VALUES ($1,'student_signup',$2,$2,'{"email":"synthetic@example.invalid","name":"Synthetic"}',
                clock_timestamp() - interval '3 days', clock_timestamp() + ($3 * interval '1 hour'))`, [id, digest, old ? -25 : 1]);
        }
        await client.query(`INSERT INTO verification_challenge_budgets (purpose,subject_digest,current_challenge_id,window_started_at,resend_available_at)
            VALUES ('student_signup',$1,$2,clock_timestamp()-interval '3 days',clock_timestamp()-interval '3 days')`, [digest, expired]);
        await purgeExpiredChallenges(pool);
        const rows = await client.query('SELECT id, bindings, secret_digest, purged_at FROM verification_challenges WHERE id = ANY($1)', [[expired, active]]);
        const old = rows.rows.find((row) => row.id === expired)!;
        assert.deepEqual(old.bindings, {}); assert.equal(old.secret_digest, '0'.repeat(64)); assert.ok(old.purged_at);
        const live = rows.rows.find((row) => row.id === active)!;
        assert.equal(live.bindings.email, 'synthetic@example.invalid'); assert.equal(live.purged_at, null);
        assert.equal((await client.query('SELECT current_challenge_id FROM verification_challenge_budgets WHERE subject_digest=$1', [digest])).rows[0].current_challenge_id, null);
    } finally { client.release(); await pool.end(); }
});

test('identity changes atomically release registration reservations and rollback restores them', async () => {
    const pool = createTestPool(); const client = await pool.connect();
    try {
        await assertFixtureDatabase(client);
        const userId = randomUUID(); const school = randomUUID();
        await client.query("INSERT INTO users(id,email,role) VALUES ($1,$2,'student')", [userId, `${userId}@example.invalid`]);
        await client.query('INSERT INTO universities(id,name) VALUES ($1,$2)', [school, `Fixture ${school}`]);
        const student = (await client.query("INSERT INTO students(user_id,name,university_id,status) VALUES ($1,'Synthetic',$2,'active') RETURNING id", [userId, school])).rows[0].id;
        for (const change of ["UPDATE students SET name=name||'x' WHERE id=$1", "UPDATE students SET status='suspended' WHERE id=$1", "UPDATE users SET deleted_at=clock_timestamp() WHERE id=$1"]) {
            const reservation = randomUUID();
            await client.query('INSERT INTO verified_registration_identities(id,university_id,identifier,student_id) VALUES ($1,$2,$3,$4)', [reservation, school, reservation, student]);
            await client.query('BEGIN');
            await client.query(change, [change.includes('UPDATE users') ? userId : student]);
            assert.ok((await client.query('SELECT revoked_at FROM verified_registration_identities WHERE id=$1', [reservation])).rows[0].revoked_at);
            await client.query('ROLLBACK');
            assert.equal((await client.query('SELECT revoked_at FROM verified_registration_identities WHERE id=$1', [reservation])).rows[0].revoked_at, null);
            await client.query(change, [change.includes('UPDATE users') ? userId : student]);
            assert.ok((await client.query('SELECT revoked_at FROM verified_registration_identities WHERE id=$1', [reservation])).rows[0].revoked_at);
        }
    } finally { client.release(); await pool.end(); }
});
