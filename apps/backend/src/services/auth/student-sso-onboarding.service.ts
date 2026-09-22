import type { PoolClient } from 'pg';
import { ConflictError } from '../../common/errors/AppError.js';
import { normalizeStudentDomain } from '../verification/eligibility-policy.service.js';
import {
    currentMicrosoftProof,
    type EvidenceCandidate,
} from '../verification/eligibility-read.service.js';
import { MICROSOFT_ENROLLMENT_SOURCE, type StudentContext } from '../verification/eligibility.types.js';
import { VERIFICATION_NOTICE_VERSION } from '../verification/verification-notices.js';
import { GOOGLE_ISSUER } from './student-google-oidc.js';
import type { ApprovedLoginPolicy, ProviderObservation } from './student-sso.types.js';

/**
 * Shared SSO link/assertion primitives (Task B4).
 *
 * This module is deliberately a leaf: the B3 flow service and the B4 link
 * service both import from here, so nothing here may import either of them.
 * It holds the moved login-policy/observation helpers (behavior unchanged
 * from B3) plus the link mailbox proof, the Microsoft membership check, and
 * the canonical locked school-assertion writer.
 *
 * Canonical lock order for link/unlink writers, extending the B3 chain:
 * users → students → universities → institution_login_policies →
 * student_auth_identities → student_auth_attempts → student_auth_link_handoffs
 * → student_auth_reauth_grants → verification authority (grants, Microsoft
 * policy/consents/identities/proofs) → student_school_assertions. No network
 * call ever runs inside these transactions.
 */

const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalidAttempt(): ConflictError {
    return new ConflictError('Student SSO attempt is no longer valid');
}

/** Authority revoked after the cookie check: the browser gets a bounded redirect, not a raw error. */
export class StudentSsoAuthorityInvalidatedError extends ConflictError {
    constructor() {
        super('Student SSO attempt is no longer valid');
    }
}

/** Fail closed on misconfigured policy trust data before any provider call. */
export function assertAdapterPolicy(policy: ApprovedLoginPolicy): void {
    if (policy.provider === 'google') {
        try {
            normalizeStudentDomain(policy.realm);
        } catch {
            throw invalidAttempt();
        }
        if (policy.issuer !== GOOGLE_ISSUER) throw invalidAttempt();
        return;
    }
    if (!TENANT_UUID.test(policy.realm)) throw invalidAttempt();
    if (policy.issuer !== `https://login.microsoftonline.com/${policy.realm}/v2.0`) throw invalidAttempt();
}

export function encodeProviderObservation(observation: ProviderObservation): string {
    return JSON.stringify({
        provider: observation.provider,
        issuer: observation.issuer,
        subject: observation.subject,
        email: observation.email,
        mailboxVerified: observation.mailboxVerified,
        realm: observation.realm,
        schoolMembershipAttested: observation.schoolMembershipAttested,
    });
}

export function decodeProviderObservation(raw: string): ProviderObservation {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw invalidAttempt();
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidAttempt();
    const value = parsed as Record<string, unknown>;
    if ((value.provider !== 'google' && value.provider !== 'microsoft')
        || typeof value.issuer !== 'string' || value.issuer === ''
        || typeof value.subject !== 'string' || value.subject === ''
        || (typeof value.email !== 'string' && value.email !== null)
        || typeof value.mailboxVerified !== 'boolean'
        || typeof value.realm !== 'string'
        || typeof value.schoolMembershipAttested !== 'boolean') {
        throw invalidAttempt();
    }
    return {
        provider: value.provider,
        issuer: value.issuer,
        subject: value.subject,
        email: value.email,
        mailboxVerified: value.mailboxVerified,
        realm: value.realm,
        schoolMembershipAttested: value.schoolMembershipAttested,
    };
}

/** A login policy rechecked under lock, with the assertion-writing fields. */
export type CurrentLoginPolicy = ApprovedLoginPolicy & {
    schoolAssertionDays: number;
    approvedUntil: Date;
};

/**
 * Current-policy recheck under the policy lock: enabled, live approval,
 * pinned version, active university, active domain mapping. Trust edits
 * increment the version under the same lock, so equality is meaningful.
 */
export async function assertCurrentLoginPolicy(
    tx: PoolClient,
    policyId: string,
    version: number,
    mailbox: string,
): Promise<CurrentLoginPolicy> {
    await tx.query('SELECT id FROM institution_login_policies WHERE id = $1 FOR UPDATE', [policyId]);
    const domain = mailbox.slice(mailbox.lastIndexOf('@') + 1);
    const result = await tx.query<{
        id: string; university_id: string; provider: string; issuer: string; provider_realm: string;
        version: number; school_assertion_days: number; approved_until: Date;
    }>(
        `SELECT p.id, p.university_id, p.provider, p.issuer, p.provider_realm, p.version,
                p.school_assertion_days, p.approved_until
         FROM institution_login_policies p
         JOIN universities u ON u.id = p.university_id AND u.is_active
         JOIN institution_login_domain_providers dp
           ON dp.policy_id = p.id
          AND dp.university_id = p.university_id
          AND dp.provider = p.provider
         JOIN institution_login_domains d
           ON d.domain = dp.domain
          AND d.university_id = dp.university_id
          AND d.is_active
         WHERE p.id = $1
           AND p.version = $2
           AND p.enabled
           AND p.approved_until IS NOT NULL
           AND p.approved_until > clock_timestamp()
           AND d.domain = $3`,
        [policyId, version, domain],
    );
    const row = result.rows[0];
    if (!row || (row.provider !== 'google' && row.provider !== 'microsoft')) {
        throw new StudentSsoAuthorityInvalidatedError();
    }
    const policy: CurrentLoginPolicy = {
        id: row.id,
        universityId: row.university_id,
        provider: row.provider,
        issuer: row.issuer,
        realm: row.provider_realm,
        version: row.version,
        schoolAssertionDays: row.school_assertion_days,
        approvedUntil: row.approved_until,
    };
    try {
        assertAdapterPolicy(policy);
    } catch {
        throw new StudentSsoAuthorityInvalidatedError();
    }
    return policy;
}

