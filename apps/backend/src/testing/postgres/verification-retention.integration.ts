import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
        // The budget pointer was cleared and the window is three days old,
        // so lifecycle deletion reaps the whole row instead of retaining it.
        assert.equal((await client.query('SELECT count(*)::text AS count FROM verification_challenge_budgets WHERE subject_digest=$1', [digest])).rows[0].count, '0');
    } finally { client.release(); await pool.end(); }
});

test('retention keeps consumed signup bindings through the handoff window but purges recovery OTPs at expiry', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        await assertFixtureDatabase(client);
        const digest = randomUUID().replaceAll('-', '').repeat(2);
        const signupFresh = randomUUID(); const signupAged = randomUUID(); const recovery = randomUUID();
        for (const [id, purpose, ago] of [
            [signupFresh, 'student_sso_signup', '5 minutes'],
            [signupAged, 'student_sso_signup', '2 hours'],
            [recovery, 'student_account_recovery', '5 minutes'],
        ] as const) {
            await client.query(`INSERT INTO verification_challenges (id,purpose,subject_digest,secret_digest,bindings,created_at,expires_at,consumed_at)
                VALUES ($1,$2,$3,$3,'{"email":"synthetic@example.invalid"}',
                clock_timestamp() - interval '3 hours', clock_timestamp() - interval '${ago}', clock_timestamp() - interval '3 hours' + interval '1 minute')`, [id, purpose, digest]);
        }
        await purgeExpiredChallenges(pool);
        const rows = await client.query('SELECT id, bindings, purged_at FROM verification_challenges WHERE id = ANY($1)', [[signupFresh, signupAged, recovery]]);
        const fresh = rows.rows.find((row) => row.id === signupFresh)!;
        assert.equal(fresh.bindings.email, 'synthetic@example.invalid'); assert.equal(fresh.purged_at, null);
        for (const id of [signupAged, recovery]) {
            const row = rows.rows.find((r) => r.id === id)!;
            assert.deepEqual(row.bindings, {}); assert.ok(row.purged_at);
        }
    } finally { client.release(); await pool.end(); }
});

test('retention deletes unreferenced tombstones and stale budgets but keeps evidence-linked rows', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        await assertFixtureDatabase(client);
        const digest = randomUUID().replaceAll('-', '');
        const dead = randomUUID(); const fresh = randomUUID(); const proven = randomUUID(); const live = randomUUID();
        const zero64 = '0'.repeat(64);
        // An aged scrubbed tombstone nothing references: deleted. A
        // freshly purged one: kept until it ages. A proven one with an
        // email-proof FK: kept despite age. A live challenge: untouched.
        await client.query(`INSERT INTO verification_challenges (id,purpose,subject_digest,secret_digest,bindings,created_at,expires_at,purged_at)
            VALUES ($1,'student_account_recovery',$2,$2,'{}',clock_timestamp()-interval '3 days',clock_timestamp()-interval '2 days',clock_timestamp()-interval '2 days')`, [dead, zero64]);
        await client.query(`INSERT INTO verification_challenges (id,purpose,subject_digest,secret_digest,bindings,created_at,expires_at,purged_at)
            VALUES ($1,'student_account_recovery',$2,$2,'{}',clock_timestamp()-interval '3 days',clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 hour')`, [fresh, zero64]);
        await client.query(`INSERT INTO verification_challenges (id,purpose,subject_digest,secret_digest,bindings,created_at,expires_at,consumed_at,purged_at)
            VALUES ($1,'student_email',$2,$2,'{}',clock_timestamp()-interval '3 days',clock_timestamp()-interval '2 days',clock_timestamp()-interval '2 days',clock_timestamp()-interval '2 days')`, [proven, zero64]);
        await client.query(`INSERT INTO verification_challenges (id,purpose,subject_digest,secret_digest,bindings,created_at,expires_at)
            VALUES ($1,'student_signup',$2,$2,'{\"email\":\"synthetic@example.invalid\"}',clock_timestamp(),clock_timestamp()+interval '1 hour')`, [live, digest.repeat(2).slice(0, 64)]);
        const userId = (await client.query(`INSERT INTO users(email,role) VALUES ($1,'student') RETURNING id`, [`${proven}@example.invalid`])).rows[0].id;
        await client.query('INSERT INTO user_email_proofs(user_id,email,challenge_id) VALUES ($1,$2,$3)', [userId, `${proven}@example.invalid`, proven]);
        const staleBudget = randomUUID().replaceAll('-', '').repeat(2);
        const liveBudget = randomUUID().replaceAll('-', '').repeat(2);
        await client.query(`INSERT INTO verification_challenge_budgets (purpose,subject_digest,window_started_at,resend_available_at)
            VALUES ('student_account_recovery',$1,clock_timestamp()-interval '2 days',clock_timestamp()-interval '2 days')`, [staleBudget]);
        await client.query(`INSERT INTO verification_challenge_budgets (purpose,subject_digest,current_challenge_id,window_started_at,resend_available_at)
            VALUES ('student_signup',$1,$2,clock_timestamp(),clock_timestamp())`, [liveBudget, live]);
        await purgeExpiredChallenges(pool);
        const remaining = await client.query<{ id: string }>('SELECT id FROM verification_challenges WHERE id = ANY($1)', [[dead, fresh, proven, live]]);
        const ids = remaining.rows.map((row) => row.id);
        assert.ok(!ids.includes(dead), 'aged unreferenced tombstones must be deleted');
        assert.ok(ids.includes(fresh), 'freshly purged tombstones survive until they age');
        assert.ok(ids.includes(proven), 'evidence-linked tombstones are kept for the immutable FK');
        assert.ok(ids.includes(live), 'live challenges are untouched');
        const budgets = await client.query<{ subject_digest: string }>('SELECT subject_digest FROM verification_challenge_budgets WHERE subject_digest = ANY($1)', [[staleBudget, liveBudget]]);
        const subjects = budgets.rows.map((row) => row.subject_digest);
        assert.ok(!subjects.includes(staleBudget), 'stale pointerless budgets must be deleted');
        assert.ok(subjects.includes(liveBudget), 'budgets with a live challenge pointer are kept');
    } finally { client.release(); await pool.end(); }
});

