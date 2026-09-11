import type { PoolClient } from 'pg';
import { BadRequestError } from '../../common/errors/AppError.js';

type CandidateMerchant = {
    user_id: string;
};

type LockedParticipant = {
    id: string;
    role: string;
    deleted_at: Date | null;
};

type LockedMerchant = {
    id: string;
    user_id: string;
    status: string;
    deleted_at: Date | null;
};

export type MerchantDisclosureContext = {
    vendorId: string;
    ownerUserId: string;
    origin: string;
};

export function canonicalWidgetOrigin(value: string): string {
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

/**
 * Prepare a merchant disclosure transaction before any other row lock.
 *
 * The candidate owner is deliberately read without a lock, then the student
 * and candidate owner user rows are locked in UUID order as the transaction's
 * first lock-acquisition phase. The vendor mapping is rechecked while the
 * vendor row is locked, so an ownership change fails closed. Callers must not
 * invoke this after lockStudentContext, recordEmailAssurance,
 * getEffectiveEligibility without a disclosure, or a different merchant
 * disclosure unless every participant user was predeclared and locked in the
 * one sorted entry phase. Public grant/read entrypoints in this task satisfy
 * that precondition.
 */
export async function prepareMerchantDisclosure(
    tx: PoolClient,
    userId: string,
    vendorId: string,
    origin: string,
): Promise<MerchantDisclosureContext | null> {
    const candidate = await tx.query<CandidateMerchant>(
        'SELECT user_id FROM vendors WHERE id = $1',
        [vendorId],
    );
    const candidateOwnerId = candidate.rows[0]?.user_id;
    if (!candidateOwnerId) return null;

    const participantIds = [...new Set([userId, candidateOwnerId])].sort();
    const participants = await tx.query<LockedParticipant>(
        `SELECT id, role, deleted_at
         FROM users
         WHERE id = ANY($1::uuid[])
         ORDER BY id
         FOR UPDATE`,
        [participantIds],
    );
    if (participants.rowCount !== participantIds.length) return null;
    const owner = participants.rows.find((participant) => participant.id === candidateOwnerId);
    if (!owner || owner.role !== 'vendor' || owner.deleted_at !== null) return null;

    const vendorResult = await tx.query<LockedMerchant>(
        `SELECT id, user_id, status, deleted_at
         FROM vendors
         WHERE id = $1
         FOR UPDATE`,
        [vendorId],
    );
    const vendor = vendorResult.rows[0];
    if (!vendor
        || vendor.user_id !== candidateOwnerId
        || vendor.status !== 'active'
        || vendor.deleted_at !== null) {
        return null;
    }

    const widget = await tx.query(
        `SELECT id
         FROM widget_configs
         WHERE vendor_id = $1
           AND status = 'active'
           AND $2 = ANY(allowed_origins)
         FOR UPDATE`,
        [vendorId, origin],
    );
    if (widget.rowCount === 0) return null;

    return { vendorId, ownerUserId: candidateOwnerId, origin };
}
