import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test, { after } from 'node:test';
import express from 'express';
import type pg from 'pg';
import { VerificationController } from '../../controllers/verification.controller.js';
import { db } from '../../config/database.js';
import { errorHandler } from '../../common/middleware/errorHandler.js';
import { createVerificationRouter } from '../../routes/verification.routes.js';
import { jwtService } from '../../services/auth/jwt.service.js';
import { challengeSubjectDigest } from '../../services/verification/challenge.service.js';
import { createVerificationFlowService } from '../../services/verification/verification-flow.service.js';
import { getAvailableVerificationMethods } from '../../services/verification/verification-orchestrator.service.js';
import type { EligibilityResult } from '../../services/verification/eligibility.types.js';
import {
    MERCHANT_DISCLOSURE_NOTICE_VERSION,
    VERIFICATION_NOTICE_VERSION,
} from '../../services/verification/verification-notices.js';
import { assertFixtureDatabase, createTestPool } from './test-database.js';

after(async () => {
    await db.close();
});

type Fixture = {
    userId: string;
    universityId: string;
    email: string;
};

type MerchantFixture = {
    vendorId: string;
    origin: string;
};

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

async function createFixture(pool: pg.Pool): Promise<Fixture> {
    const label = randomUUID();
    const adminId = (await pool.query<{ id: string }>(
        `INSERT INTO users (email, role) VALUES ($1, 'admin') RETURNING id`,
        [`admin-${label}@example.invalid`],
    )).rows[0]!.id;
    const universityId = (await pool.query<{ id: string }>(
        `INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id`,
        [`Flow University ${label}`],
    )).rows[0]!.id;
    await pool.query(
        `INSERT INTO approved_student_email_domains (university_id, domain, approved_by)
         VALUES ($1, 'students.flow.example', $2)`,
        [universityId, adminId],
    );
    const email = `ada-${label}@students.flow.example`;
    const userId = (await pool.query<{ id: string }>(
        `INSERT INTO users (email, role) VALUES ($1, 'student') RETURNING id`,
        [email],
    )).rows[0]!.id;
    await pool.query(
        `INSERT INTO students (user_id, name, university_id, status)
         VALUES ($1, 'Ada Flow', $2, 'active')`,
        [userId, universityId],
    );
    return { userId, universityId, email };
}

async function createMerchantFixture(pool: pg.Pool): Promise<MerchantFixture> {
    const label = randomUUID();
    const ownerId = (await pool.query<{ id: string }>(
        `INSERT INTO users (email, role) VALUES ($1, 'vendor') RETURNING id`,
        [`merchant-owner-${label}@example.invalid`],
    )).rows[0]!.id;
    const vendorId = (await pool.query<{ id: string }>(
        `INSERT INTO vendors (user_id, name, status) VALUES ($1, $2, 'active') RETURNING id`,
        [ownerId, `Flow Merchant ${label}`],
    )).rows[0]!.id;
    const origin = `https://${label}.merchant.example`;
    await pool.query(
        `INSERT INTO widget_configs (vendor_id, allowed_domains, allowed_origins, api_key, status)
         VALUES ($1, ARRAY['legacy.example'], ARRAY[$2], $3, 'active')`,
        [vendorId, origin, `public-${label}`],
    );
    return { vendorId, origin };
}

