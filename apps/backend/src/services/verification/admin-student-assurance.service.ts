import type pg from 'pg';
import { config } from '../../config/env.js';
import { BadRequestError } from '../../common/errors/AppError.js';
import {
    ENROLLMENT_SOURCE,
    MICROSOFT_ENROLLMENT_SOURCE,
    type EligibilityResult,
    type StudentContext,
} from './eligibility.types.js';
import {
    enrollmentMethodFromSource,
    pendingStudentAssurance,
    resolveSchoolAccount,
    resolveStudentStatus,
    type EnrollmentAssuranceFlags,
} from './student-assurance.service.js';
import type { StudentAssurance } from './student-assurance.types.js';
import { VERIFICATION_NOTICE_VERSION } from './verification-notices.js';

/** Reporting pages are capped at 100 rows; the projection refuses more. */
export const ADMIN_ASSURANCE_PAGE_MAX = 100;

/** Minimal query surface so Pool, PoolClient, and the app db all qualify. */
export interface AdminAssuranceStore {
    query<T extends pg.QueryResultRow>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

type ContextRow = {
    user_id: string;
    student_id: string;
    email: string;
    university_id: string;
    identity_version: number;
    policy_version: number;
    active: boolean;
};

type EvidenceRow = {
    student_id: string;
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

type StateRow = EvidenceRow & {
    state_university_id: string;
    authoritative_denial: boolean;
    processing_current: boolean | null;
    now: Date;
};

type AuthorityRow = {
    proof_id: string;
    proof_user_id: string;
    proof_university_id: string;
    proof_identity_id: string;
    proof_policy_version: number;
    proof_revoked_at: Date | null;
    proof_attempt_id: string | null;
    proof_observed_at: Date | null;
    proof_outcome: string | null;
    proof_source: string | null;
    consent_user_id: string;
    consent_university_id: string;
    consent_grant_id: string;
    consent_policy_version: number;
    consent_notice: string;
    consent_mode: string;
    consent_scopes: string[];
    consent_withdrawn_at: Date | null;
    consent_identity_id: string;
    identity_user_id: string;
    identity_university_id: string;
    identity_tenant_id: string;
    identity_revoked_at: Date | null;
    policy_tenant_id: string;
    policy_version: number;
    policy_enabled: boolean;
    policy_mode: string;
    policy_approved_until: Date;
    policy_term_ends_at: Date | null;
    policy_scopes: string[];
    policy_notice: string;
};

const GRAPH_SCOPES = ['https://graph.microsoft.com/EduRoster.ReadBasic', 'openid', 'profile'];

function sameTextArray(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecognizedEnrollmentSource(source: string | null): boolean {
    return source === ENROLLMENT_SOURCE || source === MICROSOFT_ENROLLMENT_SOURCE;
}

function ctxJson(contexts: StudentContext[]): string {
    return JSON.stringify(contexts.map((context) => ({
        student_id: context.studentId,
        university_id: context.universityId,
        identity_version: context.identityVersion,
        policy_version: context.policyVersion,
        email: context.email,
    })));
}

function ctxJoin(param: number): string {
    return `JOIN jsonb_to_recordset($${param}::jsonb)
     AS ctx(student_id uuid, university_id uuid, identity_version int, policy_version int, email text)
     ON ctx.student_id = evidence.student_id
     AND evidence.university_id = ctx.university_id
     AND evidence.identity_version = ctx.identity_version
     AND evidence.policy_version = ctx.policy_version
     AND proofs.email = ctx.email`;
}

function microsoftAuthorityValid(
    candidate: EvidenceRow,
    context: StudentContext,
    authority: AuthorityRow | undefined,
    now: Date,
): boolean {
    if (!authority || !candidate.provider_proof_id) return false;
    if (authority.consent_user_id !== context.userId
        || authority.consent_university_id !== context.universityId
        || authority.consent_grant_id !== candidate.processing_grant_id
        || authority.consent_policy_version !== authority.proof_policy_version
        || authority.consent_notice !== authority.policy_notice
        || authority.consent_mode !== 'graph_enrollment'
        || !sameTextArray(authority.consent_scopes, authority.policy_scopes)
        || authority.consent_withdrawn_at !== null) return false;
    if (authority.identity_user_id !== context.userId
        || authority.identity_university_id !== context.universityId
        || authority.identity_tenant_id !== authority.policy_tenant_id
        || authority.identity_revoked_at !== null) return false;
    if (authority.proof_user_id !== context.userId
        || authority.proof_university_id !== context.universityId
        || authority.proof_revoked_at !== null
        || authority.proof_attempt_id === null
        || authority.proof_observed_at === null
        || authority.proof_outcome !== 'student'
        || authority.proof_source !== MICROSOFT_ENROLLMENT_SOURCE
        || authority.proof_identity_id !== authority.consent_identity_id
        || authority.proof_policy_version !== authority.policy_version) return false;
    return config.microsoftOidc.enabled
        && authority.policy_enabled
        && authority.policy_mode === 'graph_enrollment'
        && authority.policy_approved_until > now
        && authority.policy_term_ends_at !== null
        && authority.policy_term_ends_at > now
        && sameTextArray(authority.policy_scopes, GRAPH_SCOPES)
        && candidate.expires_at !== null
        && candidate.expires_at > now;
}

// Bounded read-only projection of StudentAssurance for admin reporting pages.
// It shares the point reader's validity rules (resolveStudentStatus,
// resolveSchoolAccount, source/method mapping) over batched unlocked reads:
// no FOR UPDATE, no per-student lock-heavy reader, and a fixed small query
// count regardless of page size. A label may lag a concurrent write but can
// never authorize; benefit boundaries always re-read locked authority.
export async function readAdminStudentAssurance(
    store: AdminAssuranceStore,
    userIds: string[],
): Promise<Map<string, StudentAssurance>> {
    const unique = [...new Set(userIds)];
    if (unique.length > ADMIN_ASSURANCE_PAGE_MAX) {
        throw new BadRequestError(`Admin assurance projection is bounded to ${ADMIN_ASSURANCE_PAGE_MAX} students per page`);
    }
    const page = new Map<string, StudentAssurance>();
    for (const userId of unique) page.set(userId, pendingStudentAssurance());
    if (unique.length === 0) return page;

    const contexts = (await store.query<ContextRow>(
        `SELECT u.id AS user_id, s.id AS student_id, LOWER(TRIM(u.email)) AS email,
                univ.id AS university_id,
                s.identity_version AS identity_version,
                univ.verification_policy_version AS policy_version,
                (u.deleted_at IS NULL AND u.role = 'student'
                 AND s.status = 'active' AND univ.is_active) AS active
         FROM users u
         JOIN students s ON s.user_id = u.id
         JOIN universities univ ON univ.id = s.university_id
         WHERE u.id = ANY($1::uuid[])`,
        [unique],
    )).rows;
    const active = contexts.filter((context) => context.active);
    for (const context of contexts) {
        if (!context.active) {
            page.set(context.user_id, {
                schoolAccountStatus: 'unverified',
                schoolAccountMethod: null,
                schoolAccountValidUntil: null,
                studentStatus: 'inactive',
                enrollmentMethod: null,
                studentValidUntil: null,
                reason: 'inactive',
            });
        }
    }
    if (active.length === 0) return page;

    const activeContexts: StudentContext[] = active.map((context) => ({
        userId: context.user_id,
        studentId: context.student_id,
        email: context.email,
        universityId: context.university_id,
        identityVersion: context.identity_version,
        policyVersion: context.policy_version,
        active: context.active,
    }));
    const studentIds = activeContexts.map((context) => context.studentId);
    const universityIds = activeContexts.map((context) => context.universityId);
    const contextsJson = ctxJson(activeContexts);

    const states = (await store.query<StateRow>(
        `SELECT state.student_id AS student_id, state.university_id AS state_university_id,
                state.authoritative_denial AS authoritative_denial,
                evidence.id AS evidence_id, evidence.method AS method, evidence.outcome AS outcome,
                evidence.verified_at AS verified_at, evidence.expires_at AS expires_at,
                evidence.revoked_at AS revoked_at,
                evidence.identity_version AS evidence_identity_version,
                evidence.policy_version AS evidence_policy_version,
                evidence.processing_grant_id AS processing_grant_id,
                evidence.source AS source, evidence.provider_proof_id AS provider_proof_id,
                proofs.email AS proof_email,
                (processing.accepted AND processing.kind = 'processing'
                 AND processing.notice_version = $2 AND processing.withdrawn_at IS NULL
                 AND processing.user_id = students.user_id
                 AND processing.university_id = state.university_id) AS processing_current,
                clock_timestamp() AS now
         FROM student_eligibility_state state
         JOIN students ON students.id = state.student_id
         LEFT JOIN eligibility_evidence evidence ON evidence.id = state.current_evidence_id
         LEFT JOIN user_email_proofs proofs ON proofs.id = evidence.email_proof_id
         LEFT JOIN verification_consents processing ON processing.id = evidence.processing_grant_id
         WHERE state.student_id = ANY($1::uuid[])`,
        [studentIds, VERIFICATION_NOTICE_VERSION],
    )).rows;
    const stateByStudent = new Map<string, StateRow>();
    for (const row of states) {
        if (!stateByStudent.has(row.student_id)) stateByStudent.set(row.student_id, row);
    }
    const now = states[0]?.now ?? new Date();

    const candidates = (await store.query<EvidenceRow>(
        `SELECT evidence.student_id AS student_id, evidence.id AS evidence_id,
                evidence.method AS method, evidence.outcome AS outcome,
                evidence.verified_at AS verified_at, evidence.expires_at AS expires_at,
                evidence.revoked_at AS revoked_at,
                evidence.identity_version AS evidence_identity_version,
                evidence.policy_version AS evidence_policy_version,
                evidence.processing_grant_id AS processing_grant_id,
                proofs.email AS proof_email, evidence.source AS source,
                evidence.provider_proof_id AS provider_proof_id
         FROM eligibility_evidence evidence
         JOIN user_email_proofs proofs ON proofs.id = evidence.email_proof_id
         JOIN students ON students.id = evidence.student_id
         JOIN verification_consents processing ON processing.id = evidence.processing_grant_id
              AND processing.user_id = students.user_id
              AND processing.university_id = evidence.university_id
              AND processing.kind = 'processing' AND processing.accepted
              AND processing.notice_version = $1 AND processing.withdrawn_at IS NULL
         ${ctxJoin(2)}
         WHERE evidence.method = 'enrollment' AND evidence.outcome = 'verified'
           AND evidence.revoked_at IS NULL
           AND evidence.source IN ('institution-registration:v1', 'microsoft-education:v1')
           AND evidence.expires_at > clock_timestamp()
         ORDER BY evidence.student_id, evidence.verified_at DESC, evidence.id DESC`,
        [VERIFICATION_NOTICE_VERSION, contextsJson],
    )).rows;
    const candidatesByStudent = new Map<string, EvidenceRow[]>();
    for (const candidate of candidates) {
        const list = candidatesByStudent.get(candidate.student_id) ?? [];
        list.push(candidate);
        candidatesByStudent.set(candidate.student_id, list);
    }

    const microsoftProofIds = [...new Set(candidates
        .filter((candidate) => candidate.source === MICROSOFT_ENROLLMENT_SOURCE && candidate.provider_proof_id)
        .map((candidate) => candidate.provider_proof_id as string))];
    const authorityByProof = new Map<string, AuthorityRow>();
    if (microsoftProofIds.length > 0) {
        const authorities = (await store.query<AuthorityRow>(
            `SELECT proof.id AS proof_id,
                    proof.user_id AS proof_user_id, proof.university_id AS proof_university_id,
                    proof.identity_id AS proof_identity_id,
                    proof.provider_policy_version AS proof_policy_version,
                    proof.revoked_at AS proof_revoked_at, proof.attempt_id AS proof_attempt_id,
                    proof.observed_at AS proof_observed_at, proof.outcome AS proof_outcome,
                    proof.source AS proof_source,
                    provider.user_id AS consent_user_id, provider.university_id AS consent_university_id,
                    provider.processing_grant_id AS consent_grant_id,
                    provider.provider_policy_version AS consent_policy_version,
                    provider.notice_version AS consent_notice, provider.mode AS consent_mode,
                    provider.scopes AS consent_scopes, provider.withdrawn_at AS consent_withdrawn_at,
                    provider.identity_id AS consent_identity_id,
                    identity.user_id AS identity_user_id, identity.university_id AS identity_university_id,
                    identity.tenant_id AS identity_tenant_id, identity.revoked_at AS identity_revoked_at,
                    policy.tenant_id AS policy_tenant_id, policy.version AS policy_version,
                    policy.enabled AS policy_enabled, policy.mode AS policy_mode,
                    policy.approved_until AS policy_approved_until,
                    policy.term_ends_at AS policy_term_ends_at,
                    policy.scopes AS policy_scopes, policy.notice_version AS policy_notice
             FROM microsoft_provider_proofs proof
             JOIN microsoft_verification_consents provider ON provider.id = proof.provider_consent_id
             JOIN microsoft_identities identity ON identity.id = provider.identity_id
             JOIN institution_microsoft_policies policy ON policy.university_id = proof.university_id
             WHERE proof.id = ANY($1::uuid[])`,
            [microsoftProofIds],
        )).rows;
        for (const row of authorities) authorityByProof.set(row.proof_id, row);
    }

    const revoked = new Set((await store.query<{ student_id: string }>(
        `SELECT DISTINCT ON (evidence.student_id) evidence.student_id AS student_id
         FROM eligibility_evidence evidence
         JOIN user_email_proofs proofs ON proofs.id = evidence.email_proof_id
         JOIN verification_consents grants ON grants.id = evidence.processing_grant_id
         ${ctxJoin(1)}
         WHERE evidence.method = 'enrollment' AND evidence.outcome = 'verified'
           AND evidence.source = ANY($2)
           AND (evidence.revoked_at IS NOT NULL OR grants.withdrawn_at IS NOT NULL)
         ORDER BY evidence.student_id`,
        [contextsJson, [ENROLLMENT_SOURCE, MICROSOFT_ENROLLMENT_SOURCE]],
    )).rows.map((row) => row.student_id));

    const expiredByStudent = new Map((await store.query<{ student_id: string; source: string; expires_at: Date }>(
        `SELECT DISTINCT ON (evidence.student_id) evidence.student_id AS student_id,
                evidence.source AS source, evidence.expires_at AS expires_at
         FROM eligibility_evidence evidence
         JOIN user_email_proofs proofs ON proofs.id = evidence.email_proof_id
         ${ctxJoin(1)}
         WHERE evidence.method = 'enrollment' AND evidence.outcome = 'verified'
           AND evidence.revoked_at IS NULL
           AND evidence.source = ANY($2)
           AND evidence.expires_at <= clock_timestamp()
         ORDER BY evidence.student_id, evidence.expires_at DESC, evidence.id DESC`,
        [contextsJson, [ENROLLMENT_SOURCE, MICROSOFT_ENROLLMENT_SOURCE]],
    )).rows.map((row) => [row.student_id, row] as const));

    const driftedByStudent = new Map((await store.query<{ student_id: string; identity_version: number; policy_version: number }>(
        `SELECT DISTINCT ON (evidence.student_id) evidence.student_id AS student_id,
                evidence.identity_version AS identity_version,
                evidence.policy_version AS policy_version
         FROM eligibility_evidence evidence
         JOIN user_email_proofs proofs ON proofs.id = evidence.email_proof_id
         JOIN jsonb_to_recordset($1::jsonb)
              AS ctx(student_id uuid, university_id uuid, identity_version int, policy_version int, email text)
              ON ctx.student_id = evidence.student_id
              AND evidence.university_id = ctx.university_id
              AND proofs.email = ctx.email
         WHERE evidence.method = 'enrollment' AND evidence.outcome = 'verified'
           AND evidence.revoked_at IS NULL
           AND evidence.source = ANY($2)
           AND (evidence.identity_version <> ctx.identity_version
                OR evidence.policy_version <> ctx.policy_version)
         ORDER BY evidence.student_id`,
        [contextsJson, [ENROLLMENT_SOURCE, MICROSOFT_ENROLLMENT_SOURCE]],
    )).rows.map((row) => [row.student_id, row] as const));

    const microsoftCandidates = new Set((await store.query<{ student_id: string }>(
        `SELECT DISTINCT ON (evidence.student_id) evidence.student_id AS student_id
         FROM eligibility_evidence evidence
         JOIN user_email_proofs proofs ON proofs.id = evidence.email_proof_id
         ${ctxJoin(1)}
         WHERE evidence.method = 'enrollment' AND evidence.outcome = 'verified'
           AND evidence.revoked_at IS NULL
           AND evidence.source = $2
           AND evidence.expires_at > clock_timestamp()
         ORDER BY evidence.student_id`,
        [contextsJson, MICROSOFT_ENROLLMENT_SOURCE],
    )).rows.map((row) => row.student_id));
    const graphPolicies = new Set<string>();
    if (microsoftCandidates.size > 0) {
        const policies = (await store.query<{ university_id: string }>(
            `SELECT university_id
             FROM institution_microsoft_policies
             WHERE university_id = ANY($1::uuid[])
               AND enabled
               AND mode = 'graph_enrollment'
               AND approved_until > clock_timestamp()
               AND term_ends_at IS NOT NULL
               AND term_ends_at > clock_timestamp()`,
            [universityIds],
        )).rows;
        for (const row of policies) graphPolicies.add(row.university_id);
    }

    const schoolValidByStudent = new Map((await store.query<{ student_id: string; valid_until: Date }>(
        `SELECT DISTINCT ON (evidence.student_id) evidence.student_id AS student_id,
                LEAST(evidence.expires_at, evidence.verified_at + interval '90 days') AS valid_until
         FROM eligibility_evidence evidence
         JOIN user_email_proofs proofs ON proofs.id = evidence.email_proof_id
         JOIN verification_consents grants ON grants.id = evidence.processing_grant_id
         JOIN students ON students.id = evidence.student_id
         JOIN approved_student_email_domains domains
           ON domains.university_id = evidence.university_id
           AND domains.domain = split_part(proofs.email, '@', 2)
           AND domains.is_active
         JOIN universities institutions
           ON institutions.id = evidence.university_id AND institutions.is_active
         ${ctxJoin(2)}
         WHERE evidence.method = 'student_email' AND evidence.outcome = 'verified'
           AND evidence.revoked_at IS NULL
           AND grants.user_id = students.user_id
           AND grants.kind = 'processing' AND grants.accepted
           AND grants.notice_version = $1 AND grants.withdrawn_at IS NULL
           AND LEAST(evidence.expires_at, evidence.verified_at + interval '90 days') > clock_timestamp()
         ORDER BY evidence.student_id, evidence.verified_at DESC, evidence.id DESC`,
        [VERIFICATION_NOTICE_VERSION, contextsJson],
    )).rows.map((row) => [row.student_id, row] as const));

    const schoolExpiredByStudent = new Map((await store.query<{ student_id: string; valid_until: Date }>(
        `SELECT DISTINCT ON (evidence.student_id) evidence.student_id AS student_id,
                LEAST(evidence.expires_at, evidence.verified_at + interval '90 days') AS valid_until
         FROM eligibility_evidence evidence
         JOIN user_email_proofs proofs ON proofs.id = evidence.email_proof_id
         JOIN verification_consents grants ON grants.id = evidence.processing_grant_id
         JOIN students ON students.id = evidence.student_id
         JOIN approved_student_email_domains domains
           ON domains.university_id = evidence.university_id
           AND domains.domain = split_part(proofs.email, '@', 2)
           AND domains.is_active
         JOIN universities institutions
           ON institutions.id = evidence.university_id AND institutions.is_active
         ${ctxJoin(2)}
         WHERE evidence.method = 'student_email' AND evidence.outcome = 'verified'
           AND evidence.revoked_at IS NULL
           AND grants.user_id = students.user_id
           AND grants.kind = 'processing' AND grants.accepted
           AND grants.notice_version = $1 AND grants.withdrawn_at IS NULL
         ORDER BY evidence.student_id, evidence.expires_at DESC, evidence.id DESC`,
        [VERIFICATION_NOTICE_VERSION, contextsJson],
    )).rows.map((row) => [row.student_id, row] as const));

    for (const context of active) {
        const studentContext: StudentContext = {
            userId: context.user_id,
            studentId: context.student_id,
            email: context.email,
            universityId: context.university_id,
            identityVersion: context.identity_version,
            policyVersion: context.policy_version,
            active: context.active,
        };
        // Mirror the point reader's school precedence: an expired row is only
        // consulted when no current row exists.
        const schoolProjection = resolveSchoolAccount({
            method: 'email_otp',
            validUntil: schoolValidByStudent.get(context.student_id)?.valid_until.toISOString() ?? null,
            expiredValidUntil: schoolExpiredByStudent.get(context.student_id)?.valid_until.toISOString() ?? null,
        });

        const state = stateByStudent.get(context.student_id);
        const eligibility = projectEligibility(
            studentContext, state, candidatesByStudent.get(context.student_id) ?? [],
            authorityByProof, now,
        );
        if (eligibility.eligible) {
            const ordered = candidatesByStudent.get(context.student_id) ?? [];
            const source = ordered.find((candidate) => candidate.evidence_id === eligibility.evidenceId)?.source
                ?? (state?.evidence_id === eligibility.evidenceId ? state.source : null)
                ?? null;
            page.set(context.user_id, {
                ...schoolProjection,
                ...resolveStudentStatus(eligibility, source, {
                    revokedOrWithdrawn: false,
                    expiredMethod: null,
                    expiredValidUntil: null,
                    identityChanged: false,
                    policyChanged: false,
                    providerUnavailable: false,
                }),
            });
            continue;
        }
        const expired = expiredByStudent.get(context.student_id);
        const drifted = driftedByStudent.get(context.student_id);
        const flags: EnrollmentAssuranceFlags = {
            revokedOrWithdrawn: revoked.has(context.student_id),
            expiredMethod: enrollmentMethodFromSource(expired?.source ?? null),
            expiredValidUntil: expired ? expired.expires_at.toISOString() : null,
            identityChanged: drifted !== undefined && drifted.identity_version !== context.identity_version,
            policyChanged: drifted !== undefined
                && drifted.identity_version === context.identity_version
                && drifted.policy_version !== context.policy_version,
            providerUnavailable: microsoftCandidates.has(context.student_id)
                && (!config.microsoftOidc.enabled || !graphPolicies.has(context.university_id)),
        };
        page.set(context.user_id, { ...schoolProjection, ...resolveStudentStatus(eligibility, null, flags) });
    }
    return page;
}

function projectEligibility(
    context: StudentContext,
    state: StateRow | undefined,
    orderedCandidates: EvidenceRow[],
    authorityByProof: Map<string, AuthorityRow>,
    now: Date,
): EligibilityResult {
    // Unlocked mirror of getEffectiveEligibility without a merchant
    // disclosure: same denial short-circuit, same fast path, same
    // independent-enrollment scan order, same reason tail.
    if (!state || state.state_university_id !== context.universityId) {
        return { eligible: false, reason: 'unverified' };
    }
    if (state.authoritative_denial) return { eligible: false, reason: 'enrollment_denied' };
    if (!state.evidence_id || state.outcome !== 'verified' || !state.method
        || !state.verified_at || !state.expires_at) {
        return { eligible: false, reason: 'unverified' };
    }
    let selected: EvidenceRow | undefined;
    if (state.method === 'enrollment' && isRecognizedEnrollmentSource(state.source)) {
        if (state.source === MICROSOFT_ENROLLMENT_SOURCE) {
            if (state.provider_proof_id
                && state.processing_grant_id
                && state.proof_email === context.email
                && state.evidence_identity_version === context.identityVersion
                && state.evidence_policy_version === context.policyVersion
                && state.revoked_at === null
                && state.processing_current === true
                && microsoftAuthorityValid(state, context, authorityByProof.get(state.provider_proof_id), now)) {
                selected = state;
            }
        } else if (state.revoked_at === null
            && state.proof_email === context.email
            && state.evidence_identity_version === context.identityVersion
            && state.evidence_policy_version === context.policyVersion
            && state.processing_current === true
            && state.expires_at > now) {
            selected = state;
        }
    }
    if (!selected) {
        for (const candidate of orderedCandidates) {
            if (candidate.source === MICROSOFT_ENROLLMENT_SOURCE) {
                const authority = candidate.provider_proof_id
                    ? authorityByProof.get(candidate.provider_proof_id)
                    : undefined;
                if (microsoftAuthorityValid(candidate, context, authority, now)) {
                    selected = candidate;
                    break;
                }
                continue;
            }
            selected = candidate;
            break;
        }
    }
    if (selected) {
        // Required invariant after complete source validation:
        if (selected.method !== 'enrollment') return { eligible: false, reason: 'unverified' };
        if (!selected.expires_at || selected.expires_at <= now) return { eligible: false, reason: 'expired' };
        if (selected.source === MICROSOFT_ENROLLMENT_SOURCE && !config.microsoftOidc.enabled) {
            return { eligible: false, reason: 'unverified' };
        }
        return {
            eligible: true,
            studentId: context.studentId,
            universityId: context.universityId,
            evidenceId: selected.evidence_id as string,
            processingGrantId: selected.processing_grant_id as string,
            method: selected.method,
            verifiedAt: selected.verified_at as Date,
            expiresAt: selected.expires_at,
        };
    }
    if (state.method === 'enrollment') {
        if (state.evidence_identity_version !== context.identityVersion) {
            return { eligible: false, reason: 'identity_changed' };
        }
        if (state.evidence_policy_version !== context.policyVersion) {
            return { eligible: false, reason: 'policy_changed' };
        }
        if (state.revoked_at !== null || state.processing_current !== true) {
            return { eligible: false, reason: 'consent_required' };
        }
        if (state.proof_email !== context.email) return { eligible: false, reason: 'identity_changed' };
        if (state.expires_at <= now) return { eligible: false, reason: 'expired' };
    }
    return { eligible: false, reason: 'unverified' };
}
