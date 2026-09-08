import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import type { Response } from 'express';
import { CheckoutController } from '../../controllers/checkout.controller.js';
import type { AuthRequest } from '../../middleware/auth.middleware.js';
import { db } from '../../config/database.js';

after(() => db.close());
import type { PoolClient } from 'pg';
import { consumeChallenge, requestChallenge } from '../../services/verification/challenge.service.js';
import {
    grantMerchantDisclosure,
    grantVerificationProcessing,
    withdrawConsent,
} from '../../services/verification/eligibility-consent.service.js';
import { lockStudentContext } from '../../services/verification/eligibility-context.service.js';
import {
    applyEnrollmentDecision,
    beginEnrollmentCheck,
    recordEmailAssurance,
    recordMailboxProof,
} from '../../services/verification/eligibility-evidence.service.js';
import { updateInstitutionPolicy } from '../../services/verification/eligibility-policy.service.js';
import { getEffectiveEligibility } from '../../services/verification/eligibility-read.service.js';
import { ENROLLMENT_SOURCE, type EnrollmentSnapshot, type StudentContext } from '../../services/verification/eligibility.types.js';
import {
    MERCHANT_DISCLOSURE_NOTICE_VERSION,
    VERIFICATION_NOTICE_VERSION,
} from '../../services/verification/verification-notices.js';
import { createTestPool, inTransaction, withTestClient } from './test-database.js';

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
    registrationNumber?: string | null;
};

function uniqueLabel(): string {
    return randomUUID().replaceAll('-', '').slice(0, 12);
}

async function lockExistingStudentForChallenge(
    client: PoolClient,
    userId: string,
    processingGrantId: string,
): Promise<StudentContext> {
    const context = await lockStudentContext(client, userId);
    await client.query(
        `INSERT INTO student_eligibility_state (student_id, university_id)
         VALUES ($1, $2)
         ON CONFLICT (student_id, university_id) DO NOTHING`,
        [context.studentId, context.universityId],
    );
    const state = await client.query(
        `SELECT student_id FROM student_eligibility_state
         WHERE student_id = $1 AND university_id = $2
         FOR UPDATE`,
        [context.studentId, context.universityId],
    );
    assert.equal(state.rowCount, 1);
    const grant = await client.query(
        `SELECT id FROM verification_consents
         WHERE id = $1
           AND user_id = $2
           AND university_id = $3
           AND kind = 'processing'
           AND accepted
           AND withdrawn_at IS NULL
           AND notice_version = $4
         FOR UPDATE`,
        [processingGrantId, userId, context.universityId, VERIFICATION_NOTICE_VERSION],
    );
    assert.equal(grant.rowCount, 1);
    return context;
}

async function lockExistingAccountForChallenge(client: PoolClient, userId: string): Promise<void> {
    const account = await client.query(
        `SELECT id FROM users WHERE id = $1 FOR UPDATE`,
        [userId],
    );
    assert.equal(account.rowCount, 1);
}