async function withVerificationServer(
    operation: (baseUrl: string) => Promise<void>,
    controller: VerificationController = new VerificationController(),
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

function accessToken(userId: string, email: string, role: 'student' | 'vendor' = 'student'): string {
    return jwtService.generateAccessToken({ userId, email, role });
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(label: string, predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    do {
        if (await predicate()) return;
        await delay(10);
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${label}`);
}

async function backendPid(client: pg.PoolClient): Promise<number> {
    const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    return result.rows[0]!.pid;
}

function pinnedPool(client: pg.PoolClient): Pick<pg.Pool, 'connect'> {
    const pinned = new Proxy(client, {
        get(target, property) {
            if (property === 'release') return () => undefined;
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    }) as pg.PoolClient;
    return { connect: async () => pinned };
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

function settle<T>(operation: Promise<T>): Promise<PromiseSettledResult<T>> {
    return operation.then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ status: 'rejected', reason }),
    );
}

test('binds a delivered email OTP and resulting evidence to the current signed-in student', async () => {
    await withPool(async (pool) => {
        const fixture = await createFixture(pool);
        const delivered: Array<{ email: string; code: string }> = [];
        const flow = createVerificationFlowService({
            pool,
            isEmailConfigured: () => true,
            deliverOtp: async (email, code) => {
                delivered.push({ email, code });
                return { success: true };
            },
        });

        const initiated = await flow.initiate(fixture.userId, {
            universityId: fixture.universityId,
            accepted: true,
            noticeVersion: VERIFICATION_NOTICE_VERSION,
        });
        assert.equal(initiated.email, fixture.email);
        assert.equal(initiated.universityId, fixture.universityId);

        const requested = await flow.requestEmail(fixture.userId, {
            processingGrantId: initiated.processingGrantId,
        });
        assert.equal(delivered.length, 1);
        assert.deepEqual(delivered[0]!.email, fixture.email);
        assert.match(delivered[0]!.code, /^\d{6}$/);

        const confirmed = await flow.confirmEmail(fixture.userId, {
            challengeId: requested.challengeId,
            otp: delivered[0]!.code,
        });
        assert.equal(confirmed.eligible, true);
        if (!confirmed.eligible) return;
        assert.equal(confirmed.universityId, fixture.universityId);
        assert.equal(confirmed.processingGrantId, initiated.processingGrantId);

        const evidence = await pool.query<{ user_id: string; email: string }>(
            `SELECT proofs.user_id, proofs.email
             FROM eligibility_evidence evidence
             JOIN user_email_proofs proofs ON proofs.id = evidence.email_proof_id
             WHERE evidence.id = $1`,
            [confirmed.evidenceId],
        );
        assert.deepEqual(evidence.rows, [{ user_id: fixture.userId, email: fixture.email }]);
    });
});

test('keeps merchant disclosures separate, preserves another merchant grant, and permits inactive owner withdrawal', async () => {
    await withPool(async (pool) => {
        const fixture = await createFixture(pool);
        const merchantA = await createMerchantFixture(pool);
        const merchantB = await createMerchantFixture(pool);
        const flow = createVerificationFlowService({
            pool,
            isEmailConfigured: () => true,
            deliverOtp: async () => ({ success: true }),
        });
        const initiated = await flow.initiate(fixture.userId, {
            universityId: fixture.universityId, accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION,
        });
        const noImplicitDisclosure = await pool.query<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM verification_consents
             WHERE user_id = $1 AND kind = 'disclosure'`,
            [fixture.userId],
        );
        assert.deepEqual(noImplicitDisclosure.rows, [{ count: '0' }]);

        const disclosureA = await flow.grantDisclosure(fixture.userId, {
            vendorId: merchantA.vendorId,
            origin: merchantA.origin,
            purpose: 'student-discount',
            accepted: true,
            noticeVersion: MERCHANT_DISCLOSURE_NOTICE_VERSION,
        });
        const disclosureB = await flow.grantDisclosure(fixture.userId, {
            vendorId: merchantB.vendorId,
            origin: merchantB.origin,
            purpose: 'student-discount',
            accepted: true,
            noticeVersion: MERCHANT_DISCLOSURE_NOTICE_VERSION,
        });
        await flow.withdrawConsent(fixture.userId, disclosureA.grantId);
        const independent = await pool.query<{ id: string; withdrawn_at: Date | null }>(
            `SELECT id, withdrawn_at
             FROM verification_consents
             WHERE id = ANY($1::uuid[])
             ORDER BY id`,
            [[disclosureA.grantId, disclosureB.grantId].sort()],
        );
        assert.equal(independent.rows.length, 2);
        assert.equal(independent.rows.find((grant) => grant.id === disclosureA.grantId)?.withdrawn_at instanceof Date, true);
        assert.equal(independent.rows.find((grant) => grant.id === disclosureB.grantId)?.withdrawn_at, null);

        await pool.query(`UPDATE students SET status = 'suspended' WHERE user_id = $1`, [fixture.userId]);
        await pool.query(`UPDATE universities SET is_active = false WHERE id = $1`, [fixture.universityId]);
        await flow.withdrawConsent(fixture.userId, initiated.processingGrantId);
        const withdrawnProcessing = await pool.query<{ withdrawn_at: Date | null }>(
            `SELECT withdrawn_at FROM verification_consents WHERE id = $1`,
            [initiated.processingGrantId],
        );
        assert.equal(withdrawnProcessing.rows[0]?.withdrawn_at instanceof Date, true);

        const missingProfile = await createFixture(pool);
        const missingInitiated = await flow.initiate(missingProfile.userId, {
            universityId: missingProfile.universityId, accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION,
        });
        await pool.query(`DELETE FROM students WHERE user_id = $1`, [missingProfile.userId]);
        await flow.withdrawConsent(missingProfile.userId, missingInitiated.processingGrantId);
        const missingProfileWithdrawal = await pool.query<{ withdrawn_at: Date | null }>(
            `SELECT withdrawn_at FROM verification_consents WHERE id = $1`,
            [missingInitiated.processingGrantId],
        );
        assert.equal(missingProfileWithdrawal.rows[0]?.withdrawn_at instanceof Date, true);
    });
});

test('reports an owned inactive institution as current unverified status without allowing a new proof operation', async () => {
    await withPool(async (pool) => {
        const fixture = await createFixture(pool);
        await pool.query(`UPDATE universities SET is_active = false WHERE id = $1`, [fixture.universityId]);
        const flow = createVerificationFlowService({
            pool,
            isEmailConfigured: () => true,
            deliverOtp: async () => ({ success: true }),
        });

        const current = await flow.status(fixture.userId);
        assert.equal(current.email, fixture.email);
        assert.equal(current.universityId, fixture.universityId);
        assert.deepEqual(current.eligibility, { eligible: false, reason: 'inactive' });
        await assert.rejects(
            flow.requestEmail(fixture.userId, { processingGrantId: randomUUID() }),
            /Active student context required|Student email domain is not supported/i,
        );
    });
});

