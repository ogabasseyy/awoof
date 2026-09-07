import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import type pg from 'pg';
import { ConflictError } from '../../common/errors/AppError.js';
import { VerificationController } from '../../controllers/verification.controller.js';
import { errorHandler } from '../../common/middleware/errorHandler.js';
import { createVerificationRouter } from '../../routes/verification.routes.js';
import { jwtService } from '../../services/auth/jwt.service.js';
import { challengeSubjectDigest } from '../../services/verification/challenge.service.js';
import { applyEnrollmentDecision, beginEnrollmentCheck } from '../../services/verification/eligibility-evidence.service.js';
import { getEffectiveEligibility } from '../../services/verification/eligibility-read.service.js';
import {
    ENROLLMENT_SCHEMA_VERSION,
    parseConfiguredEnrollmentAdapter,
    verifyConfiguredEnrollment,
    type EnrollmentTransport,
} from '../../services/verification/registration-lookup.service.js';
import { createVerificationFlowService } from '../../services/verification/verification-flow.service.js';
import { VERIFICATION_NOTICE_VERSION } from '../../services/verification/verification-notices.js';
import { assertFixtureDatabase, createTestPool } from './test-database.js';

type Institution = { adminId: string; universityId: string };
type StudentFixture = { userId: string; studentId: string; email: string; universityId: string };

const MUTATION_TIMEOUT_MS = 100;

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

