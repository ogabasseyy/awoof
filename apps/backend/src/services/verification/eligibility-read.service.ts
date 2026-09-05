import type { PoolClient } from 'pg';
import { NotFoundError } from '../../common/errors/AppError.js';
import { lockStudentContext } from './eligibility-context.service.js';
import { isApprovedStudentEmail } from './eligibility-policy.service.js';
import type { EligibilityResult, StudentContext } from './eligibility.types.js';
import { MERCHANT_DISCLOSURE_NOTICE_VERSION, VERIFICATION_NOTICE_VERSION } from './verification-notices.js';

type StateEvidence = {
    authoritative_denial: boolean;
    evidence_id: string | null;
    method: 'student_email' | 'enrollment' | null;
    outcome: 'verified' | 'denied' | null;
    verified_at: Date | null;
    expires_at: Date | null;
    revoked_at: Date | null;
    evidence_identity_version: number | null;
    evidence_policy_version: number | null;
    processing_grant_id: string | null;
    proof_email: string | null;
};

async function validMerchantDisclosure(
    tx: PoolClient,
    userId: string,
    disclosure: { vendorId: string; grantId: string; origin: string; purpose: string },
): Promise<boolean> {
    const result = await tx.query(
        `SELECT 1
         FROM verification_consents consents
         JOIN widget_configs widgets ON widgets.vendor_id = consents.vendor_id
         WHERE consents.id = $1
           AND consents.user_id = $2
           AND consents.kind = 'disclosure'
           AND consents.vendor_id = $3
           AND consents.origin = $4
           AND consents.purpose = $5
           AND consents.notice_version = $6
           AND consents.accepted
           AND consents.withdrawn_at IS NULL
           AND widgets.status = 'active'
           AND $4 = ANY(widgets.allowed_origins)
         FOR UPDATE OF consents, widgets`,
        [
            disclosure.grantId,
            userId,
            disclosure.vendorId,
            disclosure.origin,
            disclosure.purpose,
            MERCHANT_DISCLOSURE_NOTICE_VERSION,
        ],
    );
    return result.rowCount === 1;
}

export async function getEffectiveEligibility(
    tx: PoolClient,
    userId: string,
    disclosure?: { vendorId: string; grantId: string; origin: string; purpose: string },
): Promise<EligibilityResult> {
    let context: StudentContext;
    try {
        context = await lockStudentContext(tx, userId);
    } catch (error) {
        if (error instanceof NotFoundError) return { eligible: false, reason: 'unverified' };
        throw error;
    }
    if (!context.active) return { eligible: false, reason: 'inactive' };

    const current = await tx.query<StateEvidence>(
        `SELECT state.authoritative_denial,
                evidence.id AS evidence_id,
                evidence.method,
                evidence.outcome,
                evidence.verified_at,
                evidence.expires_at,
                evidence.revoked_at,
                evidence.identity_version AS evidence_identity_version,
                evidence.policy_version AS evidence_policy_version,
                evidence.processing_grant_id,
                proofs.email AS proof_email
         FROM student_eligibility_state state
         LEFT JOIN eligibility_evidence evidence ON evidence.id = state.current_evidence_id
         LEFT JOIN user_email_proofs proofs ON proofs.id = evidence.email_proof_id
         WHERE state.student_id = $1 AND state.university_id = $2
         FOR UPDATE OF state`,
        [context.studentId, context.universityId],
    );
    const state = current.rows[0];
    if (!state) return { eligible: false, reason: 'unverified' };
    if (state.authoritative_denial) return { eligible: false, reason: 'enrollment_denied' };
    if (!state.evidence_id || state.outcome !== 'verified' || !state.method || !state.verified_at || !state.expires_at) {
        return { eligible: false, reason: 'unverified' };
    }
    if (state.evidence_identity_version !== context.identityVersion) {
        return { eligible: false, reason: 'identity_changed' };
    }
    if (state.evidence_policy_version !== context.policyVersion) {
        return { eligible: false, reason: 'policy_changed' };
    }
    if (state.revoked_at !== null) return { eligible: false, reason: 'consent_required' };
    if (state.proof_email !== context.email) return { eligible: false, reason: 'identity_changed' };

    const processing = await tx.query(
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
        [state.processing_grant_id, userId, context.universityId, VERIFICATION_NOTICE_VERSION],
    );
    if (processing.rowCount !== 1) return { eligible: false, reason: 'consent_required' };
    if (state.method === 'student_email'
        && !await isApprovedStudentEmail(tx, context.universityId, context.email)) {
        return { eligible: false, reason: 'policy_changed' };
    }
    if (disclosure && !await validMerchantDisclosure(tx, userId, disclosure)) {
        return { eligible: false, reason: 'consent_required' };
    }
    const now = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    if (state.expires_at <= now.rows[0]!.now) return { eligible: false, reason: 'expired' };
    return {
        eligible: true,
        studentId: context.studentId,
        universityId: context.universityId,
        evidenceId: state.evidence_id,
        processingGrantId: state.processing_grant_id!,
        method: state.method,
        verifiedAt: state.verified_at,
        expiresAt: state.expires_at,
    };
}