test('commits a wrong signed-in-student OTP guess without evidence and permits the remaining correct confirmation once', async () => {
    await withPool(async (pool) => {
        const fixture = await createFixture(pool);
        const delivered: Array<{ email: string; code: string }> = [];
        const flow = createVerificationFlowService({
            pool,
            isEmailConfigured: () => true,
            deliverOtp: async (email, code) => {
                delivered.push({ email, code });
                return { success: true };
            },
        });
        const initiated = await flow.initiate(fixture.userId, {
            universityId: fixture.universityId, accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION,
        });
        const requested = await flow.requestEmail(fixture.userId, { processingGrantId: initiated.processingGrantId });
        const wrongCode = delivered[0]!.code === '000000' ? '000001' : '000000';

        await assert.rejects(
            flow.confirmEmail(fixture.userId, { challengeId: requested.challengeId, otp: wrongCode }),
            /Invalid verification code/i,
        );
        const afterGuess = await pool.query<{ failed_attempts: number; evidence_count: string }>(
            `SELECT budgets.failed_attempts,
                    (SELECT count(*)::text FROM eligibility_evidence WHERE challenge_id = $1) AS evidence_count
             FROM verification_challenge_budgets budgets
             WHERE budgets.purpose = 'student_email' AND budgets.current_challenge_id = $1`,
            [requested.challengeId],
        );
        assert.deepEqual(afterGuess.rows, [{ failed_attempts: 1, evidence_count: '0' }]);

        const first = await flow.confirmEmail(fixture.userId, { challengeId: requested.challengeId, otp: delivered[0]!.code });
        assert.equal(first.eligible, true);
        await assert.rejects(
            flow.confirmEmail(fixture.userId, { challengeId: requested.challengeId, otp: delivered[0]!.code }),
            /Invalid verification code/i,
        );
        const evidence = await pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM eligibility_evidence WHERE challenge_id = $1`,
            [requested.challengeId],
        );
        assert.deepEqual(evidence.rows, [{ count: '1' }]);
    });
});

test('retains the committed challenge cooldown when configured mail delivery fails', async () => {
    await withPool(async (pool) => {
        const fixture = await createFixture(pool);
        const flow = createVerificationFlowService({
            pool,
            isEmailConfigured: () => true,
            deliverOtp: async () => ({ success: false }),
        });
        const initiated = await flow.initiate(fixture.userId, {
            universityId: fixture.universityId, accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION,
        });

        await assert.rejects(
            flow.requestEmail(fixture.userId, { processingGrantId: initiated.processingGrantId }),
            /could not deliver a verification code/i,
        );
        const committed = await pool.query<{ challenge_count: string; send_count: number }>(
            `SELECT (SELECT count(*)::text FROM verification_challenges WHERE purpose = 'student_email' AND subject_digest = budgets.subject_digest) AS challenge_count,
                    budgets.send_count
             FROM verification_challenge_budgets budgets
             WHERE budgets.purpose = 'student_email' AND budgets.subject_digest = $1`,
            [
                (await pool.query<{ subject_digest: string }>(
                    `SELECT subject_digest FROM verification_challenge_budgets
                     WHERE purpose = 'student_email'
                     ORDER BY window_started_at DESC LIMIT 1`,
                )).rows[0]!.subject_digest,
            ],
        );
        assert.deepEqual(committed.rows, [{ challenge_count: '1', send_count: 1 }]);
        await assert.rejects(
            flow.requestEmail(fixture.userId, { processingGrantId: initiated.processingGrantId }),
            /Please wait before requesting another verification code/i,
        );
    });
});

test('keeps the student-email resend budget scoped to the account across an institution change', async () => {
    await withPool(async (pool) => {
        const fixture = await createFixture(pool);
        const adminId = (await pool.query<{ id: string }>(
            `INSERT INTO users (email, role) VALUES ($1, 'admin') RETURNING id`,
            [`admin-switch-${randomUUID()}@example.invalid`],
        )).rows[0]!.id;
        const replacementUniversityId = (await pool.query<{ id: string }>(
            `INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id`,
            [`Replacement University ${randomUUID()}`],
        )).rows[0]!.id;
        await pool.query(
            `INSERT INTO approved_student_email_domains (university_id, domain, approved_by)
             VALUES ($1, 'students.flow.example', $2)`,
            [replacementUniversityId, adminId],
        );
        const flow = createVerificationFlowService({
            pool,
            isEmailConfigured: () => true,
            deliverOtp: async () => ({ success: true }),
        });
        const firstGrant = await flow.initiate(fixture.userId, {
            universityId: fixture.universityId, accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION,
        });
        const firstRequest = await flow.requestEmail(fixture.userId, { processingGrantId: firstGrant.processingGrantId });
        const replacementGrant = await flow.initiate(fixture.userId, {
            universityId: replacementUniversityId, accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION,
        });
        await assert.rejects(
            flow.requestEmail(fixture.userId, { processingGrantId: replacementGrant.processingGrantId }),
            /Please wait before requesting another verification code/i,
        );
        const budget = await pool.query<{ send_count: number; current_challenge_id: string }>(
            `SELECT send_count, current_challenge_id
             FROM verification_challenge_budgets
             WHERE purpose = 'student_email' AND subject_digest = $1`,
            [challengeSubjectDigest('student_email', fixture.userId)],
        );
        assert.deepEqual(budget.rows, [{ send_count: 1, current_challenge_id: firstRequest.challengeId }]);
    });
});

test('does not let a foreign account consume a current student challenge or create mailbox proof', async () => {
    await withPool(async (pool) => {
        const owner = await createFixture(pool);
        const foreign = await createFixture(pool);
        const delivered: Array<{ code: string }> = [];
        const flow = createVerificationFlowService({
            pool,
            isEmailConfigured: () => true,
            deliverOtp: async (_email, code) => {
                delivered.push({ code });
                return { success: true };
            },
        });
        const initiated = await flow.initiate(owner.userId, {
            universityId: owner.universityId, accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION,
        });
        const requested = await flow.requestEmail(owner.userId, { processingGrantId: initiated.processingGrantId });

        await assert.rejects(
            flow.requestEmail(foreign.userId, { processingGrantId: initiated.processingGrantId }),
            /Current processing consent required/i,
        );

        await assert.rejects(
            flow.confirmEmail(foreign.userId, { challengeId: requested.challengeId, otp: delivered[0]!.code }),
            /not available for this account/i,
        );
        const challenge = await pool.query<{ consumed_at: Date | null; proof_count: string }>(
            `SELECT challenges.consumed_at,
                    (SELECT count(*)::text FROM user_email_proofs WHERE challenge_id = challenges.id) AS proof_count
             FROM verification_challenges challenges
             WHERE challenges.id = $1`,
            [requested.challengeId],
        );
        assert.deepEqual(challenge.rows, [{ consumed_at: null, proof_count: '0' }]);
    });
});

test('reports expired assurance, permits a bounded re-verification, and rejects a policy-stale challenge without consuming it', async () => {
    await withPool(async (pool) => {
        const fixture = await createFixture(pool);
        const delivered: Array<{ code: string }> = [];
        const flow = createVerificationFlowService({
            pool,
            isEmailConfigured: () => true,
            deliverOtp: async (_email, code) => { delivered.push({ code }); return { success: true }; },
        });
        const initiated = await flow.initiate(fixture.userId, {
            universityId: fixture.universityId, accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION,
        });
        const initial = await flow.requestEmail(fixture.userId, { processingGrantId: initiated.processingGrantId });
        const firstEvidence = await flow.confirmEmail(fixture.userId, { challengeId: initial.challengeId, otp: delivered[0]!.code });
        assert.equal(firstEvidence.eligible, true);
        if (!firstEvidence.eligible) throw new Error('Initial synthetic assurance was not eligible');
        const original = await pool.query<{ email_proof_id: string; identity_version: number; policy_version: number }>(
            `SELECT email_proof_id, identity_version, policy_version
             FROM eligibility_evidence WHERE id = $1`,
            [firstEvidence.evidenceId],
        );
        const expired = await pool.query<{ id: string }>(
            `INSERT INTO eligibility_evidence
                 (student_id, university_id, email_proof_id, processing_grant_id,
                  method, outcome, identity_version, policy_version, source, expires_at)
             VALUES ($1, $2, $3, $4, 'enrollment', 'verified', $5, $6, 'synthetic-expiry',
                     clock_timestamp() - interval '1 second')
             RETURNING id`,
            [
                firstEvidence.studentId,
                fixture.universityId,
                original.rows[0]!.email_proof_id,
                initiated.processingGrantId,
                original.rows[0]!.identity_version,
                original.rows[0]!.policy_version,
            ],
        );
        await pool.query(
            `UPDATE student_eligibility_state SET current_evidence_id = $3
             WHERE student_id = $1 AND university_id = $2`,
            [firstEvidence.studentId, fixture.universityId, expired.rows[0]!.id],
        );
        assert.deepEqual((await flow.status(fixture.userId)).eligibility, { eligible: false, reason: 'expired' });

        await pool.query(
            `UPDATE verification_challenge_budgets
             SET resend_available_at = clock_timestamp() - interval '1 second'
             WHERE current_challenge_id = $1`,
            [initial.challengeId],
        );
        const replacement = await flow.requestEmail(fixture.userId, { processingGrantId: initiated.processingGrantId });
        const renewed = await flow.confirmEmail(fixture.userId, { challengeId: replacement.challengeId, otp: delivered[1]!.code });
        assert.equal(renewed.eligible, true);

        await pool.query(
            `UPDATE verification_challenge_budgets
             SET resend_available_at = clock_timestamp() - interval '1 second'
             WHERE current_challenge_id = $1`,
            [replacement.challengeId],
        );
        const policyChallenge = await flow.requestEmail(fixture.userId, { processingGrantId: initiated.processingGrantId });
        await pool.query(
            `UPDATE universities
             SET verification_policy_version = verification_policy_version + 1
             WHERE id = $1`,
            [fixture.universityId],
        );
        await assert.rejects(
            flow.confirmEmail(fixture.userId, { challengeId: policyChallenge.challengeId, otp: delivered[2]!.code }),
            /bindings are stale/i,
        );
        const stale = await pool.query<{ consumed_at: Date | null; evidence: string }>(
            `SELECT challenges.consumed_at,
                    (SELECT count(*)::text FROM eligibility_evidence WHERE challenge_id = challenges.id) AS evidence
             FROM verification_challenges challenges
             WHERE challenges.id = $1`,
            [policyChallenge.challengeId],
        );
        assert.deepEqual(stale.rows, [{ consumed_at: null, evidence: '0' }]);
    });
});

test('rolls back successful challenge consumption when proof or evidence recording fails', async () => {
    await withPool(async (pool) => {
        const fixture = await createFixture(pool);
        const delivered: Array<{ code: string }> = [];
        const flow = createVerificationFlowService({
            pool,
            isEmailConfigured: () => true,
            deliverOtp: async (_email, code) => {
                delivered.push({ code });
                return { success: true };
            },
        });
        const initiated = await flow.initiate(fixture.userId, {
            universityId: fixture.universityId, accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION,
        });
        const requested = await flow.requestEmail(fixture.userId, { processingGrantId: initiated.processingGrantId });
        await pool.query(
            `CREATE TRIGGER verification_flow_fail_evidence_before_insert
             BEFORE INSERT ON eligibility_evidence
             FOR EACH ROW EXECUTE FUNCTION fail_test_trigger()`,
        ).catch(async () => {
            await pool.query(`CREATE OR REPLACE FUNCTION fail_test_trigger() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'verification flow injected failure'; END; $$ LANGUAGE plpgsql`);
            await pool.query(
                `CREATE TRIGGER verification_flow_fail_evidence_before_insert
                 BEFORE INSERT ON eligibility_evidence
                 FOR EACH ROW EXECUTE FUNCTION fail_test_trigger()`,
            );
        });
        try {
            await assert.rejects(
                flow.confirmEmail(fixture.userId, { challengeId: requested.challengeId, otp: delivered[0]!.code }),
                /verification flow injected failure/i,
            );
        } finally {
            await pool.query('DROP TRIGGER IF EXISTS verification_flow_fail_evidence_before_insert ON eligibility_evidence');
        }
        const rolledBack = await pool.query<{ consumed_at: Date | null; proofs: string; evidence: string }>(
            `SELECT challenges.consumed_at,
                    (SELECT count(*)::text FROM user_email_proofs WHERE challenge_id = challenges.id) AS proofs,
                    (SELECT count(*)::text FROM eligibility_evidence WHERE challenge_id = challenges.id) AS evidence
             FROM verification_challenges challenges
             WHERE challenges.id = $1`,
            [requested.challengeId],
        );
        assert.deepEqual(rolledBack.rows, [{ consumed_at: null, proofs: '0', evidence: '0' }]);
    });
});

test('advertises email only from active approved-domain policy and configured transport, not legacy method seeds', async () => {
    await withPool(async (pool) => {
        const fixture = await createFixture(pool);
        const previousKey = process.env.BREVO_API_KEY;
        try {
            process.env.BREVO_API_KEY = 'synthetic-mail-config';
            const withoutSeed = await getAvailableVerificationMethods(fixture.universityId);
            assert.equal(withoutSeed.find((method) => method.methodType === 'email')?.isAvailable, true);

            const unconfiguredUniversity = (await pool.query<{ id: string }>(
                `INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id`,
                [`Unconfigured ${randomUUID()}`],
            )).rows[0]!.id;
            await pool.query(
                `INSERT INTO university_verification_methods (university_id, method_type, is_active)
                 VALUES ($1, 'email', true)`,
                [unconfiguredUniversity],
            );
            const seededWithoutDomain = await getAvailableVerificationMethods(unconfiguredUniversity);
            assert.equal(seededWithoutDomain.find((method) => method.methodType === 'email')?.isAvailable, false);

            process.env.BREVO_API_KEY = '';
            const transportUnavailable = await getAvailableVerificationMethods(fixture.universityId);
            assert.equal(transportUnavailable.find((method) => method.methodType === 'email')?.isAvailable, false);

            process.env.BREVO_API_KEY = 'synthetic-mail-config';
            await pool.query(`UPDATE universities SET is_active = false WHERE id = $1`, [fixture.universityId]);
            const inactive = await getAvailableVerificationMethods(fixture.universityId);
            assert.equal(inactive.find((method) => method.methodType === 'email')?.isAvailable, false);
            assert.equal(inactive.find((method) => method.methodType === 'registration')?.isAvailable, false);
        } finally {
            if (previousKey === undefined) delete process.env.BREVO_API_KEY;
            else process.env.BREVO_API_KEY = previousKey;
        }
    });
});

test('actual Express routes use live database identity over anonymous, vendor, deleted, or stale JWT role claims', async () => {
    await withPool(async (pool) => {
        const student = await createFixture(pool);
        const vendorId = (await pool.query<{ id: string }>(
            `INSERT INTO users (email, role) VALUES ($1, 'vendor') RETURNING id`,
            [`vendor-${randomUUID()}@example.invalid`],
        )).rows[0]!.id;
        const deletedId = (await pool.query<{ id: string }>(
            `INSERT INTO users (email, role, deleted_at) VALUES ($1, 'student', clock_timestamp()) RETURNING id`,
            [`deleted-${randomUUID()}@students.flow.example`],
        )).rows[0]!.id;
        await withVerificationServer(async (baseUrl) => {
            const anonymous = await fetch(`${baseUrl}/status`);
            assert.equal(anonymous.status, 401);

            const vendor = await fetch(`${baseUrl}/status`, {
                headers: { authorization: `Bearer ${accessToken(vendorId, 'vendor@example.invalid', 'vendor')}` },
            });
            assert.equal(vendor.status, 400);

            const deleted = await fetch(`${baseUrl}/status`, {
                headers: { authorization: `Bearer ${accessToken(deletedId, 'deleted@students.flow.example')}` },
            });
            assert.equal(deleted.status, 400);

            const staleRole = await fetch(`${baseUrl}/status`, {
                headers: { authorization: `Bearer ${accessToken(student.userId, student.email, 'vendor')}` },
            });
            assert.equal(staleRole.status, 200);
            const status = await staleRole.json() as { data: { email: string; eligibility: { eligible: boolean } } };
            assert.equal(status.data.email, student.email);
            assert.equal(status.data.eligibility.eligible, false);
            assert.equal(JSON.stringify(status).toLowerCase().includes('accesstoken'), false);

            const bodyIdentity = await fetch(`${baseUrl}/initiate`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken(student.userId, student.email)}` },
                body: JSON.stringify({
                    universityId: student.universityId, accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION,
                    email: 'victim@students.flow.example',
                }),
            });
            assert.equal(bodyIdentity.status, 422);
            const grants = await pool.query<{ count: string }>(
                `SELECT count(*)::text AS count FROM verification_consents WHERE user_id = $1`,
                [student.userId],
            );
            assert.deepEqual(grants.rows, [{ count: '0' }]);
        });
    });
});

