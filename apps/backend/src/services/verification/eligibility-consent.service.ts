import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../common/errors/AppError.js';
import { lockStudentContext } from './eligibility-context.service.js';
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

function canonicalWidgetOrigin(value: string): string {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new BadRequestError('Invalid merchant origin');
    }
    const permittedSpelling = value === parsed.origin || value === `${parsed.origin}/`;
    const localDevelopmentHttp = process.env.NODE_ENV === 'development'
        && parsed.protocol === 'http:'
        && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1');
    if ((parsed.protocol !== 'https:' && !localDevelopmentHttp) || parsed.username || parsed.password || parsed.pathname !== '/'
        || parsed.search || parsed.hash || !permittedSpelling) {
        throw new BadRequestError('Invalid merchant origin');
    }
    return parsed.origin;
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
    await assertActiveStudent(tx, userId);
    const origin = canonicalWidgetOrigin(input.origin);
    const liveWidget = await tx.query(
        `SELECT 1
         FROM widget_configs
         WHERE vendor_id = $1
           AND status = 'active'
           AND $2 = ANY(allowed_origins)`,
        [input.vendorId, origin],
    );
    if (liveWidget.rowCount !== 1) throw new NotFoundError('Merchant widget origin not configured');

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
    const consent = await tx.query<{
        kind: 'processing' | 'disclosure';
        university_id: string | null;
    }>(
        `SELECT kind, university_id
         FROM verification_consents
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [grantId, userId],
    );
    const row = consent.rows[0];
    if (!row) {
        const exists = await tx.query('SELECT 1 FROM verification_consents WHERE id = $1', [grantId]);
        if (exists.rowCount) throw new ForbiddenError('Consent belongs to another user');
        throw new NotFoundError('Consent not found');
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
