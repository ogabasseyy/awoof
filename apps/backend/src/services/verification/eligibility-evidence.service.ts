import type { PoolClient } from 'pg';
import { BadRequestError, ConflictError, NotFoundError } from '../../common/errors/AppError.js';
import { challengeSubjectDigest } from './challenge.service.js';
import { lockStudentContext } from './eligibility-context.service.js';
import { getEffectiveEligibility } from './eligibility-read.service.js';
import { normalizeMailbox } from './eligibility-policy.service.js';
import {
    ENROLLMENT_SOURCE,
    type EligibilityResult,
    type EnrollmentDecision,
    type EnrollmentSnapshot,
    type SignupChallengeBindings,
    type StudentContext,
    type StudentEmailChallengeBindings,
} from './eligibility.types.js';
import { VERIFICATION_NOTICE_VERSION } from './verification-notices.js';

type ChallengeRow = {
    id: string;
    purpose: string;
    subject_digest: string;
    bindings: unknown;
    consumed_at: Date | null;
    expires_at: Date;
    superseded_at: Date | null;
};

type StateRow = {
    provider_request_generation: number;
    provider_applied_generation: number;
    authoritative_denial: boolean;
};

type MailboxUser = {
    id: string;
    email: string;
    deleted_at: Date | null;
};

