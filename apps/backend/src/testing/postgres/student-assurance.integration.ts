import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import type { PoolClient } from 'pg';
import { db } from '../../config/database.js';
import { config } from '../../config/env.js';

after(() => db.close());
import { consumeChallenge, requestChallenge } from '../../services/verification/challenge.service.js';
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
import { ENROLLMENT_SOURCE, MICROSOFT_ENROLLMENT_SOURCE, type EnrollmentSnapshot } from '../../services/verification/eligibility.types.js';
import { readStudentAssurance } from '../../services/verification/student-assurance.service.js';
import type { StudentAssurance } from '../../services/verification/student-assurance.types.js';
import { VERIFICATION_NOTICE_VERSION } from '../../services/verification/verification-notices.js';
import { inTransaction, withTestClient } from './test-database.js';

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
    emailEvidenceValidityDays?: number;
    enrollmentValidityDays?: number;
};

function uniqueLabel(): string {
    return randomUUID().replaceAll('-', '').slice(0, 12);
}

async function createFixture(client: PoolClient, options: FixtureOptions = {}): Promise<Fixture> {
    const label = uniqueLabel();
    const adminId = (await client.query<{ id: string }>(
        `INSERT INTO users (email, role) VALUES ($1, 'admin') RETURNING id`,
        [`assurance-admin-${label}@example.invalid`],
    )).rows[0]!.id;
    const email = `assurance-${label}@students.school.example`;
    const userId = (await client.query<{ id: string }>(
        `INSERT INTO users (email, role) VALUES ($1, 'student') RETURNING id`,
        [email],
    )).rows[0]!.id;
    const universityId = (await client.query<{ id: string }>(
        `INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id`,
        [`Assurance School ${label}`],
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
         VALUES ($1, 'Assurance Student ${label}', $2, null)
         RETURNING id`,
        [userId, universityId],
    )).rows[0]!.id;
    await inTransaction(client, () => updateInstitutionPolicy(client, adminId, universityId, {
        domains: ['students.school.example'],
        emailEvidenceValidityDays: options.emailEvidenceValidityDays ?? 90,
        enrollmentValidityDays: options.enrollmentValidityDays ?? 30,
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

async function begin(client: PoolClient, fixture: Fixture): Promise<EnrollmentSnapshot> {
    return inTransaction(client, () => beginEnrollmentCheck(client, fixture.userId, fixture.grantId));
}

async function applyRegistrationEnrollment(client: PoolClient, fixture: Fixture, registrationNumber: string): Promise<void> {
    const snapshot = await begin(client, fixture);
    const result = await inTransaction(client, () => applyEnrollmentDecision(client, snapshot, {
        outcome: 'verified',
        email: fixture.email,
        registrationNumber,
        validUntil: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
        source: ENROLLMENT_SOURCE,
    }));
    assert.equal(result.eligible, true);
}

async function read(client: PoolClient, userId: string): Promise<StudentAssurance> {
    return inTransaction(client, () => readStudentAssurance(client, userId));
}

function assertIsoInstant(value: string | null): asserts value is string {
    assert.equal(typeof value, 'string');
    assert.ok(Number.isFinite(Date.parse(value as string)), 'valid-until must be an ISO instant');
}

// R3: Release A reads existing mailbox/evidence tables only and must not
// depend on migration 057. The same fixture must project identical assurance
// on a migration-056-only database and on a fully upgraded database where the
// SSO tables exist.
test('R3: assurance reader is identical on pre-057 and fully-upgraded databases', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client);
        const baseline = await read(client, fixture.userId);
        assert.equal(baseline.schoolAccountStatus, 'verified');
        assert.equal(baseline.studentStatus, 'pending');

        await client.query('BEGIN');
        try {
            await client.query(`CREATE TABLE student_auth_identities (
                id uuid PRIMARY KEY, user_id uuid NOT NULL, university_id uuid NOT NULL,
                provider text NOT NULL, issuer text NOT NULL, subject text NOT NULL,
                observed_email text, revoked_at timestamptz, linked_at timestamptz NOT NULL DEFAULT clock_timestamp()
            )`);
            await client.query(`CREATE TABLE institution_login_policies (
                id uuid PRIMARY KEY, university_id uuid NOT NULL, provider text NOT NULL,
                issuer text NOT NULL, provider_realm text NOT NULL, version integer NOT NULL DEFAULT 1,
                enabled boolean NOT NULL DEFAULT false
            )`);
            await client.query(`CREATE TABLE student_school_assertions (
                id uuid PRIMARY KEY, user_id uuid NOT NULL, university_id uuid NOT NULL,
                source text NOT NULL, verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
                expires_at timestamptz NOT NULL, revoked_at timestamptz
            )`);
            const upgraded = await readStudentAssurance(client, fixture.userId);
            assert.deepEqual(upgraded, baseline);
        } finally {
            await client.query('ROLLBACK');
        }

        const tables = await client.query<{ tablename: string }>(
            `SELECT tablename FROM pg_tables
             WHERE schemaname = 'public'
               AND tablename IN ('student_school_assertions', 'student_auth_identities', 'institution_login_policies')`,
        );
        assert.equal(tables.rowCount, 0);
        assert.deepEqual(await read(client, fixture.userId), baseline);
    });
});

test('mailbox-confirmed student reads school verified and student pending', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client);
        const assurance = await read(client, fixture.userId);
        assert.equal(assurance.schoolAccountStatus, 'verified');
        assert.equal(assurance.schoolAccountMethod, 'email_otp');
        assertIsoInstant(assurance.schoolAccountValidUntil);
        assert.ok(Date.parse(assurance.schoolAccountValidUntil) > Date.now());
        assert.equal(assurance.studentStatus, 'pending');
        assert.equal(assurance.enrollmentMethod, null);
        assert.equal(assurance.studentValidUntil, null);
        assert.equal(assurance.reason, 'awaiting_enrollment');
    });
});

test('email evidence expiry is visible on the next read without token refresh', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client);
        assert.equal((await read(client, fixture.userId)).schoolAccountStatus, 'verified');
        await client.query(
            `UPDATE eligibility_evidence SET expires_at = clock_timestamp() - interval '1 second'
             WHERE student_id = $1 AND method = 'student_email'`,
            [fixture.studentId],
        );
        // No token, session, or cache refresh: the next direct read reflects it.
        const assurance = await read(client, fixture.userId);
        assert.equal(assurance.schoolAccountStatus, 'expired');
        assert.equal(assurance.schoolAccountMethod, 'email_otp');
        assertIsoInstant(assurance.schoolAccountValidUntil);
        assert.ok(Date.parse(assurance.schoolAccountValidUntil) <= Date.now());
        assert.equal(assurance.studentStatus, 'pending');
    });
});

test('school valid-until is capped at 90 days and never extended', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { emailEvidenceValidityDays: 365 });
        const assurance = await read(client, fixture.userId);
        assert.equal(assurance.schoolAccountStatus, 'verified');
        assertIsoInstant(assurance.schoolAccountValidUntil);
        const stored = await client.query<{ verified_at: Date; expires_at: Date }>(
            `SELECT verified_at, expires_at FROM eligibility_evidence
             WHERE student_id = $1 AND method = 'student_email'
             ORDER BY verified_at DESC LIMIT 1`,
            [fixture.studentId],
        );
        const verifiedAt = stored.rows[0]!.verified_at.getTime();
        const cap = verifiedAt + 90 * 24 * 60 * 60 * 1000;
        assert.ok(Date.parse(assurance.schoolAccountValidUntil) <= cap);
        assert.ok(Date.parse(assurance.schoolAccountValidUntil) < stored.rows[0]!.expires_at.getTime());
    });
});

test('fresh registration enrollment reads verified with the registration method', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        await applyRegistrationEnrollment(client, fixture, 'assurance-reg');
        const assurance = await read(client, fixture.userId);
        assert.equal(assurance.schoolAccountStatus, 'verified');
        assert.equal(assurance.studentStatus, 'verified');
        assert.equal(assurance.enrollmentMethod, 'registration');
        assertIsoInstant(assurance.studentValidUntil);
        assert.equal(assurance.reason, null);
    });
});

test('enrollment expiry is visible on the next read without token refresh', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        await applyRegistrationEnrollment(client, fixture, 'assurance-reg');
        assert.equal((await read(client, fixture.userId)).studentStatus, 'verified');
        await client.query(
            `UPDATE eligibility_evidence SET expires_at = clock_timestamp() - interval '1 second'
             WHERE student_id = $1 AND method = 'enrollment'`,
            [fixture.studentId],
        );
        const assurance = await read(client, fixture.userId);
        assert.equal(assurance.studentStatus, 'expired');
        assert.equal(assurance.reason, 'evidence_expired');
        assert.equal(assurance.enrollmentMethod, 'registration');
        assertIsoInstant(assurance.studentValidUntil);
        // Mailbox assurance is independent of enrollment expiry.
        assert.equal(assurance.schoolAccountStatus, 'verified');
    });
});

test('withdrawn enrollment consent reads revoked, never verified', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        await applyRegistrationEnrollment(client, fixture, 'assurance-reg');
        assert.equal((await read(client, fixture.userId)).studentStatus, 'verified');
        await inTransaction(client, () => withdrawConsent(client, fixture.userId, fixture.grantId));
        const assurance = await read(client, fixture.userId);
        assert.equal(assurance.studentStatus, 'revoked');
        assert.equal(assurance.reason, 'consent_withdrawn');
        assert.equal(assurance.enrollmentMethod, null);
        assert.equal(assurance.studentValidUntil, null);
    });
});

test('revoked enrollment evidence reads revoked on the next read', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        await applyRegistrationEnrollment(client, fixture, 'assurance-reg');
        await client.query(
            `UPDATE eligibility_evidence SET revoked_at = clock_timestamp()
             WHERE student_id = $1 AND method = 'enrollment'`,
            [fixture.studentId],
        );
        const assurance = await read(client, fixture.userId);
        assert.equal(assurance.studentStatus, 'revoked');
        assert.equal(assurance.reason, 'consent_withdrawn');
    });
});

test('authoritative denial reads denied', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        const snapshot = await begin(client, fixture);
        await inTransaction(client, () => applyEnrollmentDecision(client, snapshot, {
            outcome: 'denied',
            email: fixture.email,
            source: ENROLLMENT_SOURCE,
        }));
        const assurance = await read(client, fixture.userId);
        assert.equal(assurance.studentStatus, 'denied');
        assert.equal(assurance.reason, 'enrollment_denied');
        assert.equal(assurance.schoolAccountStatus, 'verified');
    });
});

test('inactive actor reads inactive', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client);
        await client.query(`UPDATE students SET status = 'suspended' WHERE id = $1`, [fixture.studentId]);
        const assurance = await read(client, fixture.userId);
        assert.equal(assurance.studentStatus, 'inactive');
        assert.equal(assurance.reason, 'inactive');
    });
});

test('valid independent enrollment survives another source failure', async () => {
    const originalEnabled = config.microsoftOidc.enabled;
    config.microsoftOidc.enabled = true;
    try {
        await withTestClient(async (client) => {
            const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
            await applyRegistrationEnrollment(client, fixture, 'independent-reg');
            const email = (await client.query<{ email_proof_id: string; identity_version: number; policy_version: number }>(
                `SELECT email_proof_id, identity_version, policy_version FROM eligibility_evidence
                 WHERE student_id = $1 AND method = 'student_email'
                 ORDER BY verified_at DESC LIMIT 1`,
                [fixture.studentId],
            )).rows[0]!;
            const tenantId = randomUUID();
            await client.query(
                `INSERT INTO institution_microsoft_policies
                     (university_id, tenant_id, enabled, mode, approved_until, approved_by,
                      term_ends_at, max_evidence_hours, scopes, notice_version)
                 VALUES ($1, $2, true, 'graph_enrollment', clock_timestamp() + interval '30 days', $3,
                         clock_timestamp() + interval '20 days', 24,
                         ARRAY['https://graph.microsoft.com/EduRoster.ReadBasic', 'openid', 'profile'], 'microsoft-v2')`,
                [fixture.universityId, tenantId, fixture.adminId],
            );
            const consentId = randomUUID();
            const identityId = randomUUID();
            const attemptId = randomUUID();
            const proofId = randomUUID();
            await client.query(
                `INSERT INTO microsoft_verification_consents
                     (id, user_id, university_id, processing_grant_id, provider_policy_version,
                      notice_version, mode, scopes)
                 VALUES ($1, $2, $3, $4, 1, 'microsoft-v2', 'graph_enrollment',
                         ARRAY['https://graph.microsoft.com/EduRoster.ReadBasic', 'openid', 'profile'])`,
                [consentId, fixture.userId, fixture.universityId, fixture.grantId],
            );
            await client.query(
                `INSERT INTO microsoft_identities (id, user_id, university_id, tenant_id, object_id)
                 VALUES ($1, $2, $3, $4, $5)`,
                [identityId, fixture.userId, fixture.universityId, tenantId, randomUUID()],
            );
            await client.query(
                `INSERT INTO microsoft_verification_attempts
                     (id, user_id, university_id, institution_policy_version, provider_policy_version,
                      identity_version, processing_grant_id, provider_consent_id, server_session_id,
                      state_hash, browser_secret_hash, finish_secret_hash, expires_at, status, result)
                 VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, 'browser', 'finish',
                         clock_timestamp() + interval '1 hour', 'ready', '{}')`,
                [attemptId, fixture.userId, fixture.universityId, email.policy_version,
                    email.identity_version, fixture.grantId, consentId, randomUUID(), `assurance-${randomUUID()}`],
            );
            await client.query(
                `INSERT INTO microsoft_provider_proofs
                     (id, user_id, university_id, provider_consent_id, identity_id,
                      provider_policy_version, attempt_id, observed_at, outcome, source)
                 VALUES ($1, $2, $3, $4, $5, 1, $6, clock_timestamp(), 'student', $7)`,
                [proofId, fixture.userId, fixture.universityId, consentId, identityId, attemptId, MICROSOFT_ENROLLMENT_SOURCE],
            );
            await client.query(
                `INSERT INTO eligibility_evidence
                     (student_id, university_id, email_proof_id, processing_grant_id, provider_proof_id,
                      method, outcome, identity_version, policy_version, source, expires_at)
                 VALUES ($1, $2, $3, $4, $5, 'enrollment', 'verified', $6, $7, $8,
                         clock_timestamp() - interval '1 second')`,
                [fixture.studentId, fixture.universityId, email.email_proof_id, fixture.grantId,
                    proofId, email.identity_version, email.policy_version, MICROSOFT_ENROLLMENT_SOURCE],
            );
            // The expired Microsoft row must not conceal the valid registration.
            const assurance = await read(client, fixture.userId);
            assert.equal(assurance.studentStatus, 'verified');
            assert.equal(assurance.enrollmentMethod, 'registration');
            assert.equal(assurance.reason, null);
        });
    } finally {
        config.microsoftOidc.enabled = originalEnabled;
    }
});

test('disabled Microsoft provider reads pending with provider_unavailable', async () => {
    const originalEnabled = config.microsoftOidc.enabled;
    config.microsoftOidc.enabled = true;
    try {
        await withTestClient(async (client) => {
            const fixture = await createFixture(client);
            const email = (await client.query<{ email_proof_id: string; identity_version: number; policy_version: number }>(
                `SELECT email_proof_id, identity_version, policy_version FROM eligibility_evidence
                 WHERE student_id = $1 AND method = 'student_email'
                 ORDER BY verified_at DESC LIMIT 1`,
                [fixture.studentId],
            )).rows[0]!;
            const tenantId = randomUUID();
            await client.query(
                `INSERT INTO institution_microsoft_policies
                     (university_id, tenant_id, enabled, mode, approved_until, approved_by,
                      term_ends_at, max_evidence_hours, scopes, notice_version)
                 VALUES ($1, $2, false, 'graph_enrollment', clock_timestamp() + interval '30 days', $3,
                         clock_timestamp() + interval '20 days', 24,
                         ARRAY['https://graph.microsoft.com/EduRoster.ReadBasic', 'openid', 'profile'], 'microsoft-v2')`,
                [fixture.universityId, tenantId, fixture.adminId],
            );
            const consentId = randomUUID();
            const identityId = randomUUID();
            const attemptId = randomUUID();
            const proofId = randomUUID();
            await client.query(
                `INSERT INTO microsoft_verification_consents
                     (id, user_id, university_id, processing_grant_id, provider_policy_version,
                      notice_version, mode, scopes)
                 VALUES ($1, $2, $3, $4, 1, 'microsoft-v2', 'graph_enrollment',
                         ARRAY['https://graph.microsoft.com/EduRoster.ReadBasic', 'openid', 'profile'])`,
                [consentId, fixture.userId, fixture.universityId, fixture.grantId],
            );
            await client.query(
                `INSERT INTO microsoft_identities (id, user_id, university_id, tenant_id, object_id)
                 VALUES ($1, $2, $3, $4, $5)`,
                [identityId, fixture.userId, fixture.universityId, tenantId, randomUUID()],
            );
            await client.query(
                `INSERT INTO microsoft_verification_attempts
                     (id, user_id, university_id, institution_policy_version, provider_policy_version,
                      identity_version, processing_grant_id, provider_consent_id, server_session_id,
                      state_hash, browser_secret_hash, finish_secret_hash, expires_at, status, result)
                 VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, 'browser', 'finish',
                         clock_timestamp() + interval '1 hour', 'ready', '{}')`,
                [attemptId, fixture.userId, fixture.universityId, email.policy_version,
                    email.identity_version, fixture.grantId, consentId, randomUUID(), `assurance-${randomUUID()}`],
            );
            await client.query(
                `INSERT INTO microsoft_provider_proofs
                     (id, user_id, university_id, provider_consent_id, identity_id,
                      provider_policy_version, attempt_id, observed_at, outcome, source)
                 VALUES ($1, $2, $3, $4, $5, 1, $6, clock_timestamp(), 'student', $7)`,
                [proofId, fixture.userId, fixture.universityId, consentId, identityId, attemptId, MICROSOFT_ENROLLMENT_SOURCE],
            );
            const evidence = (await client.query<{ id: string }>(
                `INSERT INTO eligibility_evidence
                     (student_id, university_id, email_proof_id, processing_grant_id, provider_proof_id,
                      method, outcome, identity_version, policy_version, source, expires_at)
                 VALUES ($1, $2, $3, $4, $5, 'enrollment', 'verified', $6, $7, $8,
                         clock_timestamp() + interval '24 hours')
                 RETURNING id`,
                [fixture.studentId, fixture.universityId, email.email_proof_id, fixture.grantId,
                    proofId, email.identity_version, email.policy_version, MICROSOFT_ENROLLMENT_SOURCE],
            )).rows[0]!.id;
            await client.query(
                `UPDATE student_eligibility_state SET current_evidence_id = $1
                 WHERE student_id = $2 AND university_id = $3`,
                [evidence, fixture.studentId, fixture.universityId],
            );
            const assurance = await read(client, fixture.userId);
            assert.equal(assurance.studentStatus, 'pending');
            assert.equal(assurance.reason, 'provider_unavailable');
        });
    } finally {
        config.microsoftOidc.enabled = originalEnabled;
    }
});

test('absent student profile reads pending with unverified school account', async () => {
    await withTestClient(async (client) => {
        const label = uniqueLabel();
        const userId = (await client.query<{ id: string }>(
            `INSERT INTO users (email, role) VALUES ($1, 'student') RETURNING id`,
            [`profileless-${label}@example.invalid`],
        )).rows[0]!.id;
        assert.deepEqual(await read(client, userId), {
            schoolAccountStatus: 'unverified',
            schoolAccountMethod: null,
            schoolAccountValidUntil: null,
            studentStatus: 'pending',
            enrollmentMethod: null,
            studentValidUntil: null,
            reason: 'awaiting_enrollment',
        });
    });
});