async function inTransaction<T>(pool: pg.Pool, operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

async function runBoundedMutation<T>(
    pool: pg.Pool,
    mutation: (client: pg.PoolClient) => Promise<T>,
    timeoutMs = MUTATION_TIMEOUT_MS,
): Promise<T> {
    const client = await pool.connect();
    let transactionOpen = false;
    try {
        await client.query('BEGIN');
        transactionOpen = true;
        await client.query(`SET LOCAL lock_timeout = '${timeoutMs}ms'`);
        await client.query(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);
        const result = await mutation(client);
        await client.query('COMMIT');
        transactionOpen = false;
        return result;
    } catch (error) {
        if (transactionOpen) await settleWithin(settle(client.query('ROLLBACK')), 'bounded mutation rollback', timeoutMs);
        throw error;
    } finally {
        client.release();
    }
}

async function withVerificationServer(
    operation: (baseUrl: string) => Promise<void>,
    controller: VerificationController,
): Promise<void> {
    const app = express();
    app.use(express.json());
    app.use('/verification', createVerificationRouter(controller));
    app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture did not expose a loopback port');
    try {
        await operation(`http://127.0.0.1:${address.port}/verification`);
    } finally {
        server.close();
        await once(server, 'close');
    }
}

function accessToken(userId: string, email: string): string {
    return jwtService.generateAccessToken({ userId, email, role: 'student' });
}

async function createInstitution(pool: pg.Pool): Promise<Institution> {
    const label = randomUUID();
    const adminId = (await pool.query<{ id: string }>(
        `INSERT INTO users (email, role) VALUES ($1, 'admin') RETURNING id`,
        [`admin-${label}@example.invalid`],
    )).rows[0]!.id;
    const universityId = (await pool.query<{ id: string }>(
        `INSERT INTO universities (name, is_active, registration_normalization)
         VALUES ($1, true, 'trim_upper') RETURNING id`,
        [`Enrollment Flow University ${label}`],
    )).rows[0]!.id;
    await pool.query(
        `INSERT INTO approved_student_email_domains (university_id, domain, approved_by)
         VALUES ($1, 'students.flow.example', $2)`,
        [universityId, adminId],
    );
    await pool.query(
        `INSERT INTO university_verification_methods
             (university_id, method_type, api_endpoint, api_config, is_active)
         VALUES ($1, 'registration', 'https://provider.school.example/v1/enrollment', $2, true)`,
        [universityId, { schemaVersion: ENROLLMENT_SCHEMA_VERSION }],
    );
    return { adminId, universityId };
}

async function createStudent(pool: pg.Pool, institution: Institution): Promise<StudentFixture> {
    const label = randomUUID();
    const email = `ada-${label}@students.flow.example`;
    const userId = (await pool.query<{ id: string }>(
        `INSERT INTO users (email, role) VALUES ($1, 'student') RETURNING id`,
        [email],
    )).rows[0]!.id;
    const studentId = (await pool.query<{ id: string }>(
        `INSERT INTO students (user_id, name, university_id, status)
         VALUES ($1, 'Ada Flow', $2, 'active') RETURNING id`,
        [userId, institution.universityId],
    )).rows[0]!.id;
    return { userId, studentId, email, universityId: institution.universityId };
}

async function prepareEnrollmentFlow(
    pool: pg.Pool,
    student: StudentFixture,
    enrollmentTransport: EnrollmentTransport,
) {
    const delivered: Array<{ code: string }> = [];
    const flow = createVerificationFlowService({
        pool,
        isEmailConfigured: () => true,
        deliverOtp: async (_email, code) => {
            delivered.push({ code });
            return { success: true };
        },
        enrollmentTransport,
    });
    const initiated = await flow.initiate(student.userId, {
        universityId: student.universityId,
        accepted: true,
        noticeVersion: VERIFICATION_NOTICE_VERSION,
    });
    const requested = await flow.requestEmail(student.userId, { processingGrantId: initiated.processingGrantId });
    await flow.confirmEmail(student.userId, { challengeId: requested.challengeId, otp: delivered[0]!.code });
    return { flow, processingGrantId: initiated.processingGrantId, delivered };
}

async function refreshEmailAssurance(
    pool: pg.Pool,
    student: StudentFixture,
    flow: ReturnType<typeof createVerificationFlowService>,
    processingGrantId: string,
    delivered: Array<{ code: string }>,
): Promise<void> {
    await pool.query(
        `UPDATE verification_challenge_budgets
         SET resend_available_at = clock_timestamp() - interval '1 second'
         WHERE purpose = 'student_email'
           AND subject_digest = $1`,
        [challengeSubjectDigest('student_email', student.userId)],
    );
    const requested = await flow.requestEmail(student.userId, { processingGrantId });
    await flow.confirmEmail(student.userId, { challengeId: requested.challengeId, otp: delivered.at(-1)!.code });
}

function verifiedReply(email: string, registrationNumber: string) {
    return {
        status: 200,
        data: {
            schemaVersion: ENROLLMENT_SCHEMA_VERSION,
            outcome: 'verified',
            email,
            registrationNumber,
            validUntil: '2099-01-02T03:04:05.000Z',
        },
    };
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    do {
        if (predicate()) return;
        await delay(5);
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${label}`);
}

async function settleWithin<T>(operation: Promise<T>, label: string, timeoutMs = 500): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<T>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`Timed out draining ${label}`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function deferred(): { promise: Promise<void>; release: () => void } {
    let release: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
}

function settle<T>(operation: Promise<T>): Promise<PromiseSettledResult<T>> {
    return operation.then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ status: 'rejected', reason }),
    );
}

test('authenticated registration commits a proven mailbox snapshot and returns only effective eligibility', async () => {
    await withPool(async (pool) => {
        const institution = await createInstitution(pool);
        const student = await createStudent(pool, institution);
        const providerCalls: Array<{ email: string; registrationNumber: string }> = [];
        const { flow, processingGrantId } = await prepareEnrollmentFlow(pool, student, async (request) => {
            providerCalls.push({ email: request.email, registrationNumber: request.registrationNumber });
            return verifiedReply(request.email, request.registrationNumber);
        });
        await withVerificationServer(async (baseUrl) => {
            const response = await fetch(`${baseUrl}/registration`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${accessToken(student.userId, student.email)}`,
                },
                body: JSON.stringify({ registrationNumber: 'REG-FLOW-1', processingGrantId }),
            });
            assert.equal(response.status, 200);
            const body = await response.json() as { data: { eligibility: { eligible: boolean } } };
            assert.equal(body.data.eligibility.eligible, true);
            assert.equal(JSON.stringify(body).includes('provider.school.example'), false);
            assert.equal(JSON.stringify(body).toLowerCase().includes('accesstoken'), false);
            assert.equal(JSON.stringify(body).toLowerCase().includes('refreshtoken'), false);
        }, new VerificationController({ flow }));
        assert.deepEqual(providerCalls, [{ email: student.email, registrationNumber: 'REG-FLOW-1' }]);
        const evidence = await pool.query<{ method: string; outcome: string; source: string }>(
            `SELECT method, outcome, source FROM eligibility_evidence
             WHERE student_id = $1 AND method = 'enrollment'`,
            [student.studentId],
        );
        assert.deepEqual(evidence.rows, [{ method: 'enrollment', outcome: 'verified', source: 'institution-registration:v1' }]);
    });
});