export type ProvenSchoolMailbox = {
    email: string;
};

/**
 * The account's independently proven school mailbox, if any. The predicates
 * mirror the A2 school-account projection exactly (active approved domain,
 * matching identity/policy versions, current processing grant, unexpired
 * evidence capped at 90 days): a mailbox that would not read as
 * school-verified cannot bind a provider link either.
 */
export async function readProvenSchoolMailbox(
    tx: PoolClient,
    userId: string,
    context: StudentContext,
): Promise<ProvenSchoolMailbox | null> {
    const proven = await tx.query<{ email: string }>(
        `SELECT proofs.email AS email
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
        [
            context.studentId,
            context.universityId,
            context.identityVersion,
            context.policyVersion,
            context.email,
            userId,
            VERIFICATION_NOTICE_VERSION,
        ],
    );
    const row = proven.rows[0];
    return row ? { email: row.email } : null;
}

/**
 * Trusted Microsoft membership for the login tenant: every tenant-scoped
 * Microsoft enrollment candidate is validated through the shared
 * currentMicrosoftProof predicate (live consent, tenant-bound identity,
 * outcome student). Guests and missing membership return false, which
 * permits linked login but records no positive school assertion.
 */
export async function hasCurrentMicrosoftMembership(
    tx: PoolClient,
    userId: string,
    context: StudentContext,
    tenantId: string,
): Promise<boolean> {
    if (!TENANT_UUID.test(tenantId)) return false;
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
         JOIN microsoft_provider_proofs provider_proof ON provider_proof.id = evidence.provider_proof_id
         JOIN microsoft_identities identity ON identity.id = provider_proof.identity_id
         WHERE evidence.student_id = $1
           AND evidence.university_id = $2
           AND evidence.method = 'enrollment'
           AND evidence.outcome = 'verified'
           AND evidence.revoked_at IS NULL
           AND evidence.identity_version = $3
           AND evidence.policy_version = $4
           AND proofs.email = $5
           AND evidence.source = $6
           AND evidence.provider_proof_id IS NOT NULL
           AND evidence.expires_at > clock_timestamp()
           AND identity.tenant_id = $7::uuid
         ORDER BY evidence.verified_at DESC, evidence.id DESC`,
        [
            context.studentId,
            context.universityId,
            context.identityVersion,
            context.policyVersion,
            context.email,
            MICROSOFT_ENROLLMENT_SOURCE,
            tenantId,
        ],
    );
    for (const candidate of candidates.rows) {
        if (await currentMicrosoftProof(tx, userId, context, candidate)) return true;
    }
    return false;
}

export type SsoSchoolAssertionInput = {
    userId: string;
    universityId: string;
    identityVersion: number;
    identityId: string;
    policy: {
        id: string;
        version: number;
        schoolAssertionDays: number;
        approvedUntil: Date;
    };
    observation: ProviderObservation;
    microsoftMembershipAttested: boolean;
};

/**
 * Canonical locked school-assertion writer, used by first-use linking and
 * the existing-identity finish transaction. Google asserts only on an
 * approved hosted-domain attestation; Microsoft asserts only on trusted
 * membership evidence. Anything else records nothing. This writes
 * student_school_assertions rows only and never touches enrollment evidence.
 */
export async function writeSsoSchoolAssertion(
    tx: PoolClient,
    input: SsoSchoolAssertionInput,
): Promise<'recorded' | 'not_attested'> {
    const source = input.observation.provider === 'google'
        ? (input.observation.schoolMembershipAttested ? 'google_workspace' : null)
        : (input.microsoftMembershipAttested ? 'microsoft_school' : null);
    if (!source) return 'not_attested';
    await tx.query(
        `INSERT INTO student_school_assertions
             (user_id, university_id, source, auth_identity_id, login_policy_id,
              policy_version, identity_version, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 LEAST(clock_timestamp() + make_interval(days => $8), $9::timestamptz))`,
        [
            input.userId,
            input.universityId,
            source,
            input.identityId,
            input.policy.id,
            input.policy.version,
            input.identityVersion,
            input.policy.schoolAssertionDays,
            input.policy.approvedUntil,
        ],
    );
    return 'recorded';
}

/** One-way revocation of every school assertion bound to a login identity. Email-OTP mailbox assertions are untouched. */
export async function revokeSsoSchoolAssertions(tx: PoolClient, identityId: string): Promise<number> {
    const revoked = await tx.query(
        `UPDATE student_school_assertions
         SET revoked_at = clock_timestamp()
         WHERE auth_identity_id = $1 AND revoked_at IS NULL`,
        [identityId],
    );
    return revoked.rowCount ?? 0;
}
