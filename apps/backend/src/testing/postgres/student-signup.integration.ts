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

type SignupRows = {
    budgets: string;
    challenges: string;
    users: string;
    students: string;
    grants: string;
    proofs: string;
    evidence: string;
};

async function readSignupRows(pool: pg.Pool, email: string): Promise<SignupRows> {
    const subjectDigest = challengeSubjectDigest('student_signup', email);
    const result = await pool.query<SignupRows>(
        `SELECT (SELECT count(*) FROM verification_challenge_budgets
                 WHERE purpose = 'student_signup' AND subject_digest = $1) AS budgets,
                (SELECT count(*) FROM verification_challenges
                 WHERE purpose = 'student_signup' AND subject_digest = $1) AS challenges,
                (SELECT count(*) FROM users WHERE lower(btrim(email)) = $2) AS users,
                (SELECT count(*) FROM students
                 JOIN users ON users.id = students.user_id
                 WHERE lower(btrim(users.email)) = $2) AS students,
                (SELECT count(*) FROM verification_consents
                 JOIN users ON users.id = verification_consents.user_id
                 WHERE lower(btrim(users.email)) = $2) AS grants,
                (SELECT count(*) FROM user_email_proofs
                 JOIN users ON users.id = user_email_proofs.user_id
                 WHERE lower(btrim(users.email)) = $2) AS proofs,
                (SELECT count(*) FROM eligibility_evidence
                 JOIN students ON students.id = eligibility_evidence.student_id
                 JOIN users ON users.id = students.user_id
                 WHERE lower(btrim(users.email)) = $2) AS evidence`,
        [subjectDigest, email],
    );
    return result.rows[0]!;
}

async function assertNoSignupRows(pool: pg.Pool, email: string): Promise<void> {
    assert.deepEqual(await readSignupRows(pool, email), {
        budgets: '0', challenges: '0', users: '0', students: '0', grants: '0', proofs: '0', evidence: '0',
    });
}

async function assertNoSignupAuthority(pool: pg.Pool, email: string): Promise<void> {
    const rows = await readSignupRows(pool, email);
    assert.deepEqual(
        { users: rows.users, students: rows.students, grants: rows.grants, proofs: rows.proofs, evidence: rows.evidence },
        { users: '0', students: '0', grants: '0', proofs: '0', evidence: '0' },
    );
}