test('actual authenticated routes bind student actions to the live subject and never issue a session', async () => {
    await withPool(async (pool) => {
        const student = await createFixture(pool);
        const changedAfterChallenge = await createFixture(pool);
        const merchant = await createMerchantFixture(pool);
        const vendorId = (await pool.query<{ id: string }>(
            `INSERT INTO users (email, role) VALUES ($1, 'vendor') RETURNING id`,
            [`route-vendor-${randomUUID()}@example.invalid`],
        )).rows[0]!.id;
        const deletedId = (await pool.query<{ id: string }>(
            `INSERT INTO users (email, role, deleted_at) VALUES ($1, 'student', clock_timestamp()) RETURNING id`,
            [`route-deleted-${randomUUID()}@students.flow.example`],
        )).rows[0]!.id;
        const delivered: Array<{ code: string }> = [];
        const flow = createVerificationFlowService({
            pool,
            isEmailConfigured: () => true,
            deliverOtp: async (_email, code) => { delivered.push({ code }); return { success: true }; },
        });
        await withVerificationServer(async (baseUrl) => {
            const body = { universityId: student.universityId, accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION };
            const anonymous = await fetch(`${baseUrl}/initiate`, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
            });
            assert.equal(anonymous.status, 401);
            const vendor = await fetch(`${baseUrl}/initiate`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken(vendorId, 'vendor@example.invalid', 'vendor')}` },
                body: JSON.stringify(body),
            });
            assert.equal(vendor.status, 400);
            const deleted = await fetch(`${baseUrl}/initiate`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken(deletedId, 'deleted@example.invalid')}` },
                body: JSON.stringify(body),
            });
            assert.equal(deleted.status, 400);

            const initiated = await fetch(`${baseUrl}/initiate`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken(student.userId, student.email, 'vendor')}` },
                body: JSON.stringify(body),
            });
            assert.equal(initiated.status, 200);
            const initiatedBody = await initiated.json() as { data: { processingGrantId: string } };
            assert.equal(JSON.stringify(initiatedBody).toLowerCase().includes('token'), false);

            const deniedRequestBodies = [
                { id: vendorId, email: 'vendor@example.invalid', role: 'vendor' as const },
                { id: deletedId, email: 'deleted@example.invalid', role: 'student' as const },
            ];
            for (const deniedActor of deniedRequestBodies) {
                const deniedRequest = await fetch(`${baseUrl}/email/request`, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        authorization: `Bearer ${accessToken(deniedActor.id, deniedActor.email, deniedActor.role)}`,
                    },
                    body: JSON.stringify({ processingGrantId: initiatedBody.data.processingGrantId }),
                });
                assert.equal(deniedRequest.status, 400);
            }

            const requested = await fetch(`${baseUrl}/email/request`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken(student.userId, student.email)}` },
                body: JSON.stringify({ processingGrantId: initiatedBody.data.processingGrantId }),
            });
            assert.equal(requested.status, 200);
            const requestedBody = await requested.json() as { data: { challengeId: string } };
            const confirmed = await fetch(`${baseUrl}/email/confirm`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken(student.userId, student.email)}` },
                body: JSON.stringify({ challengeId: requestedBody.data.challengeId, otp: delivered[0]!.code }),
            });
            assert.equal(confirmed.status, 200);
            assert.equal(JSON.stringify(await confirmed.json()).toLowerCase().includes('token'), false);

            const disclosure = await fetch(`${baseUrl}/disclosures`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken(student.userId, student.email)}` },
                body: JSON.stringify({
                    vendorId: merchant.vendorId, origin: merchant.origin, purpose: 'student-discount',
                    accepted: true, noticeVersion: MERCHANT_DISCLOSURE_NOTICE_VERSION,
                }),
            });
            assert.equal(disclosure.status, 201);
            const disclosureBody = await disclosure.json() as { data: { grantId: string } };
            const withdrawn = await fetch(`${baseUrl}/consents/${disclosureBody.data.grantId}`, {
                method: 'DELETE', headers: { authorization: `Bearer ${accessToken(student.userId, student.email)}` },
            });
            assert.equal(withdrawn.status, 200);

            const changedInitiated = await flow.initiate(changedAfterChallenge.userId, {
                universityId: changedAfterChallenge.universityId,
                accepted: true,
                noticeVersion: VERIFICATION_NOTICE_VERSION,
            });
            const changedRequested = await flow.requestEmail(changedAfterChallenge.userId, {
                processingGrantId: changedInitiated.processingGrantId,
            });
            await pool.query(`UPDATE users SET role = 'vendor' WHERE id = $1`, [changedAfterChallenge.userId]);
            const deniedConfirmation = await fetch(`${baseUrl}/email/confirm`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${accessToken(changedAfterChallenge.userId, changedAfterChallenge.email)}`,
                },
                body: JSON.stringify({ challengeId: changedRequested.challengeId, otp: delivered[1]!.code }),
            });
            assert.equal(deniedConfirmation.status, 400);
            const deniedDisclosure = await fetch(`${baseUrl}/disclosures`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${accessToken(changedAfterChallenge.userId, changedAfterChallenge.email)}`,
                },
                body: JSON.stringify({
                    vendorId: merchant.vendorId, origin: merchant.origin, purpose: 'student-discount',
                    accepted: true, noticeVersion: MERCHANT_DISCLOSURE_NOTICE_VERSION,
                }),
            });
            assert.equal(deniedDisclosure.status, 400);
            const deniedState = await pool.query<{ consumed: string; evidence: string }>(
                `SELECT (SELECT count(*)::text FROM verification_challenges WHERE id = $1 AND consumed_at IS NOT NULL) AS consumed,
                        (SELECT count(*)::text FROM eligibility_evidence WHERE challenge_id = $1) AS evidence`,
                [changedRequested.challengeId],
            );
            assert.deepEqual(deniedState.rows, [{ consumed: '0', evidence: '0' }]);

            for (const path of ['/registration', '/widget/token']) {
                const unavailable = await fetch(`${baseUrl}${path}`, {
                    method: 'POST', headers: { authorization: `Bearer ${accessToken(student.userId, student.email)}` },
                });
                assert.equal(unavailable.status, 503);
                const serialized = JSON.stringify(await unavailable.json()).toLowerCase();
                assert.equal(serialized.includes('accesstoken'), false);
                assert.equal(serialized.includes('refreshtoken'), false);
            }
        }, new VerificationController({ flow }));
    });
});

