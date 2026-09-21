import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { BadRequestError, ConflictError, ForbiddenError, UnauthorizedError } from '../../common/errors/AppError.js';
import { authenticateReportingKey } from '../auth/reporting-key.service.js';
import { canonicalWidgetOrigin, prepareMerchantDisclosure } from './eligibility-merchant-context.service.js';
import { getEffectiveEligibility } from './eligibility-read.service.js';
import { BENEFIT_CURRENCY, computePricingVersion } from './merchant-benefit.service.js';

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
    productId?: string;
};
export async function issueMerchantAssertion(pool: Pool, userId: string, input: AssertionInput) {
    const origin = canonicalWidgetOrigin(input.origin);
    return transaction(pool, async (tx) => {
        const eligibility = await getEffectiveEligibility(tx, userId, {
            vendorId: input.vendorId, origin, purpose: input.purpose, grantId: input.disclosureGrantId,
        });
        if (!eligibility.eligible) throw new ForbiddenError('Current student eligibility and merchant consent required');
        if (input.productId !== undefined) {
            const product = await tx.query(
                `SELECT id FROM products WHERE id = $1 AND vendor_id = $2 AND status = 'active' AND deleted_at IS NULL`,
                [input.productId, input.vendorId],
            );
            if (product.rowCount !== 1) throw new BadRequestError('Product is not available for this merchant');
        }
        const code = randomBytes(32).toString('base64url');
        const inserted = await tx.query<{ expires_at: Date }>(
            `INSERT INTO merchant_assertions
             (code_hash,user_id,vendor_id,origin,purpose,campaign_id,disclosure_grant_id,evidence_id,processing_grant_id,product_id,expires_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,LEAST($11::timestamptz,clock_timestamp()+interval '2 minutes'))
             RETURNING expires_at`,
            [hash(code), userId, input.vendorId, origin, input.purpose, input.campaignId,
                input.disclosureGrantId, eligibility.evidenceId, eligibility.processingGrantId,
                input.productId ?? null, eligibility.expiresAt],
        );
        return { code, expiresAt: inserted.rows[0]!.expires_at.toISOString() };
    });
}
export type MerchantReceipt = {
    receiptId: string; merchantSubject: string; eligible: true; assuranceMethod: string;
    institutionId: string; verifiedAt: string; validUntil: string; campaignId: string;
    benefitAuthorizationId?: string;
};

/**
 * Return the already-committed receipt for an idempotency key, or null when
 * none exists. A concurrent exchange may commit between our earlier read
 * and a contended write; re-reading converts that race into the promised
 * immutable receipt instead of a spurious conflict.
 */
async function readCommittedReceipt(tx: PoolClient, vendorId: string, idempotencyKey: string, assertionId: string): Promise<MerchantReceipt | null> {
    const committed = await tx.query<{ assertion_id: string; receipt: MerchantReceipt }>(
        `SELECT assertion_id,receipt FROM merchant_assertion_receipts WHERE vendor_id=$1 AND idempotency_key=$2`,
        [vendorId, idempotencyKey],
    );
    if (!committed.rows[0]) return null;
    if (committed.rows[0].assertion_id !== assertionId) throw new ConflictError('Idempotency key already used');
    return committed.rows[0].receipt;
}
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
        const previous = await readCommittedReceipt(tx, assertion.vendor_id, input.idempotencyKey, assertion.id);
        if (previous) return previous;
        const eligibility = await getEffectiveEligibility(tx, assertion.user_id, {
            vendorId: assertion.vendor_id, origin: assertion.origin, purpose: assertion.purpose,
            grantId: assertion.disclosure_grant_id,
        });
        if (!eligibility.eligible || eligibility.evidenceId !== assertion.evidence_id
            || eligibility.processingGrantId !== assertion.processing_grant_id) {
            throw new ForbiddenError('Verification is no longer eligible');
        }
        const productId = (assertion.product_id as string | null | undefined) ?? null;
        if (productId !== null) {
            const available = await tx.query(
                `SELECT id FROM products WHERE id = $1 AND vendor_id = $2 AND status = 'active' AND deleted_at IS NULL`,
                [productId, assertion.vendor_id],
            );
            if (available.rowCount !== 1) throw new BadRequestError('Product is no longer available');
        }
        const consumed = await tx.query(`UPDATE merchant_assertions SET consumed_at=clock_timestamp()
            WHERE id=$1 AND consumed_at IS NULL AND expires_at > clock_timestamp() RETURNING id`, [assertion.id]);
        if (consumed.rowCount !== 1) {
            const committed = await readCommittedReceipt(tx, assertion.vendor_id, input.idempotencyKey, assertion.id);
            if (committed) return committed;
            throw new ConflictError('Verification code expired or already used');
        }
        let benefitAuthorizationId: string | undefined;
        if (productId !== null) {
            const locked = await tx.query(
                `SELECT id, price, student_price FROM products
                 WHERE id = $1 AND vendor_id = $2 AND status = 'active' AND deleted_at IS NULL FOR UPDATE`,
                [productId, assertion.vendor_id],
            );
            const quoted = locked.rows[0];
            if (!quoted) throw new BadRequestError('Product is no longer available');
            const authorization = await tx.query<{ id: string }>(
                `INSERT INTO merchant_benefit_authorizations
                 (assertion_id,vendor_id,user_id,product_id,evidence_id,processing_grant_id,disclosure_grant_id,
                  list_price_snapshot,student_price_snapshot,currency,pricing_version,expires_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,LEAST($12::timestamptz,clock_timestamp()+interval '2 minutes'))
                 RETURNING id`,
                [assertion.id, assertion.vendor_id, assertion.user_id, productId,
                    eligibility.evidenceId, eligibility.processingGrantId, assertion.disclosure_grant_id,
                    quoted.price, quoted.student_price, BENEFIT_CURRENCY,
                    computePricingVersion(productId, BENEFIT_CURRENCY, quoted.price, quoted.student_price),
                    eligibility.expiresAt],
            );
            benefitAuthorizationId = authorization.rows[0]!.id;
        }
        await tx.query(`INSERT INTO merchant_subjects (vendor_id,user_id) VALUES ($1,$2)
            ON CONFLICT (vendor_id,user_id) DO NOTHING`, [assertion.vendor_id, assertion.user_id]);
        const subject = await tx.query(`SELECT subject FROM merchant_subjects WHERE vendor_id=$1 AND user_id=$2`,
            [assertion.vendor_id, assertion.user_id]);
        const receipt: MerchantReceipt = {
            receiptId: randomUUID(), merchantSubject: subject.rows[0].subject, eligible: true,
            assuranceMethod: eligibility.method, institutionId: eligibility.universityId,
            verifiedAt: eligibility.verifiedAt.toISOString(), validUntil: eligibility.expiresAt.toISOString(),
            campaignId: assertion.campaign_id,
            ...(benefitAuthorizationId !== undefined ? { benefitAuthorizationId } : {}),
        };
        const stored = await tx.query(`INSERT INTO merchant_assertion_receipts (vendor_id,idempotency_key,assertion_id,receipt)
            VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (vendor_id, idempotency_key) DO NOTHING RETURNING receipt`, [assertion.vendor_id,input.idempotencyKey,assertion.id,JSON.stringify(receipt)]);
        if ((stored.rowCount ?? 0) > 0) return receipt;
        const raced = await readCommittedReceipt(tx, assertion.vendor_id, input.idempotencyKey, assertion.id);
        if (raced) return raced;
        throw new ConflictError('Verification code expired or already used');
    });
}