test('a denied enrollment remains denied after a weaker email retry; mismatched denial writes no evidence; matching verification clears it', async () => {
    await withPool(async (pool) => {
        const institution = await createInstitution(pool);
        const student = await createStudent(pool, institution);
        let reply: unknown = { schemaVersion: ENROLLMENT_SCHEMA_VERSION, outcome: 'denied', email: student.email };
        const { flow, processingGrantId, delivered } = await prepareEnrollmentFlow(pool, student, async () => ({ status: 200, data: reply }));

        const denied = await flow.verifyRegistration(student.userId, { registrationNumber: 'REG-DENIED', processingGrantId });
        assert.deepEqual(denied.eligibility, { eligible: false, reason: 'enrollment_denied' });
        await refreshEmailAssurance(pool, student, flow, processingGrantId, delivered);
        assert.deepEqual((await flow.status(student.userId)).eligibility, { eligible: false, reason: 'enrollment_denied' });

        const evidenceBeforeMismatch = await pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM eligibility_evidence
             WHERE student_id = $1 AND method = 'enrollment' AND outcome = 'denied'`,
            [student.studentId],
        );
        reply = { schemaVersion: ENROLLMENT_SCHEMA_VERSION, outcome: 'denied', email: 'victim@students.flow.example' };
        const mismatched = await flow.verifyRegistration(student.userId, { registrationNumber: 'REG-DENIED', processingGrantId });
        assert.deepEqual(mismatched, { eligibility: { eligible: false, reason: 'enrollment_denied' }, reason: 'provider_unknown' });
        const evidenceAfterMismatch = await pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM eligibility_evidence
             WHERE student_id = $1 AND method = 'enrollment' AND outcome = 'denied'`,
            [student.studentId],
        );
        assert.deepEqual(evidenceBeforeMismatch.rows, [{ count: '1' }]);
        assert.deepEqual(evidenceAfterMismatch.rows, [{ count: '1' }]);

        reply = verifiedReply(student.email, ' reg-denied ' ).data;
        const verified = await flow.verifyRegistration(student.userId, { registrationNumber: 'REG-DENIED', processingGrantId });
        assert.equal(verified.eligibility.eligible, true);
    });
});

test('a conflicting parsed denial cannot change an already applied positive generation', async () => {
    await withPool(async (pool) => {
        const institution = await createInstitution(pool);
        const student = await createStudent(pool, institution);
        const { processingGrantId } = await prepareEnrollmentFlow(pool, student, async (request) => verifiedReply(request.email, request.registrationNumber));
        const snapshot = await inTransaction(pool, (client) => beginEnrollmentCheck(client, student.userId, processingGrantId));
        const adapter = parseConfiguredEnrollmentAdapter({
            isActive: true,
            apiEndpoint: 'https://provider.school.example/v1/enrollment',
            apiConfig: { schemaVersion: ENROLLMENT_SCHEMA_VERSION },
        });
        if (!adapter) throw new Error('Fixture adapter did not parse');
        const positive = await verifyConfiguredEnrollment(adapter, {
            email: student.email,
            registrationNumber: 'REG-SAME-GENERATION',
            normalization: 'trim_upper',
        }, async (request) => verifiedReply(request.email, request.registrationNumber));
        const conflictingDenial = await verifyConfiguredEnrollment(adapter, {
            email: student.email,
            registrationNumber: 'REG-SAME-GENERATION',
            normalization: 'trim_upper',
        }, async (request) => ({
            status: 200,
            data: { schemaVersion: ENROLLMENT_SCHEMA_VERSION, outcome: 'denied', email: request.email },
        }));
        assert.equal(positive.decision.outcome, 'verified');
        assert.equal(conflictingDenial.decision.outcome, 'denied');
        await inTransaction(pool, (client) => applyEnrollmentDecision(client, snapshot, positive.decision));
        const capture = async () => ({
            state: (await pool.query(
                `SELECT provider_request_generation, provider_applied_generation, authoritative_denial, current_evidence_id::text
                 FROM student_eligibility_state WHERE student_id = $1 AND university_id = $2`,
                [student.studentId, student.universityId],
            )).rows,
            evidence: (await pool.query<{ evidence: string }>(
                `SELECT coalesce(json_agg(to_jsonb(e) ORDER BY e.id)::text, '[]') AS evidence
                 FROM eligibility_evidence e WHERE e.student_id = $1 AND e.method = 'enrollment'`,
                [student.studentId],
            )).rows,
            ownership: (await pool.query(
                `SELECT identifier, student_id::text, revoked_at::text
                 FROM verified_registration_identities
                 WHERE university_id = $1 ORDER BY identifier`,
                [student.universityId],
            )).rows,
            eligibility: await inTransaction(pool, (client) => getEffectiveEligibility(client, student.userId)),
        });
        const before = await capture();
        await assert.rejects(
            inTransaction(pool, (client) => applyEnrollmentDecision(client, snapshot, conflictingDenial.decision)),
            (error: unknown) => error instanceof ConflictError && /generation/.test(error.message),
        );
        assert.deepEqual(await capture(), before);
    });
});