test('does not consume a stale identity challenge and refuses a withdrawn processing grant before issuing another code', async () => {
    await withPool(async (pool) => {
        const fixture = await createFixture(pool);
        const delivered: Array<{ code: string }> = [];
        const flow = createVerificationFlowService({
            pool,
            isEmailConfigured: () => true,
            deliverOtp: async (_email, code) => {
                delivered.push({ code });
                return { success: true };
            },
        });
        const initiated = await flow.initiate(fixture.userId, {
            universityId: fixture.universityId, accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION,
        });
        const requested = await flow.requestEmail(fixture.userId, { processingGrantId: initiated.processingGrantId });
        await pool.query(`UPDATE students SET identity_version = identity_version + 1 WHERE user_id = $1`, [fixture.userId]);
        await assert.rejects(
            flow.confirmEmail(fixture.userId, { challengeId: requested.challengeId, otp: delivered[0]!.code }),
            /bindings are stale/i,
        );
        const stale = await pool.query<{ consumed_at: Date | null; evidence: string }>(
            `SELECT challenges.consumed_at,
                    (SELECT count(*)::text FROM eligibility_evidence WHERE challenge_id = challenges.id) AS evidence
             FROM verification_challenges challenges WHERE challenges.id = $1`,
            [requested.challengeId],
        );
        assert.deepEqual(stale.rows, [{ consumed_at: null, evidence: '0' }]);

        await flow.withdrawConsent(fixture.userId, initiated.processingGrantId);
        await assert.rejects(
            flow.requestEmail(fixture.userId, { processingGrantId: initiated.processingGrantId }),
            /Current processing consent required/i,
        );
    });
});

