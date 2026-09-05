import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import type pg from 'pg';
import { BadRequestError, ConflictError, ServiceUnavailableError, UnauthorizedError } from '../../common/errors/AppError.js';
import { errorHandler } from '../../common/middleware/errorHandler.js';
import { AuthController } from '../../controllers/auth.controller.js';
import { createAuthRouter } from '../../routes/auth.routes.js';
import { createStudentSignupService, StudentSignupRateLimitError } from '../../services/auth/student-signup.service.js';
import { challengeSubjectDigest } from '../../services/verification/challenge.service.js';
import { createStudentEmailPreflight } from '../../services/verification/student-email-verification.service.js';
import { VERIFICATION_NOTICE_VERSION } from '../../services/verification/verification-notices.js';
import { assertFixtureDatabase, createTestPool } from './test-database.js';

type Fixture = {
    universityId: string;
    email: string;
    name: string;
};

function uniqueEmail(): string {
    return `signup-${randomUUID()}@students.school.example`;
}

async function createFixture(client: pg.PoolClient): Promise<Fixture> {
    const adminId = (await client.query<{ id: string }>(
        `INSERT INTO users (email, role) VALUES ($1, 'admin') RETURNING id`,
        [`admin-${randomUUID()}@example.invalid`],
    )).rows[0]!.id;
    const universityId = (await client.query<{ id: string }>(
        `INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id`,
        [`Signup University ${randomUUID()}`],
    )).rows[0]!.id;
    await client.query(
        `INSERT INTO approved_student_email_domains (university_id, domain, approved_by)
         VALUES ($1, 'students.school.example', $2)`,
        [universityId, adminId],
    );
    return { universityId, email: uniqueEmail(), name: 'Ada Student' };
}

function requestInput(fixture: Fixture) {
    return {
        email: fixture.email,
        name: fixture.name,
        universityId: fixture.universityId,
        matricNumber: null,
        verificationConsent: true as const,
        noticeVersion: VERIFICATION_NOTICE_VERSION,
    };
}

async function withPool(operation: (pool: pg.Pool) => Promise<void>): Promise<void> {
    const pool = createTestPool();
    try {
        const client = await pool.connect();
        try {
            await assertFixtureDatabase(client);
        } finally {
            client.release();
        }
        await operation(pool);
    } finally {
        await pool.end();
    }
}

async function waitForBlockingBackend(observer: pg.Pool, label: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const blocked = await observer.query<{ pids: number[] }>(
            `SELECT pg_blocking_pids(pid) AS pids
             FROM pg_stat_activity
             WHERE datname = current_database() AND pid <> pg_backend_pid()`,
        );
        if (blocked.rows.some((row) => row.pids.length > 0)) return;
        await delay(10);
    }
    throw new Error(`Expected PostgreSQL blocking for ${label}`);
}

async function withHttpServer(controller: AuthController, operation: (baseUrl: string) => Promise<void>): Promise<void> {
    const app = express();
    app.use(express.json());
    app.use('/auth', createAuthRouter(controller));
    app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture did not expose a loopback port');
    try {
        await operation(`http://127.0.0.1:${address.port}/auth`);
    } finally {
        server.close();
        await once(server, 'close');
    }
}

