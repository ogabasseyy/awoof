import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { db } from '../../config/database.js';
import { errorHandler } from '../../common/middleware/errorHandler.js';
import { preflightStudentEmail } from '../../services/verification/student-email-verification.service.js';
import adminRouter from '../../routes/admin.routes.js';
import { jwtService } from '../../services/auth/jwt.service.js';
import { createTestPool, assertFixtureDatabase } from './test-database.js';

async function policyBody(response: Response): Promise<{ domains: string[]; emailEvidenceValidityDays: number; policyVersion: number }> {
    const body = await response.json() as { data: { policy: { domains: string[]; emailEvidenceValidityDays: number; policyVersion: number } } };
    return body.data.policy;
}

test('admin policy HTTP approval is explicit, audited, reversible and checks current administrator authority', async (t) => {
    const pool = createTestPool();
    t.mock.method(db, 'getPool', () => pool);
    const client = await pool.connect();
    await assertFixtureDatabase(client);
    const label = randomUUID();
    const actor = (await client.query(`INSERT INTO users (email, role) VALUES ($1, 'admin') RETURNING id`, [`${label}@example.invalid`])).rows[0].id;
    const school = (await client.query(`INSERT INTO universities (name, domain) VALUES ($1, $2) RETURNING id`, [label, `${label}.example`])).rows[0].id;
    const token = jwtService.generateAccessToken({ userId: actor, email: `${label}@example.invalid`, role: 'admin' });
    const app = express();
    app.use(express.json());
    app.use('/admin', adminRouter);
    app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a loopback test port');
    const endpoint = `http://127.0.0.1:${address.port}/admin/universities/${school}/verification-policy`;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const policy = { domains: ['students.school.example'], emailEvidenceValidityDays: 90, enrollmentValidityDays: 30, registrationNormalization: null, isActive: true };
    const put = (body: unknown) => fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify(body) });
    try {
        assert.equal((await fetch(endpoint)).status, 401);
        const initial = await fetch(endpoint, { headers });
        assert.equal(initial.status, 200);
        assert.equal(initial.headers.get('cache-control'), 'no-store');
        assert.deepEqual((await policyBody(initial)).domains, []);
        assert.equal((await preflightStudentEmail(school, 'student@students.school.example')).supported, false);
        const approved = await put(policy);
        assert.equal(approved.status, 200);
        assert.equal((await preflightStudentEmail(school, 'student@students.school.example')).supported, true);
        const first = await policyBody(approved);
        assert.deepEqual(first.domains, ['students.school.example']);
        assert.equal(first.emailEvidenceValidityDays, 90);
        assert.deepEqual((await client.query('SELECT domain, approved_by FROM approved_student_email_domains WHERE university_id = $1', [school])).rows,
            [{ domain: 'students.school.example', approved_by: actor }]);
        assert.equal((await client.query(`SELECT 1 FROM verification_audit_events WHERE university_id = $1 AND actor_user_id = $2 AND event_type = 'institution_policy_updated'`, [school, actor])).rowCount, 1);
        assert.equal((await put(policy)).status, 200);
        assert.equal((await client.query('SELECT verification_policy_version FROM universities WHERE id = $1', [school])).rows[0].verification_policy_version, first.policyVersion);
        await t.test('rolls back domains, policy settings, version and audit history when the audit write fails', async () => {
            const beforePolicy = await client.query('SELECT * FROM universities WHERE id = $1', [school]);
            const beforeDomains = await client.query('SELECT * FROM approved_student_email_domains WHERE university_id = $1 ORDER BY domain', [school]);
            const beforeAudit = await client.query('SELECT * FROM verification_audit_events WHERE university_id = $1 ORDER BY id', [school]);
            // These identifiers and the institution UUID are generated fixture
            // values, never user input. Fail inside PostgreSQL after policy writes.
            const failureFunction = `test_policy_failure_${label.replaceAll('-', '')}`;
            await client.query(`CREATE FUNCTION ${failureFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    IF NEW.university_id = '${school}'::uuid THEN
                        RAISE EXCEPTION 'Synthetic policy audit failure';
                    END IF;
                    RETURN NEW;
                END $$`);
            await client.query(`CREATE TRIGGER ${failureFunction} BEFORE INSERT ON verification_audit_events
                FOR EACH ROW EXECUTE FUNCTION ${failureFunction}()`);
            try {
                const failed = await put({ ...policy, domains: ['replacement.school.example'], isActive: false,
                    emailEvidenceValidityDays: 15, enrollmentValidityDays: 7 });
                assert.equal(failed.status, 500);
                assert.deepEqual((await client.query('SELECT * FROM universities WHERE id = $1', [school])).rows, beforePolicy.rows);
                assert.deepEqual((await client.query('SELECT * FROM approved_student_email_domains WHERE university_id = $1 ORDER BY domain', [school])).rows, beforeDomains.rows);
                assert.deepEqual((await client.query('SELECT * FROM verification_audit_events WHERE university_id = $1 ORDER BY id', [school])).rows, beforeAudit.rows);
            } finally {
                await client.query(`DROP TRIGGER ${failureFunction} ON verification_audit_events`);
                await client.query(`DROP FUNCTION ${failureFunction}()`);
            }
        });
        for (const bad of [{ ...policy, actorUserId: actor }, { domains: [] }, { ...policy, emailEvidenceValidityDays: 0 }]) {
            assert.equal((await put(bad)).status, 422);
        }
        assert.equal((await put({ ...policy, domains: ['*.school.example'] })).status, 400);
        await client.query(`UPDATE users SET role = 'student' WHERE id = $1`, [actor]);
        assert.equal((await put({ ...policy, domains: [] })).status, 403);
        assert.equal((await fetch(endpoint, { headers })).status, 403);
        await client.query(`UPDATE users SET role = 'admin', deleted_at = clock_timestamp() WHERE id = $1`, [actor]);
        assert.equal((await put({ ...policy, domains: [] })).status, 403);
        await client.query('UPDATE users SET deleted_at = NULL WHERE id = $1', [actor]);
        const removed = await put({ ...policy, domains: [] });
        assert.equal(removed.status, 200);
        assert.deepEqual((await policyBody(removed)).domains, []);
        assert.equal((await client.query('SELECT 1 FROM approved_student_email_domains WHERE university_id = $1 AND is_active', [school])).rowCount, 0);
        assert.equal((await put(policy)).status, 200);
        const deactivated = await fetch(endpoint.replace('/verification-policy', ''), { method: 'DELETE', headers });
        assert.equal(deactivated.status, 200);
        assert.equal((await client.query('SELECT is_active FROM universities WHERE id = $1', [school])).rows[0].is_active, false);
        assert.equal((await client.query('SELECT 1 FROM approved_student_email_domains WHERE university_id = $1', [school])).rowCount, 1);
        assert.equal((await preflightStudentEmail(school, 'student@students.school.example')).supported, false);

    } finally {
        server.close();
        await once(server, 'close');
        client.release();
        await pool.end();
    }
});
