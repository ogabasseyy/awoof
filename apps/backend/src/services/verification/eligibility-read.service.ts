import type { PoolClient } from 'pg';
import { config } from '../../config/env.js';
import { BadRequestError, NotFoundError } from '../../common/errors/AppError.js';
import { lockStudentContext } from './eligibility-context.service.js';
import {
    canonicalWidgetOrigin,
    prepareMerchantDisclosure,
    type MerchantDisclosureContext,
} from './eligibility-merchant-context.service.js';
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
    source: string | null;
    provider_proof_id: string | null;
};

type EvidenceCandidate = StateEvidence;

async function validMerchantDisclosure(
    tx: PoolClient,
    userId: string,
    disclosure: { vendorId: string; grantId: string; origin: string; purpose: string },
    merchant: MerchantDisclosureContext,
): Promise<boolean> {
    const result = await tx.query(
        `SELECT 1
         FROM verification_consents consents
         WHERE consents.id = $1
           AND consents.user_id = $2
           AND consents.kind = 'disclosure'
           AND consents.vendor_id = $3
           AND consents.origin = $4
           AND consents.purpose = $5
           AND consents.notice_version = $6
           AND consents.accepted
           AND consents.withdrawn_at IS NULL
         FOR UPDATE OF consents`,
        [
            disclosure.grantId,
            userId,
            disclosure.vendorId,
            disclosure.origin,
            disclosure.purpose,
            MERCHANT_DISCLOSURE_NOTICE_VERSION,
        ],
    );
    return result.rowCount === 1
        && merchant.vendorId === disclosure.vendorId
        && merchant.origin === disclosure.origin;
}

async function currentProcessingGrant(
    tx: PoolClient,
    userId: string,
    universityId: string,
    processingGrantId: string | null,
): Promise<boolean> {
    if (!processingGrantId) return false;
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
        [processingGrantId, userId, universityId, VERIFICATION_NOTICE_VERSION],
    );
    return processing.rowCount === 1;
}

function hasCurrentBaseAuthority(evidence: EvidenceCandidate, context: StudentContext): boolean {
    return evidence.outcome === 'verified'
        && evidence.method !== null
        && evidence.verified_at !== null
        && evidence.expires_at !== null
        && evidence.revoked_at === null
        && evidence.evidence_identity_version === context.identityVersion
        && evidence.evidence_policy_version === context.policyVersion
        && evidence.proof_email === context.email;
}

async function currentMicrosoftProof(
    tx: PoolClient,
    userId: string,
    context: StudentContext,
    evidence: EvidenceCandidate,
): Promise<boolean> {
    if (!hasCurrentBaseAuthority(evidence, context)
        || evidence.source !== 'microsoft-education:v1'
        || !evidence.provider_proof_id
        || !await currentProcessingGrant(tx, userId, context.universityId, evidence.processing_grant_id)) return false;

    // Keep the mutation/read lock order: parent grant, provider policy,
    // provider consent, linked identity, then immutable provider proof.
    const policy = await tx.query<{ tenant_id: string; version: number; enabled: boolean; mode: string; approved_until: Date; term_ends_at: Date | null; scopes: string[]; notice_version: string }>(
        `SELECT tenant_id, version, enabled, mode, approved_until, term_ends_at, scopes, notice_version
         FROM institution_microsoft_policies WHERE university_id = $1 FOR UPDATE`,
        [context.universityId],
    );
    const policyRow = policy.rows[0];
    if (!policyRow) return false;
    const provider = await tx.query<{ identity_id: string }>(
        `SELECT identity_id
         FROM microsoft_provider_proofs proof
         JOIN microsoft_verification_consents provider ON provider.id = proof.provider_consent_id
         WHERE proof.id = $1
           AND provider.user_id = $2
           AND provider.university_id = $3
           AND provider.processing_grant_id = $4
           AND provider.provider_policy_version = proof.provider_policy_version
           AND provider.notice_version = $5
           AND provider.mode = 'graph_enrollment'
           AND provider.scopes = $6::text[]
           AND provider.withdrawn_at IS NULL
         FOR UPDATE OF provider`,
        [evidence.provider_proof_id, userId, context.universityId, evidence.processing_grant_id,
            policyRow.notice_version, policyRow.scopes],
    );
    const identityId = provider.rows[0]?.identity_id;
    if (!identityId) return false;
    const identity = await tx.query(
        `SELECT 1 FROM microsoft_identities
         WHERE id = $1 AND user_id = $2 AND university_id = $3
           AND tenant_id = $4 AND revoked_at IS NULL
         FOR UPDATE`,
        [identityId, userId, context.universityId, policyRow.tenant_id],
    );
    if (identity.rowCount !== 1) return false;
    // A legacy proof without this immutable observation contract is deliberately
    // not a Microsoft eligibility source. It cannot gain trust through a read.
    const proof = await tx.query(
        `SELECT 1
         FROM microsoft_provider_proofs proof
         WHERE proof.id = $1
           AND proof.user_id = $2
           AND proof.university_id = $3
           AND proof.revoked_at IS NULL
           AND proof.attempt_id IS NOT NULL
           AND proof.observed_at IS NOT NULL
           AND proof.outcome = 'student'
           AND proof.source = 'microsoft-education:v1'
           AND proof.identity_id = $4
           AND proof.provider_policy_version = $5
         FOR UPDATE`,
        [evidence.provider_proof_id, userId, context.universityId, identityId, policyRow.version],
    );
    if (proof.rowCount !== 1) return false;
    // This must be after every dependent lock. Configuration is server-owned;
    // no caller-controlled input can override the production switch.
    const now = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
    return config.microsoftOidc.enabled
        && policyRow.enabled
        && policyRow.mode === 'graph_enrollment'
        && policyRow.approved_until > now
        && policyRow.term_ends_at !== null
        && policyRow.term_ends_at > now
        && policyRow.scopes.length === 3
        && policyRow.scopes.every((scope, index) => scope === ['https://graph.microsoft.com/EduRoster.ReadBasic', 'openid', 'profile'][index])
        && evidence.expires_at! > now;
}

