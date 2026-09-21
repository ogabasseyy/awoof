import type { Pool, PoolClient } from 'pg';
import { config } from '../../config/env.js';
import { NotFoundError, ServiceUnavailableError } from '../../common/errors/AppError.js';
import { lockStudentContext } from './eligibility-context.service.js';
import { getEffectiveEligibility } from './eligibility-read.service.js';
import {
    ENROLLMENT_SOURCE,
    MICROSOFT_ENROLLMENT_SOURCE,
    type EligibilityResult,
    type StudentContext,
} from './eligibility.types.js';
import {
    type EnrollmentMethod,
    type SchoolAccountMethod,
    type StudentAssurance,
    type StudentAssuranceReason,
    type StudentStatus,
} from './student-assurance.types.js';
import { VERIFICATION_NOTICE_VERSION } from './verification-notices.js';

export type EnrollmentAssuranceFlags = {
    revokedOrWithdrawn: boolean;
    expiredMethod: EnrollmentMethod;
    expiredValidUntil: string | null;
    identityChanged: boolean;
    policyChanged: boolean;
    providerUnavailable: boolean;
};

export type StudentStatusProjection = {
    studentStatus: StudentStatus;
    enrollmentMethod: EnrollmentMethod;
    studentValidUntil: string | null;
    reason: StudentAssuranceReason;
};

export type SchoolAccountProjection = {
    schoolAccountStatus: StudentAssurance['schoolAccountStatus'];
    schoolAccountMethod: SchoolAccountMethod;
    schoolAccountValidUntil: string | null;
};

function enrollmentMethodFromSource(source: string | null): EnrollmentMethod {
    if (source === MICROSOFT_ENROLLMENT_SOURCE) return 'microsoft_graph';
    if (source === ENROLLMENT_SOURCE) return 'registration';
    return null;
}

function revokedProjection(): StudentStatusProjection {
    return {
        studentStatus: 'revoked',
        enrollmentMethod: null,
        studentValidUntil: null,
        reason: 'consent_withdrawn',
    };
}

function expiredProjection(flags: EnrollmentAssuranceFlags): StudentStatusProjection {
    return {
        studentStatus: 'expired',
        enrollmentMethod: flags.expiredMethod,
        studentValidUntil: flags.expiredValidUntil,
        reason: 'evidence_expired',
    };
}

function pendingProjection(reason: Exclude<StudentAssuranceReason, null>): StudentStatusProjection {
    return {
        studentStatus: 'pending',
        enrollmentMethod: null,
        studentValidUntil: null,
        reason,
    };
}

// Shared precedence table: inactive actor, authoritative denial, any fully
// valid enrollment candidate, current-subject revoked/withdrawn enrollment,
// expired enrollment, then pending with the most precise reason. A generic
// consent_required reason alone never implies revoked; revocation requires
// explicit revoked or withdrawn enrollment evidence (see readEnrollmentFlags).
export function resolveStudentStatus(
    eligibility: EligibilityResult,
    evidenceSource: string | null,
    flags: EnrollmentAssuranceFlags,
): StudentStatusProjection {
    if (eligibility.eligible) {
        return {
            studentStatus: 'verified',
            enrollmentMethod: enrollmentMethodFromSource(evidenceSource),
            studentValidUntil: eligibility.expiresAt.toISOString(),
            reason: null,
        };
    }
    switch (eligibility.reason) {
        case 'inactive':
            return {
                studentStatus: 'inactive',
                enrollmentMethod: null,
                studentValidUntil: null,
                reason: 'inactive',
            };
        case 'enrollment_denied':
            return {
                studentStatus: 'denied',
                enrollmentMethod: null,
                studentValidUntil: null,
                reason: 'enrollment_denied',
            };
        case 'identity_changed':
            return pendingProjection('identity_changed');
        case 'policy_changed':
            return pendingProjection('policy_changed');
        case 'expired':
            if (flags.revokedOrWithdrawn) return revokedProjection();
            return expiredProjection(flags);
        case 'consent_required':
        case 'unverified':
            if (flags.revokedOrWithdrawn) return revokedProjection();
            if (flags.expiredValidUntil) return expiredProjection(flags);
            if (flags.identityChanged) return pendingProjection('identity_changed');
            if (flags.policyChanged) return pendingProjection('policy_changed');
            if (flags.providerUnavailable) return pendingProjection('provider_unavailable');
            return pendingProjection('awaiting_enrollment');
    }
}