async function createFixture(client: PoolClient, options: FixtureOptions = {}): Promise<Fixture> {
    const label = uniqueLabel();
    const adminId = (await client.query<{ id: string }>(
        `INSERT INTO users (email, role) VALUES ($1, 'admin') RETURNING id`,
        [`admin-${label}@example.invalid`],
    )).rows[0]!.id;
    const email = `student-${label}@students.school.example`;
    const userId = (await client.query<{ id: string }>(
        `INSERT INTO users (email, role) VALUES ($1, 'student') RETURNING id`,
        [email],
    )).rows[0]!.id;
    const universityId = (await client.query<{ id: string }>(
        `INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id`,
        [`School ${label}`],
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
         VALUES ($1, 'Student ${label}', $2, $3)
         RETURNING id`,
        [userId, universityId, options.registrationNumber ?? null],
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
        // Existing-subject assurance locks context/state/grant before the
        // challenge budget/consumption/proof path in this transaction.
        const context = await lockExistingStudentForChallenge(client, userId, grantId);
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

async function issueEmailAssurance(client: PoolClient, fixture: Fixture): Promise<void> {
    await client.query(
        `UPDATE verification_challenge_budgets
         SET resend_available_at = clock_timestamp() - interval '1 second'
         WHERE purpose = 'student_email'`,
    );
    await inTransaction(client, async () => {
        const context = await lockExistingStudentForChallenge(client, fixture.userId, fixture.grantId);
        const issued = await requestChallenge(client, {
            purpose: 'student_email',
            subjectKey: fixture.userId,
            bindings: {
                ...context,
                processingGrantId: fixture.grantId,
                noticeVersion: VERIFICATION_NOTICE_VERSION,
            },
        });
        assert.equal(issued.status, 'issued');
        if (issued.status !== 'issued') throw new Error('Retry challenge was not issued');
        const consumed = await consumeChallenge(client, {
            purpose: 'student_email',
            subjectKey: fixture.userId,
            challengeId: issued.challengeId,
            code: issued.code,
        });
        assert.equal(consumed.status, 'verified');
        await recordEmailAssurance(client, fixture.userId, {
            challengeId: issued.challengeId,
            processingGrantId: fixture.grantId,
        });
    });
}

async function begin(client: PoolClient, fixture: Fixture): Promise<EnrollmentSnapshot> {
    return inTransaction(client, () => beginEnrollmentCheck(client, fixture.userId, fixture.grantId));
}

function verifiedDecision(email: string, registrationNumber: string): {
    outcome: 'verified'; email: string; registrationNumber: string; validUntil: Date; source: string;
} {
    return {
        outcome: 'verified',
        email,
        registrationNumber,
        validUntil: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
        source: ENROLLMENT_SOURCE,
    };
}

async function state(client: PoolClient, fixture: Fixture): Promise<{
    provider_request_generation: number;
    provider_applied_generation: number;
    authoritative_denial: boolean;
    current_evidence_id: string | null;
}> {
    const result = await client.query<{
        provider_request_generation: number;
        provider_applied_generation: number;
        authoritative_denial: boolean;
        current_evidence_id: string | null;
    }>(
        `SELECT provider_request_generation, provider_applied_generation, authoritative_denial, current_evidence_id
         FROM student_eligibility_state
         WHERE student_id = $1 AND university_id = $2`,
        [fixture.studentId, fixture.universityId],
    );
    return result.rows[0]!;
}

type MerchantFixture = {
    ownerId: string;
    vendorId: string;
    origin: string;
};

async function createMerchantFixture(client: PoolClient): Promise<MerchantFixture> {
    const ownerId = (await client.query<{ id: string }>(
        `INSERT INTO users (email, role) VALUES ($1, 'vendor') RETURNING id`,
        [`vendor-${uniqueLabel()}@example.invalid`],
    )).rows[0]!.id;
    const vendorId = (await client.query<{ id: string }>(
        `INSERT INTO vendors (user_id, name, status) VALUES ($1, $2, 'active') RETURNING id`,
        [ownerId, `Vendor ${uniqueLabel()}`],
    )).rows[0]!.id;
    const origin = `https://${uniqueLabel()}.merchant.example`;
    await client.query(
        `INSERT INTO widget_configs (vendor_id, allowed_domains, allowed_origins, api_key, status)
         VALUES ($1, ARRAY['legacy.example'], ARRAY[$2], $3, 'active')`,
        [vendorId, origin, `public-${uniqueLabel()}`],
    );
    return { ownerId, vendorId, origin };
}

async function clientPid(client: PoolClient): Promise<number> {
    const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    return result.rows[0]!.pid;
}

async function waitForBlockedBy(
    observer: PoolClient,
    waitingPid: number,
    blockingPid: number,
    label: string,
): Promise<void> {
    const deadline = Date.now() + 2_000;
    do {
        const result = await observer.query<{ blocked: boolean }>(
            'SELECT $2 = ANY(pg_blocking_pids($1)) AS blocked',
            [waitingPid, blockingPid],
        );
        if (result.rows[0]?.blocked) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    throw new Error(`Expected ${label} to be blocked by the required PostgreSQL backend`);
}

async function beginWithLockTimeout(client: PoolClient): Promise<void> {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
}

type SignupClaim = {
    email: string;
    name: string;
    universityId: string;
    matricNumber: string | null;
    policyVersion: number;
    noticeVersion: string;
};

async function issueSignupChallenge(client: PoolClient, claim: SignupClaim): Promise<{ challengeId: string; code: string }> {
    const issued = await inTransaction(client, () => requestChallenge(client, {
        purpose: 'student_signup',
        subjectKey: claim.email,
        bindings: {
            email: claim.email,
            name: claim.name,
            universityId: claim.universityId,
            matricNumber: claim.matricNumber,
            policyVersion: claim.policyVersion,
            verificationConsent: true,
            noticeVersion: claim.noticeVersion,
        },
    }));
    assert.equal(issued.status, 'issued');
    if (issued.status !== 'issued') throw new Error('Signup challenge was not issued');
    return issued;
}

async function signupClaim(client: PoolClient, universityId: string, overrides: Partial<SignupClaim> = {}): Promise<SignupClaim> {
    const policy = await client.query<{ verification_policy_version: number }>(
        `SELECT verification_policy_version FROM universities WHERE id = $1`,
        [universityId],
    );
    return {
        email: `signup-${uniqueLabel()}@students.school.example`,
        name: `Signup ${uniqueLabel()}`,
        universityId,
        matricNumber: null,
        policyVersion: policy.rows[0]!.verification_policy_version,
        noticeVersion: VERIFICATION_NOTICE_VERSION,
        ...overrides,
    };
}

async function completeNewSignup(
    client: PoolClient,
    claim: SignupClaim,
    created: Partial<Pick<SignupClaim, 'email' | 'name' | 'universityId' | 'matricNumber'>> = {},
): Promise<{ userId: string; studentId: string; grantId: string }> {
    const issued = await issueSignupChallenge(client, claim);
    return inTransaction(client, async () => {
        // The new-account exception consumes this signup proof before the
        // account exists; all user/profile/grant/proof/evidence writes follow
        // in this same transaction. Existing students never use this path.
        const consumed = await consumeChallenge(client, {
            purpose: 'student_signup',
            subjectKey: claim.email,
            challengeId: issued.challengeId,
            code: issued.code,
        });
        assert.equal(consumed.status, 'verified');
        const email = created.email ?? claim.email;
        const name = created.name ?? claim.name;
        const universityId = created.universityId ?? claim.universityId;
        const matricNumber = created.matricNumber === undefined ? claim.matricNumber : created.matricNumber;
        const userId = (await client.query<{ id: string }>(
            `INSERT INTO users (email, role) VALUES ($1, 'student') RETURNING id`,
            [email],
        )).rows[0]!.id;
        const studentId = (await client.query<{ id: string }>(
            `INSERT INTO students (user_id, name, university_id, registration_number)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [userId, name, universityId, matricNumber],
        )).rows[0]!.id;
        const grantId = await grantVerificationProcessing(client, userId, universityId, {
            accepted: true,
            noticeVersion: VERIFICATION_NOTICE_VERSION,
        });
        const result = await recordEmailAssurance(client, userId, {
            challengeId: issued.challengeId,
            processingGrantId: grantId,
        });
        assert.equal(result.eligible, true);
        return { userId, studentId, grantId };
    });
}

test('legacy verified status without explicit evidence is not eligible', async () => {
    await withTestClient(async (client) => {
        const user = await client.query<{ id: string }>(
            `INSERT INTO users (email, role, verification_status)
             VALUES ('legacy-eligibility@example.invalid', 'student', 'verified') RETURNING id`,
        );
        const university = await client.query<{ id: string }>(
            `INSERT INTO universities (name, is_active) VALUES ('Eligibility Legacy University', true) RETURNING id`,
        );
        await client.query(
            `INSERT INTO students (user_id, name, university_id) VALUES ($1, 'Legacy', $2)`,
            [user.rows[0]!.id, university.rows[0]!.id],
        );
        assert.deepEqual(
            await inTransaction(client, () => getEffectiveEligibility(client, user.rows[0]!.id)),
            { eligible: false, reason: 'unverified' },
        );
    });
});

test('requires an exact active approved domain and explicit fresh processing consent', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client);
        assert.equal((await inTransaction(client, () => getEffectiveEligibility(client, fixture.userId))).eligible, true);
        await client.query(`UPDATE universities SET domain = 'students.school.example,public.example' WHERE id = $1`, [fixture.universityId]);
        assert.equal((await inTransaction(client, () => getEffectiveEligibility(client, fixture.userId))).eligible, true);
        await inTransaction(client, () => updateInstitutionPolicy(client, fixture.adminId, fixture.universityId, {
            domains: [], emailEvidenceValidityDays: 90, enrollmentValidityDays: 30,
            registrationNormalization: null, isActive: true,
        }));
        assert.deepEqual(
            await inTransaction(client, () => getEffectiveEligibility(client, fixture.userId)),
            { eligible: false, reason: 'policy_changed' },
        );
        await inTransaction(client, () => updateInstitutionPolicy(client, fixture.adminId, fixture.universityId, {
            domains: ['students.school.example'], emailEvidenceValidityDays: 90, enrollmentValidityDays: 30,
            registrationNormalization: null, isActive: true,
        }));
        assert.deepEqual(
            await inTransaction(client, () => getEffectiveEligibility(client, fixture.userId)),
            { eligible: false, reason: 'policy_changed' },
        );
        await assert.rejects(
            inTransaction(client, () => grantVerificationProcessing(client, fixture.userId, fixture.universityId, {
                accepted: false as true,
                noticeVersion: VERIFICATION_NOTICE_VERSION,
            })),
            /consent/i,
        );
        await assert.rejects(
            inTransaction(client, () => grantVerificationProcessing(client, fixture.userId, fixture.universityId, {
                accepted: true,
                noticeVersion: 'obsolete.v1',
            })),
            /consent/i,
        );
        await assert.rejects(
            client.query(
                `INSERT INTO users (email, role) VALUES ($1, 'student')`,
                [fixture.email.toUpperCase()],
            ),
            /users_normalized_email_unique|duplicate key/i,
        );
    });
});

test('invalidates evidence for suspension, restoration, and identity changes without resurrection', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client);
        await client.query(`UPDATE students SET status = 'suspended' WHERE id = $1`, [fixture.studentId]);
        assert.deepEqual(
            await inTransaction(client, () => getEffectiveEligibility(client, fixture.userId)),
            { eligible: false, reason: 'inactive' },
        );
        await client.query(`UPDATE students SET status = 'active' WHERE id = $1`, [fixture.studentId]);
        assert.deepEqual(
            await inTransaction(client, () => getEffectiveEligibility(client, fixture.userId)),
            { eligible: false, reason: 'identity_changed' },
        );
        await client.query(`UPDATE users SET email = upper(email) WHERE id = $1`, [fixture.userId]);
        await client.query(`UPDATE users SET email = lower(email) WHERE id = $1`, [fixture.userId]);
        assert.deepEqual(
            await inTransaction(client, () => getEffectiveEligibility(client, fixture.userId)),
            { eligible: false, reason: 'identity_changed' },
        );
    });
});

test('processing withdrawal revokes the old evidence and a re-grant cannot revive it', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client);
        await inTransaction(client, () => withdrawConsent(client, fixture.userId, fixture.grantId));
        assert.deepEqual(
            await inTransaction(client, () => getEffectiveEligibility(client, fixture.userId)),
            { eligible: false, reason: 'consent_required' },
        );
        await inTransaction(client, () => grantVerificationProcessing(
            client,
            fixture.userId,
            fixture.universityId,
            { accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION },
        ));
        assert.deepEqual(
            await inTransaction(client, () => getEffectiveEligibility(client, fixture.userId)),
            { eligible: false, reason: 'consent_required' },
        );
        const foreign = (await client.query<{ id: string }>(
            `INSERT INTO users (email, role) VALUES ($1, 'student') RETURNING id`,
            [`foreign-${uniqueLabel()}@students.school.example`],
        )).rows[0]!.id;
        await assert.rejects(
            inTransaction(client, () => withdrawConsent(client, foreign, fixture.grantId)),
            /another user/i,
        );
    });
});

test('keeps merchant disclosures independent and requires a configured exact origin', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client);
        const owner = (await client.query<{ id: string }>(
            `INSERT INTO users (email, role) VALUES ($1, 'vendor') RETURNING id`,
            [`vendor-${uniqueLabel()}@example.invalid`],
        )).rows[0]!.id;
        const vendorA = (await client.query<{ id: string }>(
            `INSERT INTO vendors (user_id, name, status) VALUES ($1, 'Vendor A', 'active') RETURNING id`,
            [owner],
        )).rows[0]!.id;
        const vendorB = (await client.query<{ id: string }>(
            `INSERT INTO vendors (user_id, name, status) VALUES ($1, 'Vendor B', 'active') RETURNING id`,
            [owner],
        )).rows[0]!.id;
        await client.query(
            `INSERT INTO widget_configs (vendor_id, allowed_domains, allowed_origins, api_key, status)
             VALUES ($1, ARRAY['legacy.example'], ARRAY['https://a.example'], 'public-a', 'active'),
                    ($2, ARRAY['legacy.example'], ARRAY['https://b.example'], 'public-b', 'active')`,
            [vendorA, vendorB],
        );
        await assert.rejects(
            inTransaction(client, () => grantMerchantDisclosure(client, fixture.userId, {
                vendorId: vendorA, origin: 'https://a.example/path', purpose: 'discount',
                accepted: true, noticeVersion: MERCHANT_DISCLOSURE_NOTICE_VERSION,
            })),
            /origin/i,
        );
        const disclosureA = await inTransaction(client, () => grantMerchantDisclosure(client, fixture.userId, {
            vendorId: vendorA, origin: 'https://a.example', purpose: 'discount',
            accepted: true, noticeVersion: MERCHANT_DISCLOSURE_NOTICE_VERSION,
        }));
        const disclosureB = await inTransaction(client, () => grantMerchantDisclosure(client, fixture.userId, {
            vendorId: vendorB, origin: 'https://b.example', purpose: 'discount',
            accepted: true, noticeVersion: MERCHANT_DISCLOSURE_NOTICE_VERSION,
        }));
        await inTransaction(client, () => withdrawConsent(client, fixture.userId, disclosureA));
        assert.deepEqual(
            await inTransaction(client, () => getEffectiveEligibility(client, fixture.userId, {
                vendorId: vendorA, grantId: disclosureA, origin: 'https://a.example', purpose: 'discount',
            })),
            { eligible: false, reason: 'consent_required' },
        );
        assert.equal((await inTransaction(client, () => getEffectiveEligibility(client, fixture.userId, {
            vendorId: vendorB, grantId: disclosureB, origin: 'https://b.example', purpose: 'discount',
        }))).eligible, true);
    });
});

test('records account-email ownership for a non-student account without granting eligibility', async () => {
    await withTestClient(async (client) => {
        const account = (await client.query<{ id: string }>(
            `INSERT INTO users (email, role) VALUES ('ordinary-account@example.invalid', 'vendor') RETURNING id`,
        )).rows[0]!.id;
        const issued = await inTransaction(client, () => requestChallenge(client, {
            purpose: 'account_email',
            subjectKey: account,
            bindings: { userId: account, email: 'ordinary-account@example.invalid' },
        }));
        assert.equal(issued.status, 'issued');
        if (issued.status !== 'issued') throw new Error('Account challenge was not issued');
        const proofId = await inTransaction(client, async () => {
            await lockExistingAccountForChallenge(client, account);
            const consumed = await consumeChallenge(client, {
                purpose: 'account_email', subjectKey: account, challengeId: issued.challengeId, code: issued.code,
            });
            assert.equal(consumed.status, 'verified');
            return recordMailboxProof(client, account, issued.challengeId);
        });
        assert.match(proofId, /^[0-9a-f-]{36}$/);
        assert.deepEqual(
            await inTransaction(client, () => getEffectiveEligibility(client, account)),
            { eligible: false, reason: 'unverified' },
        );
    });
});

test('rejects unconsumed, cross-account, and evidence-reused challenge references', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client);
        const issued = await inTransaction(client, () => requestChallenge(client, {
            purpose: 'account_email',
            subjectKey: fixture.userId,
            bindings: { userId: fixture.userId, email: fixture.email },
        }));
        assert.equal(issued.status, 'issued');
        if (issued.status !== 'issued') throw new Error('Forgery challenge was not issued');
        await assert.rejects(
            inTransaction(client, () => recordMailboxProof(client, fixture.userId, issued.challengeId)),
            /consumed/i,
        );
        await inTransaction(client, async () => {
            await lockExistingAccountForChallenge(client, fixture.userId);
            await consumeChallenge(client, {
                purpose: 'account_email', subjectKey: fixture.userId, challengeId: issued.challengeId, code: issued.code,
            });
            const proof = await recordMailboxProof(client, fixture.userId, issued.challengeId);
            assert.equal(proof, await recordMailboxProof(client, fixture.userId, issued.challengeId));
        });
        const other = (await client.query<{ id: string }>(
            `INSERT INTO users (email, role) VALUES ($1, 'vendor') RETURNING id`,
            [`other-${uniqueLabel()}@example.invalid`],
        )).rows[0]!.id;
        await assert.rejects(
            inTransaction(client, () => recordMailboxProof(client, other, issued.challengeId)),
            /bindings|belongs/i,
        );
        const evidence = await client.query<{ challenge_id: string }>(
            `SELECT challenge_id FROM eligibility_evidence WHERE student_id = $1 AND challenge_id IS NOT NULL LIMIT 1`,
            [fixture.studentId],
        );
        await assert.rejects(
            inTransaction(client, () => recordEmailAssurance(client, fixture.userId, {
                challengeId: evidence.rows[0]!.challenge_id,
                processingGrantId: fixture.grantId,
            })),
            /evidence/i,
        );
    });
});

test('applies matched enrollment, then denial prevents an email retry, and newer positive clears it', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        const first = await begin(client, fixture);
        const positive = await inTransaction(client, () => applyEnrollmentDecision(
            client,
            first,
            verifiedDecision(fixture.email, ' reg-001 '),
        ));
        assert.equal(positive.eligible, true);
        const deniedSnapshot = await begin(client, fixture);
        const denied = await inTransaction(client, () => applyEnrollmentDecision(client, deniedSnapshot, {
            outcome: 'denied', email: fixture.email, source: ENROLLMENT_SOURCE,
        }));
        assert.deepEqual(denied, { eligible: false, reason: 'enrollment_denied' });
        await assert.rejects(
            inTransaction(client, () => applyEnrollmentDecision(
                client,
                deniedSnapshot,
                verifiedDecision(fixture.email, 'reg-001'),
            )),
            /generation/i,
        );
        const unknownAfterDenial = await begin(client, fixture);
        assert.deepEqual(
            await inTransaction(client, () => applyEnrollmentDecision(client, unknownAfterDenial, { outcome: 'unknown' })),
            { eligible: false, reason: 'enrollment_denied' },
        );
        await issueEmailAssurance(client, fixture);
        assert.deepEqual(
            await inTransaction(client, () => getEffectiveEligibility(client, fixture.userId)),
            { eligible: false, reason: 'enrollment_denied' },
        );
        const newer = await begin(client, fixture);
        assert.equal((await inTransaction(client, () => applyEnrollmentDecision(
            client,
            newer,
            verifiedDecision(fixture.email, 'reg-001'),
        ))).eligible, true);
    });
});

test('unknown preserves current evidence while consuming exactly one provider generation', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        const snapshot = await begin(client, fixture);
        assert.equal((await inTransaction(client, () => applyEnrollmentDecision(client, snapshot, { outcome: 'unknown' }))).eligible, true);
        const after = await state(client, fixture);
        assert.equal(after.provider_applied_generation, snapshot.requestGeneration);
        assert.ok(after.current_evidence_id);
        await assert.rejects(
            inTransaction(client, () => applyEnrollmentDecision(client, snapshot, { outcome: 'unknown' })),
            /generation/i,
        );
    });
});

test('rejects mismatched and untrusted provider outcomes before consuming their generation', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        const snapshot = await begin(client, fixture);
        await assert.rejects(
            inTransaction(client, () => applyEnrollmentDecision(client, snapshot, {
                outcome: 'denied', email: 'other@students.school.example', source: ENROLLMENT_SOURCE,
            })),
            /mailbox-attested/i,
        );
        await assert.rejects(
            inTransaction(client, () => applyEnrollmentDecision(client, snapshot, {
                ...verifiedDecision(fixture.email, 'reg-bad'), source: 'caller-supplied',
            })),
            /mailbox-attested/i,
        );
        await assert.rejects(
            inTransaction(client, () => applyEnrollmentDecision(client, snapshot, {
                outcome: 'denied', email: fixture.email, source: 'caller-supplied',
            })),
            /mailbox-attested/i,
        );
        const before = await state(client, fixture);
        assert.equal(before.provider_applied_generation, 0);
        const identities = await client.query(
            `SELECT 1 FROM verified_registration_identities WHERE student_id = $1`,
            [fixture.studentId],
        );
        assert.equal(identities.rowCount, 0);
        assert.equal((await inTransaction(client, () => applyEnrollmentDecision(
            client,
            snapshot,
            verifiedDecision(fixture.email, 'reg-good'),
        ))).eligible, true);
    });
});

test('rejects malformed positive provider results before advancing the applied marker', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        const snapshot = await begin(client, fixture);
        const expired = verifiedDecision(fixture.email, 'never-reserved');
        expired.validUntil = new Date(Date.now() - 1);
        await assert.rejects(
            inTransaction(client, () => applyEnrollmentDecision(client, snapshot, expired)),
            /deadline/i,
        );
        await assert.rejects(
            inTransaction(client, () => applyEnrollmentDecision(client, snapshot, {
                outcome: 'provider-error',
            } as unknown as { outcome: 'unknown' })),
            /unsupported/i,
        );
        const before = await state(client, fixture);
        assert.equal(before.provider_applied_generation, 0);
        const reservations = await client.query(
            `SELECT 1 FROM verified_registration_identities
             WHERE university_id = $1 AND identifier = 'NEVER-RESERVED'`,
            [fixture.universityId],
        );
        assert.equal(reservations.rowCount, 0);
        assert.equal((await inTransaction(client, () => applyEnrollmentDecision(
            client,
            snapshot,
            verifiedDecision(fixture.email, 'never-reserved'),
        ))).eligible, true);
    });
});

test('rejects missing and foreign processing grants without changing current authority state', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        const baseline = await state(client, fixture);
        const baselineEvidence = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM eligibility_evidence WHERE student_id = $1`,
            [fixture.studentId],
        );
        const snapshot = await begin(client, fixture);
        const foreignOwner = await createFixture(client);
        await assert.rejects(
            inTransaction(client, () => applyEnrollmentDecision(client, {
                ...snapshot,
                processingGrantId: randomUUID(),
            }, { outcome: 'unknown' })),
            /consent/i,
        );
        await assert.rejects(
            inTransaction(client, () => applyEnrollmentDecision(client, {
                ...snapshot,
                processingGrantId: foreignOwner.grantId,
            }, { outcome: 'unknown' })),
            /consent/i,
        );
        const after = await state(client, fixture);
        assert.equal(after.provider_request_generation, snapshot.requestGeneration);
        assert.equal(after.provider_applied_generation, baseline.provider_applied_generation);
        assert.equal(after.current_evidence_id, baseline.current_evidence_id);
        const evidence = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM eligibility_evidence WHERE student_id = $1`,
            [fixture.studentId],
        );
        assert.equal(evidence.rows[0]!.count, baselineEvidence.rows[0]!.count);
        assert.equal((await inTransaction(client, () => applyEnrollmentDecision(
            client,
            snapshot,
            { outcome: 'unknown' },
        ))).eligible, true);
    });
});

test('rejects stale generations and every changed provider snapshot input', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        const stale = await begin(client, fixture);
        const current = await begin(client, fixture);
        await assert.rejects(
            inTransaction(client, () => applyEnrollmentDecision(client, stale, { outcome: 'unknown' })),
            /generation/i,
        );
        await inTransaction(client, () => applyEnrollmentDecision(client, current, { outcome: 'unknown' }));

        const identitySnapshot = await begin(client, fixture);
        await client.query(`UPDATE students SET name = name || ' changed' WHERE id = $1`, [fixture.studentId]);
        await assert.rejects(
            inTransaction(client, () => applyEnrollmentDecision(client, identitySnapshot, { outcome: 'unknown' })),
            /snapshot/i,
        );

        const policySnapshot = await begin(client, fixture);
        await client.query(
            `UPDATE university_verification_methods
             SET api_endpoint = 'https://institution.example/changed'
             WHERE university_id = $1`,
            [fixture.universityId],
        );
        await assert.rejects(
            inTransaction(client, () => applyEnrollmentDecision(client, policySnapshot, { outcome: 'unknown' })),
            /snapshot/i,
        );

        const grantSnapshot = await begin(client, fixture);
        await inTransaction(client, () => withdrawConsent(client, fixture.userId, fixture.grantId));
        await assert.rejects(
            inTransaction(client, () => applyEnrollmentDecision(client, grantSnapshot, { outcome: 'unknown' })),
            /consent/i,
        );
    });
});

test('scopes registration identity to an institution and rejects same-institution takeover without merging', async () => {
    await withTestClient(async (client) => {
        const first = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        const firstSnapshot = await begin(client, first);
        await inTransaction(client, () => applyEnrollmentDecision(
            client,
            firstSnapshot,
            verifiedDecision(first.email, 'shared-reg'),
        ));
        const second = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        const secondSnapshot = await begin(client, second);
        assert.equal((await inTransaction(client, () => applyEnrollmentDecision(
            client,
            secondSnapshot,
            verifiedDecision(second.email, 'shared-reg'),
        ))).eligible, true);

        const sameUniversityEmail = `same-${uniqueLabel()}@students.school.example`;
        const sameUniversityUser = (await client.query<{ id: string }>(
            `INSERT INTO users (email, role) VALUES ($1, 'student') RETURNING id`,
            [sameUniversityEmail],
        )).rows[0]!.id;
        const sameUniversityStudent = (await client.query<{ id: string }>(
            `INSERT INTO students (user_id, name, university_id) VALUES ($1, 'Same University', $2) RETURNING id`,
            [sameUniversityUser, first.universityId],
        )).rows[0]!.id;
        const sameGrant = await inTransaction(client, () => grantVerificationProcessing(
            client, sameUniversityUser, first.universityId,
            { accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION },
        ));
        await inTransaction(client, async () => {
            const sameContext = await lockExistingStudentForChallenge(client, sameUniversityUser, sameGrant);
            const issue = await requestChallenge(client, {
                purpose: 'student_email', subjectKey: sameUniversityUser,
                bindings: { ...sameContext, processingGrantId: sameGrant, noticeVersion: VERIFICATION_NOTICE_VERSION },
            });
            assert.equal(issue.status, 'issued');
            if (issue.status !== 'issued') throw new Error('Same-institution challenge was not issued');
            await consumeChallenge(client, {
                purpose: 'student_email', subjectKey: sameUniversityUser,
                challengeId: issue.challengeId, code: issue.code,
            });
            await recordEmailAssurance(client, sameUniversityUser, {
                challengeId: issue.challengeId, processingGrantId: sameGrant,
            });
        });
        const sameSnapshot = await inTransaction(client, () => beginEnrollmentCheck(client, sameUniversityUser, sameGrant));
        await assert.rejects(
            inTransaction(client, () => applyEnrollmentDecision(
                client,
                sameSnapshot,
                verifiedDecision(sameUniversityEmail, 'shared-reg'),
            )),
            /belongs/i,
        );
        const marker = await client.query<{ provider_applied_generation: number }>(
            `SELECT provider_applied_generation FROM student_eligibility_state
             WHERE student_id = $1 AND university_id = $2`,
            [sameUniversityStudent, first.universityId],
        );
        assert.equal(marker.rows[0]!.provider_applied_generation, 0);
    });
});

test('uses controlled database timestamps for expiry and enforces configured evidence caps', async () => {
    await withTestClient(async (client) => {
        const defaultEmail = await createFixture(client);
        const configuredEmail = await createFixture(client, { emailEvidenceValidityDays: 7 });
        const defaultWindow = await client.query<{ seconds: number }>(
            `SELECT EXTRACT(epoch FROM expires_at - verified_at) AS seconds
             FROM eligibility_evidence
             WHERE student_id = $1 AND method = 'student_email'
             ORDER BY verified_at DESC LIMIT 1`,
            [defaultEmail.studentId],
        );
        const configuredWindow = await client.query<{ seconds: number }>(
            `SELECT EXTRACT(epoch FROM expires_at - verified_at) AS seconds
             FROM eligibility_evidence
             WHERE student_id = $1 AND method = 'student_email'
             ORDER BY verified_at DESC LIMIT 1`,
            [configuredEmail.studentId],
        );
        assert.ok(Math.abs(defaultWindow.rows[0]!.seconds - 90 * 86_400) < 2);
        assert.ok(Math.abs(configuredWindow.rows[0]!.seconds - 7 * 86_400) < 2);

        const policyCap = await createFixture(client, {
            enrollment: true,
            normalization: 'trim_upper',
            enrollmentValidityDays: 30,
        });
        const policySnapshot = await begin(client, policyCap);
        await inTransaction(client, () => applyEnrollmentDecision(
            client,
            policySnapshot,
            verifiedDecision(policyCap.email, 'policy-cap'),
        ));
        const policyWindow = await client.query<{ seconds: number }>(
            `SELECT EXTRACT(epoch FROM expires_at - verified_at) AS seconds
             FROM eligibility_evidence
             WHERE student_id = $1 AND method = 'enrollment'
             ORDER BY verified_at DESC LIMIT 1`,
            [policyCap.studentId],
        );
        assert.ok(Math.abs(policyWindow.rows[0]!.seconds - 30 * 86_400) < 2);

        const deadlineCap = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        const deadlineSnapshot = await begin(client, deadlineCap);
        const tenDayDeadline = new Date(Date.now() + 10 * 86_400_000);
        await inTransaction(client, () => applyEnrollmentDecision(client, deadlineSnapshot, {
            outcome: 'verified',
            email: deadlineCap.email,
            registrationNumber: 'provider-cap',
            validUntil: tenDayDeadline,
            source: ENROLLMENT_SOURCE,
        }));
        const deadlineWindow = await client.query<{ seconds: number }>(
            `SELECT EXTRACT(epoch FROM expires_at - verified_at) AS seconds
             FROM eligibility_evidence
             WHERE student_id = $1 AND method = 'enrollment'
             ORDER BY verified_at DESC LIMIT 1`,
            [deadlineCap.studentId],
        );
        assert.ok(deadlineWindow.rows[0]!.seconds > 9 * 86_400);
        assert.ok(deadlineWindow.rows[0]!.seconds <= 10 * 86_400);

        const original = await client.query<{ email_proof_id: string; identity_version: number; policy_version: number }>(
            `SELECT email_proof_id, identity_version, policy_version
             FROM eligibility_evidence
             WHERE student_id = $1 AND method = 'student_email'
             ORDER BY verified_at DESC LIMIT 1`,
            [defaultEmail.studentId],
        );
        const expired = await client.query<{ id: string }>(
            `INSERT INTO eligibility_evidence
                 (student_id, university_id, email_proof_id, processing_grant_id,
                  method, outcome, identity_version, policy_version, source, expires_at)
             VALUES ($1, $2, $3, $4, 'enrollment', 'verified', $5, $6, $7,
                     clock_timestamp() - interval '1 minute')
             RETURNING id`,
            [
                defaultEmail.studentId,
                defaultEmail.universityId,
                original.rows[0]!.email_proof_id,
                defaultEmail.grantId,
                original.rows[0]!.identity_version,
                original.rows[0]!.policy_version,
                ENROLLMENT_SOURCE,
            ],
        );
        await client.query(
            `UPDATE student_eligibility_state SET current_evidence_id = $3
             WHERE student_id = $1 AND university_id = $2`,
            [defaultEmail.studentId, defaultEmail.universityId, expired.rows[0]!.id],
        );
        assert.deepEqual(
            await inTransaction(client, () => getEffectiveEligibility(client, defaultEmail.userId)),
            { eligible: false, reason: 'expired' },
        );
    });
});

test('fresh evidence never resurrects after material identity or policy changes are restored', async () => {
    await withTestClient(async (client) => {
        const emailFixture = await createFixture(client);
        const originalEmail = emailFixture.email;
        const changedEmail = `changed-${uniqueLabel()}@students.school.example`;
        await client.query(`UPDATE users SET email = $2 WHERE id = $1`, [emailFixture.userId, changedEmail]);
        await client.query(`UPDATE users SET email = $2 WHERE id = $1`, [emailFixture.userId, originalEmail]);
        assert.deepEqual(
            await inTransaction(client, () => getEffectiveEligibility(client, emailFixture.userId)),
            { eligible: false, reason: 'identity_changed' },
        );

        const profileFixture = await createFixture(client);
        await client.query(`UPDATE students SET name = name || ' changed' WHERE id = $1`, [profileFixture.studentId]);
        await client.query(
            `UPDATE students SET name = regexp_replace(name, ' changed$', '') WHERE id = $1`,
            [profileFixture.studentId],
        );
        assert.deepEqual(
            await inTransaction(client, () => getEffectiveEligibility(client, profileFixture.userId)),
            { eligible: false, reason: 'identity_changed' },
        );

        const institutionFixture = await createFixture(client);
        await client.query(`UPDATE universities SET is_active = false WHERE id = $1`, [institutionFixture.universityId]);
        assert.deepEqual(
            await inTransaction(client, () => getEffectiveEligibility(client, institutionFixture.userId)),
            { eligible: false, reason: 'inactive' },
        );
        await client.query(`UPDATE universities SET is_active = true WHERE id = $1`, [institutionFixture.universityId]);
        assert.deepEqual(
            await inTransaction(client, () => getEffectiveEligibility(client, institutionFixture.userId)),
            { eligible: false, reason: 'policy_changed' },
        );

        const domainFixture = await createFixture(client);
        await inTransaction(client, () => updateInstitutionPolicy(client, domainFixture.adminId, domainFixture.universityId, {
            domains: [], emailEvidenceValidityDays: 90, enrollmentValidityDays: 30,
            registrationNormalization: null, isActive: true,
        }));
        await inTransaction(client, () => updateInstitutionPolicy(client, domainFixture.adminId, domainFixture.universityId, {
            domains: ['students.school.example'], emailEvidenceValidityDays: 90, enrollmentValidityDays: 30,
            registrationNormalization: null, isActive: true,
        }));
        assert.deepEqual(
            await inTransaction(client, () => getEffectiveEligibility(client, domainFixture.userId)),
            { eligible: false, reason: 'policy_changed' },
        );

        const caseOnlyFixture = await createFixture(client);
        await client.query(`UPDATE users SET email = upper(email) WHERE id = $1`, [caseOnlyFixture.userId]);
        assert.equal(
            (await inTransaction(client, () => getEffectiveEligibility(client, caseOnlyFixture.userId))).eligible,
            true,
        );
    });
});

test('serializes profile and email mutations behind a live eligibility read', async () => {
    await withTestClient(async (client) => {
        for (const mutation of [
            {
                label: 'profile',
                query: (fixture: Fixture) => ({
                    text: `UPDATE students SET name = name || ' concurrent' WHERE id = $1`,
                    values: [fixture.studentId],
                }),
            },
            {
                label: 'email',
                query: (fixture: Fixture) => ({
                    text: `UPDATE users SET email = $2 WHERE id = $1`,
                    values: [fixture.userId, `concurrent-${uniqueLabel()}@students.school.example`],
                }),
            },
        ]) {
            const fixture = await createFixture(client);
            const pool = createTestPool();
            const reader = await pool.connect();
            const mutator = await pool.connect();
            try {
                await beginWithLockTimeout(reader);
                assert.equal((await getEffectiveEligibility(reader, fixture.userId)).eligible, true);
                await beginWithLockTimeout(mutator);
                const blockedPid = await clientPid(mutator);
                const blockerPid = await clientPid(reader);
                const statement = mutation.query(fixture);
                const update = mutator.query(statement.text, statement.values);
                await waitForBlockedBy(client, blockedPid, blockerPid, `${mutation.label} mutation`);
                await reader.query('COMMIT');
                await update;
                await mutator.query('COMMIT');
                assert.deepEqual(
                    await inTransaction(client, () => getEffectiveEligibility(client, fixture.userId)),
                    { eligible: false, reason: 'identity_changed' },
                );
            } finally {
                await reader.query('ROLLBACK').catch(() => undefined);
                await mutator.query('ROLLBACK').catch(() => undefined);
                reader.release();
                mutator.release();
                await pool.end();
            }
        }
    });
});

test('serializes institution policy mutation behind an application and invalidates its old evidence', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        const snapshot = await begin(client, fixture);
        const pool = createTestPool();
        const application = await pool.connect();
        const mutator = await pool.connect();
        try {
            await beginWithLockTimeout(application);
            assert.equal((await applyEnrollmentDecision(application, snapshot, { outcome: 'unknown' })).eligible, true);
            await beginWithLockTimeout(mutator);
            const blockedPid = await clientPid(mutator);
            const blockerPid = await clientPid(application);
            const update = mutator.query(
                `UPDATE universities SET email_evidence_validity_days = 89 WHERE id = $1`,
                [fixture.universityId],
            );
            await waitForBlockedBy(client, blockedPid, blockerPid, 'policy mutation');
            await application.query('COMMIT');
            await update;
            await mutator.query('COMMIT');
            assert.deepEqual(
                await inTransaction(client, () => getEffectiveEligibility(client, fixture.userId)),
                { eligible: false, reason: 'policy_changed' },
            );
        } finally {
            await application.query('ROLLBACK').catch(() => undefined);
            await mutator.query('ROLLBACK').catch(() => undefined);
            application.release();
            mutator.release();
            await pool.end();
        }
    });
});

test('lets exactly one concurrent student profile and normalized email claim commit', async () => {
    await withTestClient(async (client) => {
        const universityId = (await client.query<{ id: string }>(
            `INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id`,
            [`Concurrency ${uniqueLabel()}`],
        )).rows[0]!.id;
        const profileUser = (await client.query<{ id: string }>(
            `INSERT INTO users (email, role) VALUES ($1, 'student') RETURNING id`,
            [`profile-${uniqueLabel()}@students.school.example`],
        )).rows[0]!.id;
        const pool = createTestPool();
        const first = await pool.connect();
        const second = await pool.connect();
        try {
            await beginWithLockTimeout(first);
            await first.query(
                `INSERT INTO students (user_id, name, university_id) VALUES ($1, 'One', $2)`,
                [profileUser, universityId],
            );
            await beginWithLockTimeout(second);
            const blockedPid = await clientPid(second);
            const blockerPid = await clientPid(first);
            const duplicateProfile = second.query(
                `INSERT INTO students (user_id, name, university_id) VALUES ($1, 'Two', $2)`,
                [profileUser, universityId],
            );
            await waitForBlockedBy(client, blockedPid, blockerPid, 'duplicate student profile');
            await first.query('COMMIT');
            await assert.rejects(duplicateProfile, /students_user_unique|duplicate key/i);
            await second.query('ROLLBACK');
        } finally {
            await first.query('ROLLBACK').catch(() => undefined);
            await second.query('ROLLBACK').catch(() => undefined);
            first.release();
            second.release();
        }
        const profiles = await client.query(
            `SELECT 1 FROM students WHERE user_id = $1`,
            [profileUser],
        );
        assert.equal(profiles.rowCount, 1);

        const emailFirst = await pool.connect();
        const emailSecond = await pool.connect();
        try {
            const localPart = `normal-${uniqueLabel()}`;
            await beginWithLockTimeout(emailFirst);
            await emailFirst.query(
                `INSERT INTO users (email, role) VALUES ($1, 'student')`,
                [`${localPart}@students.school.example`],
            );
            await beginWithLockTimeout(emailSecond);
            const blockedPid = await clientPid(emailSecond);
            const blockerPid = await clientPid(emailFirst);
            const duplicateEmail = emailSecond.query(
                `INSERT INTO users (email, role) VALUES ($1, 'student')`,
                [`${localPart.toUpperCase()}@STUDENTS.SCHOOL.EXAMPLE`],
            );
            await waitForBlockedBy(client, blockedPid, blockerPid, 'duplicate normalized email');
            await emailFirst.query('COMMIT');
            await assert.rejects(duplicateEmail, /users_normalized_email_unique|duplicate key/i);
            await emailSecond.query('ROLLBACK');
            const emails = await client.query(
                `SELECT 1 FROM users WHERE lower(btrim(email)) = $1`,
                [`${localPart}@students.school.example`],
            );
            assert.equal(emails.rowCount, 1);
        } finally {
            await emailFirst.query('ROLLBACK').catch(() => undefined);
            await emailSecond.query('ROLLBACK').catch(() => undefined);
            emailFirst.release();
            emailSecond.release();
            await pool.end();
        }
    });
});

test('new-account signup consumes proof and creates matching null and matric-bound assurance atomically', async () => {
    await withTestClient(async (client) => {
        const seed = await createFixture(client);
        const noMatricClaim = await signupClaim(client, seed.universityId);
        const noMatric = await completeNewSignup(client, noMatricClaim);
        const valueClaim = await signupClaim(client, seed.universityId, { matricNumber: 'SELF-DECLARED-42' });
        const withMatric = await completeNewSignup(client, valueClaim);
        assert.equal((await inTransaction(client, () => getEffectiveEligibility(client, noMatric.userId))).eligible, true);
        assert.equal((await inTransaction(client, () => getEffectiveEligibility(client, withMatric.userId))).eligible, true);
        const profiles = await client.query<{ registration_number: string | null }>(
            `SELECT registration_number FROM students WHERE id = ANY($1::uuid[]) ORDER BY id`,
            [[noMatric.studentId, withMatric.studentId]],
        );
        assert.deepEqual(profiles.rows.map((row) => row.registration_number).sort(), ['SELF-DECLARED-42', null]);
        const reservation = await client.query(
            `SELECT 1 FROM verified_registration_identities
             WHERE university_id = $1 AND identifier = 'SELF-DECLARED-42'`,
            [seed.universityId],
        );
        assert.equal(reservation.rowCount, 0);
    });
});

test('rejects changed signup email, name, institution, matric, notice, and policy bindings', async () => {
    await withTestClient(async (client) => {
        const seed = await createFixture(client);
        const alternateUniversity = (await client.query<{ id: string }>(
            `INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id`,
            [`Signup alternate ${uniqueLabel()}`],
        )).rows[0]!.id;
        const rejectCreatedMismatch = async (
            label: string,
            created: Partial<Pick<SignupClaim, 'email' | 'name' | 'universityId' | 'matricNumber'>>,
            claimOverrides: Partial<SignupClaim> = {},
        ): Promise<void> => {
            const claim = await signupClaim(client, seed.universityId, {
                matricNumber: 'BOUND-MATRIC',
                ...claimOverrides,
            });
            await assert.rejects(
                completeNewSignup(client, claim, created),
                /stale challenge bindings/i,
                label,
            );
            const users = await client.query(
                `SELECT 1 FROM users WHERE email IN ($1, $2)`,
                [claim.email, created.email ?? claim.email],
            );
            assert.equal(users.rowCount, 0, `${label} leaves no created account`);
        };
        await rejectCreatedMismatch('email', { email: `different-${uniqueLabel()}@students.school.example` });
        await rejectCreatedMismatch('name', { name: 'Different signup name' });
        await rejectCreatedMismatch('institution', { universityId: alternateUniversity });
        await rejectCreatedMismatch('matric replacement', { matricNumber: 'REPLACED-MATRIC' });
        await rejectCreatedMismatch('matric omission', { matricNumber: null });
        await rejectCreatedMismatch('notice', {}, { noticeVersion: 'obsolete.v1' });

        const stalePolicyClaim = await signupClaim(client, seed.universityId, { matricNumber: 'POLICY-MATRIC' });
        await inTransaction(client, () => updateInstitutionPolicy(client, seed.adminId, seed.universityId, {
            domains: ['students.school.example'], emailEvidenceValidityDays: 89, enrollmentValidityDays: 30,
            registrationNormalization: null, isActive: true,
        }));
        await assert.rejects(
            completeNewSignup(client, stalePolicyClaim),
            /stale challenge bindings/i,
        );
    });
});

async function waitForOtherClientLock(client: PoolClient): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
        const result = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM pg_stat_activity
             WHERE datname = current_database()
               AND pid <> pg_backend_pid()
               AND wait_event_type = 'Lock'`,
        );
        if (Number(result.rows[0]?.count) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Expected competing PostgreSQL client to wait on a lock');
}

test('observes real client contention and admits only one application of a provider generation', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        const snapshot = await begin(client, fixture);
        const pool = createTestPool();
        const first = await pool.connect();
        const second = await pool.connect();
        try {
            await first.query('BEGIN');
            assert.equal((await applyEnrollmentDecision(first, snapshot, { outcome: 'unknown' })).eligible, true);
            await second.query('BEGIN');
            const blocked = applyEnrollmentDecision(second, snapshot, { outcome: 'unknown' });
            await waitForOtherClientLock(client);
            await first.query('COMMIT');
            await assert.rejects(blocked, /generation/i);
            await second.query('ROLLBACK');
        } finally {
            await first.query('ROLLBACK').catch(() => undefined);
            await second.query('ROLLBACK').catch(() => undefined);
            first.release();
            second.release();
            await pool.end();
        }
    });
});

test('rolls back proof consumption and provider markers, evidence, and reservations together', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        const before = await state(client, fixture);
        const beforeEvidence = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM eligibility_evidence WHERE student_id = $1`,
            [fixture.studentId],
        );
        const beforeProofs = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM user_email_proofs WHERE user_id = $1`,
            [fixture.userId],
        );
        await client.query(
            `UPDATE verification_challenge_budgets
             SET resend_available_at = clock_timestamp() - interval '1 second'
             WHERE purpose = 'student_email'`,
        );
        const issued = await inTransaction(client, async () => {
            const context = await lockExistingStudentForChallenge(client, fixture.userId, fixture.grantId);
            return requestChallenge(client, {
                purpose: 'student_email', subjectKey: fixture.userId,
                bindings: { ...context, processingGrantId: fixture.grantId, noticeVersion: VERIFICATION_NOTICE_VERSION },
            });
        });
        assert.equal(issued.status, 'issued');
        if (issued.status !== 'issued') throw new Error('Rollback challenge was not issued');
        await client.query('BEGIN');
        try {
            await lockExistingStudentForChallenge(client, fixture.userId, fixture.grantId);
            await consumeChallenge(client, {
                purpose: 'student_email', subjectKey: fixture.userId, challengeId: issued.challengeId, code: issued.code,
            });
            await recordEmailAssurance(client, fixture.userId, {
                challengeId: issued.challengeId, processingGrantId: fixture.grantId,
            });
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
        await client.query('ROLLBACK');
        const challenge = await client.query<{ consumed_at: Date | null }>(
            `SELECT consumed_at FROM verification_challenges WHERE id = $1`,
            [issued.challengeId],
        );
        assert.equal(challenge.rows[0]!.consumed_at, null);
        const proof = await client.query(`SELECT 1 FROM user_email_proofs WHERE challenge_id = $1`, [issued.challengeId]);
        assert.equal(proof.rowCount, 0);

        const snapshot = await begin(client, fixture);
        await client.query('BEGIN');
        await applyEnrollmentDecision(client, snapshot, verifiedDecision(fixture.email, 'rollback-reg'));
        await client.query('ROLLBACK');
        const after = await state(client, fixture);
        assert.equal(after.provider_applied_generation, 0);
        assert.equal(after.provider_request_generation, snapshot.requestGeneration);
        assert.equal(after.current_evidence_id, before.current_evidence_id);
        const afterEvidence = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM eligibility_evidence WHERE student_id = $1`,
            [fixture.studentId],
        );
        const afterProofs = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM user_email_proofs WHERE user_id = $1`,
            [fixture.userId],
        );
        assert.equal(afterEvidence.rows[0]!.count, beforeEvidence.rows[0]!.count);
        assert.equal(afterProofs.rows[0]!.count, beforeProofs.rows[0]!.count);
        const reservation = await client.query(
            `SELECT 1 FROM verified_registration_identities WHERE university_id = $1 AND identifier = 'ROLLBACK-REG'`,
            [fixture.universityId],
        );
        assert.equal(reservation.rowCount, 0);
        assert.equal((await inTransaction(client, () => applyEnrollmentDecision(
            client,
            snapshot,
            verifiedDecision(fixture.email, 'rollback-reg'),
        ))).eligible, true);
    });
});