/** Exported for unit testing; production entry remains getEffectiveEligibility. */
export async function independentlyValidEmailEvidence(
    tx: PoolClient,
    userId: string,
    context: StudentContext,
): Promise<EvidenceCandidate | undefined> {
    // This is intentionally a valid-set query. A newer revoked or stale row
    // must not conceal an older still-valid independently verified mailbox.
    const candidates = await tx.query<EvidenceCandidate>(
        `SELECT evidence.id AS evidence_id, evidence.method, evidence.outcome,
                evidence.verified_at, evidence.expires_at, evidence.revoked_at,
                evidence.identity_version AS evidence_identity_version,
                evidence.policy_version AS evidence_policy_version,
                evidence.processing_grant_id, proofs.email AS proof_email,
                evidence.source, evidence.provider_proof_id,
                false AS authoritative_denial
         FROM eligibility_evidence evidence
         JOIN user_email_proofs proofs ON proofs.id = evidence.email_proof_id
         JOIN verification_consents processing ON processing.id = evidence.processing_grant_id
         WHERE evidence.student_id = $1
           AND evidence.university_id = $2
           AND evidence.method = 'student_email'
           AND evidence.outcome = 'verified'
           AND evidence.revoked_at IS NULL
           AND evidence.identity_version = $3
           AND evidence.policy_version = $4
           AND proofs.email = $5
           -- Evidence is retained indefinitely, so expired rows must not
           -- reach the per-candidate grant, row-lock, and clock queries
           -- below. This mirrors the loop's own expiry check exactly.
           AND evidence.expires_at > clock_timestamp()
         ORDER BY evidence.verified_at DESC, evidence.id DESC
        `,
        [context.studentId, context.universityId, context.identityVersion, context.policyVersion,
            context.email],
    );
    const domainApproved = await isApprovedStudentEmail(tx, context.universityId, context.email);
    if (!domainApproved) return undefined;
    for (const candidate of candidates.rows) {
        if (!await currentProcessingGrant(tx, userId, context.universityId, candidate.processing_grant_id)) continue;
        const locked = await tx.query<EvidenceCandidate>(
            `SELECT evidence.id AS evidence_id, evidence.method, evidence.outcome,
                    evidence.verified_at, evidence.expires_at, evidence.revoked_at,
                    evidence.identity_version AS evidence_identity_version,
                    evidence.policy_version AS evidence_policy_version,
                    evidence.processing_grant_id, proofs.email AS proof_email,
                    evidence.source, evidence.provider_proof_id, false AS authoritative_denial
             FROM eligibility_evidence evidence
             JOIN user_email_proofs proofs ON proofs.id = evidence.email_proof_id
             WHERE evidence.id = $1 FOR UPDATE OF evidence, proofs`,
            [candidate.evidence_id],
        );
        const current = locked.rows[0];
        const now = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
        if (current && hasCurrentBaseAuthority(current, context) && current.method === 'student_email'
            && current.expires_at! > now && current.processing_grant_id === candidate.processing_grant_id) return current;
    }
    return undefined;
}