export function resolveSchoolAccount(input: {
    method: SchoolAccountMethod;
    validUntil: string | null;
    expiredValidUntil: string | null;
}): SchoolAccountProjection {
    if (input.validUntil) {
        return {
            schoolAccountStatus: 'verified',
            schoolAccountMethod: input.method,
            schoolAccountValidUntil: input.validUntil,
        };
    }
    if (input.expiredValidUntil) {
        return {
            schoolAccountStatus: 'expired',
            schoolAccountMethod: input.method,
            schoolAccountValidUntil: input.expiredValidUntil,
        };
    }
    return { schoolAccountStatus: 'unverified', schoolAccountMethod: null, schoolAccountValidUntil: null };
}

export function pendingStudentAssurance(): StudentAssurance {
    return {
        schoolAccountStatus: 'unverified',
        schoolAccountMethod: null,
        schoolAccountValidUntil: null,
        studentStatus: 'pending',
        enrollmentMethod: null,
        studentValidUntil: null,
        reason: 'awaiting_enrollment',
    };
}

type SchoolEvidenceRow = {
    valid_until: Date;
};

async function readSchoolAccount(tx: PoolClient, userId: string, context: StudentContext): Promise<SchoolAccountProjection> {
    // Release A school assurance is mailbox proof only. It requires an active
    // approved domain, matching identity/policy versions, a current
    // processing grant, and unexpired evidence. The projection caps lifetime
    // at 90 days from proof; it never extends old proof expiry.
    const params = [
        context.studentId,
        context.universityId,
        context.identityVersion,
        context.policyVersion,
        context.email,
        userId,
        VERIFICATION_NOTICE_VERSION,
    ];
    const valid = await tx.query<SchoolEvidenceRow>(
        `SELECT LEAST(evidence.expires_at, evidence.verified_at + interval '90 days') AS valid_until
         FROM eligibility_evidence evidence
         JOIN user_email_proofs proofs ON proofs.id = evidence.email_proof_id
         JOIN verification_consents grants ON grants.id = evidence.processing_grant_id
         JOIN approved_student_email_domains domains
           ON domains.university_id = evidence.university_id
           AND domains.domain = split_part($5, '@', 2)
           AND domains.is_active
         JOIN universities institutions
           ON institutions.id = evidence.university_id AND institutions.is_active
         WHERE evidence.student_id = $1
           AND evidence.university_id = $2
           AND evidence.method = 'student_email'
           AND evidence.outcome = 'verified'
           AND evidence.revoked_at IS NULL
           AND evidence.identity_version = $3
           AND evidence.policy_version = $4
           AND proofs.email = $5
           AND grants.user_id = $6
           AND grants.kind = 'processing'
           AND grants.accepted
           AND grants.notice_version = $7
           AND grants.withdrawn_at IS NULL
           AND LEAST(evidence.expires_at, evidence.verified_at + interval '90 days') > clock_timestamp()
         ORDER BY evidence.verified_at DESC, evidence.id DESC
         LIMIT 1`,
        params,
    );
    const current = valid.rows[0];
    if (current) {
        return resolveSchoolAccount({
            method: 'email_otp',
            validUntil: current.valid_until.toISOString(),
            expiredValidUntil: null,
        });
    }
    const expired = await tx.query<SchoolEvidenceRow>(
        `SELECT LEAST(evidence.expires_at, evidence.verified_at + interval '90 days') AS valid_until
         FROM eligibility_evidence evidence
         JOIN user_email_proofs proofs ON proofs.id = evidence.email_proof_id
         JOIN verification_consents grants ON grants.id = evidence.processing_grant_id
         JOIN approved_student_email_domains domains
           ON domains.university_id = evidence.university_id
           AND domains.domain = split_part($5, '@', 2)
           AND domains.is_active
         JOIN universities institutions
           ON institutions.id = evidence.university_id AND institutions.is_active
         WHERE evidence.student_id = $1
           AND evidence.university_id = $2
           AND evidence.method = 'student_email'
           AND evidence.outcome = 'verified'
           AND evidence.revoked_at IS NULL
           AND evidence.identity_version = $3
           AND evidence.policy_version = $4
           AND proofs.email = $5
           AND grants.user_id = $6
           AND grants.kind = 'processing'
           AND grants.accepted
           AND grants.notice_version = $7
           AND grants.withdrawn_at IS NULL
         ORDER BY evidence.expires_at DESC, evidence.id DESC
         LIMIT 1`,
        params,
    );
    const past = expired.rows[0];
    return resolveSchoolAccount({
        method: 'email_otp',
        validUntil: null,
        expiredValidUntil: past ? past.valid_until.toISOString() : null,
    });
}

