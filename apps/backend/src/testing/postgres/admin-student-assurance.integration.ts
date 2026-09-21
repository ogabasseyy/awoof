import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { db } from '../../config/database.js';
import { AdminStudentController } from '../../controllers/admin-student.controller.js';
import { requestChallenge, consumeChallenge } from '../../services/verification/challenge.service.js';
import {
    grantVerificationProcessing,
    withdrawConsent,
} from '../../services/verification/eligibility-consent.service.js';
import { lockStudentContext } from '../../services/verification/eligibility-context.service.js';
import {
    applyEnrollmentDecision,
    beginEnrollmentCheck,
    recordEmailAssurance,
} from '../../services/verification/eligibility-evidence.service.js';
import { updateInstitutionPolicy } from '../../services/verification/eligibility-policy.service.js';
import { ENROLLMENT_SOURCE, type EnrollmentSnapshot } from '../../services/verification/eligibility.types.js';
import {
    ADMIN_ASSURANCE_PAGE_MAX,
    readAdminStudentAssurance,
} from '../../services/verification/admin-student-assurance.service.js';
import { readStudentAssurance } from '../../services/verification/student-assurance.service.js';
import type { StudentAssurance } from '../../services/verification/student-assurance.types.js';
import { VERIFICATION_NOTICE_VERSION } from '../../services/verification/verification-notices.js';
import { inTransaction, withTestClient } from './test-database.js';

after(() => db.close());

type Fixture = {
    adminId: string;
    userId: string;
    studentId: string;
    universityId: string;
    grantId: string;
    email: string;
};

type FixtureOptions = {
    enrollment?: boolean;
    normalization?: 'exact' | 'trim_upper' | null;
};

function uniqueLabel(): string {
    return randomUUID().replaceAll('-', '').slice(0, 12);
}

async function createFixture(client: PoolClient, options: FixtureOptions = {}): Promise<Fixture> {
    const label = uniqueLabel();
    const adminId = (await client.query<{ id: string }>(
        `INSERT INTO users (email, role) VALUES ($1, 'admin') RETURNING id`,
        [`cutover-admin-${label}@example.invalid`],
    )).rows[0]!.id;
    const email = `cutover-${label}@students.school.example`;
    const userId = (await client.query<{ id: string }>(
        `INSERT INTO users (email, role) VALUES ($1, 'student') RETURNING id`,
        [email],
    )).rows[0]!.id;
    const universityId = (await client.query<{ id: string }>(
        `INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id`,
        [`Cutover School ${label}`],
    )).rows[0]!.id;
    if (options.enrollment) {
        await client.query(
            `INSERT INTO university_verification_methods
                 (university_id, method_type, api_endpoint, is_active)
             VALUES ($1, 'registration', 'https://institution.example/verify', true)`,
            [universityId],
        );
    }
    const studentId = (await client.query<{ id: string }>(
        `INSERT INTO students (user_id, name, university_id, registration_number)
         VALUES ($1, 'Cutover Student ${label}', $2, null)
         RETURNING id`,
        [userId, universityId],
    )).rows[0]!.id;
    await inTransaction(client, () => updateInstitutionPolicy(client, adminId, universityId, {
        domains: ['students.school.example'],
        emailEvidenceValidityDays: 90,
        enrollmentValidityDays: 30,
        registrationNormalization: options.normalization ?? null,
        isActive: true,
    }));
    const grantId = await inTransaction(client, () => grantVerificationProcessing(
        client,
        userId,
        universityId,
        { accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION },
    ));
    await inTransaction(client, async () => {
        const context = await lockStudentContext(client, userId);
        await client.query(
            `INSERT INTO student_eligibility_state (student_id, university_id)
             VALUES ($1, $2)
             ON CONFLICT (student_id, university_id) DO NOTHING`,
            [context.studentId, context.universityId],
        );
        await client.query(
            `SELECT student_id FROM student_eligibility_state
             WHERE student_id = $1 AND university_id = $2
             FOR UPDATE`,
            [context.studentId, context.universityId],
        );
        const issued = await requestChallenge(client, {
            purpose: 'student_email',
            subjectKey: userId,
            bindings: {
                ...context,
                processingGrantId: grantId,
                noticeVersion: VERIFICATION_NOTICE_VERSION,
            },
        });
        assert.equal(issued.status, 'issued');
        if (issued.status !== 'issued') throw new Error('Fixture challenge was not issued');
        const consumed = await consumeChallenge(client, {
            purpose: 'student_email',
            subjectKey: userId,
            challengeId: issued.challengeId,
            code: issued.code,
        });
        assert.equal(consumed.status, 'verified');
        await recordEmailAssurance(client, userId, {
            challengeId: issued.challengeId,
            processingGrantId: grantId,
        });
    });
    return { adminId, userId, studentId, universityId, grantId, email };
}

