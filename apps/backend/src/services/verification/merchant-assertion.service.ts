import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { BadRequestError, ConflictError, ForbiddenError, UnauthorizedError } from '../../common/errors/AppError.js';
import { authenticateReportingKey } from '../auth/reporting-key.service.js';
import { canonicalWidgetOrigin, prepareMerchantDisclosure } from './eligibility-merchant-context.service.js';
import { getEffectiveEligibility } from './eligibility-read.service.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function transaction<T>(pool: Pool, operation: (tx: PoolClient) => Promise<T>): Promise<T> {
    const tx = await pool.connect();
    try {
        await tx.query('BEGIN');
        const result = await operation(tx);
        await tx.query('COMMIT');
        return result;
    } catch (error) { await tx.query('ROLLBACK'); throw error; }
    finally { tx.release(); }
}
export type AssertionInput = {
    vendorId: string; origin: string; purpose: string; campaignId: string; disclosureGrantId: string;
};
export async function issueMerchantAssertion(pool: Pool, userId: string, input: AssertionInput) {
    const origin = canonicalWidgetOrigin(input.origin);
    return transaction(pool, async (tx) => {
        const eligibility = await getEffectiveEligibility(tx, userId, {
            vendorId: input.vendorId, origin, purpose: input.purpose, grantId: input.disclosureGrantId,
        });
        if (!eligibility.eligible) throw new ForbiddenError('Current student eligibility and merchant consent required');
        const code = randomBytes(32).toString('base64url');
        const inserted = await tx.query<{ expires_at: Date }>(
            `INSERT INTO merchant_assertions
             (code_hash,user_id,vendor_id,origin,purpose,campaign_id,disclosure_grant_id,evidence_id,processing_grant_id,expires_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,LEAST($10::timestamptz,clock_timestamp()+interval '2 minutes'))
             RETURNING expires_at`,
            [hash(code), userId, input.vendorId, origin, input.purpose, input.campaignId,
                input.disclosureGrantId, eligibility.evidenceId, eligibility.processingGrantId, eligibility.expiresAt],
        );
        return { code, expiresAt: inserted.rows[0]!.expires_at.toISOString() };
    });
}
export type MerchantReceipt = {
    receiptId: string; merchantSubject: string; eligible: true; assuranceMethod: string;
    institutionId: string; verifiedAt: string; validUntil: string; campaignId: string;
};
export async function exchangeMerchantAssertion(pool: Pool, key: string, input: {
    code: string; campaignId: string; idempotencyKey: string;
}): Promise<MerchantReceipt> {
    // Slow cryptographic authentication and quota admission happen before locks.
    // Authority is rechecked below after sorted participant locks, including rotation.
    const owner = await authenticateReportingKey(pool, key);
    const candidate = await pool.query(`SELECT * FROM merchant_assertions WHERE code_hash=$1`, [hash(input.code)]);
    const assertion = candidate.rows[0];
    if (!assertion) throw new BadRequestError('Invalid verification code');
    return transaction(pool, async (tx) => {
        const merchant = await prepareMerchantDisclosure(tx, assertion.user_id, assertion.vendor_id, assertion.origin);
        if (!merchant || merchant.ownerUserId !== owner.user_id) throw new UnauthorizedError('Merchant unavailable');
        const currentKey = await tx.query(
            `SELECT id FROM api_keys WHERE lookup_hash=$1 AND vendor_id=$2 AND status='active'
             AND (expires_at IS NULL OR expires_at > clock_timestamp()) FOR UPDATE`,
            [hash(key), assertion.vendor_id],
        );
        if (currentKey.rowCount !== 1) throw new UnauthorizedError('Merchant key unavailable');
        if (input.campaignId !== assertion.campaign_id) throw new BadRequestError('Campaign mismatch');
        const previous = await tx.query(`SELECT assertion_id,receipt FROM merchant_assertion_receipts
            WHERE vendor_id=$1 AND idempotency_key=$2`, [assertion.vendor_id, input.idempotencyKey]);
        if (previous.rows[0]) {
            if (previous.rows[0].assertion_id !== assertion.id) throw new ConflictError('Idempotency key already used');
            return previous.rows[0].receipt as MerchantReceipt;
        }
        const eligibility = await getEffectiveEligibility(tx, assertion.user_id, {
            vendorId: assertion.vendor_id, origin: assertion.origin, purpose: assertion.purpose,
            grantId: assertion.disclosure_grant_id,
        });
        if (!eligibility.eligible || eligibility.evidenceId !== assertion.evidence_id
            || eligibility.processingGrantId !== assertion.processing_grant_id) {
            throw new ForbiddenError('Verification is no longer eligible');
        }
        const consumed = await tx.query(`UPDATE merchant_assertions SET consumed_at=clock_timestamp()
            WHERE id=$1 AND consumed_at IS NULL AND expires_at > clock_timestamp() RETURNING id`, [assertion.id]);
        if (consumed.rowCount !== 1) throw new ConflictError('Verification code expired or already used');
        await tx.query(`INSERT INTO merchant_subjects (vendor_id,user_id) VALUES ($1,$2)
            ON CONFLICT (vendor_id,user_id) DO NOTHING`, [assertion.vendor_id, assertion.user_id]);
        const subject = await tx.query(`SELECT subject FROM merchant_subjects WHERE vendor_id=$1 AND user_id=$2`,
            [assertion.vendor_id, assertion.user_id]);
        const receipt: MerchantReceipt = {
            receiptId: randomUUID(), merchantSubject: subject.rows[0].subject, eligible: true,
            assuranceMethod: eligibility.method, institutionId: eligibility.universityId,
            verifiedAt: eligibility.verifiedAt.toISOString(), validUntil: eligibility.expiresAt.toISOString(),
            campaignId: assertion.campaign_id,
        };
        await tx.query(`INSERT INTO merchant_assertion_receipts (vendor_id,idempotency_key,assertion_id,receipt)
            VALUES ($1,$2,$3,$4::jsonb)`, [assertion.vendor_id,input.idempotencyKey,assertion.id,JSON.stringify(receipt)]);
        return receipt;
    });
}