test('runs duplicate legacy diagnostics against isolated synthetic schemas without exposing identities', async () => {
    await withTestClient(async (client) => {
        const migration = readFileSync(
            new URL('../../database/migrations/030_eligibility_authority.sql', import.meta.url),
            'utf8',
        );
        const diagnostics = migration.split('DROP INDEX IF EXISTS')[0]!;
        const studentSchema = `eligibility_dupe_students_${uniqueLabel()}`;
        await client.query(`CREATE SCHEMA ${studentSchema}`);
        await client.query(`CREATE TABLE ${studentSchema}.users (email text)`);
        await client.query(`CREATE TABLE ${studentSchema}.students (user_id text)`);
        await client.query(`INSERT INTO ${studentSchema}.students VALUES ('same'), ('same')`);
        await client.query('BEGIN');
        await client.query(`SET LOCAL search_path TO ${studentSchema}`);
        await assert.rejects(client.query(diagnostics), /duplicate students\.user_id groups/);
        await client.query('ROLLBACK');

        const emailSchema = `eligibility_dupe_email_${uniqueLabel()}`;
        await client.query(`CREATE SCHEMA ${emailSchema}`);
        await client.query(`CREATE TABLE ${emailSchema}.users (email text)`);
        await client.query(`CREATE TABLE ${emailSchema}.students (user_id text)`);
        await client.query(`INSERT INTO ${emailSchema}.users VALUES ('Example@School.invalid'), (' example@school.invalid ')`);
        await client.query('BEGIN');
        await client.query(`SET LOCAL search_path TO ${emailSchema}`);
        await assert.rejects(client.query(diagnostics), /duplicate normalized users\.email groups/);
        await client.query('ROLLBACK');
        await client.query(`DROP SCHEMA ${studentSchema} CASCADE`);
        await client.query(`DROP SCHEMA ${emailSchema} CASCADE`);
    });
});