test('holds a confirmation at a real barrier and proves the competing confirmation blocks behind its exact PID', async () => {
    await withPool(async (pool) => {
        const fixture = await createFixture(pool);
        const delivered: Array<{ code: string }> = [];
        const setupFlow = createVerificationFlowService({
            pool,
            isEmailConfigured: () => true,
            deliverOtp: async (_email, code) => { delivered.push({ code }); return { success: true }; },
        });
        const initiated = await setupFlow.initiate(fixture.userId, {
            universityId: fixture.universityId, accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION,
        });
        const requested = await setupFlow.requestEmail(fixture.userId, { processingGrantId: initiated.processingGrantId });

        const barrierKey = 734262;
        await pool.query(`
            CREATE OR REPLACE FUNCTION verification_flow_test_hold_winner() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                PERFORM pg_advisory_xact_lock(${barrierKey});
                RETURN NEW;
            END $$;
            CREATE TRIGGER verification_flow_test_hold_winner_before_evidence
            BEFORE INSERT ON eligibility_evidence
            FOR EACH ROW EXECUTE FUNCTION verification_flow_test_hold_winner();
        `);
        const control = await pool.connect();
        const winnerClient = await pool.connect();
        const contenderClient = await pool.connect();
        const winnerPid = await backendPid(winnerClient);
        const contenderPid = await backendPid(contenderClient);
        const winnerFlow = createVerificationFlowService({
            pool: pinnedPool(winnerClient),
            isEmailConfigured: () => true,
            deliverOtp: async () => ({ success: true }),
        });
        const contenderFlow = createVerificationFlowService({
            pool: pinnedPool(contenderClient),
            isEmailConfigured: () => true,
            deliverOtp: async () => ({ success: true }),
        });
        let barrierReleased = false;
        let winner: Promise<PromiseSettledResult<Awaited<ReturnType<typeof winnerFlow.confirmEmail>>>> | undefined;
        let contender: Promise<PromiseSettledResult<Awaited<ReturnType<typeof contenderFlow.confirmEmail>>>> | undefined;
        try {
            await control.query('SELECT pg_advisory_lock($1)', [barrierKey]);
            winner = Promise.allSettled([
                winnerFlow.confirmEmail(fixture.userId, { challengeId: requested.challengeId, otp: delivered[0]!.code }),
            ]).then(([result]) => result!);
            await waitForAdvisoryWait(pool, winnerPid);

            contender = Promise.allSettled([
                contenderFlow.confirmEmail(fixture.userId, { challengeId: requested.challengeId, otp: delivered[0]!.code }),
            ]).then(([result]) => result!);
            await waitForExactBlockingPid(pool, contenderPid, winnerPid);

            await control.query('SELECT pg_advisory_unlock($1)', [barrierKey]);
            barrierReleased = true;
            const [winnerResult, contenderResult] = await Promise.all([winner, contender]);
            assert.equal(winnerResult.status, 'fulfilled');
            assert.equal(contenderResult.status, 'rejected');
            if (contenderResult.status === 'rejected') assert.match(String(contenderResult.reason), /Invalid verification code/i);
        } finally {
            if (!barrierReleased) await control.query('SELECT pg_advisory_unlock($1)', [barrierKey]).catch(() => undefined);
            await Promise.all([winner, contender].filter((pending): pending is Promise<PromiseSettledResult<EligibilityResult>> => pending !== undefined));
            control.release();
            winnerClient.release();
            contenderClient.release();
            await pool.query('DROP TRIGGER IF EXISTS verification_flow_test_hold_winner_before_evidence ON eligibility_evidence');
            await pool.query('DROP FUNCTION IF EXISTS verification_flow_test_hold_winner()');
        }
        const result = await pool.query<{ consumed: string; proofs: string; evidence: string }>(
            `SELECT (SELECT count(*)::text FROM verification_challenges WHERE id = $1 AND consumed_at IS NOT NULL) AS consumed,
                    (SELECT count(*)::text FROM user_email_proofs WHERE challenge_id = $1) AS proofs,
                    (SELECT count(*)::text FROM eligibility_evidence WHERE challenge_id = $1) AS evidence`,
            [requested.challengeId],
        );
        assert.deepEqual(result.rows, [{ consumed: '1', proofs: '1', evidence: '1' }]);
    });
});