test('request records only an immutable signup challenge and wrong confirmation commits one guess without an account', async () => {
    await withPool(async (pool) => {
        const client = await pool.connect();
        const fixture = await createFixture(client);
        client.release();
        const delivered: Array<{ email: string; code: string; name: string }> = [];
        const service = createStudentSignupService({
            pool,
            isEmailConfigured: () => true,
            deliverOtp: async (email, code, name) => {
                delivered.push({ email, code, name });
                return { success: true };
            },
        });

        const request = await service.request({ ...requestInput(fixture), email: ` ${fixture.email.toUpperCase()} ` });
        assert.equal(request.email, fixture.email);
        assert.equal(delivered.length, 1);
        assert.equal(delivered[0]?.email, fixture.email);
        assert.match(delivered[0]?.code ?? '', /^\d{6}$/);
        const before = await pool.query(
            `SELECT (SELECT count(*) FROM users WHERE lower(btrim(email)) = $1) AS users,
                    (SELECT count(*) FROM user_email_proofs proofs
                     JOIN users ON users.id = proofs.user_id
                     WHERE lower(btrim(users.email)) = $1) AS proofs,
                    (SELECT count(*) FROM eligibility_evidence evidence
                     JOIN students ON students.id = evidence.student_id
                     JOIN users ON users.id = students.user_id
                     WHERE lower(btrim(users.email)) = $1) AS evidence`,
            [fixture.email],
        );
        assert.deepEqual(before.rows[0], { users: '0', proofs: '0', evidence: '0' });

        await assert.rejects(
            service.confirm({ ...requestInput(fixture), challengeId: request.challengeId, otp: '000000', password: 'StrongPass123!' }),
            UnauthorizedError,
        );
        const after = await pool.query<{ failed_attempts: number; users: string; grants: string; proofs: string; evidence: string }>(
            `SELECT budgets.failed_attempts,
                    (SELECT count(*) FROM users WHERE lower(btrim(email)) = $1) AS users,
                    (SELECT count(*) FROM verification_consents grants
                     JOIN users ON users.id = grants.user_id
                     WHERE grants.kind = 'processing' AND lower(btrim(users.email)) = $1) AS grants,
                    (SELECT count(*) FROM user_email_proofs proofs
                     JOIN users ON users.id = proofs.user_id
                     WHERE lower(btrim(users.email)) = $1) AS proofs,
                    (SELECT count(*) FROM eligibility_evidence evidence
                     JOIN students ON students.id = evidence.student_id
                     JOIN users ON users.id = students.user_id
                     WHERE lower(btrim(users.email)) = $1) AS evidence
             FROM verification_challenge_budgets budgets
             WHERE budgets.current_challenge_id = $2`,
            [fixture.email, request.challengeId],
        );
        assert.deepEqual(after.rows[0], { failed_attempts: 1, users: '0', grants: '0', proofs: '0', evidence: '0' });
    });
});

test('confirmation binds every pending identity claim and policy generation before atomically creating one eligible student', async () => {
    await withPool(async (pool) => {
        const client = await pool.connect();
        const fixture = await createFixture(client);
        client.release();
        let otp = '';
        const service = createStudentSignupService({
            pool,
            isEmailConfigured: () => true,
            deliverOtp: async (_email, code) => {
                otp = code;
                return { success: true };
            },
        });
        const input = { ...requestInput(fixture), matricNumber: 'SELF-DECLARED-42' };
        const request = await service.request(input);
        const otherClient = await pool.connect();
        const otherFixture = await createFixture(otherClient);
        otherClient.release();

        await assert.rejects(
            service.confirm({ ...input, name: 'Changed Name', challengeId: request.challengeId, otp, password: 'StrongPass123!' }),
            BadRequestError,
        );
        await assert.rejects(
            service.confirm({ ...input, matricNumber: 'CHANGED-MATRIC', challengeId: request.challengeId, otp, password: 'StrongPass123!' }),
            BadRequestError,
        );
        await assert.rejects(
            service.confirm({ ...input, universityId: otherFixture.universityId, challengeId: request.challengeId, otp, password: 'StrongPass123!' }),
            BadRequestError,
        );
        await assert.rejects(
            service.confirm({ ...input, noticeVersion: 'stale-notice', challengeId: request.challengeId, otp, password: 'StrongPass123!' }),
            BadRequestError,
        );
        await pool.query(
            `UPDATE universities
             SET verification_policy_version = verification_policy_version + 1
             WHERE id = $1`,
            [fixture.universityId],
        );
        await assert.rejects(
            service.confirm({ ...input, challengeId: request.challengeId, otp, password: 'StrongPass123!' }),
            BadRequestError,
        );
        await pool.query(
            `UPDATE universities
             SET verification_policy_version = verification_policy_version - 1
             WHERE id = $1`,
            [fixture.universityId],
        );
        const completion = await service.confirm({ ...input, challengeId: request.challengeId, otp, password: 'StrongPass123!' });
        assert.equal(completion.user.email, fixture.email);
        assert.equal(completion.user.role, 'student');
        assert.equal(completion.eligibility.eligible, true);
        assert.match(completion.expectedPasswordHash, /^\$2[aby]\$/);

        const rows = await pool.query<{
            name: string; university_id: string; registration_number: string | null; proof_count: string;
            processing_grants: string; disclosure_grants: string; evidence_count: string; reservations: string;
        }>(
            `SELECT students.name, students.university_id, students.registration_number,
                    (SELECT count(*) FROM user_email_proofs WHERE user_id = users.id) AS proof_count,
                    (SELECT count(*) FROM verification_consents WHERE user_id = users.id AND kind = 'processing') AS processing_grants,
                    (SELECT count(*) FROM verification_consents WHERE user_id = users.id AND kind = 'disclosure') AS disclosure_grants,
                    (SELECT count(*) FROM eligibility_evidence WHERE student_id = students.id) AS evidence_count,
                    (SELECT count(*) FROM verified_registration_identities WHERE student_id = students.id) AS reservations
             FROM users JOIN students ON students.user_id = users.id
             WHERE users.id = $1`,
            [completion.user.id],
        );
        assert.deepEqual(rows.rows[0], {
            name: fixture.name,
            university_id: fixture.universityId,
            registration_number: 'SELF-DECLARED-42',
            proof_count: '1',
            processing_grants: '1',
            disclosure_grants: '0',
            evidence_count: '1',
            reservations: '0',
        });
        await assert.rejects(
            service.confirm({ ...input, challengeId: request.challengeId, otp, password: 'StrongPass123!' }),
            ConflictError,
        );
    });
});