test('a verified registration identity remains owned by its first student and does not merge another student', async () => {
    await withPool(async (pool) => {
        const institution = await createInstitution(pool);
        const firstStudent = await createStudent(pool, institution);
        const secondStudent = await createStudent(pool, institution);
        const first = await prepareEnrollmentFlow(pool, firstStudent, async (request) => verifiedReply(request.email, request.registrationNumber));
        const second = await prepareEnrollmentFlow(pool, secondStudent, async (request) => verifiedReply(request.email, request.registrationNumber));
        const identifier = 'REG-SHARED';
        assert.equal((await first.flow.verifyRegistration(firstStudent.userId, { registrationNumber: identifier, processingGrantId: first.processingGrantId })).eligibility.eligible, true);
        await assert.rejects(
            second.flow.verifyRegistration(secondStudent.userId, { registrationNumber: identifier, processingGrantId: second.processingGrantId }),
            /Verified registration identity belongs to another student/,
        );
        const identity = await pool.query<{ student_id: string }>(
            `SELECT student_id FROM verified_registration_identities
             WHERE university_id = $1 AND identifier = $2 AND revoked_at IS NULL`,
            [institution.universityId, identifier],
        );
        const secondEvidence = await pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM eligibility_evidence
             WHERE student_id = $1 AND method = 'enrollment'`,
            [secondStudent.studentId],
        );
        assert.deepEqual(identity.rows, [{ student_id: firstStudent.studentId }]);
        assert.deepEqual(secondEvidence.rows, [{ count: '0' }]);
    });
});

test('transport barriers settle and drain in finally while every stale snapshot input writes no enrollment evidence', async () => {
    await withPool(async (pool) => {
        const scenarios: Array<{
            name: string;
            mutate: (client: pg.PoolClient, student: StudentFixture, processingGrantId: string) => Promise<unknown>;
            expected: RegExp;
        }> = [
            {
                name: 'mailbox',
                mutate: (client, student) => client.query(
                    `UPDATE users SET email = $2 WHERE id = $1`,
                    [student.userId, `changed-${randomUUID()}@students.flow.example`],
                ),
                expected: /Enrollment snapshot is stale/,
            },
            {
                name: 'student profile',
                mutate: (client, student) => client.query(
                    `UPDATE students SET name = 'Changed Student' WHERE user_id = $1`,
                    [student.userId],
                ),
                expected: /Enrollment snapshot is stale/,
            },
            {
                name: 'institution policy',
                mutate: (client, student) => client.query(
                    `UPDATE universities SET enrollment_validity_days = enrollment_validity_days + 1 WHERE id = $1`,
                    [student.universityId],
                ),
                expected: /Enrollment snapshot is stale/,
            },
            {
                name: 'processing grant',
                mutate: (client, _student, processingGrantId) => client.query(
                    `UPDATE verification_consents SET withdrawn_at = clock_timestamp() WHERE id = $1`,
                    [processingGrantId],
                ),
                expected: /Current processing consent required/,
            },
        ];
        for (const scenario of scenarios) {
            const institution = await createInstitution(pool);
            const student = await createStudent(pool, institution);
            const gate = deferred();
            let started = false;
            const { flow, processingGrantId } = await prepareEnrollmentFlow(pool, student, async (request) => {
                started = true;
                await gate.promise;
                return verifiedReply(request.email, request.registrationNumber);
            });
            const registration = settle(flow.verifyRegistration(student.userId, { registrationNumber: 'REG-STALE', processingGrantId }));
            try {
                await waitFor(`${scenario.name} provider transport barrier`, () => started);
                const mutation = settle(runBoundedMutation(pool, (client) => scenario.mutate(client, student, processingGrantId)));
                const mutationResult = await mutation;
                assert.equal(mutationResult.status, 'fulfilled', scenario.name);
                gate.release();
                const settled = await registration;
                assert.equal(settled.status, 'rejected', scenario.name);
                if (settled.status === 'rejected') assert.match(String(settled.reason), scenario.expected, scenario.name);
                const evidence = await pool.query<{ count: string }>(
                    `SELECT count(*)::text AS count FROM eligibility_evidence WHERE student_id = $1 AND method = 'enrollment'`,
                    [student.studentId],
                );
                assert.deepEqual(evidence.rows, [{ count: '0' }], scenario.name);
            } finally {
                gate.release();
                await settleWithin(registration, `${scenario.name} registration`);
            }
        }
    });
});

test('held database contention bounds the mutation before the transport barrier is released and drained', async () => {
    await withPool(async (pool) => {
        const institution = await createInstitution(pool);
        const student = await createStudent(pool, institution);
        const gate = deferred();
        let transportStarted = false;
        const { flow, processingGrantId } = await prepareEnrollmentFlow(pool, student, async (request) => {
            transportStarted = true;
            await gate.promise;
            return verifiedReply(request.email, request.registrationNumber);
        });
        const registration = settle(flow.verifyRegistration(student.userId, { registrationNumber: 'REG-LOCK-TIMEOUT', processingGrantId }));
        const blocker = await pool.connect();
        let blockerTransactionOpen = false;
        let mutation: Promise<PromiseSettledResult<unknown>> | undefined;
        try {
            await waitFor('provider transport barrier', () => transportStarted);
            await blocker.query('BEGIN');
            blockerTransactionOpen = true;
            await blocker.query(`SET LOCAL statement_timeout = '${MUTATION_TIMEOUT_MS}ms'`);
            await blocker.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [student.userId]);

            const startedAt = Date.now();
            mutation = settle(runBoundedMutation(pool, (client) => client.query(
                `UPDATE users SET email = $2 WHERE id = $1`,
                [student.userId, `blocked-${randomUUID()}@students.flow.example`],
            )));
            const mutationResult = await settleWithin(mutation, 'blocked mutation', MUTATION_TIMEOUT_MS * 3);
            assert.equal(mutationResult.status, 'rejected');
            if (mutationResult.status === 'rejected') assert.match(String(mutationResult.reason), /lock timeout|statement timeout/i);
            assert.ok(Date.now() - startedAt < MUTATION_TIMEOUT_MS * 3);

            gate.release();
            const rollback = await settleWithin(settle(blocker.query('ROLLBACK')), 'blocker rollback', MUTATION_TIMEOUT_MS * 3);
            assert.equal(rollback.status, 'fulfilled');
            blockerTransactionOpen = false;
            const registrationResult = await settleWithin(registration, 'released registration', MUTATION_TIMEOUT_MS * 5);
            assert.equal(registrationResult.status, 'fulfilled');
        } finally {
            gate.release();
            if (blockerTransactionOpen) {
                await settleWithin(settle(blocker.query('ROLLBACK')), 'finally blocker rollback', MUTATION_TIMEOUT_MS * 3);
            }
            blocker.release();
            if (mutation) await settleWithin(mutation, 'finally blocked mutation', MUTATION_TIMEOUT_MS * 3);
            await settleWithin(registration, 'finally registration', MUTATION_TIMEOUT_MS * 5);
        }
    });
});

test('concurrent provider barriers settle and drain in finally, applying only the newest generation', async () => {
    await withPool(async (pool) => {
        const institution = await createInstitution(pool);
        const student = await createStudent(pool, institution);
        const gate = deferred();
        let arrivals = 0;
        const { flow, processingGrantId } = await prepareEnrollmentFlow(pool, student, async (request) => {
            arrivals += 1;
            await gate.promise;
            return verifiedReply(request.email, request.registrationNumber);
        });
        const registrations = [
            settle(flow.verifyRegistration(student.userId, { registrationNumber: 'REG-CONCURRENT', processingGrantId })),
            settle(flow.verifyRegistration(student.userId, { registrationNumber: 'REG-CONCURRENT', processingGrantId })),
        ];
        try {
            await waitFor('both synthetic provider requests', () => arrivals === 2);
            gate.release();
            const settled = await Promise.all(registrations);
            assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1);
            assert.equal(settled.filter((result) => result.status === 'rejected').length, 1);
            const state = await pool.query<{ provider_request_generation: number; provider_applied_generation: number }>(
                `SELECT state.provider_request_generation, state.provider_applied_generation
                 FROM student_eligibility_state state
                 WHERE state.student_id = $1 AND state.university_id = $2`,
                [student.studentId, institution.universityId],
            );
            assert.deepEqual(state.rows, [{ provider_request_generation: 2, provider_applied_generation: 2 }]);
        } finally {
            gate.release();
            await settleWithin(Promise.all(registrations), 'concurrent registrations');
        }
    });
});