test('capped retention batches clear and scrub the same challenge set', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        await assertFixtureDatabase(client);
        // 505 expired pairs whose subject order reverses their expiry
        // order: two independently capped batches would clear pointers
        // for one 500-subset while scrubbing another, stranding purged
        // challenges behind live pointers forever.
        const total = 505;
        const ids: string[] = [];
        const subjects: string[] = [];
        // Salted per run: deterministic subjects collide with other runs
        // sharing a database, and index 0 ('0'.repeat(64)) collides with
        // the scrub sentinel every purged tombstone carries.
        const salt = randomUUID();
        for (let index = 0; index < total; index++) {
            ids.push(randomUUID());
            subjects.push(createHash('sha256').update(`${salt}:${index}`).digest('hex'));
        }
        const challengeValues = ids.map((id, index) =>
            `('${id}','student_signup','${subjects[index]}','${'b'.repeat(64)}','{}',clock_timestamp()-interval '${1560 + index} minutes',clock_timestamp()-interval '${1500 + index} minutes',NULL)`,
        ).join(',');
        await client.query(`INSERT INTO verification_challenges (id,purpose,subject_digest,secret_digest,bindings,created_at,expires_at,purged_at) VALUES ${challengeValues}`);
        const budgetValues = ids.map((id, index) =>
            `('student_signup','${subjects[index]}','${id}',clock_timestamp()-interval '2 days',clock_timestamp()-interval '2 days')`,
        ).join(',');
        await client.query('INSERT INTO verification_challenge_budgets (purpose,subject_digest,current_challenge_id,window_started_at,resend_available_at) VALUES ' + budgetValues);
        // Converge scrubbing across passes: the 500-cap splits the set,
        // and other tests' expired rows may share a batch. Backdating an
        // unscrubbed row would exclude it from every later scrub set while
        // its pointer stays live, stranding it, so only converged
        // (fully scrubbed) rows are aged below.
        for (let pass = 0; pass < 6; pass++) {
            await purgeExpiredChallenges(pool);
            const pending = await client.query<{ count: string }>(
                'SELECT count(*)::text AS count FROM verification_challenges WHERE id = ANY($1) AND purged_at IS NULL',
                [ids],
            );
            if (pending.rows[0]!.count === '0') break;
            if (pass === 5) assert.equal(pending.rows[0]!.count, '0', 'scrubbing must converge across capped passes');
        }
        const stranded = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM verification_challenge_budgets b
             JOIN verification_challenges c ON c.id = b.current_challenge_id
             WHERE c.purged_at IS NOT NULL AND b.subject_digest = ANY($1)`,
            [subjects],
        );
        assert.equal(stranded.rows[0]!.count, '0', 'every scrubbed challenge must have its budget pointer cleared in the same batch');
        // Age the converged tombstones and reap everything: deletion
        // converges across passes with nothing stranded behind a pointer.
        // Scoping by id: scrubbed rows carry the zeroed subject sentinel,
        // so subject scoping would miss them and match other tombstones.
        await client.query('UPDATE verification_challenges SET purged_at = clock_timestamp() - interval \'25 hours\' WHERE id = ANY($1) AND purged_at IS NOT NULL', [ids]);
        for (let pass = 0; pass < 6; pass++) {
            await purgeExpiredChallenges(pool);
            const remaining = await client.query<{ challenges: string; budgets: string }>(
                `SELECT (SELECT count(*)::text FROM verification_challenges WHERE id = ANY($1)) AS challenges,
                        (SELECT count(*)::text FROM verification_challenge_budgets WHERE subject_digest = ANY($2)) AS budgets`,
                [ids, subjects],
            );
            if (remaining.rows[0]!.challenges === '0' && remaining.rows[0]!.budgets === '0') break;
            if (pass === 5) assert.deepEqual(remaining.rows[0], { challenges: '0', budgets: '0' });
        }
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
