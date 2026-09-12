import type { PoolClient } from 'pg';
import { ConflictError } from '../../common/errors/AppError.js';
import { lockStudentContext } from './eligibility-context.service.js';
import { assertMicrosoftSession, type MicrosoftSessionUse } from './microsoft-session.service.js';
import { VERIFICATION_NOTICE_VERSION } from './verification-notices.js';

export const IDENTITY_ONLY_MICROSOFT_SCOPES = ['openid', 'profile'] as const;
export const GRAPH_ENROLLMENT_MICROSOFT_SCOPES = ['https://graph.microsoft.com/EduRoster.ReadBasic', 'openid', 'profile'] as const;

export type MicrosoftPolicyAuthority = {
    tenant_id: string;
    version: number;
    enabled: boolean;
    mode: 'identity_only' | 'graph_enrollment';
    approved_until: Date;
    term_ends_at: Date | null;
    max_evidence_hours: number;
    scopes: string[];
    notice_version: string;
};

export type MicrosoftAttemptAuthority = {
    user_id: string;
    university_id: string;
    institution_policy_version: number;
    provider_policy_version: number;
    identity_version: number;
    processing_grant_id: string;
    provider_consent_id: string;
    server_session_id: string;
};

export type MicrosoftAuthority = {
    policy: MicrosoftPolicyAuthority;
    studentId: string;
    identityVersion: number;
    institutionPolicyVersion: number;
    universityId: string;
    authoritativeDenial: boolean;
};

function invalidAttempt(): ConflictError {
    return new ConflictError('Microsoft verification attempt is no longer valid');
}

function sameScopes(actual: readonly string[], expected: readonly string[]): boolean {
    return actual.length === expected.length && actual.every((scope, index) => scope === expected[index]);
}

/**
 * Locks Microsoft authority in the canonical order: live session, current
 * user/student/university context, state, parent grant, policy, provider
 * consent, then (at the caller) the attempt and its dependent proof/evidence.
 * It deliberately performs no provider I/O.
 */
export async function assertMicrosoftAuthority(
    tx: PoolClient,
    input: {
        userId: string;
        sid: string;
        use: MicrosoftSessionUse;
        processingGrantId: string;
        providerConsentId: string;
        expected?: MicrosoftAttemptAuthority;
        mode?: 'identity_only' | 'graph_enrollment';
    },
): Promise<MicrosoftAuthority> {
    const session = await assertMicrosoftSession(tx, input.userId, input.sid, input.use);
    const context = await lockStudentContext(tx, session.userId);
    if (!context.active) throw invalidAttempt();
    if (input.mode === 'graph_enrollment') {
        await tx.query(
            `INSERT INTO student_eligibility_state (student_id, university_id)
             VALUES ($1, $2) ON CONFLICT (student_id, university_id) DO NOTHING`,
            [context.studentId, context.universityId],
        );
    }
    const state = await tx.query<{ authoritative_denial: boolean }>(
        `SELECT authoritative_denial FROM student_eligibility_state
         WHERE student_id = $1 AND university_id = $2 FOR UPDATE`,
        [context.studentId, context.universityId],
    );
    const parent = await tx.query(
        `SELECT id FROM verification_consents WHERE id=$1 AND user_id=$2 AND university_id=$3
         AND kind='processing' AND accepted AND withdrawn_at IS NULL AND notice_version=$4 FOR UPDATE`,
        [input.processingGrantId, input.userId, context.universityId, VERIFICATION_NOTICE_VERSION],
    );
    if (parent.rowCount !== 1) throw invalidAttempt();
    const policies = await tx.query<MicrosoftPolicyAuthority>(
        `SELECT tenant_id, version, enabled, mode, approved_until, term_ends_at, max_evidence_hours, scopes, notice_version
         FROM institution_microsoft_policies WHERE university_id=$1 FOR UPDATE`,
        [context.universityId],
    );
    const policy = policies.rows[0];
    const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const expectedMode = input.mode ?? 'identity_only';
    const expectedScopes = expectedMode === 'graph_enrollment'
        ? GRAPH_ENROLLMENT_MICROSOFT_SCOPES : IDENTITY_ONLY_MICROSOFT_SCOPES;
    if (!policy || !policy.enabled || policy.mode !== expectedMode || policy.approved_until <= clock.rows[0]!.now
        || (expectedMode === 'graph_enrollment' && (!policy.term_ends_at || policy.term_ends_at <= clock.rows[0]!.now))
        || !sameScopes(policy.scopes, expectedScopes)) throw invalidAttempt();
    const provider = await tx.query(
        `SELECT id FROM microsoft_verification_consents WHERE id=$1 AND user_id=$2 AND university_id=$3
         AND processing_grant_id=$4 AND provider_policy_version=$5 AND notice_version=$6
         AND mode=$7 AND scopes=$8::text[] AND withdrawn_at IS NULL FOR UPDATE`,
        [input.providerConsentId, input.userId, context.universityId, input.processingGrantId,
            policy.version, policy.notice_version, expectedMode, policy.scopes],
    );
    if (provider.rowCount !== 1) throw invalidAttempt();
    if (input.expected && (input.expected.user_id !== input.userId || input.expected.university_id !== context.universityId
        || input.expected.server_session_id !== input.sid || input.expected.identity_version !== context.identityVersion
        || input.expected.institution_policy_version !== context.policyVersion || input.expected.provider_policy_version !== policy.version
        || input.expected.processing_grant_id !== input.processingGrantId || input.expected.provider_consent_id !== input.providerConsentId)) {
        throw invalidAttempt();
    }
    return { policy, studentId: context.studentId, identityVersion: context.identityVersion,
        institutionPolicyVersion: context.policyVersion, universityId: context.universityId,
        authoritativeDenial: state.rows[0]?.authoritative_denial === true };
}