async function waitFor(label: string, predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    do {
        if (await predicate()) return;
        await delay(10);
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${label}`);
}

function settle<T>(operation: Promise<T>): Promise<PromiseSettledResult<T>> {
    return operation.then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ status: 'rejected', reason }),
    );
}

function trackedSignupPool(pool: pg.Pool): { pool: Pick<pg.Pool, 'connect'>; pids: number[] } {
    const pids: number[] = [];
    return {
        pids,
        pool: {
            connect: async () => {
                const client = await pool.connect();
                const pid = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
                pids.push(pid.rows[0]!.pid);
                return client;
            },
        },
    };
}

async function waitForAdvisoryWait(observer: pg.Pool, pid: number): Promise<void> {
    await waitFor(`winner PID ${pid} to reach the fixture barrier`, async () => {
        const status = await observer.query<{ wait_event_type: string | null; wait_event: string | null }>(
            'SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1',
            [pid],
        );
        return status.rows[0]?.wait_event_type === 'Lock' && status.rows[0]?.wait_event === 'advisory';
    });
}

async function waitForExactBlockingPid(observer: pg.Pool, contenderPid: number, winnerPid: number): Promise<void> {
    await waitFor(`contender PID ${contenderPid} to block behind winner PID ${winnerPid}`, async () => {
        const blocked = await observer.query<{ pids: number[] }>(
            'SELECT pg_blocking_pids($1) AS pids',
            [contenderPid],
        );
        return blocked.rows[0]?.pids.map(Number).includes(winnerPid) ?? false;
    });
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

        const wrongOtp = delivered[0]?.code === '000000' ? '000001' : '000000';
        await assert.rejects(
            service.confirm({ ...requestInput(fixture), challengeId: request.challengeId, otp: wrongOtp, password: 'StrongPass123!' }),
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

test('rejects unsupported exact, website, general-domain, and inactive-policy requests before creating signup rows', async () => {
    await withPool(async (pool) => {
        const client = await pool.connect();
        const fixture = await createFixture(client);
        client.release();
        const service = createStudentSignupService({ pool, isEmailConfigured: () => true, deliverOtp: async () => ({ success: true }) });
        const deniedEmails = [
            'ada@other-school.example',
            'ada@www.signup-university.example',
            'ada@gmail.com',
        ];
        for (const email of deniedEmails) {
            await assert.rejects(service.request({ ...requestInput(fixture), email }), BadRequestError);
            await assertNoSignupRows(pool, email);
        }

        await pool.query('UPDATE universities SET is_active = false WHERE id = $1', [fixture.universityId]);
        await assert.rejects(service.request(requestInput(fixture)), BadRequestError);
        await assertNoSignupRows(pool, fixture.email);
    });
});

test('rejects confirmation after domain withdrawal or university deactivation without consuming proof or creating authority', async () => {
    await withPool(async (pool) => {
        for (const withdrawal of ['domain', 'university'] as const) {
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
            if (withdrawal === 'domain') {
                await pool.query(
                    `UPDATE approved_student_email_domains SET is_active = false
                     WHERE university_id = $1 AND domain = 'students.school.example'`,
                    [fixture.universityId],
                );
            } else {
                await pool.query('UPDATE universities SET is_active = false WHERE id = $1', [fixture.universityId]);
            }

            await assert.rejects(
                service.confirm({ ...requestInput(fixture), challengeId: request.challengeId, otp, password: 'StrongPass123!' }),
                BadRequestError,
            );
            assert.deepEqual(await readSignupRows(pool, fixture.email), {
                budgets: '1', challenges: '1', users: '0', students: '0', grants: '0', proofs: '0', evidence: '0',
            });
            const budget = await pool.query<{ current_challenge_id: string; failed_attempts: number; send_count: number }>(
                `SELECT current_challenge_id, failed_attempts, send_count
                 FROM verification_challenge_budgets
                 WHERE purpose = 'student_signup' AND subject_digest = $1`,
                [challengeSubjectDigest('student_signup', fixture.email)],
            );
            assert.deepEqual(budget.rows[0], { current_challenge_id: request.challengeId, failed_attempts: 0, send_count: 1 });
            const challenge = await pool.query<{ consumed_at: Date | null; superseded_at: Date | null }>(
                'SELECT consumed_at, superseded_at FROM verification_challenges WHERE id = $1',
                [request.challengeId],
            );
            assert.deepEqual(challenge.rows[0], { consumed_at: null, superseded_at: null });
        }
    });
});

test('does not issue a challenge when mail is unconfigured', async () => {
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
    });
});

test('retains a failed-delivery cooldown, redacts transport detail, and later issues a usable replacement challenge', async () => {
    await withPool(async (pool) => {
        const client = await pool.connect();
        const fixture = await createFixture(client);
        client.release();
        let deliveries = 0;
        let recoveredOtp = '';
        const deliveryFailed = createStudentSignupService({
            pool,
            isEmailConfigured: () => true,
            deliverOtp: async (_email, code) => {
                deliveries += 1;
                if (deliveries === 1) throw new Error('synthetic provider transport detail');
                recoveredOtp = code;
                return { success: true };
            },
        });
        await assert.rejects(deliveryFailed.request(requestInput(fixture)), (error: unknown) => {
            assert.ok(error instanceof ServiceUnavailableError);
            assert.doesNotMatch(error.message, /provider|brevo|transport|detail/i);
            return true;
        });
        assert.equal(deliveries, 1);
        assert.deepEqual(await readSignupRows(pool, fixture.email), {
            budgets: '1', challenges: '1', users: '0', students: '0', grants: '0', proofs: '0', evidence: '0',
        });
        const failedBudget = await pool.query<{ current_challenge_id: string; resend_available_at: Date }>(
            `SELECT current_challenge_id, resend_available_at
             FROM verification_challenge_budgets
             WHERE purpose = 'student_signup' AND subject_digest = $1`,
            [challengeSubjectDigest('student_signup', fixture.email)],
        );
        const firstChallengeId = failedBudget.rows[0]!.current_challenge_id;
        await assert.rejects(deliveryFailed.request(requestInput(fixture)), (error: unknown) => {
            assert.ok(error instanceof StudentSignupRateLimitError);
            assert.equal(error.statusCode, 429);
            assert.equal(error.retryAt.getTime(), failedBudget.rows[0]!.resend_available_at.getTime());
            return true;
        });
        assert.equal(deliveries, 1);

        await pool.query(
            `UPDATE verification_challenge_budgets
             SET resend_available_at = clock_timestamp() - interval '1 second'
             WHERE current_challenge_id = $1`,
            [firstChallengeId],
        );
        const replacement = await deliveryFailed.request(requestInput(fixture));
        assert.notEqual(replacement.challengeId, firstChallengeId);
        assert.equal(deliveries, 2);
        await assertNoSignupAuthority(pool, fixture.email);
        const firstChallenge = await pool.query<{ superseded_at: Date | null }>(
            'SELECT superseded_at FROM verification_challenges WHERE id = $1',
            [firstChallengeId],
        );
        assert.notEqual(firstChallenge.rows[0]?.superseded_at, null);
        const completion = await deliveryFailed.confirm({
            ...requestInput(fixture), challengeId: replacement.challengeId, otp: recoveredOtp, password: 'StrongPass123!',
        });
        assert.equal(completion.user.email, fixture.email);
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

test('holds the winner at an explicit PostgreSQL barrier and proves the exact contender PID blocks behind it', async () => {
    await withPool(async (pool) => {
        const client = await pool.connect();
        const fixture = await createFixture(client);
        client.release();
        let otp = '';
        const tracked = trackedSignupPool(pool);
        const service = createStudentSignupService({
            pool: tracked.pool,
            isEmailConfigured: () => true,
            deliverOtp: async (_email, code) => {
                otp = code;
                return { success: true };
            },
        });
        const request = await service.request(requestInput(fixture));
        const barrierKey = 734261;
        const emailLiteral = fixture.email.replaceAll("'", "''");
        await pool.query(`
            CREATE FUNCTION student_signup_test_hold_winner() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW.email = '${emailLiteral}' THEN
                    PERFORM pg_advisory_xact_lock(${barrierKey});
                END IF;
                RETURN NEW;
            END $$;
            CREATE TRIGGER student_signup_test_hold_winner_before_insert
            BEFORE INSERT ON users
            FOR EACH ROW EXECUTE FUNCTION student_signup_test_hold_winner();
        `);
        const control = await pool.connect();
        let barrierReleased = false;
        let first: Promise<PromiseSettledResult<Awaited<ReturnType<typeof service.confirm>>>> | undefined;
        let second: Promise<PromiseSettledResult<Awaited<ReturnType<typeof service.confirm>>>> | undefined;
        try {
            await control.query('SELECT pg_advisory_lock($1)', [barrierKey]);
            first = settle(service.confirm({ ...requestInput(fixture), challengeId: request.challengeId, otp, password: 'StrongPass123!' }));
            await waitFor('winner confirmation connection', async () => tracked.pids.length >= 2);
            const winnerPid = tracked.pids[1]!;
            await waitForAdvisoryWait(pool, winnerPid);

            second = settle(service.confirm({ ...requestInput(fixture), challengeId: request.challengeId, otp, password: 'StrongPass123!' }));
            await waitFor('contender confirmation connection', async () => tracked.pids.length >= 3);
            const contenderPid = tracked.pids[2]!;
            await waitForExactBlockingPid(pool, contenderPid, winnerPid);

            await control.query('SELECT pg_advisory_unlock($1)', [barrierKey]);
            barrierReleased = true;
            const results = await Promise.all([first, second]);
            assert.equal(results[0]?.status, 'fulfilled');
            assert.equal(results[1]?.status, 'rejected');
            if (results[1]?.status === 'rejected') assert.ok(results[1].reason instanceof ConflictError);
        } finally {
            if (!barrierReleased) await control.query('SELECT pg_advisory_unlock($1)', [barrierKey]).catch(() => undefined);
            control.release();
            await Promise.all([first, second].filter((pending): pending is Promise<PromiseSettledResult<Awaited<ReturnType<typeof service.confirm>>>> => pending !== undefined));
            await pool.query('DROP TRIGGER IF EXISTS student_signup_test_hold_winner_before_insert ON users');
            await pool.query('DROP FUNCTION IF EXISTS student_signup_test_hold_winner()');
        }
        const outcome = await pool.query<{ users: string; students: string; grants: string; proofs: string; evidence: string }>(
            `SELECT (SELECT count(*) FROM users WHERE lower(btrim(email)) = $1) AS users,
                    (SELECT count(*) FROM students
                     JOIN users ON users.id = students.user_id
                     WHERE lower(btrim(users.email)) = $1) AS students,
                    (SELECT count(*) FROM verification_consents
                     JOIN users ON users.id = verification_consents.user_id
                     WHERE lower(btrim(users.email)) = $1) AS grants,
                    (SELECT count(*) FROM user_email_proofs
                     JOIN users ON users.id = user_email_proofs.user_id
                     WHERE lower(btrim(users.email)) = $1) AS proofs,
                    (SELECT count(*) FROM eligibility_evidence evidence
                     JOIN students ON students.id = evidence.student_id
                     JOIN users ON users.id = students.user_id
                     WHERE lower(btrim(users.email)) = $1) AS evidence`,
            [fixture.email],
        );
        assert.deepEqual(outcome.rows[0], { users: '1', students: '1', grants: '1', proofs: '1', evidence: '1' });
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