test('rejects policy-row reparenting and remove-add cannot resurrect fresh evidence', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true });
        const target = (await client.query<{ id: string }>(
            `INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id`,
            [`Target ${uniqueLabel()}`],
        )).rows[0]!.id;
        const domain = await client.query<{ university_id: string }>(
            `SELECT university_id FROM approved_student_email_domains
             WHERE university_id = $1 AND domain = 'students.school.example'`,
            [fixture.universityId],
        );
        assert.equal(domain.rows[0]!.university_id, fixture.universityId);
        await assert.rejects(
            client.query(
                `UPDATE approved_student_email_domains SET university_id = $2
                 WHERE university_id = $1 AND domain = 'students.school.example'`,
                [fixture.universityId, target],
            ),
            /cannot be reparented/i,
        );
        const method = await client.query<{ university_id: string }>(
            `SELECT university_id FROM university_verification_methods
             WHERE university_id = $1 AND method_type = 'registration'`,
            [fixture.universityId],
        );
        assert.equal(method.rows[0]!.university_id, fixture.universityId);
        await assert.rejects(
            client.query(
                `UPDATE university_verification_methods SET university_id = $2
                 WHERE university_id = $1 AND method_type = 'registration'`,
                [fixture.universityId, target],
            ),
            /cannot be reparented/i,
        );
        await inTransaction(client, () => updateInstitutionPolicy(client, fixture.adminId, fixture.universityId, {
            domains: [], emailEvidenceValidityDays: 90, enrollmentValidityDays: 30,
            registrationNormalization: null, isActive: true,
        }));
        await inTransaction(client, () => updateInstitutionPolicy(client, fixture.adminId, fixture.universityId, {
            domains: ['students.school.example'], emailEvidenceValidityDays: 90, enrollmentValidityDays: 30,
            registrationNormalization: null, isActive: true,
        }));
        assert.deepEqual(
            await inTransaction(client, () => getEffectiveEligibility(client, fixture.userId)),
            { eligible: false, reason: 'policy_changed' },
        );
    });
});