test('retains the five-guess signup budget across a cooldown-bounded replacement challenge', async () => {
    await withPool(async (pool) => {
        const client = await pool.connect();
        const fixture = await createFixture(client);
        client.release();
        const deliveries: string[] = [];
        const service = createStudentSignupService({
            pool,
            isEmailConfigured: () => true,
            deliverOtp: async (_email, code) => {
                deliveries.push(code);
                return { success: true };
            },
        });
        const input = requestInput(fixture);
        const first = await service.request(input);
        assert.ok(first.expiresAt.getTime() > Date.now() + (9 * 60 * 1000));
        assert.ok(first.resendAvailableAt.getTime() > Date.now() + 55_000);
        await assert.rejects(service.request(input), StudentSignupRateLimitError);

        const wrongFirst = deliveries[0] === '000000' ? '000001' : '000000';
        await assert.rejects(
            service.confirm({ ...input, challengeId: first.challengeId, otp: wrongFirst, password: 'StrongPass123!' }),
            UnauthorizedError,
        );
        await pool.query(
            `UPDATE verification_challenge_budgets
             SET resend_available_at = clock_timestamp() - interval '1 second'
             WHERE current_challenge_id = $1`,
            [first.challengeId],
        );
        const replacement = await service.request(input);
        assert.notEqual(replacement.challengeId, first.challengeId);
        assert.equal(deliveries.length, 2);
        const superseded = await pool.query<{ superseded_at: Date | null }>(
            'SELECT superseded_at FROM verification_challenges WHERE id = $1',
            [first.challengeId],
        );
        assert.notEqual(superseded.rows[0]?.superseded_at, null);

        const wrongReplacement = deliveries[1] === '000000' ? '000001' : '000000';
        for (let attempt = 0; attempt < 4; attempt += 1) {
            await assert.rejects(
                service.confirm({ ...input, challengeId: replacement.challengeId, otp: wrongReplacement, password: 'StrongPass123!' }),
                UnauthorizedError,
            );
        }
        await assert.rejects(service.request(input), StudentSignupRateLimitError);
        const budget = await pool.query<{ failed_attempts: number }>(
            'SELECT failed_attempts FROM verification_challenge_budgets WHERE current_challenge_id = $1',
            [replacement.challengeId],
        );
        assert.equal(budget.rows[0]?.failed_attempts, 5);
        assert.equal((await pool.query('SELECT id FROM users WHERE lower(btrim(email)) = $1', [fixture.email])).rowCount, 0);
    });
});

test('rejects existing normalized and soft-deleted identities without issuing a replacement account', async () => {
    await withPool(async (pool) => {
        const client = await pool.connect();
        const fixture = await createFixture(client);
        await client.query(
            `INSERT INTO users (email, role, deleted_at) VALUES ($1, 'student', clock_timestamp())`,
            [` ${fixture.email.toUpperCase()} `],
        );
        client.release();
        const service = createStudentSignupService({ pool, isEmailConfigured: () => true, deliverOtp: async () => ({ success: true }) });
        await assert.rejects(service.request(requestInput(fixture)), ConflictError);
        const users = await pool.query('SELECT id FROM users WHERE lower(btrim(email)) = $1', [fixture.email]);
        assert.equal(users.rowCount, 1);
    });
});

