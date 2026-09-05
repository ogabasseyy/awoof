import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../common/errors/AppError.js';
import { lockStudentContext } from './eligibility-context.service.js';
import { canonicalWidgetOrigin, prepareMerchantDisclosure } from './eligibility-merchant-context.service.js';
import { MERCHANT_DISCLOSURE_NOTICE_VERSION, VERIFICATION_NOTICE_VERSION } from './verification-notices.js';

function assertCurrentAction(
    accepted: boolean,
    noticeVersion: string,
    expectedVersion: string,
    description: string,
): void {
    if (accepted !== true || noticeVersion !== expectedVersion) {
        throw new BadRequestError(`Current ${description} consent required`);
    }
}

async function assertActiveStudent(tx: PoolClient, userId: string, universityId?: string): Promise<void> {
    const context = await lockStudentContext(tx, userId);
    if (!context.active || (universityId !== undefined && context.universityId !== universityId)) {
        throw new BadRequestError('Active canonical student context required');
    }
}

export async function grantVerificationProcessing(
    tx: PoolClient,
    userId: string,
    universityId: string,
    action: { accepted: true; noticeVersion: string },
): Promise<string> {
    assertCurrentAction(action.accepted, action.noticeVersion, VERIFICATION_NOTICE_VERSION, 'verification processing');
    await assertActiveStudent(tx, userId, universityId);
    const id = randomUUID();
    await tx.query(
        `INSERT INTO verification_consents (id, user_id, kind, university_id, notice_version, accepted)
         VALUES ($1, $2, 'processing', $3, $4, true)`,
        [id, userId, universityId, action.noticeVersion],
    );
    await tx.query(
        `INSERT INTO verification_audit_events (user_id, university_id, event_type, metadata)
         VALUES ($1, $2, 'verification_processing_granted', jsonb_build_object('noticeVersion', $3::text))`,
        [userId, universityId, action.noticeVersion],
    );
    return id;
}

export async function grantMerchantDisclosure(
    tx: PoolClient,
    userId: string,
    input: { vendorId: string; origin: string; purpose: string; accepted: true; noticeVersion: string },
): Promise<string> {
    assertCurrentAction(input.accepted, input.noticeVersion, MERCHANT_DISCLOSURE_NOTICE_VERSION, 'merchant disclosure');
    if (typeof input.purpose !== 'string' || input.purpose.trim().length === 0) {
        throw new BadRequestError('Disclosure purpose required');
    }
    const origin = canonicalWidgetOrigin(input.origin);
    // This is the transaction entrypoint: participant user locks precede every
    // subject/context lock. See prepareMerchantDisclosure's contract.
    if (!await prepareMerchantDisclosure(tx, userId, input.vendorId, origin)) {
        throw new NotFoundError('Live merchant widget origin not configured');
    }
    await assertActiveStudent(tx, userId);

    const id = randomUUID();
    await tx.query(
        `INSERT INTO verification_consents
             (id, user_id, kind, vendor_id, origin, purpose, notice_version, accepted)
         VALUES ($1, $2, 'disclosure', $3, $4, $5, $6, true)`,
        [id, userId, input.vendorId, origin, input.purpose.trim(), input.noticeVersion],
    );
    await tx.query(
        `INSERT INTO verification_audit_events (user_id, event_type, metadata)
         VALUES ($1, 'merchant_disclosure_granted', jsonb_build_object('vendorId', $2::text, 'origin', $3::text))`,
        [userId, input.vendorId, origin],
    );
    return id;
}

export async function withdrawConsent(tx: PoolClient, userId: string, grantId: string): Promise<void> {
    const preliminary = await tx.query<{
        user_id: string;
        kind: 'processing' | 'disclosure';
        university_id: string | null;
    }>(
        `SELECT user_id, kind, university_id
         FROM verification_consents
         WHERE id = $1`,
        [grantId],
    );
    const target = preliminary.rows[0];
    if (!target) throw new NotFoundError('Consent not found');
    if (target.user_id !== userId) throw new ForbiddenError('Consent belongs to another user');

    // Withdrawal intentionally permits inactive/historical subjects. It locks
    // user, student, every current/historical institution, and state before
    // consent, matching readers/application and avoiding the audit-FK cycle.
    const subject = await tx.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (subject.rowCount !== 1) throw new NotFoundError('Consent subject not found');
    const student = await tx.query<{ id: string; university_id: string | null }>(
        'SELECT id, university_id FROM students WHERE user_id = $1 FOR UPDATE',
        [userId],
    );
    const relevantInstitutions = [student.rows[0]?.university_id, target.university_id]
        .filter((id): id is string => id !== null && id !== undefined)
        .filter((id, index, all) => all.indexOf(id) === index)
        .sort();
    for (const universityId of relevantInstitutions) {
        const university = await tx.query('SELECT id FROM universities WHERE id = $1 FOR UPDATE', [universityId]);
        if (university.rowCount !== 1) throw new NotFoundError('Consent institution not found');
    }
    if (student.rows[0]) {
        for (const universityId of relevantInstitutions) {
            await tx.query(
                `SELECT student_id
                 FROM student_eligibility_state
                 WHERE student_id = $1 AND university_id = $2
                 FOR UPDATE`,
                [student.rows[0].id, universityId],
            );
        }
    }

    const consent = await tx.query<{
        user_id: string;
        kind: 'processing' | 'disclosure';
        university_id: string | null;
    }>(
        `SELECT user_id, kind, university_id
         FROM verification_consents
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [grantId, userId],
    );
    const row = consent.rows[0];
    if (!row || row.user_id !== target.user_id || row.kind !== target.kind || row.university_id !== target.university_id) {
        throw new ConflictError('Consent changed while preparing withdrawal');
    }
    await tx.query(
        `UPDATE verification_consents
         SET withdrawn_at = COALESCE(withdrawn_at, clock_timestamp())
         WHERE id = $1`,
        [grantId],
    );
    if (row.kind === 'processing') {
        await tx.query(
            `UPDATE eligibility_evidence
             SET revoked_at = clock_timestamp(), revocation_reason = 'processing_consent_withdrawn'
             WHERE processing_grant_id = $1 AND revoked_at IS NULL`,
            [grantId],
        );
    }
    await tx.query(
        `INSERT INTO verification_audit_events (user_id, university_id, event_type, metadata)
         VALUES ($1, $2, 'verification_consent_withdrawn', jsonb_build_object('kind', $3::text))`,
        [userId, row.university_id, row.kind],
    );
}