test('requires a live merchant owner and merchant for grants and qualified reads', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client);
        const merchant = await createMerchantFixture(client);
        const disclosure = await inTransaction(client, () => grantMerchantDisclosure(client, fixture.userId, {
            vendorId: merchant.vendorId,
            origin: merchant.origin,
            purpose: 'student-discount',
            accepted: true,
            noticeVersion: MERCHANT_DISCLOSURE_NOTICE_VERSION,
        }));
        const read = () => inTransaction(client, () => getEffectiveEligibility(client, fixture.userId, {
            vendorId: merchant.vendorId,
            grantId: disclosure,
            origin: merchant.origin,
            purpose: 'student-discount',
        }));
        const grant = () => inTransaction(client, () => grantMerchantDisclosure(client, fixture.userId, {
            vendorId: merchant.vendorId,
            origin: merchant.origin,
            purpose: 'another-purpose',
            accepted: true,
            noticeVersion: MERCHANT_DISCLOSURE_NOTICE_VERSION,
        }));
        assert.equal((await read()).eligible, true);

        await client.query(`UPDATE vendors SET status = 'suspended' WHERE id = $1`, [merchant.vendorId]);
        assert.deepEqual(await read(), { eligible: false, reason: 'consent_required' });
        await assert.rejects(grant(), /merchant/i);
        await client.query(`UPDATE vendors SET status = 'active' WHERE id = $1`, [merchant.vendorId]);

        await client.query(`UPDATE vendors SET deleted_at = clock_timestamp() WHERE id = $1`, [merchant.vendorId]);
        assert.deepEqual(await read(), { eligible: false, reason: 'consent_required' });
        await assert.rejects(grant(), /merchant/i);
        await client.query(`UPDATE vendors SET deleted_at = NULL WHERE id = $1`, [merchant.vendorId]);

        await client.query(`UPDATE users SET role = 'student' WHERE id = $1`, [merchant.ownerId]);
        assert.deepEqual(await read(), { eligible: false, reason: 'consent_required' });
        await assert.rejects(grant(), /merchant/i);
        await client.query(`UPDATE users SET role = 'vendor' WHERE id = $1`, [merchant.ownerId]);

        await client.query(`UPDATE users SET deleted_at = clock_timestamp() WHERE id = $1`, [merchant.ownerId]);
        assert.deepEqual(await read(), { eligible: false, reason: 'consent_required' });
        await assert.rejects(grant(), /merchant/i);
    });
});