test('does not issue a challenge when mail is unconfigured and retains delivery-failed cooldown without leaking transport detail', async () => {
    await withPool(async (pool) => {
        const client = await pool.connect();
        const fixture = await createFixture(client);
        client.release();
        const unconfigured = createStudentSignupService({ pool, isEmailConfigured: () => false, deliverOtp: async () => ({ success: true }) });
        await assert.rejects(unconfigured.request(requestInput(fixture)), ServiceUnavailableError);
        assert.equal((await pool.query(
            `SELECT 1 FROM verification_challenge_budgets
             WHERE purpose = 'student_signup' AND subject_digest = $1`,
            [challengeSubjectDigest('student_signup', fixture.email)],
        )).rowCount, 0);

        const deliveryFailed = createStudentSignupService({
            pool,
            isEmailConfigured: () => true,
            deliverOtp: async () => ({ success: false }),
        });
        await assert.rejects(deliveryFailed.request(requestInput(fixture)), (error: unknown) => {
            assert.ok(error instanceof ServiceUnavailableError);
            assert.doesNotMatch(error.message, /provider|brevo|transport/i);
            return true;
        });
        assert.equal((await pool.query(
            `SELECT 1 FROM verification_challenge_budgets
             WHERE purpose = 'student_signup' AND subject_digest = $1`,
            [challengeSubjectDigest('student_signup', fixture.email)],
        )).rowCount, 1);
    });
});

test('preflight reports canonical approved-domain support without treating it as mailbox proof', async () => {
    await withPool(async (pool) => {
        const client = await pool.connect();
        const fixture = await createFixture(client);
        client.release();
        const preflight = createStudentEmailPreflight({ query: (text, values) => pool.query(text, values) });
        assert.deepEqual(await preflight(fixture.universityId, fixture.email), { supported: true });
        assert.deepEqual(await preflight(fixture.universityId, `ada@${fixture.email.split('@')[1]}.invalid`), {
            supported: false,
            reason: 'This school email domain is not approved.',
        });
        await pool.query('UPDATE universities SET is_active = false WHERE id = $1', [fixture.universityId]);
        assert.deepEqual(await preflight(fixture.universityId, fixture.email), {
            supported: false,
            reason: 'This institution is not currently available for student signup.',
        });
    });
});

test('rolls back successful proof consumption and every new row if evidence writing fails', async () => {
    await withPool(async (pool) => {
        const client = await pool.connect();
        const fixture = await createFixture(client);
        client.release();
        let otp = '';
        const service = createStudentSignupService({
            pool,
            isEmailConfigured: () => true,
            deliverOtp: async (_email, code) => {
                otp = code;
                return { success: true };
            },
        });
        const request = await service.request(requestInput(fixture));
        await pool.query(`
            CREATE FUNCTION student_signup_test_fail_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                RAISE EXCEPTION 'synthetic evidence write failure';
            END $$;
            CREATE TRIGGER student_signup_test_fail_evidence_before_insert
            BEFORE INSERT ON eligibility_evidence
            FOR EACH ROW EXECUTE FUNCTION student_signup_test_fail_evidence();
        `);
        try {
            await assert.rejects(
                service.confirm({ ...requestInput(fixture), challengeId: request.challengeId, otp, password: 'StrongPass123!' }),
                /synthetic evidence write failure/,
            );
        } finally {
            await pool.query('DROP TRIGGER IF EXISTS student_signup_test_fail_evidence_before_insert ON eligibility_evidence');
            await pool.query('DROP FUNCTION IF EXISTS student_signup_test_fail_evidence()');
        }
        const state = await pool.query<{ consumed_at: Date | null; users: string; proofs: string; grants: string; evidence: string }>(
            `SELECT challenges.consumed_at,
                    (SELECT count(*) FROM users WHERE lower(btrim(email)) = $1) AS users,
                    (SELECT count(*) FROM user_email_proofs proofs JOIN users ON users.id = proofs.user_id WHERE lower(btrim(users.email)) = $1) AS proofs,
                    (SELECT count(*) FROM verification_consents grants JOIN users ON users.id = grants.user_id WHERE lower(btrim(users.email)) = $1) AS grants,
                    (SELECT count(*) FROM eligibility_evidence evidence JOIN students ON students.id = evidence.student_id JOIN users ON users.id = students.user_id WHERE lower(btrim(users.email)) = $1) AS evidence
             FROM verification_challenges challenges
             WHERE challenges.id = $2`,
            [fixture.email, request.challengeId],
        );
        assert.deepEqual(state.rows[0], { consumed_at: null, users: '0', proofs: '0', grants: '0', evidence: '0' });
    });
});

