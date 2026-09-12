import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AppError, BadRequestError, ForbiddenError, NotFoundError, ServiceUnavailableError } from '../../common/errors/AppError.js';
import { lockStudentContext } from './eligibility-context.service.js';
import { hasSupportedMicrosoftScopes, sameConsentSnapshot } from './microsoft-policy.js';
import type { AcceptMicrosoftConsent, MicrosoftConsentHistoryItem, MicrosoftConsentNotice, MicrosoftConsentSnapshot } from './microsoft.types.js';
import { VERIFICATION_NOTICE_VERSION } from './verification-notices.js';

type PolicyRow = {
    university_id: string;
    version: number;
    enabled: boolean;
    mode: 'identity_only' | 'graph_enrollment';
    approved_until: Date;
    term_ends_at: Date | null;
    scopes: string[];
    notice_version: string;
};

function consentNoticeChanged(): never {
    throw new AppError('Microsoft consent notice changed', 409, 'consent_notice_changed');
}

function assertSnapshot(input: MicrosoftConsentSnapshot): void {
    if (!input || typeof input.universityId !== 'string' || !Number.isInteger(input.providerPolicyVersion)
        || input.providerPolicyVersion < 1 || typeof input.noticeVersion !== 'string' || !input.noticeVersion.trim()
        || (input.mode !== 'identity_only' && input.mode !== 'graph_enrollment') || !Array.isArray(input.scopes)
        || input.scopes.some((scope) => typeof scope !== 'string' || !scope.trim())
        || input.scopes.some((scope, index) => index > 0 && scope <= input.scopes[index - 1]!)) {
        throw new BadRequestError('Invalid Microsoft consent snapshot');
    }
}

function snapshotFrom(row: PolicyRow): MicrosoftConsentSnapshot {
    return {
        universityId: row.university_id,
        providerPolicyVersion: row.version,
        noticeVersion: row.notice_version,
        mode: row.mode,
        scopes: [...row.scopes].sort(),
    };
}

function validCurrentPolicy(policy: PolicyRow, now: Date): boolean {
    return policy.enabled && policy.approved_until > now
        && (policy.mode !== 'graph_enrollment' || (policy.term_ends_at !== null && policy.term_ends_at > now))
        && hasSupportedMicrosoftScopes(policy.mode, policy.scopes);
}

async function lockPolicy(tx: PoolClient, universityId: string): Promise<PolicyRow> {
    const result = await tx.query<PolicyRow>(
        `SELECT university_id, version, enabled, mode, approved_until, term_ends_at, scopes, notice_version
         FROM institution_microsoft_policies WHERE university_id = $1 FOR UPDATE`, [universityId],
    );
    const policy = result.rows[0];
    if (!policy) throw new NotFoundError('Microsoft institution policy not found');
    return policy;
}