export async function getEffectiveEligibility(
    tx: PoolClient,
    userId: string,
    disclosure?: { vendorId: string; grantId: string; origin: string; purpose: string },
): Promise<EligibilityResult> {
    let merchant: MerchantDisclosureContext | undefined;
    let canonicalDisclosure: typeof disclosure;
    if (disclosure) {
        try {
            canonicalDisclosure = { ...disclosure, origin: canonicalWidgetOrigin(disclosure.origin) };
        } catch (error) {
            if (error instanceof BadRequestError) return { eligible: false, reason: 'consent_required' };
            throw error;
        }
        // Qualified disclosure reads are transaction entrypoints: participant
        // users are the first locks. See prepareMerchantDisclosure's contract.
        const preparedMerchant = await prepareMerchantDisclosure(
            tx,
            userId,
            canonicalDisclosure.vendorId,
            canonicalDisclosure.origin,
        );
        if (!preparedMerchant) return { eligible: false, reason: 'consent_required' };
        merchant = preparedMerchant;
    }
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
                proofs.email AS proof_email,
                evidence.source,
                evidence.provider_proof_id
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
    // Identity and base institution policy are global authority gates. A
    // provider-only failure may fall back; a changed canonical identity/policy
    // may not resurrect any historical evidence.
    if (state.evidence_identity_version !== context.identityVersion) return { eligible: false, reason: 'identity_changed' };
    if (state.evidence_policy_version !== context.policyVersion) return { eligible: false, reason: 'policy_changed' };
    let selected: EvidenceCandidate | undefined = state;
    if (state.source === 'microsoft-education:v1') {
        if (!await currentMicrosoftProof(tx, userId, context, state)) {
            selected = await independentlyValidEmailEvidence(tx, userId, context);
            if (!selected) {
                if (state.revoked_at !== null || !await currentProcessingGrant(tx, userId, context.universityId, state.processing_grant_id)) {
                    return { eligible: false, reason: 'consent_required' };
                }
                const failureNow = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
                return { eligible: false, reason: state.expires_at <= failureNow ? 'expired' : 'unverified' };
            }
        }
    } else {
        // Preserve the established non-Microsoft behavior exactly: only a
        // provider-invalid Microsoft pointer may use independent-email fallback.
        if (state.revoked_at !== null || !await currentProcessingGrant(tx, userId, context.universityId, state.processing_grant_id)) {
            return { eligible: false, reason: 'consent_required' };
        }
        if (state.proof_email !== context.email) return { eligible: false, reason: 'identity_changed' };
        if (state.method === 'student_email' && !await isApprovedStudentEmail(tx, context.universityId, context.email)) {
            return { eligible: false, reason: 'policy_changed' };
        }
    }
    if (canonicalDisclosure && merchant && !await validMerchantDisclosure(tx, userId, canonicalDisclosure, merchant)) {
        return { eligible: false, reason: 'consent_required' };
    }
    // Disclosure acquisition may have blocked behind a concurrent withdrawal.
    // Re-evaluate both selected expiry and the server-owned provider switch only
    // after that final dependent lock.
    const finalNow = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
    if (selected.source === 'microsoft-education:v1'
        && (selected.expires_at! <= finalNow || !config.microsoftOidc.enabled)) {
        const fallback = await independentlyValidEmailEvidence(tx, userId, context);
        if (!fallback) return { eligible: false, reason: selected.expires_at! <= finalNow ? 'expired' : 'unverified' };
        selected = fallback;
        const fallbackNow = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
        if (selected.expires_at! <= fallbackNow) return { eligible: false, reason: 'expired' };
    } else if (selected.expires_at! <= finalNow) {
        return { eligible: false, reason: 'expired' };
    }
    return {
        eligible: true,
        studentId: context.studentId,
        universityId: context.universityId,
        evidenceId: selected.evidence_id!,
        processingGrantId: selected.processing_grant_id!,
        method: selected.method!,
        verifiedAt: selected.verified_at!,
        expiresAt: selected.expires_at!,
    };
}