test('serializes concurrent confirmations at PostgreSQL and only the winner creates an account', async () => {
    await withPool(async (pool) => {
        const client = await pool.connect();
        const fixture = await createFixture(client);
        client.release();
        let otp = '';
        const service = createStudentSignupService({
            pool,
            isEmailConfigured: () => true,
            deliverOtp: async (_email, code) => {
                otp = code;
                return { success: true };
            },
        });
        const request = await service.request(requestInput(fixture));
        await pool.query(`
            CREATE FUNCTION student_signup_test_delay_insert() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW.email = '${fixture.email}' THEN PERFORM pg_sleep(0.35); END IF;
                RETURN NEW;
            END $$;
            CREATE TRIGGER student_signup_test_delay_before_insert
            BEFORE INSERT ON users
            FOR EACH ROW EXECUTE FUNCTION student_signup_test_delay_insert();
        `);
        try {
            const first = service.confirm({ ...requestInput(fixture), challengeId: request.challengeId, otp, password: 'StrongPass123!' });
            await delay(25);
            const second = service.confirm({ ...requestInput(fixture), challengeId: request.challengeId, otp, password: 'StrongPass123!' });
            await waitForBlockingBackend(pool, 'concurrent signup confirmation');
            const results = await Promise.allSettled([first, second]);
            assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
            assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
        } finally {
            await pool.query('DROP TRIGGER IF EXISTS student_signup_test_delay_before_insert ON users');
            await pool.query('DROP FUNCTION IF EXISTS student_signup_test_delay_insert()');
        }
        const outcome = await pool.query<{ users: string; evidence: string }>(
            `SELECT (SELECT count(*) FROM users WHERE lower(btrim(email)) = $1) AS users,
                    (SELECT count(*) FROM eligibility_evidence evidence
                     JOIN students ON students.id = evidence.student_id
                     JOIN users ON users.id = students.user_id
                     WHERE lower(btrim(users.email)) = $1) AS evidence`,
            [fixture.email],
        );
        assert.deepEqual(outcome.rows[0], { users: '1', evidence: '1' });
    });
});

test('keeps a committed account usable by ordinary login after controller session issuance fails', async () => {
    await withPool(async (pool) => {
        const client = await pool.connect();
        const fixture = await createFixture(client);
        client.release();
        let otp = '';
        const signupService = createStudentSignupService({
            pool,
            isEmailConfigured: () => true,
            deliverOtp: async (_email, code) => {
                otp = code;
                return { success: true };
            },
        });
        const controller = new AuthController({
            studentSignupService: signupService,
            studentEmailPreflight: async () => ({ supported: true }),
            issueSession: async () => { throw new Error('synthetic post-commit session failure'); },
        });
        await withHttpServer(controller, async (baseUrl) => {
            const input = {
                ...requestInput(fixture),
                password: 'StrongPass123!',
            };
            const requested = await fetch(`${baseUrl}/student/register-request`, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
            });
            assert.equal(requested.status, 200);
            const request = (await requested.json() as { data: { challengeId: string } }).data;
            const confirmation = await fetch(`${baseUrl}/student/register-confirm`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ...input, challengeId: request.challengeId, otp }),
            });
            assert.equal(confirmation.status, 503);
            assert.match((await confirmation.json() as { error: { message: string } }).error.message, /account was created/i);

            const login = await fetch(`${baseUrl}/login`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ email: fixture.email.toUpperCase(), password: input.password }),
            });
            assert.equal(login.status, 200);
            assert.equal((await login.json() as { data: { user: { email: string } } }).data.user.email, fixture.email);
        });
    });
});
