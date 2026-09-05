import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
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
import { ENROLLMENT_SOURCE, type EnrollmentSnapshot } from '../../services/verification/eligibility.types.js';
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
};

function uniqueLabel(): string {
    return randomUUID().replaceAll('-', '').slice(0, 12);
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
        `INSERT INTO students (user_id, name, university_id)
         VALUES ($1, 'Student ${label}', $2)
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
    const context = await inTransaction(client, () => lockStudentContext(client, userId));
    const issued = await inTransaction(client, () => requestChallenge(client, {
        purpose: 'student_email',
        subjectKey: userId,
        bindings: {
            ...context,
            processingGrantId: grantId,
            noticeVersion: VERIFICATION_NOTICE_VERSION,
        },
    }));
    assert.equal(issued.status, 'issued');
    if (issued.status !== 'issued') throw new Error('Fixture challenge was not issued');
    await inTransaction(client, async () => {
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
    const context = await inTransaction(client, () => lockStudentContext(client, fixture.userId));
    const issued = await inTransaction(client, () => requestChallenge(client, {
        purpose: 'student_email',
        subjectKey: fixture.userId,
        bindings: {
            ...context,
            processingGrantId: fixture.grantId,
            noticeVersion: VERIFICATION_NOTICE_VERSION,
        },
    }));
    assert.equal(issued.status, 'issued');
    if (issued.status !== 'issued') throw new Error('Retry challenge was not issued');
    await inTransaction(client, async () => {
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
        validUntil: new Date(Date.now() + 60_000),
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

test('accepts only matching immutable signup bindings when issuing signup email assurance', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client);
        const profile = await client.query<{ name: string }>(
            `SELECT name FROM students WHERE id = $1`,
            [fixture.studentId],
        );
        const context = await inTransaction(client, () => lockStudentContext(client, fixture.userId));
        const issued = await inTransaction(client, () => requestChallenge(client, {
            purpose: 'student_signup',
            subjectKey: fixture.email,
            bindings: {
                email: fixture.email,
                name: profile.rows[0]!.name,
                universityId: fixture.universityId,
                matricNumber: null,
                policyVersion: context.policyVersion,
                verificationConsent: true,
                noticeVersion: VERIFICATION_NOTICE_VERSION,
            },
        }));
        assert.equal(issued.status, 'issued');
        if (issued.status !== 'issued') throw new Error('Signup challenge was not issued');
        assert.equal((await inTransaction(client, async () => {
            const consumed = await consumeChallenge(client, {
                purpose: 'student_signup', subjectKey: fixture.email,
                challengeId: issued.challengeId, code: issued.code,
            });
            assert.equal(consumed.status, 'verified');
            return recordEmailAssurance(client, fixture.userId, {
                challengeId: issued.challengeId,
                processingGrantId: fixture.grantId,
            });
        })).eligible, true);
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

        const sameUniversityUser = (await client.query<{ id: string }>(
            `INSERT INTO users (email, role) VALUES ($1, 'student') RETURNING id`,
            [`same-${uniqueLabel()}@students.school.example`],
        )).rows[0]!.id;
        const sameUniversityStudent = (await client.query<{ id: string }>(
            `INSERT INTO students (user_id, name, university_id) VALUES ($1, 'Same University', $2) RETURNING id`,
            [sameUniversityUser, first.universityId],
        )).rows[0]!.id;
        const sameGrant = await inTransaction(client, () => grantVerificationProcessing(
            client, sameUniversityUser, first.universityId,
            { accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION },
        ));
        const sameContext = await inTransaction(client, () => lockStudentContext(client, sameUniversityUser));
        const issue = await inTransaction(client, () => requestChallenge(client, {
            purpose: 'student_email', subjectKey: sameUniversityUser,
            bindings: { ...sameContext, processingGrantId: sameGrant, noticeVersion: VERIFICATION_NOTICE_VERSION },
        }));
        assert.equal(issue.status, 'issued');
        if (issue.status !== 'issued') throw new Error('Same-institution challenge was not issued');
        await inTransaction(client, async () => {
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
                verifiedDecision(sameContext.email, 'shared-reg'),
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

test('uses database time for finite enrollment expiry', async () => {
    await withTestClient(async (client) => {
        const fixture = await createFixture(client, { enrollment: true, normalization: 'trim_upper' });
        const snapshot = await begin(client, fixture);
        const decision = verifiedDecision(fixture.email, 'expires-soon');
        decision.validUntil = new Date(Date.now() + 20);
        await inTransaction(client, () => applyEnrollmentDecision(client, snapshot, decision));
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.deepEqual(
            await inTransaction(client, () => getEffectiveEligibility(client, fixture.userId)),
            { eligible: false, reason: 'expired' },
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
        await client.query(
            `UPDATE verification_challenge_budgets
             SET resend_available_at = clock_timestamp() - interval '1 second'
             WHERE purpose = 'student_email'`,
        );
        const context = await inTransaction(client, () => lockStudentContext(client, fixture.userId));
        const issued = await inTransaction(client, () => requestChallenge(client, {
            purpose: 'student_email', subjectKey: fixture.userId,
            bindings: { ...context, processingGrantId: fixture.grantId, noticeVersion: VERIFICATION_NOTICE_VERSION },
        }));
        assert.equal(issued.status, 'issued');
        if (issued.status !== 'issued') throw new Error('Rollback challenge was not issued');
        await client.query('BEGIN');
        await consumeChallenge(client, {
            purpose: 'student_email', subjectKey: fixture.userId, challengeId: issued.challengeId, code: issued.code,
        });
        await recordEmailAssurance(client, fixture.userId, {
            challengeId: issued.challengeId, processingGrantId: fixture.grantId,
        });
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