test('observes merchant deactivation blocked by a disclosure grant and fails closed after commit', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client);
        const merchant = await createMerchantFixture(client);
        const pool = createTestPool();
        const disclosureClient = await pool.connect();
        const deactivator = await pool.connect();
        try {
            await beginWithLockTimeout(disclosureClient);
            const grantId = await grantMerchantDisclosure(disclosureClient, fixture.userId, {
                vendorId: merchant.vendorId,
                origin: merchant.origin,
                purpose: 'student-discount',
                accepted: true,
                noticeVersion: MERCHANT_DISCLOSURE_NOTICE_VERSION,
            });
            await beginWithLockTimeout(deactivator);
            const blockedPid = await clientPid(deactivator);
            const blockerPid = await clientPid(disclosureClient);
            const deactivate = deactivator.query(
                `UPDATE vendors SET status = 'suspended' WHERE id = $1`,
                [merchant.vendorId],
            );
            await waitForBlockedBy(client, blockedPid, blockerPid, 'merchant deactivation');
            await disclosureClient.query('COMMIT');
            await deactivate;
            await deactivator.query('COMMIT');
            assert.deepEqual(
                await inTransaction(client, () => getEffectiveEligibility(client, fixture.userId, {
                    vendorId: merchant.vendorId,
                    grantId,
                    origin: merchant.origin,
                    purpose: 'student-discount',
                })),
                { eligible: false, reason: 'consent_required' },
            );
        } finally {
            await disclosureClient.query('ROLLBACK').catch(() => undefined);
            await deactivator.query('ROLLBACK').catch(() => undefined);
            disclosureClient.release();
            deactivator.release();
            await pool.end();
        }
    });
});