async function applyRegistrationEnrollment(client: PoolClient, fixture: Fixture, registrationNumber: string): Promise<void> {
    const snapshot: EnrollmentSnapshot = await inTransaction(client, () => beginEnrollmentCheck(client, fixture.userId, fixture.grantId));
    const result = await inTransaction(client, () => applyEnrollmentDecision(client, snapshot, {
        outcome: 'verified',
        email: fixture.email,
        registrationNumber,
        validUntil: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
        source: ENROLLMENT_SOURCE,
    }));
    assert.equal(result.eligible, true);
}

async function pointRead(client: PoolClient, userId: string): Promise<StudentAssurance> {
    return inTransaction(client, () => readStudentAssurance(client, userId));
}

async function assertParity(client: PoolClient, userId: string, expectedStatus: StudentAssurance['studentStatus']): Promise<StudentAssurance> {
    // Sequential reads on one connection: the point read commits a
    // transaction while the projection stays a lock-free batch.
    const projected = (await readAdminStudentAssurance(client, [userId])).get(userId);
    const authoritative = await pointRead(client, userId);
    assert.ok(projected, 'projection covers the requested user');
    assert.equal(projected.studentStatus, expectedStatus);
    assert.deepEqual(projected, authoritative);
    return authoritative;
}

test('admin projection matches the authoritative read for a pending email-only student', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client);
        const assurance = await assertParity(client, fixture.userId, 'pending');
        assert.equal(assurance.schoolAccountStatus, 'verified');
        assert.equal(assurance.schoolAccountMethod, 'email_otp');
        assert.equal(assurance.reason, 'awaiting_enrollment');
    });
});

test('admin projection matches the authoritative read for current enrollment', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        await applyRegistrationEnrollment(client, fixture, 'cutover-reg');
        const assurance = await assertParity(client, fixture.userId, 'verified');
        assert.equal(assurance.enrollmentMethod, 'registration');
        assert.ok(assurance.studentValidUntil);
    });
});

test('admin projection matches the authoritative read for expired enrollment', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        await applyRegistrationEnrollment(client, fixture, 'cutover-reg');
        // Evidence rows are immutable: revoke the live enrollment and point at
        // a historical expired row, mirroring the release rehearsal lapse.
        await client.query(
            `UPDATE eligibility_evidence SET revoked_at = clock_timestamp()
             WHERE student_id = $1 AND method = 'enrollment'`,
            [fixture.studentId],
        );
        const live = (await client.query<{ email_proof_id: string; identity_version: number; policy_version: number }>(
            `SELECT email_proof_id, identity_version, policy_version FROM eligibility_evidence
             WHERE student_id = $1 AND method = 'enrollment'
             ORDER BY verified_at DESC LIMIT 1`,
            [fixture.studentId],
        )).rows[0]!;
        const expiredId = (await client.query<{ id: string }>(
            `INSERT INTO eligibility_evidence
                 (student_id, university_id, email_proof_id, processing_grant_id,
                  method, outcome, identity_version, policy_version, source, expires_at)
             VALUES ($1, $2, $3, $4, 'enrollment', 'verified', $5, $6, $7,
                     clock_timestamp() - interval '1 second')
             RETURNING id`,
            [fixture.studentId, fixture.universityId, live.email_proof_id, fixture.grantId,
                live.identity_version, live.policy_version, ENROLLMENT_SOURCE],
        )).rows[0]!.id;
        await client.query(
            `UPDATE student_eligibility_state SET current_evidence_id = $1
             WHERE student_id = $2 AND university_id = $3`,
            [expiredId, fixture.studentId, fixture.universityId],
        );
        // The revoked live row outranks expiry in the shared precedence table,
        // so the lapsed student reads revoked here; pure expiry is covered by
        // the rehearsal's dedicated expired-pointer fixture below.
        const assurance = await assertParity(client, fixture.userId, 'revoked');
        assert.equal(assurance.reason, 'consent_withdrawn');
    });
});

test('admin projection matches the authoritative read for a purely expired pointer', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        const live = (await client.query<{ email_proof_id: string; identity_version: number; policy_version: number }>(
            `SELECT email_proof_id, identity_version, policy_version FROM eligibility_evidence
             WHERE student_id = $1 AND method = 'student_email'
             ORDER BY verified_at DESC LIMIT 1`,
            [fixture.studentId],
        )).rows[0]!;
        const expiredId = (await client.query<{ id: string }>(
            `INSERT INTO eligibility_evidence
                 (student_id, university_id, email_proof_id, processing_grant_id,
                  method, outcome, identity_version, policy_version, source, expires_at)
             VALUES ($1, $2, $3, $4, 'enrollment', 'verified', $5, $6, $7,
                     clock_timestamp() - interval '1 second')
             RETURNING id`,
            [fixture.studentId, fixture.universityId, live.email_proof_id, fixture.grantId,
                live.identity_version, live.policy_version, ENROLLMENT_SOURCE],
        )).rows[0]!.id;
        await client.query(
            `UPDATE student_eligibility_state SET current_evidence_id = $1
             WHERE student_id = $2 AND university_id = $3`,
            [expiredId, fixture.studentId, fixture.universityId],
        );
        const assurance = await assertParity(client, fixture.userId, 'expired');
        assert.equal(assurance.reason, 'evidence_expired');
        assert.equal(assurance.enrollmentMethod, 'registration');
    });
});