async function readEnrollmentFlags(tx: PoolClient, context: StudentContext): Promise<EnrollmentAssuranceFlags> {
    // These are non-locking projection reads: benefits always re-read locked
    // authority, so a status label may lag a concurrent write but can never
    // authorize. Revocation is explicit evidence state, never inferred from
    // the generic consent_required reason.
    const params = [context.studentId, context.universityId, context.identityVersion, context.policyVersion, context.email];
    const sources = [ENROLLMENT_SOURCE, MICROSOFT_ENROLLMENT_SOURCE];
    const revoked = await tx.query(
        `SELECT 1
         FROM eligibility_evidence evidence
         JOIN user_email_proofs proofs ON proofs.id = evidence.email_proof_id
         JOIN verification_consents grants ON grants.id = evidence.processing_grant_id
         WHERE evidence.student_id = $1
           AND evidence.university_id = $2
           AND evidence.method = 'enrollment'
           AND evidence.outcome = 'verified'
           AND evidence.source = ANY ($6)
           AND evidence.identity_version = $3
           AND evidence.policy_version = $4
           AND proofs.email = $5
           AND (evidence.revoked_at IS NOT NULL OR grants.withdrawn_at IS NOT NULL)
         LIMIT 1`,
        [...params, sources],
    );
    const expired = await tx.query<{ source: string; expires_at: Date }>(
        `SELECT evidence.source, evidence.expires_at
         FROM eligibility_evidence evidence
         JOIN user_email_proofs proofs ON proofs.id = evidence.email_proof_id
         WHERE evidence.student_id = $1
           AND evidence.university_id = $2
           AND evidence.method = 'enrollment'
           AND evidence.outcome = 'verified'
           AND evidence.revoked_at IS NULL
           AND evidence.source = ANY ($6)
           AND evidence.identity_version = $3
           AND evidence.policy_version = $4
           AND proofs.email = $5
           AND evidence.expires_at <= clock_timestamp()
         ORDER BY evidence.expires_at DESC, evidence.id DESC
         LIMIT 1`,
        [...params, sources],
    );
    const drifted = await tx.query<{ identity_version: number; policy_version: number }>(
        `SELECT evidence.identity_version, evidence.policy_version
         FROM eligibility_evidence evidence
         JOIN user_email_proofs proofs ON proofs.id = evidence.email_proof_id
         WHERE evidence.student_id = $1
           AND evidence.university_id = $2
           AND evidence.method = 'enrollment'
           AND evidence.outcome = 'verified'
           AND evidence.revoked_at IS NULL
           AND evidence.source = ANY ($6)
           AND proofs.email = $5
           AND (evidence.identity_version <> $3 OR evidence.policy_version <> $4)
         LIMIT 1`,
        [...params, sources],
    );
    const microsoftCandidate = await tx.query(
        `SELECT 1
         FROM eligibility_evidence evidence
         JOIN user_email_proofs proofs ON proofs.id = evidence.email_proof_id
         WHERE evidence.student_id = $1
           AND evidence.university_id = $2
           AND evidence.method = 'enrollment'
           AND evidence.outcome = 'verified'
           AND evidence.revoked_at IS NULL
           AND evidence.source = $6
           AND evidence.identity_version = $3
           AND evidence.policy_version = $4
           AND proofs.email = $5
           AND evidence.expires_at > clock_timestamp()
         LIMIT 1`,
        [...params, MICROSOFT_ENROLLMENT_SOURCE],
    );
    let providerUnavailable = false;
    if ((microsoftCandidate.rowCount ?? 0) > 0) {
        const policy = await tx.query<{ enabled: boolean }>(
            `SELECT enabled
             FROM institution_microsoft_policies
             WHERE university_id = $1
               AND enabled
               AND mode = 'graph_enrollment'
               AND approved_until > clock_timestamp()
               AND term_ends_at IS NOT NULL
               AND term_ends_at > clock_timestamp()
             LIMIT 1`,
            [context.universityId],
        );
        providerUnavailable = !config.microsoftOidc.enabled || (policy.rowCount ?? 0) === 0;
    }
    const expiredRow = expired.rows[0];
    const driftedRow = drifted.rows[0];
    return {
        revokedOrWithdrawn: (revoked.rowCount ?? 0) > 0,
        expiredMethod: enrollmentMethodFromSource(expiredRow?.source ?? null),
        expiredValidUntil: expiredRow ? expiredRow.expires_at.toISOString() : null,
        identityChanged: driftedRow?.identity_version !== undefined && driftedRow.identity_version !== context.identityVersion,
        policyChanged: driftedRow?.policy_version !== undefined
            && driftedRow.identity_version === context.identityVersion
            && driftedRow.policy_version !== context.policyVersion,
        providerUnavailable,
    };
}