test('withdrawal keeps inactive historical owners revocable across current and grant institutions', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client);
        const currentUniversity = (await client.query<{ id: string }>(
            `INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id`,
            [`Current ${uniqueLabel()}`],
        )).rows[0]!.id;
        await client.query(`UPDATE students SET university_id = $2 WHERE id = $1`, [fixture.studentId, currentUniversity]);
        await client.query(`UPDATE students SET status = 'suspended' WHERE id = $1`, [fixture.studentId]);
        await client.query(`UPDATE universities SET is_active = false WHERE id = $1`, [fixture.universityId]);
        await client.query(`UPDATE users SET deleted_at = clock_timestamp() WHERE id = $1`, [fixture.userId]);
        await inTransaction(client, () => withdrawConsent(client, fixture.userId, fixture.grantId));
        const withdrawn = await client.query<{ withdrawn_at: Date | null }>(
            `SELECT withdrawn_at FROM verification_consents WHERE id = $1`,
            [fixture.grantId],
        );
        const revoked = await client.query<{ revoked_at: Date | null }>(
            `SELECT revoked_at FROM eligibility_evidence WHERE processing_grant_id = $1`,
            [fixture.grantId],
        );
        assert.ok(withdrawn.rows[0]!.withdrawn_at);
        assert.ok(revoked.rows[0]!.revoked_at);
    });
});