test('admin projection matches the authoritative read for denied enrollment', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        const snapshot = await inTransaction(client, () => beginEnrollmentCheck(client, fixture.userId, fixture.grantId));
        await inTransaction(client, () => applyEnrollmentDecision(client, snapshot, {
            outcome: 'denied',
            email: fixture.email,
            source: ENROLLMENT_SOURCE,
        }));
        const assurance = await assertParity(client, fixture.userId, 'denied');
        assert.equal(assurance.reason, 'enrollment_denied');
    });
});

test('admin projection matches the authoritative read for withdrawn consent', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        await applyRegistrationEnrollment(client, fixture, 'cutover-reg');
        await inTransaction(client, () => withdrawConsent(client, fixture.userId, fixture.grantId));
        const assurance = await assertParity(client, fixture.userId, 'revoked');
        assert.equal(assurance.reason, 'consent_withdrawn');
    });
});

test('admin projection matches the authoritative read for inactive students', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        await applyRegistrationEnrollment(client, fixture, 'cutover-reg');
        await client.query(`UPDATE students SET status = 'suspended' WHERE id = $1`, [fixture.studentId]);
        const assurance = await assertParity(client, fixture.userId, 'inactive');
        assert.equal(assurance.reason, 'inactive');
    });
});

test('admin projection routes missing profiles and universities to pending', async () => {
    await withTestClient(async (client) => {
        const label = uniqueLabel();
        const profileless = (await client.query<{ id: string }>(
            `INSERT INTO users (email, role) VALUES ($1, 'student') RETURNING id`,
            [`profileless-${label}@example.invalid`],
        )).rows[0]!.id;
        const universitylessUser = (await client.query<{ id: string }>(
            `INSERT INTO users (email, role) VALUES ($1, 'student') RETURNING id`,
            [`universityless-${label}@example.invalid`],
        )).rows[0]!.id;
        await client.query(
            `INSERT INTO students (user_id, name, university_id) VALUES ($1, 'Universityless', null)`,
            [universitylessUser],
        );
        await assertParity(client, profileless, 'pending');
        const assurance = await assertParity(client, universitylessUser, 'pending');
        assert.equal(assurance.schoolAccountStatus, 'unverified');
        assert.equal(assurance.reason, 'awaiting_enrollment');
    });
});

test('admin projection is bounded and takes no locks', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        await applyRegistrationEnrollment(client, fixture, 'cutover-reg');
        const oversized = Array.from({ length: ADMIN_ASSURANCE_PAGE_MAX + 1 }, () => randomUUID());
        await assert.rejects(readAdminStudentAssurance(client, oversized), /bounded/);
        const seen: string[] = [];
        const counting = {
            query: async (text: string, params?: unknown[]) => {
                seen.push(text);
                return client.query(text, params);
            },
        };
        const page = await readAdminStudentAssurance(counting, [fixture.userId, randomUUID()]);
        assert.equal(page.size, 2);
        assert.ok(seen.length > 0 && seen.length <= 15, `expected a fixed small batch, saw ${seen.length} queries`);
        for (const text of seen) {
            assert.ok(!/FOR UPDATE/i.test(text), 'reporting projection must not lock evidence rows');
        }
    });
});

test('admin students list carries assurance matching the authoritative read', async () => {
    await withTestClient(async (client) => {
        const pending = await createFixture(client);
        const verified = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        await applyRegistrationEnrollment(client, verified, 'cutover-reg');
        let body = {} as { students: { email: string; studentAssurance: StudentAssurance }[] };
        const response = {
            status() { return this; },
            json(value: { data: typeof body }) { body = value.data; return this; },
        } as unknown as Response;
        await new AdminStudentController().getStudents({ query: { search: 'cutover-', limit: '100' } } as unknown as Request, response);
        const byEmail = new Map(body.students.map((row) => [row.email, row.studentAssurance]));
        assert.deepEqual(byEmail.get(pending.email), await pointRead(client, pending.userId));
        assert.deepEqual(byEmail.get(verified.email), await pointRead(client, verified.userId));
    });
});