// Read-only status projection over current evidence. Release A reads existing
// mailbox/evidence tables only; it must not depend on migration 057 (the B4
// SSO assertion reader extends this module behind the provider flags).
// Expiry, denial, and revocation take effect on the next read: nothing here
// is cached in the session or JWT. A reader failure is a retryable status
// error, never a fabricated positive result.
export async function readStudentAssurance(tx: PoolClient, userId: string): Promise<StudentAssurance> {
    let context: StudentContext;
    try {
        context = await lockStudentContext(tx, userId);
    } catch (error) {
        // Absent institution/profile routes to pending; the verification page
        // adds incomplete-profile guidance alongside this payload.
        if (error instanceof NotFoundError) return pendingStudentAssurance();
        throw error;
    }
    if (!context.active) {
        return {
            schoolAccountStatus: 'unverified',
            schoolAccountMethod: null,
            schoolAccountValidUntil: null,
            studentStatus: 'inactive',
            enrollmentMethod: null,
            studentValidUntil: null,
            reason: 'inactive',
        };
    }
    try {
        const school = await readSchoolAccount(tx, userId, context);
        const eligibility = await getEffectiveEligibility(tx, userId);
        if (eligibility.eligible) {
            const stored = await tx.query<{ source: string | null }>(
                'SELECT source FROM eligibility_evidence WHERE id = $1',
                [eligibility.evidenceId],
            );
            return {
                ...school,
                ...resolveStudentStatus(eligibility, stored.rows[0]?.source ?? null, {
                    revokedOrWithdrawn: false,
                    expiredMethod: null,
                    expiredValidUntil: null,
                    identityChanged: false,
                    policyChanged: false,
                    providerUnavailable: false,
                }),
            };
        }
        const flags = await readEnrollmentFlags(tx, context);
        return { ...school, ...resolveStudentStatus(eligibility, null, flags) };
    } catch (error) {
        if (error instanceof NotFoundError) return pendingStudentAssurance();
        throw new ServiceUnavailableError('Student status is temporarily unavailable. Please retry.');
    }
}

// Best-effort sibling for account surfaces (profile, login): a transient
// status failure must not lock the student out or blank their account page.
// Callers render null as "unavailable" with a retry and no positive state.
export async function readStudentAssuranceOrNull(
    pool: Pick<Pool, 'connect'>,
    userId: string,
): Promise<StudentAssurance | null> {
    let client: PoolClient | undefined;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const assurance = await readStudentAssurance(client, userId);
        await client.query('COMMIT');
        return assurance;
    } catch {
        await client?.query('ROLLBACK').catch(() => undefined);
        return null;
    } finally {
        client?.release();
    }
}