test('observes withdrawal blocked by a reader and preserves final revoked authority', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client);
        const pool = createTestPool();
        const reader = await pool.connect();
        const withdrawal = await pool.connect();
        try {
            await beginWithLockTimeout(reader);
            assert.equal((await getEffectiveEligibility(reader, fixture.userId)).eligible, true);
            await beginWithLockTimeout(withdrawal);
            const blockedPid = await clientPid(withdrawal);
            const blockerPid = await clientPid(reader);
            const revoke = withdrawConsent(withdrawal, fixture.userId, fixture.grantId);
            await waitForBlockedBy(client, blockedPid, blockerPid, 'withdrawal against eligibility read');
            await reader.query('COMMIT');
            await revoke;
            await withdrawal.query('COMMIT');
            assert.deepEqual(
                await inTransaction(client, () => getEffectiveEligibility(client, fixture.userId)),
                { eligible: false, reason: 'consent_required' },
            );
        } finally {
            await reader.query('ROLLBACK').catch(() => undefined);
            await withdrawal.query('ROLLBACK').catch(() => undefined);
            reader.release();
            withdrawal.release();
            await pool.end();
        }
    });
});

test('withdrawal never holds consent ahead of a reader common-lock sequence', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client);
        const pool = createTestPool();
        const reader = await pool.connect();
        const withdrawal = await pool.connect();
        try {
            await beginWithLockTimeout(reader);
            await reader.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [fixture.userId]);
            await reader.query(`SELECT id FROM students WHERE id = $1 FOR UPDATE`, [fixture.studentId]);
            await reader.query(`SELECT id FROM universities WHERE id = $1 FOR UPDATE`, [fixture.universityId]);
            await reader.query(
                `SELECT student_id FROM student_eligibility_state
                 WHERE student_id = $1 AND university_id = $2 FOR UPDATE`,
                [fixture.studentId, fixture.universityId],
            );
            await beginWithLockTimeout(withdrawal);
            const blockedPid = await clientPid(withdrawal);
            const blockerPid = await clientPid(reader);
            const revoke = withdrawConsent(withdrawal, fixture.userId, fixture.grantId);
            await waitForBlockedBy(client, blockedPid, blockerPid, 'withdrawal common-lock acquisition');
            assert.equal((await getEffectiveEligibility(reader, fixture.userId)).eligible, true);
            await reader.query('COMMIT');
            await revoke;
            await withdrawal.query('COMMIT');
            assert.deepEqual(
                await inTransaction(client, () => getEffectiveEligibility(client, fixture.userId)),
                { eligible: false, reason: 'consent_required' },
            );
        } finally {
            await reader.query('ROLLBACK').catch(() => undefined);
            await withdrawal.query('ROLLBACK').catch(() => undefined);
            reader.release();
            withdrawal.release();
            await pool.end();
        }
    });
});

test('observes withdrawal blocked by an application and revokes after the generation settles', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        const snapshot = await begin(client, fixture);
        const pool = createTestPool();
        const application = await pool.connect();
        const withdrawal = await pool.connect();
        try {
            await beginWithLockTimeout(application);
            assert.equal((await applyEnrollmentDecision(application, snapshot, { outcome: 'unknown' })).eligible, true);
            await beginWithLockTimeout(withdrawal);
            const blockedPid = await clientPid(withdrawal);
            const blockerPid = await clientPid(application);
            const revoke = withdrawConsent(withdrawal, fixture.userId, fixture.grantId);
            await waitForBlockedBy(client, blockedPid, blockerPid, 'withdrawal against enrollment application');
            await application.query('COMMIT');
            await revoke;
            await withdrawal.query('COMMIT');
            const after = await state(client, fixture);
            assert.equal(after.provider_applied_generation, snapshot.requestGeneration);
            assert.deepEqual(
                await inTransaction(client, () => getEffectiveEligibility(client, fixture.userId)),
                { eligible: false, reason: 'consent_required' },
            );
        } finally {
            await application.query('ROLLBACK').catch(() => undefined);
            await withdrawal.query('ROLLBACK').catch(() => undefined);
            application.release();
            withdrawal.release();
            await pool.end();
        }
    });
});

test('serializes method mutation behind beginEnrollmentCheck without a lock cycle', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        const pool = createTestPool();
        const beginClient = await pool.connect();
        const mutator = await pool.connect();
        try {
            await beginWithLockTimeout(beginClient);
            const snapshot = await beginEnrollmentCheck(beginClient, fixture.userId, fixture.grantId);
            await beginWithLockTimeout(mutator);
            const blockedPid = await clientPid(mutator);
            const blockerPid = await clientPid(beginClient);
            const update = mutator.query(
                `UPDATE university_verification_methods
                 SET api_endpoint = 'https://institution.example/reconfigured-begin'
                 WHERE university_id = $1 AND method_type = 'registration'`,
                [fixture.universityId],
            );
            await waitForBlockedBy(client, blockedPid, blockerPid, 'method mutation against enrollment begin');
            await beginClient.query('COMMIT');
            await update;
            await mutator.query('COMMIT');
            await assert.rejects(
                inTransaction(client, () => applyEnrollmentDecision(client, snapshot, { outcome: 'unknown' })),
                /snapshot/i,
            );
        } finally {
            await beginClient.query('ROLLBACK').catch(() => undefined);
            await mutator.query('ROLLBACK').catch(() => undefined);
            beginClient.release();
            mutator.release();
            await pool.end();
        }
    });
});

test('beginEnrollmentCheck never waits on a method lock while holding its university', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        const pool = createTestPool();
        const methodLocker = await pool.connect();
        const beginClient = await pool.connect();
        try {
            await beginWithLockTimeout(methodLocker);
            await methodLocker.query(
                `SELECT id FROM university_verification_methods
                 WHERE university_id = $1 AND method_type = 'registration' FOR UPDATE`,
                [fixture.universityId],
            );
            await beginWithLockTimeout(beginClient);
            const snapshot = await beginEnrollmentCheck(beginClient, fixture.userId, fixture.grantId);
            const blockedPid = await clientPid(methodLocker);
            const blockerPid = await clientPid(beginClient);
            const update = methodLocker.query(
                `UPDATE university_verification_methods
                 SET api_endpoint = 'https://institution.example/reconfigured-reverse'
                 WHERE university_id = $1 AND method_type = 'registration'`,
                [fixture.universityId],
            );
            await waitForBlockedBy(client, blockedPid, blockerPid, 'method writer after enrollment begin');
            await beginClient.query('COMMIT');
            await update;
            await methodLocker.query('COMMIT');
            await assert.rejects(
                inTransaction(client, () => applyEnrollmentDecision(client, snapshot, { outcome: 'unknown' })),
                /snapshot/i,
            );
        } finally {
            await methodLocker.query('ROLLBACK').catch(() => undefined);
            await beginClient.query('ROLLBACK').catch(() => undefined);
            methodLocker.release();
            beginClient.release();
            await pool.end();
        }
    });
});

test('serializes method mutation behind applyEnrollmentDecision without a lock cycle', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        const snapshot = await begin(client, fixture);
        const pool = createTestPool();
        const applyClient = await pool.connect();
        const mutator = await pool.connect();
        try {
            await beginWithLockTimeout(applyClient);
            assert.equal((await applyEnrollmentDecision(applyClient, snapshot, { outcome: 'unknown' })).eligible, true);
            await beginWithLockTimeout(mutator);
            const blockedPid = await clientPid(mutator);
            const blockerPid = await clientPid(applyClient);
            const update = mutator.query(
                `UPDATE university_verification_methods
                 SET api_endpoint = 'https://institution.example/reconfigured-apply'
                 WHERE university_id = $1 AND method_type = 'registration'`,
                [fixture.universityId],
            );
            await waitForBlockedBy(client, blockedPid, blockerPid, 'method mutation against enrollment application');
            await applyClient.query('COMMIT');
            await update;
            await mutator.query('COMMIT');
            assert.deepEqual(
                await inTransaction(client, () => getEffectiveEligibility(client, fixture.userId)),
                { eligible: false, reason: 'policy_changed' },
            );
        } finally {
            await applyClient.query('ROLLBACK').catch(() => undefined);
            await mutator.query('ROLLBACK').catch(() => undefined);
            applyClient.release();
            mutator.release();
            await pool.end();
        }
    });
});


test('checkout uses current evidence even when legacy verification flags disagree', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client);
        const controller = new CheckoutController();
        // Missing product proves authority admission without calling a provider.
        const request = { user: { userId: fixture.userId, role: 'student' },
            body: { productId: randomUUID() } } as unknown as AuthRequest;
        const response = {} as Response;
        await client.query(`UPDATE users SET verification_status = 'unverified' WHERE id = $1`, [fixture.userId]);
        await assert.rejects(controller.createCheckout(request, response), /Product not found/);
        await inTransaction(client, () => withdrawConsent(client, fixture.userId, fixture.grantId));
        await client.query(`UPDATE users SET verification_status = 'verified' WHERE id = $1`, [fixture.userId]);
        await assert.rejects(controller.createCheckout(request, response), /Current student eligibility is required/);
    });
});