test('proves owner withdrawal and live profile and policy mutations block behind a held confirmation before settling', async () => {
    await withPool(async (pool) => {
        const fixture = await createFixture(pool);
        const delivered: Array<{ code: string }> = [];
        const setupFlow = createVerificationFlowService({
            pool,
            isEmailConfigured: () => true,
            deliverOtp: async (_email, code) => { delivered.push({ code }); return { success: true }; },
        });
        const initiated = await setupFlow.initiate(fixture.userId, {
            universityId: fixture.universityId, accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION,
        });
        const requested = await setupFlow.requestEmail(fixture.userId, { processingGrantId: initiated.processingGrantId });
        const barrierKey = 734263;
        await pool.query(`
            CREATE OR REPLACE FUNCTION verification_flow_test_hold_mutations() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                PERFORM pg_advisory_xact_lock(${barrierKey});
                RETURN NEW;
            END $$;
            CREATE TRIGGER verification_flow_test_hold_mutations_before_evidence
            BEFORE INSERT ON eligibility_evidence
            FOR EACH ROW EXECUTE FUNCTION verification_flow_test_hold_mutations();
        `);
        const control = await pool.connect();
        const winnerClient = await pool.connect();
        const withdrawalClient = await pool.connect();
        const profileClient = await pool.connect();
        const policyClient = await pool.connect();
        const winnerPid = await backendPid(winnerClient);
        const withdrawalPid = await backendPid(withdrawalClient);
        const profilePid = await backendPid(profileClient);
        const policyPid = await backendPid(policyClient);
        const winnerFlow = createVerificationFlowService({
            pool: pinnedPool(winnerClient), isEmailConfigured: () => true, deliverOtp: async () => ({ success: true }),
        });
        const withdrawalFlow = createVerificationFlowService({
            pool: pinnedPool(withdrawalClient), isEmailConfigured: () => true, deliverOtp: async () => ({ success: true }),
        });
        let barrierReleased = false;
        let winner: Promise<PromiseSettledResult<EligibilityResult>> | undefined;
        let withdrawal: Promise<PromiseSettledResult<void>> | undefined;
        let profileMutation: Promise<PromiseSettledResult<pg.QueryResult>> | undefined;
        let policyMutation: Promise<PromiseSettledResult<pg.QueryResult>> | undefined;
        try {
            await control.query('SELECT pg_advisory_lock($1)', [barrierKey]);
            winner = settle(winnerFlow.confirmEmail(fixture.userId, {
                challengeId: requested.challengeId, otp: delivered[0]!.code,
            }));
            await waitForAdvisoryWait(pool, winnerPid);

            withdrawal = settle(withdrawalFlow.withdrawConsent(fixture.userId, initiated.processingGrantId));
            await waitForExactBlockingPid(pool, withdrawalPid, winnerPid);
            profileMutation = settle(profileClient.query(
                `UPDATE students SET name = name || ' updated' WHERE user_id = $1`,
                [fixture.userId],
            ));
            await waitForExactBlockingPid(pool, profilePid, winnerPid);
            policyMutation = settle(policyClient.query(
                `UPDATE universities SET email_evidence_validity_days = email_evidence_validity_days - 1 WHERE id = $1`,
                [fixture.universityId],
            ));
            await waitForExactBlockingPid(pool, policyPid, winnerPid);

            await control.query('SELECT pg_advisory_unlock($1)', [barrierKey]);
            barrierReleased = true;
            assert.equal((await winner).status, 'fulfilled');
            assert.equal((await profileMutation).status, 'fulfilled');
            assert.equal((await policyMutation).status, 'fulfilled');
            assert.equal((await withdrawal).status, 'fulfilled');
        } finally {
            if (!barrierReleased) await control.query('SELECT pg_advisory_unlock($1)', [barrierKey]).catch(() => undefined);
            await Promise.all([
                winner?.then(() => undefined, () => undefined),
                withdrawal?.then(() => undefined, () => undefined),
                profileMutation?.then(() => undefined, () => undefined),
                policyMutation?.then(() => undefined, () => undefined),
            ]);
            control.release();
            winnerClient.release();
            withdrawalClient.release();
            profileClient.release();
            policyClient.release();
            await pool.query('DROP TRIGGER IF EXISTS verification_flow_test_hold_mutations_before_evidence ON eligibility_evidence');
            await pool.query('DROP FUNCTION IF EXISTS verification_flow_test_hold_mutations()');
        }
        const state = await pool.query<{ revoked: string; withdrawn: string }>(
            `SELECT (SELECT count(*)::text FROM eligibility_evidence WHERE challenge_id = $1 AND revoked_at IS NOT NULL) AS revoked,
                    (SELECT count(*)::text FROM verification_consents WHERE id = $2 AND withdrawn_at IS NOT NULL) AS withdrawn`,
            [requested.challengeId, initiated.processingGrantId],
        );
        assert.deepEqual(state.rows, [{ revoked: '1', withdrawn: '1' }]);
    });
});