export async function acceptMicrosoftConsent(
    tx: PoolClient, userId: string, input: AcceptMicrosoftConsent,
): Promise<string> {
    if (!input || input.accepted !== true || typeof input.processingGrantId !== 'string') {
        throw new BadRequestError('Affirmative Microsoft consent required');
    }
    assertSnapshot(input.snapshot);
    const context = await lockStudentContext(tx, userId);
    if (!context.active || context.universityId !== input.snapshot.universityId) {
        throw new BadRequestError('Active canonical student context required');
    }
    const parent = await tx.query(
        `SELECT id FROM verification_consents WHERE id = $1 AND user_id = $2 AND university_id = $3
           AND kind = 'processing' AND accepted AND withdrawn_at IS NULL AND notice_version = $4 FOR UPDATE`,
        [input.processingGrantId, userId, context.universityId, VERIFICATION_NOTICE_VERSION],
    );
    if (parent.rowCount !== 1) throw new BadRequestError('Current verification processing consent required');
    const policy = await lockPolicy(tx, context.universityId);
    const current = snapshotFrom(policy);
    const now = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
    if (!validCurrentPolicy(policy, now)) {
        consentNoticeChanged();
    }
    if (!sameConsentSnapshot(input.snapshot, current)) consentNoticeChanged();
    const id = randomUUID();
    await tx.query(
        `INSERT INTO microsoft_verification_consents
             (id, user_id, university_id, processing_grant_id, provider_policy_version, notice_version, mode, scopes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, userId, context.universityId, input.processingGrantId, current.providerPolicyVersion,
            current.noticeVersion, current.mode, current.scopes],
    );
    await tx.query(
        `INSERT INTO verification_audit_events (user_id, university_id, event_type, metadata)
         VALUES ($1, $2, 'microsoft_consent_accepted', jsonb_build_object('providerPolicyVersion', $3::int))`,
        [userId, context.universityId, current.providerPolicyVersion],
    );
    return id;
}

/**
 * Returns the immutable version the caller must render. v1/v2 are retained
 * for historical grants, but cannot be used for new HTTP acceptance because
 * they predate the approved retention/withdrawal explanation.
 */
export async function getMicrosoftConsentNotice(tx: PoolClient, userId: string): Promise<MicrosoftConsentNotice> {
    const context = await lockStudentContext(tx, userId);
    if (!context.active) throw new ServiceUnavailableError('Microsoft verification is unavailable');
    const result = await tx.query<PolicyRow & { content: string }>(
        `SELECT policy.university_id, policy.version, policy.enabled, policy.mode, policy.approved_until,
                policy.term_ends_at, policy.scopes, policy.notice_version, notice.content
         FROM institution_microsoft_policies policy
         JOIN microsoft_published_notices notice ON notice.version = policy.notice_version
         WHERE policy.university_id = $1 FOR UPDATE OF policy`, [context.universityId],
    );
    const policy = result.rows[0];
    const now = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]?.now;
    if (!policy || !now || !validCurrentPolicy(policy, now) || policy.notice_version !== 'microsoft-v3') {
        throw new ServiceUnavailableError('Microsoft verification is unavailable');
    }
    return { snapshot: snapshotFrom(policy), copy: { text: policy.content } };
}

export async function listMicrosoftConsents(
    tx: PoolClient, userId: string, cursor: string | undefined,
): Promise<{ items: MicrosoftConsentHistoryItem[]; nextCursor: string | null }> {
    const result = await tx.query<{
        id: string; university_id: string; provider_policy_version: number; notice_version: string;
        mode: 'identity_only' | 'graph_enrollment'; scopes: string[]; accepted_at: Date; withdrawn_at: Date | null;
    }>(
        `WITH cursor_row AS (
             SELECT accepted_at, id FROM microsoft_verification_consents WHERE id = $2 AND user_id = $1
         )
         SELECT id, university_id, provider_policy_version, notice_version, mode, scopes, accepted_at, withdrawn_at
         FROM microsoft_verification_consents
         WHERE user_id = $1
           AND ($2::uuid IS NULL OR (accepted_at, id) < (SELECT accepted_at, id FROM cursor_row))
         ORDER BY accepted_at DESC, id DESC
         LIMIT 21`, [userId, cursor ?? null],
    );
    if (cursor && result.rows.length === 0) {
        const valid = await tx.query('SELECT 1 FROM microsoft_verification_consents WHERE id=$1 AND user_id=$2', [cursor, userId]);
        if (valid.rowCount !== 1) throw new BadRequestError('Invalid Microsoft consent cursor');
    }
    const page = result.rows.slice(0, 20);
    return {
        items: page.map((row) => ({
            id: row.id,
            snapshot: { universityId: row.university_id, providerPolicyVersion: row.provider_policy_version,
                noticeVersion: row.notice_version, mode: row.mode, scopes: row.scopes },
            acceptedAt: row.accepted_at, withdrawnAt: row.withdrawn_at,
        })),
        nextCursor: result.rows.length > 20 ? page.at(-1)!.id : null,
    };
}

export async function withdrawMicrosoftConsent(tx: PoolClient, userId: string, consentId: string): Promise<void> {
    const target = await tx.query<{ user_id: string; university_id: string }>(
        `SELECT user_id, university_id FROM microsoft_verification_consents WHERE id = $1`, [consentId],
    );
    const row = target.rows[0];
    if (!row) throw new NotFoundError('Microsoft consent not found');
    if (row.user_id !== userId) throw new ForbiddenError('Microsoft consent belongs to another user');
    const subject = await tx.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (subject.rowCount !== 1) throw new NotFoundError('Microsoft consent subject not found');
    const student = await tx.query<{ id: string; university_id: string | null }>(
        'SELECT id, university_id FROM students WHERE user_id = $1 FOR UPDATE', [userId],
    );
    const universityIds = [student.rows[0]?.university_id, row.university_id]
        .filter((id): id is string => id !== null && id !== undefined)
        .filter((id, index, all) => all.indexOf(id) === index).sort();
    for (const universityId of universityIds) {
        const university = await tx.query('SELECT id FROM universities WHERE id = $1 FOR UPDATE', [universityId]);
        if (university.rowCount !== 1) throw new NotFoundError('Microsoft consent institution not found');
    }
    if (student.rows[0]) for (const universityId of universityIds) {
        await tx.query(`SELECT student_id FROM student_eligibility_state WHERE student_id = $1 AND university_id = $2 FOR UPDATE`, [student.rows[0].id, universityId]);
    }
    const locked = await tx.query<{ user_id: string; university_id: string }>(
        `SELECT user_id, university_id FROM microsoft_verification_consents WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [consentId, userId],
    );
    if (!locked.rows[0]) throw new NotFoundError('Microsoft consent not found');
    await tx.query(`UPDATE microsoft_verification_consents SET withdrawn_at = COALESCE(withdrawn_at, clock_timestamp()) WHERE id = $1`, [consentId]);
    await tx.query(
        `UPDATE microsoft_verification_attempts
         SET status = 'failed', encrypted_verifier = NULL, nonce = NULL, result = NULL
         WHERE provider_consent_id = $1 AND status IN ('pending', 'processing', 'ready')`, [consentId],
    );
    await tx.query(`UPDATE microsoft_provider_proofs SET revoked_at = clock_timestamp() WHERE provider_consent_id = $1 AND revoked_at IS NULL`, [consentId]);
    await tx.query(
        `INSERT INTO verification_audit_events (user_id, university_id, event_type, metadata)
         VALUES ($1, $2, 'microsoft_consent_withdrawn', '{}'::jsonb)`, [userId, row.university_id],
    );
}