type StudentProfile = {
    id: string;
    name: string;
    university_id: string | null;
    identity_version: number;
    verification_policy_version: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameStudentEmailBindings(value: unknown, context: StudentContext, grantId: string): boolean {
    if (!isRecord(value)) return false;
    const bindings = value as StudentEmailChallengeBindings;
    return bindings.userId === context.userId
        && bindings.studentId === context.studentId
        && bindings.email === context.email
        && bindings.universityId === context.universityId
        && bindings.identityVersion === context.identityVersion
        && bindings.policyVersion === context.policyVersion
        && bindings.processingGrantId === grantId
        && bindings.noticeVersion === VERIFICATION_NOTICE_VERSION;
}

function sameSignupBindings(
    value: unknown,
    user: MailboxUser,
    profile: StudentProfile,
): boolean {
    if (!isRecord(value) || !profile.university_id || profile.verification_policy_version === null) return false;
    const bindings = value as SignupChallengeBindings;
    return bindings.email === user.email
        && bindings.name === profile.name
        && bindings.universityId === profile.university_id
        && bindings.policyVersion === profile.verification_policy_version
        && bindings.verificationConsent === true
        && bindings.noticeVersion === VERIFICATION_NOTICE_VERSION;
}

function assertActiveContext(context: StudentContext): void {
    if (!context.active) throw new BadRequestError('Active student context required');
}

async function databaseNow(tx: PoolClient): Promise<Date> {
    const result = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const now = result.rows[0]?.now;
    if (!now) throw new Error('Database clock was not returned');
    return now;
}

async function lockMailboxUser(tx: PoolClient, userId: string): Promise<MailboxUser> {
    const result = await tx.query<MailboxUser>(
        `SELECT id, lower(btrim(email)) AS email, deleted_at
         FROM users
         WHERE id = $1
         FOR UPDATE`,
        [userId],
    );
    const user = result.rows[0];
    if (!user) throw new NotFoundError('Account not found');
    if (user.deleted_at !== null) throw new BadRequestError('Non-deleted account required');
    return user;
}

async function lockStudentProfile(tx: PoolClient, userId: string): Promise<StudentProfile> {
    const result = await tx.query<StudentProfile>(
        `SELECT students.id, students.name, students.university_id, students.identity_version,
                universities.verification_policy_version
         FROM students
         JOIN universities ON universities.id = students.university_id
         WHERE students.user_id = $1
         FOR UPDATE OF students, universities`,
        [userId],
    );
    const profile = result.rows[0];
    if (!profile) throw new BadRequestError('Student profile required for this mailbox proof');
    return profile;
}

async function lockChallenge(tx: PoolClient, challengeId: string): Promise<ChallengeRow> {
    const result = await tx.query<ChallengeRow>(
        `SELECT id, purpose, subject_digest, bindings, consumed_at, expires_at, superseded_at
         FROM verification_challenges
         WHERE id = $1
         FOR UPDATE`,
        [challengeId],
    );
    const challenge = result.rows[0];
    if (!challenge) throw new BadRequestError('Challenge not found');
    const now = await databaseNow(tx);
    if (challenge.consumed_at === null || challenge.superseded_at !== null || challenge.expires_at <= now) {
        throw new BadRequestError('Unexpired consumed challenge required');
    }
    return challenge;
}

async function challengePurpose(tx: PoolClient, challengeId: string): Promise<string> {
    const result = await tx.query<{ purpose: string }>(
        'SELECT purpose FROM verification_challenges WHERE id = $1',
        [challengeId],
    );
    const purpose = result.rows[0]?.purpose;
    if (!purpose) throw new BadRequestError('Challenge not found');
    return purpose;
}

async function lockState(tx: PoolClient, context: StudentContext): Promise<StateRow> {
    await tx.query(
        `INSERT INTO student_eligibility_state (student_id, university_id)
         VALUES ($1, $2)
         ON CONFLICT (student_id, university_id) DO NOTHING`,
        [context.studentId, context.universityId],
    );
    const result = await tx.query<StateRow>(
        `SELECT provider_request_generation, provider_applied_generation, authoritative_denial
         FROM student_eligibility_state
         WHERE student_id = $1 AND university_id = $2
         FOR UPDATE`,
        [context.studentId, context.universityId],
    );
    const state = result.rows[0];
    if (!state) throw new Error('Eligibility state was not returned');
    return state;
}

async function lockCurrentProcessingGrant(
    tx: PoolClient,
    userId: string,
    universityId: string,
    grantId: string,
): Promise<void> {
    const result = await tx.query(
        `SELECT 1
         FROM verification_consents
         WHERE id = $1
           AND user_id = $2
           AND university_id = $3
           AND kind = 'processing'
           AND accepted
           AND notice_version = $4
           AND withdrawn_at IS NULL
         FOR UPDATE`,
        [grantId, userId, universityId, VERIFICATION_NOTICE_VERSION],
    );
    if (result.rowCount !== 1) throw new BadRequestError('Current processing consent required');
}

async function recordLockedMailboxProof(
    tx: PoolClient,
    user: MailboxUser,
    challenge: ChallengeRow,
): Promise<string> {
    const existing = await tx.query<{ id: string; user_id: string; email: string }>(
        `SELECT id, user_id, email
         FROM user_email_proofs
         WHERE challenge_id = $1
         FOR UPDATE`,
        [challenge.id],
    );
    const proof = existing.rows[0];
    if (proof) {
        if (proof.user_id !== user.id || proof.email !== user.email) {
            throw new ConflictError('Challenge mailbox proof belongs to another account');
        }
        return proof.id;
    }
    const inserted = await tx.query<{ id: string }>(
        `INSERT INTO user_email_proofs (user_id, email, challenge_id)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [user.id, user.email, challenge.id],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error('Mailbox proof was not returned');
    return id;
}

export async function recordMailboxProof(tx: PoolClient, userId: string, challengeId: string): Promise<string> {
    const user = await lockMailboxUser(tx, userId);
    const purpose = await challengePurpose(tx, challengeId);
    const studentContext = purpose === 'student_email' ? await lockStudentContext(tx, userId) : undefined;
    const signupProfile = purpose === 'student_signup' ? await lockStudentProfile(tx, userId) : undefined;
    const challenge = await lockChallenge(tx, challengeId);
    if (challenge.purpose !== purpose) throw new ConflictError('Challenge purpose changed');

    if (challenge.purpose === 'account_email') {
        if (!isRecord(challenge.bindings)
            || challenge.bindings.userId !== user.id
            || challenge.bindings.email !== user.email
            || challenge.subject_digest !== challengeSubjectDigest('account_email', user.id)) {
            throw new BadRequestError('Account-email challenge bindings do not match');
        }
    } else if (challenge.purpose === 'student_email') {
        const bindings = challenge.bindings;
        if (!isRecord(bindings)
            || !studentContext
            || !sameStudentEmailBindings(bindings, studentContext, String(bindings.processingGrantId))
            || challenge.subject_digest !== challengeSubjectDigest('student_email', user.id)) {
            throw new BadRequestError('Student-email challenge bindings do not match');
        }
    } else if (challenge.purpose === 'student_signup') {
        if (!signupProfile
            || !sameSignupBindings(challenge.bindings, user, signupProfile)
            || challenge.subject_digest !== challengeSubjectDigest('student_signup', user.email)) {
            throw new BadRequestError('Signup challenge bindings do not match');
        }
    } else {
        throw new BadRequestError('Mailbox challenge purpose required');
    }
    return recordLockedMailboxProof(tx, user, challenge);
}

function validFutureDate(value: unknown, now: Date): value is Date {
    return value instanceof Date && Number.isFinite(value.getTime()) && value > now;
}

function normalizedRegistration(value: string, policy: 'exact' | 'trim_upper' | null): string {
    if (policy === null) throw new BadRequestError('Registration normalization unavailable');
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new BadRequestError('Enrollment registration identifier required');
    }
    return policy === 'trim_upper' ? value.trim().toUpperCase() : value;
}

export async function recordEmailAssurance(
    tx: PoolClient,
    userId: string,
    input: { challengeId: string; processingGrantId: string },
): Promise<EligibilityResult> {
    const context = await lockStudentContext(tx, userId);
    assertActiveContext(context);
    const state = await lockState(tx, context);
    await lockCurrentProcessingGrant(tx, userId, context.universityId, input.processingGrantId);
    const challenge = await lockChallenge(tx, input.challengeId);
    const user = await lockMailboxUser(tx, userId);

    let bindingsMatch = false;
    if (challenge.purpose === 'student_email') {
        bindingsMatch = sameStudentEmailBindings(challenge.bindings, context, input.processingGrantId)
            && challenge.subject_digest === challengeSubjectDigest('student_email', userId);
    } else if (challenge.purpose === 'student_signup') {
        const profile = await lockStudentProfile(tx, userId);
        bindingsMatch = sameSignupBindings(challenge.bindings, user, profile)
            && challenge.subject_digest === challengeSubjectDigest('student_signup', context.email);
    }
    if (!bindingsMatch) throw new BadRequestError('Stale challenge bindings');

    const boundEvidence = await tx.query('SELECT 1 FROM eligibility_evidence WHERE challenge_id = $1', [challenge.id]);
    if (boundEvidence.rowCount !== 0) throw new ConflictError('Challenge already issued eligibility evidence');
    const proof = await recordLockedMailboxProof(tx, user, challenge);
    const policy = await tx.query<{ email_evidence_validity_days: number }>(
        `SELECT email_evidence_validity_days
         FROM universities
         WHERE id = $1 AND is_active`,
        [context.universityId],
    );
    const validityDays = policy.rows[0]?.email_evidence_validity_days;
    if (!validityDays) throw new BadRequestError('Active institution policy required');
    const mailboxApproved = await tx.query(
        `SELECT 1
         FROM approved_student_email_domains
         WHERE university_id = $1
           AND domain = split_part($2, '@', 2)
           AND is_active`,
        [context.universityId, context.email],
    );
    if (mailboxApproved.rowCount !== 1) throw new BadRequestError('Mailbox domain is not approved');

    const evidence = await tx.query<{ id: string; verified_at: Date; expires_at: Date }>(
        `INSERT INTO eligibility_evidence
             (student_id, university_id, email_proof_id, processing_grant_id, challenge_id,
              method, outcome, identity_version, policy_version, verified_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'student_email', 'verified', $6, $7,
                 clock_timestamp(), clock_timestamp() + ($8 * interval '1 day'))
         RETURNING id, verified_at, expires_at`,
        [
            context.studentId,
            context.universityId,
            proof,
            input.processingGrantId,
            challenge.id,
            context.identityVersion,
            context.policyVersion,
            validityDays,
        ],
    );
    const created = evidence.rows[0];
    if (!created) throw new Error('Eligibility evidence was not returned');
    if (state.authoritative_denial) {
        return { eligible: false, reason: 'enrollment_denied' };
    }
    await tx.query(
        `UPDATE student_eligibility_state
         SET current_evidence_id = $3
         WHERE student_id = $1 AND university_id = $2`,
        [context.studentId, context.universityId, created.id],
    );
    await tx.query(
        `INSERT INTO verification_audit_events (user_id, university_id, event_type, metadata)
         VALUES ($1, $2, 'student_email_assurance_recorded', jsonb_build_object('evidenceId', $3::text))`,
        [userId, context.universityId, created.id],
    );
    return {
        eligible: true,
        studentId: context.studentId,
        universityId: context.universityId,
        evidenceId: created.id,
        processingGrantId: input.processingGrantId,
        method: 'student_email',
        verifiedAt: created.verified_at,
        expiresAt: created.expires_at,
    };
}

export async function beginEnrollmentCheck(
    tx: PoolClient,
    userId: string,
    processingGrantId: string,
): Promise<EnrollmentSnapshot> {
    const context = await lockStudentContext(tx, userId);
    assertActiveContext(context);
    await lockState(tx, context);
    await lockCurrentProcessingGrant(tx, userId, context.universityId, processingGrantId);
    const proof = await tx.query<{ id: string }>(
        `SELECT id
         FROM user_email_proofs
         WHERE user_id = $1 AND email = $2
         ORDER BY proven_at DESC
         LIMIT 1
         FOR UPDATE`,
        [userId, context.email],
    );
    const emailProofId = proof.rows[0]?.id;
    if (!emailProofId) throw new BadRequestError('Current mailbox proof required');
    const adapter = await tx.query(
        `SELECT 1
         FROM university_verification_methods
         WHERE university_id = $1
           AND method_type = 'registration'
           AND is_active
           AND api_endpoint IS NOT NULL
           AND length(btrim(api_endpoint)) > 0
         FOR UPDATE`,
        [context.universityId],
    );
    if (adapter.rowCount !== 1) throw new BadRequestError('Enrollment method unavailable');
    const next = await tx.query<{ provider_request_generation: number }>(
        `UPDATE student_eligibility_state
         SET provider_request_generation = provider_request_generation + 1
         WHERE student_id = $1 AND university_id = $2
         RETURNING provider_request_generation`,
        [context.studentId, context.universityId],
    );
    const requestGeneration = next.rows[0]?.provider_request_generation;
    if (requestGeneration === undefined) throw new Error('Enrollment request generation was not returned');
    return { ...context, requestGeneration, processingGrantId, emailProofId };
}

export async function applyEnrollmentDecision(
    tx: PoolClient,
    snapshot: EnrollmentSnapshot,
    decision: EnrollmentDecision,
): Promise<EligibilityResult> {
    const context = await lockStudentContext(tx, snapshot.userId);
    assertActiveContext(context);
    if (context.universityId !== snapshot.universityId
        || context.email !== snapshot.email
        || context.identityVersion !== snapshot.identityVersion
        || context.policyVersion !== snapshot.policyVersion) {
        throw new ConflictError('Enrollment snapshot is stale');
    }
    const state = await lockState(tx, context);
    if (state.provider_request_generation !== snapshot.requestGeneration
        || state.provider_applied_generation >= snapshot.requestGeneration) {
        throw new ConflictError('Enrollment generation already applied or stale');
    }
    await lockCurrentProcessingGrant(tx, snapshot.userId, context.universityId, snapshot.processingGrantId);
    const proof = await tx.query(
        `SELECT 1
         FROM user_email_proofs
         WHERE id = $1 AND user_id = $2 AND email = $3
         FOR UPDATE`,
        [snapshot.emailProofId, snapshot.userId, context.email],
    );
    if (proof.rowCount !== 1) throw new ConflictError('Enrollment mailbox proof changed');
    const adapter = await tx.query(
        `SELECT 1
         FROM university_verification_methods
         WHERE university_id = $1
           AND method_type = 'registration'
           AND is_active
           AND api_endpoint IS NOT NULL
           AND length(btrim(api_endpoint)) > 0
         FOR UPDATE`,
        [context.universityId],
    );
    if (adapter.rowCount !== 1) throw new ConflictError('Enrollment provider configuration changed');
    if (decision.outcome !== 'unknown' && decision.outcome !== 'verified' && decision.outcome !== 'denied') {
        throw new BadRequestError('Unsupported enrollment decision outcome');
    }

    const now = await databaseNow(tx);
    let identifier: string | undefined;
    let validUntil: Date | undefined;
    let enrollmentValidityDays: number | undefined;
    if (decision.outcome !== 'unknown') {
        if (decision.source !== ENROLLMENT_SOURCE || normalizeMailbox(decision.email) !== context.email) {
            throw new BadRequestError('Enrollment decision is not mailbox-attested');
        }
        if (decision.outcome === 'verified') {
            if (!validFutureDate(decision.validUntil, now)) {
                throw new BadRequestError('Enrollment decision deadline must be a finite future date');
            }
            const policy = await tx.query<{
                enrollment_validity_days: number;
                registration_normalization: 'exact' | 'trim_upper' | null;
            }>(
                `SELECT enrollment_validity_days, registration_normalization
                 FROM universities
                 WHERE id = $1`,
                [context.universityId],
            );
            const currentPolicy = policy.rows[0];
            if (!currentPolicy) throw new ConflictError('Institution policy changed');
            identifier = normalizedRegistration(decision.registrationNumber, currentPolicy.registration_normalization);
            validUntil = decision.validUntil;
            enrollmentValidityDays = currentPolicy.enrollment_validity_days;
            await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
                `${context.universityId}:${identifier}`,
            ]);
            const reserved = await tx.query<{ student_id: string }>(
                `SELECT student_id
                 FROM verified_registration_identities
                 WHERE university_id = $1 AND identifier = $2 AND revoked_at IS NULL
                 FOR UPDATE`,
                [context.universityId, identifier],
            );
            if (reserved.rows[0] && reserved.rows[0].student_id !== context.studentId) {
                throw new ConflictError('Verified registration identity belongs to another student');
            }
        }
    }

    const marked = await tx.query(
        `UPDATE student_eligibility_state
         SET provider_applied_generation = $3
         WHERE student_id = $1
           AND university_id = $2
           AND provider_request_generation = $3
           AND provider_applied_generation < $3`,
        [context.studentId, context.universityId, snapshot.requestGeneration],
    );
    if (marked.rowCount !== 1) throw new ConflictError('Enrollment generation already applied or stale');
    if (decision.outcome === 'unknown') return getEffectiveEligibility(tx, snapshot.userId);

    if (decision.outcome === 'denied') {
        await tx.query(
            `INSERT INTO eligibility_evidence
                 (student_id, university_id, email_proof_id, processing_grant_id,
                  method, outcome, identity_version, policy_version, source)
             VALUES ($1, $2, $3, $4, 'enrollment', 'denied', $5, $6, $7)`,
            [
                context.studentId,
                context.universityId,
                snapshot.emailProofId,
                snapshot.processingGrantId,
                context.identityVersion,
                context.policyVersion,
                ENROLLMENT_SOURCE,
            ],
        );
        await tx.query(
            `UPDATE student_eligibility_state
             SET authoritative_denial = true, current_evidence_id = NULL
             WHERE student_id = $1 AND university_id = $2`,
            [context.studentId, context.universityId],
        );
        await tx.query(
            `INSERT INTO verification_audit_events (user_id, university_id, event_type, metadata)
             VALUES ($1, $2, 'enrollment_denied', jsonb_build_object('generation', $3::integer))`,
            [snapshot.userId, context.universityId, snapshot.requestGeneration],
        );
        return { eligible: false, reason: 'enrollment_denied' };
    }

    if (!identifier || !validUntil || enrollmentValidityDays === undefined) {
        throw new Error('Validated enrollment result missing required fields');
    }
    await tx.query(
        `INSERT INTO verified_registration_identities (university_id, identifier, student_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (university_id, identifier) WHERE revoked_at IS NULL DO NOTHING`,
        [context.universityId, identifier, context.studentId],
    );
    const evidence = await tx.query<{ id: string; verified_at: Date; expires_at: Date }>(
        `INSERT INTO eligibility_evidence
             (student_id, university_id, email_proof_id, processing_grant_id,
              method, outcome, identity_version, policy_version, source, expires_at)
         VALUES ($1, $2, $3, $4, 'enrollment', 'verified', $5, $6, $7,
                 LEAST($8, clock_timestamp() + ($9 * interval '1 day')))
         RETURNING id, verified_at, expires_at`,
        [
            context.studentId,
            context.universityId,
            snapshot.emailProofId,
            snapshot.processingGrantId,
            context.identityVersion,
            context.policyVersion,
            ENROLLMENT_SOURCE,
            validUntil,
            enrollmentValidityDays,
        ],
    );
    const created = evidence.rows[0];
    if (!created) throw new Error('Enrollment evidence was not returned');
    await tx.query(
        `UPDATE student_eligibility_state
         SET authoritative_denial = false, current_evidence_id = $3
         WHERE student_id = $1 AND university_id = $2`,
        [context.studentId, context.universityId, created.id],
    );
    await tx.query(
        `INSERT INTO verification_audit_events (user_id, university_id, event_type, metadata)
         VALUES ($1, $2, 'enrollment_verified', jsonb_build_object('generation', $3::integer, 'evidenceId', $4::text))`,
        [snapshot.userId, context.universityId, snapshot.requestGeneration, created.id],
    );
    return {
        eligible: true,
        studentId: context.studentId,
        universityId: context.universityId,
        evidenceId: created.id,
        processingGrantId: snapshot.processingGrantId,
        method: 'enrollment',
        verifiedAt: created.verified_at,
        expiresAt: created.expires_at,
    };
}