test('actual authenticated confirmation returns 400 and commits exactly one wrong-OTP guess', async () => {
    await withPool(async (pool) => {
        const fixture = await createFixture(pool);
        const delivered: Array<{ code: string }> = [];
        const flow = createVerificationFlowService({
            pool, isEmailConfigured: () => true,
            deliverOtp: async (_email, code) => { delivered.push({ code }); return { success: true }; },
        });
        const initiated = await flow.initiate(fixture.userId, {
            universityId: fixture.universityId, accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION,
        });
        const requested = await flow.requestEmail(fixture.userId, { processingGrantId: initiated.processingGrantId });
        await withVerificationServer(async (baseUrl) => {
            const response = await fetch(`${baseUrl}/email/confirm`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken(fixture.userId, fixture.email)}` },
                body: JSON.stringify({
                    challengeId: requested.challengeId,
                    otp: delivered[0]!.code === '000000' ? '000001' : '000000',
                }),
            });
            assert.equal(response.status, 400);
        }, new VerificationController({ flow }));
        const budget = await pool.query<{ failed_attempts: number }>(
            `SELECT failed_attempts FROM verification_challenge_budgets WHERE current_challenge_id = $1`,
            [requested.challengeId],
        );
        assert.deepEqual(budget.rows, [{ failed_attempts: 1 }]);
    });
});
