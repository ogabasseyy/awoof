import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from '../../common/errors/AppError.js';
import { recheckReportingKeyInTransaction } from '../auth/reporting-key.service.js';
import { verifyPaystackPayment } from '../payment/paystack.service.js';
import { calculateMarketplaceCommission, effectiveVendorCommissionRate } from '../payment/checkout.service.js';
import { prepareMerchantDisclosure } from './eligibility-merchant-context.service.js';
import { getEffectiveEligibility } from './eligibility-read.service.js';

/** Catalog currency. Products and transactions carry no currency column; the
 *  merchant catalog is NGN-only (kobo minor units at provider boundaries). */
export const BENEFIT_CURRENCY = 'NGN';

const PRICING_VERSION_PREFIX = 'merchant-benefit-pricing:v1';

export function normalizeMoneyNaira(value: number | string): number {
    const amount = typeof value === 'string' ? Number(value) : value;
    if (!Number.isFinite(amount) || amount < 0) {
        throw new BadRequestError('Quoted price must be a non-negative amount');
    }
    return Math.round(amount * 100) / 100;
}

/** Server-computed digest of product, currency and both quoted prices. Never
 *  a client input; recomputed and compared before a report settles. */
export function computePricingVersion(
    productId: string,
    currency: string,
    listPrice: number | string,
    studentPrice: number | string,
): string {
    const list = normalizeMoneyNaira(listPrice).toFixed(2);
    const student = normalizeMoneyNaira(studentPrice).toFixed(2);
    return createHash('sha256')
        .update(`${PRICING_VERSION_PREFIX}:${productId}:${currency}:${list}:${student}`)
        .digest('hex');
}

/** Explicit minor-unit boundary: provider/report kobo in, naira out. */
export function koboToNaira(kobo: number): number {
    if (!Number.isInteger(kobo) || kobo <= 0) {
        throw new BadRequestError('Amount must be a positive integer in minor units');
    }
    return kobo / 100;
}

export function nairaToKobo(naira: number | string): number {
    const amount = typeof naira === 'string' ? Number(naira) : naira;
    if (!Number.isFinite(amount)) throw new BadRequestError('Amount must be a finite number');
    return Math.round(amount * 100);
}

/** Release the catalog units held by expired unused reservations. Runs at
 *  authorization expiry, independently of row retention, so an abandoned
 *  checkout stops holding a sellable unit within minutes instead of days.
 *  Single statement: the flag update and the stock restore commit
 *  atomically even when the caller runs in autocommit. Returns the number
 *  of units restored. */
export async function restoreExpiredBenefitReservations(
    tx: PoolClient,
    options: { expiredBefore: Date },
): Promise<number> {
    const restored = await tx.query<{ units: number }>(
        `WITH expired AS (
             UPDATE merchant_benefit_authorizations
             SET stock_restored_at = clock_timestamp()
             WHERE transaction_id IS NULL AND expires_at < $1
               AND stock_reserved AND stock_restored_at IS NULL
             RETURNING product_id
         ),
         restocked AS (
             UPDATE products AS p
             SET stock = p.stock + e.units, updated_at = CURRENT_TIMESTAMP
             FROM (SELECT product_id, count(*)::int AS units FROM expired GROUP BY product_id) AS e
             WHERE p.id = e.product_id
             RETURNING p.id
         )
         SELECT (SELECT count(*)::int FROM expired) AS units`,
        [options.expiredBefore],
    );
    return restored.rows[0]?.units ?? 0;
}

/** Lifecycle cleanup for unused authorization rows only. Rows attached to a
 *  committed transaction are retained; receipts are never deleted here.
 *  Single statement: rows whose reservations were never restored (for
 *  example, cleanup ran while restores were skipped) release their units
 *  in the same atomic step, so a crash between delete and restock cannot
 *  strand inventory. Returns the number of rows deleted. */
export async function deleteExpiredUnusedBenefitAuthorizations(
    tx: PoolClient,
    options: { expiredBefore: Date },
): Promise<number> {
    const deleted = await tx.query<{ deleted: number }>(
        `WITH deleted AS (
             DELETE FROM merchant_benefit_authorizations
             WHERE transaction_id IS NULL AND expires_at < $1
             RETURNING product_id, stock_reserved, stock_restored_at
         ),
         restocked AS (
             UPDATE products AS p
             SET stock = p.stock + d.units, updated_at = CURRENT_TIMESTAMP
             FROM (SELECT product_id, count(*)::int AS units FROM deleted
                   WHERE stock_reserved AND stock_restored_at IS NULL
                   GROUP BY product_id) AS d
             WHERE p.id = d.product_id
             RETURNING p.id
         )
         SELECT (SELECT count(*)::int FROM deleted) AS deleted`,
        [options.expiredBefore],
    );
    return deleted.rows[0]?.deleted ?? 0;
}

/** Lifecycle cleanup for spent claim sessions. Sessions past retention
 *  become tombstones instead of being deleted: the (vendor_id,
 *  checkout_id) row must survive so a reused checkout keeps failing
 *  closed, and assertion/authorization references stay attached so exact
 *  retries still resolve their committed receipts. Only the nonce digest
 *  and origin are scrubbed. Returns the number newly tombstoned. */
export async function tombstoneExpiredClaimSessions(
    tx: PoolClient,
    options: { expiredBefore: Date },
): Promise<number> {
    const tombstoned = await tx.query(
        `UPDATE merchant_claim_sessions
         SET browser_nonce_hash = NULL, origin = NULL, tombstoned_at = clock_timestamp()
         WHERE expires_at < $1 AND tombstoned_at IS NULL`,
        [options.expiredBefore],
    );
    return tombstoned.rowCount ?? 0;
}

export type ReportBenefitInput = {
    benefitAuthorizationId: string;
    productId: string;
    paymentReference: string;
    amountKobo: number;
    paymentGateway: string;
};

export type ReportBenefitAuth = {
    ownerUserId: string;
    apiKey?: string;
};

export type ReportBenefitResult = {
    transactionId: string;
    status: string;
    amountNaira: number;
    commission: number;
    earnings: number;
    createdAt: Date;
    newlyCompleted: boolean;
    studentId: string;
    productName: string;
    listPriceNaira: number;
    discountNaira: number;
};

type BenefitAuthorizationRow = {
    id: string;
    assertion_id: string;
    vendor_id: string;
    user_id: string;
    product_id: string;
    evidence_id: string;
    processing_grant_id: string;
    disclosure_grant_id: string;
    list_price_snapshot: string;
    student_price_snapshot: string;
    currency: string;
    pricing_version: string;
    expires_at: Date;
    transaction_id: string | null;
    stock_reserved: boolean;
};

type AssertionBinding = {
    id: string;
    vendor_id: string;
    user_id: string;
    origin: string;
    purpose: string;
    product_id: string | null;
    disclosure_grant_id: string;
};

async function readExactCommittedReport(
    tx: PoolClient,
    authorization: BenefitAuthorizationRow,
    input: ReportBenefitInput,
    paymentSource: string,
): Promise<ReportBenefitResult> {
    const committed = (await tx.query(
        `SELECT t.id, t.status, t.amount, t.commission, t.vendor_id, t.product_id,
                t.payment_source, t.vendor_payment_reference, t.created_at,
                t.student_id, t.list_price_snapshot, t.recorded_savings_delta, p.name AS product_name
         FROM transactions t JOIN products p ON p.id = t.product_id
         WHERE t.id = $1 FOR UPDATE OF t`,
        [authorization.transaction_id],
    )).rows[0];
    const matches = committed !== undefined
        && committed.vendor_id === authorization.vendor_id
        && committed.product_id === input.productId
        && committed.vendor_payment_reference === input.paymentReference
        && committed.payment_source === paymentSource
        && nairaToKobo(committed.amount) === input.amountKobo;
    if (!matches) {
        throw new ConflictError('Report does not match the committed transaction for this benefit authorization');
    }
    const amountNaira = Number(committed.amount);
    const commission = Number(committed.commission);
    return {
        transactionId: committed.id,
        status: committed.status,
        amountNaira,
        commission,
        earnings: Math.round((amountNaira - commission) * 100) / 100,
        createdAt: committed.created_at,
        newlyCompleted: false,
        studentId: committed.student_id,
        productName: committed.product_name,
        listPriceNaira: Number(committed.list_price_snapshot),
        discountNaira: Number(committed.recorded_savings_delta),
    };
}

async function readCommittedReportAfterConflict(
    pool: Pool,
    auth: ReportBenefitAuth,
    vendorId: string,
    input: ReportBenefitInput,
    paymentSource: string,
): Promise<ReportBenefitResult> {
    const tx = await pool.connect();
    try {
        await tx.query('BEGIN');
        const candidate = (await tx.query(
            `SELECT a.vendor_id, a.user_id, assertion.origin
             FROM merchant_benefit_authorizations a
             JOIN merchant_assertions assertion ON assertion.id = a.assertion_id
             WHERE a.id = $1`,
            [input.benefitAuthorizationId],
        )).rows[0];
        if (!candidate || candidate.vendor_id !== vendorId) {
            throw new ConflictError('Transaction report conflicts with another committed report');
        }
        // This path only ever returns already-committed results, so live
        // origin configuration is not required; merchant/key checks stay.
        const merchant = await prepareMerchantDisclosure(tx, candidate.user_id, candidate.vendor_id, candidate.origin, { requireOrigin: false });
        if (!merchant || merchant.ownerUserId !== auth.ownerUserId) throw new UnauthorizedError('Merchant unavailable');
        if (auth.apiKey !== undefined && !await recheckReportingKeyInTransaction(tx, auth.apiKey, candidate.vendor_id)) {
            throw new UnauthorizedError('Merchant key unavailable');
        }
        const authorization = (await tx.query<BenefitAuthorizationRow>(
            'SELECT * FROM merchant_benefit_authorizations WHERE id = $1 FOR UPDATE', [input.benefitAuthorizationId],
        )).rows[0];
        if (!authorization || authorization.transaction_id === null) {
            throw new ConflictError('Transaction report conflicts with another committed report');
        }
        const result = await readExactCommittedReport(tx, authorization, input, paymentSource);
        await tx.query('COMMIT');
        return result;
    } catch (error) {
        await tx.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        tx.release();
    }
}

/**
 * Settle a merchant-reported discounted transaction against a product-bound
 * benefit authorization. A payment report alone cannot enforce an external
 * checkout: the merchant must hold current enrollment authority before
 * granting a discount, and late first reports reconcile instead of settling.
 *
 * Lock order: untrusted candidate IDs without locks, participant users in
 * sorted order through the existing merchant context, then
 * student/university/state/consent/provider/evidence through the canonical
 * eligibility reader, then assertion/authorization and product/transaction.
 */
export async function reportMerchantBenefit(
    pool: Pool,
    auth: ReportBenefitAuth,
    input: ReportBenefitInput,
    dependencies: { verifyPaystack?: (reference: string) => Promise<{ verified: boolean; amount?: number; error?: string }> } = {},
): Promise<ReportBenefitResult> {
    const reportedNaira = koboToNaira(input.amountKobo);
    const paymentSource = input.paymentGateway === 'paystack' ? 'vendor_paystack' : 'vendor_other';
    const vendor = (await pool.query('SELECT id FROM vendors WHERE user_id = $1 AND deleted_at IS NULL AND status = $2', [auth.ownerUserId, 'active'])).rows[0];
    if (!vendor) throw new NotFoundError('Vendor profile not found');
    const candidate = (await pool.query(
        `SELECT a.transaction_id, a.vendor_id, a.user_id,
                assertion.id AS assertion_id, assertion.origin, assertion.purpose,
                assertion.disclosure_grant_id
         FROM merchant_benefit_authorizations a
         JOIN merchant_assertions assertion ON assertion.id = a.assertion_id
         WHERE a.id = $1`,
        [input.benefitAuthorizationId],
    )).rows[0];
    if (!candidate || candidate.vendor_id !== vendor.id) throw new NotFoundError('Benefit authorization not found');
    // Verify external payment outside DB locks, on first use only. A committed
    // transaction never unsets, so a pre-read retry hint is stable and exact
    // retries stay historical bookkeeping without renewed provider calls.
    if (candidate.transaction_id === null && input.paymentGateway === 'paystack') {
        const verify = dependencies.verifyPaystack ?? verifyPaystackPayment;
        const payment = await verify(input.paymentReference);
        if (!payment.verified) throw new BadRequestError(payment.error || 'Payment verification failed');
        if (payment.amount == null || !Number.isFinite(payment.amount) || nairaToKobo(payment.amount) !== input.amountKobo) {
            throw new BadRequestError(
                `Paystack payment amount (${payment.amount}) does not match reported amount (${reportedNaira})`,
            );
        }
    }
    const tx = await pool.connect();
    try {
        await tx.query('BEGIN');
        // Committed retries are historical bookkeeping: the pre-read
        // transaction id tells us whether live origin configuration is
        // required (first settlement) or must not gate the original
        // result (a retry after the merchant removed the origin). A
        // commit that lands between the pre-read and this transaction
        // still resolves on retry.
        const merchant = await prepareMerchantDisclosure(tx, candidate.user_id, candidate.vendor_id, candidate.origin, {
            requireOrigin: candidate.transaction_id === null,
        });
        if (!merchant || merchant.ownerUserId !== auth.ownerUserId) throw new UnauthorizedError('Merchant unavailable');
        if (auth.apiKey !== undefined && !await recheckReportingKeyInTransaction(tx, auth.apiKey, candidate.vendor_id)) {
            throw new UnauthorizedError('Merchant key unavailable');
        }
        const looksLikeFirstUse = candidate.transaction_id === null;
        const eligibility = looksLikeFirstUse
            ? await getEffectiveEligibility(tx, candidate.user_id, {
                vendorId: candidate.vendor_id, origin: candidate.origin,
                purpose: candidate.purpose, grantId: candidate.disclosure_grant_id,
            })
            : undefined;
        const assertion = (await tx.query<AssertionBinding>(
            'SELECT id, vendor_id, user_id, origin, purpose, product_id, disclosure_grant_id FROM merchant_assertions WHERE id = $1 FOR UPDATE',
            [candidate.assertion_id],
        )).rows[0];
        const authorization = (await tx.query<BenefitAuthorizationRow>(
            'SELECT * FROM merchant_benefit_authorizations WHERE id = $1 FOR UPDATE', [input.benefitAuthorizationId],
        )).rows[0];
        if (!assertion || !authorization || authorization.vendor_id !== candidate.vendor_id || authorization.assertion_id !== assertion.id) {
            throw new NotFoundError('Benefit authorization not found');
        }
        if (authorization.transaction_id !== null) {
            const result = await readExactCommittedReport(tx, authorization, input, paymentSource);
            await tx.query('COMMIT');
            return result;
        }
        if (eligibility === undefined) {
            throw new ConflictError('Benefit authorization changed while reporting; retry the report');
        }
        const product = (await tx.query(
            'SELECT id, vendor_id, name, status, deleted_at FROM products WHERE id = $1 FOR UPDATE', [input.productId],
        )).rows[0];
        // First-use reports always follow an externally collected payment
        // (verified for Paystack, merchant-asserted otherwise), so every
        // authority lapse here — consent, enrollment, or evidence drift —
        // is a reconciliation outcome, never a plain refusal.
        if (!eligibility.eligible) {
            throw new ConflictError(
                eligibility.reason === 'consent_required'
                    ? 'Merchant disclosure consent lapsed after payment; reconcile the external payment with the merchant instead of retrying'
                    : 'Student enrollment lapsed after payment; reconcile the external payment with the merchant instead of retrying',
                { reconciliation: 'required', paymentReference: input.paymentReference },
            );
        }
        if (eligibility.evidenceId !== authorization.evidence_id
            || eligibility.processingGrantId !== authorization.processing_grant_id) {
            throw new ConflictError(
                'Student enrollment changed after payment; reconcile the external payment with the merchant instead of retrying',
                { reconciliation: 'required', paymentReference: input.paymentReference },
            );
        }
        if (authorization.product_id !== input.productId || assertion.product_id !== input.productId) {
            throw new BadRequestError('Report product does not match the benefit authorization');
        }
        if (authorization.currency !== BENEFIT_CURRENCY) {
            throw new BadRequestError('Report currency does not match the benefit authorization');
        }
        const quotedPricing = computePricingVersion(
            authorization.product_id, authorization.currency,
            authorization.list_price_snapshot, authorization.student_price_snapshot,
        );
        if (quotedPricing !== authorization.pricing_version) {
            throw new BadRequestError('Benefit pricing quote is no longer valid');
        }
        if (nairaToKobo(authorization.student_price_snapshot) !== input.amountKobo) {
            throw new BadRequestError(
                `Payment amount (${reportedNaira}) does not match the quoted student price (${Number(authorization.student_price_snapshot)})`,
            );
        }
        const now = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
        if (authorization.expires_at <= now) {
            throw new ConflictError(
                'Benefit authorization expired after payment; reconcile the external payment with the merchant instead of retrying',
                { reconciliation: 'required', paymentReference: input.paymentReference },
            );
        }
        if (!product || product.vendor_id !== authorization.vendor_id || product.status !== 'active' || product.deleted_at !== null) {
            throw new ConflictError(
                'Discounted deal is unavailable after payment; reconcile the external payment with the merchant instead of retrying',
                { reconciliation: 'required', paymentReference: input.paymentReference },
            );
        }
        const listPrice = normalizeMoneyNaira(authorization.list_price_snapshot);
        const discount = Math.round((listPrice - reportedNaira) * 100) / 100;
        const vendorRate = (await tx.query('SELECT commission_rate FROM vendors WHERE id = $1', [authorization.vendor_id])).rows[0]?.commission_rate;
        const platformFee = (await tx.query(`SELECT value FROM platform_settings WHERE key = 'platform_fee_percent'`)).rows[0]?.value;
        const platformRate = Number.parseFloat(platformFee ?? '');
        const commissionRate = effectiveVendorCommissionRate(
            vendorRate, Number.isFinite(platformRate) && platformRate >= 0 && platformRate <= 100 ? platformRate : 10,
        );
        const { commission, vendorNet: earnings } = calculateMarketplaceCommission(reportedNaira, commissionRate);
        const inserted = (await tx.query(
            `INSERT INTO transactions (
                student_id, product_id, vendor_id, amount, commission, list_price_snapshot,
                status, payment_source, vendor_payment_reference, verified_at, inventory_consumed, recorded_savings_delta
            )
            VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7, $8, CURRENT_TIMESTAMP, true, $9)
            RETURNING id, status, created_at`,
            [
                eligibility.studentId, input.productId, authorization.vendor_id, reportedNaira,
                commission, listPrice, paymentSource, input.paymentReference, discount,
            ],
        )).rows[0];
        // Reserved authorizations already decremented stock atomically at
        // exchange; settling consumes the reservation. Legacy
        // authorizations minted before reservation still decrement here
        // and fail closed into reconciliation when stock is gone.
        if (!authorization.stock_reserved) {
            const stockUpdate = await tx.query(
                `UPDATE products
                 SET stock = stock - 1, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1 AND vendor_id = $2 AND stock > 0 AND deleted_at IS NULL AND status = 'active'
                 RETURNING id`,
                [input.productId, authorization.vendor_id],
            );
            if (stockUpdate.rows.length === 0) {
                throw new ConflictError(
                    'Discounted stock is unavailable after payment; reconcile the external payment with the merchant instead of retrying',
                    { reconciliation: 'required', paymentReference: input.paymentReference },
                );
            }
        }
        await tx.query(
            `INSERT INTO savings_stats (student_id, total_savings, total_purchases, last_updated)
             VALUES ($1, $2, 1, CURRENT_TIMESTAMP)
             ON CONFLICT (student_id)
             DO UPDATE SET
                 total_savings = savings_stats.total_savings + $2,
                 total_purchases = savings_stats.total_purchases + 1,
                 last_updated = CURRENT_TIMESTAMP`,
            [eligibility.studentId, discount],
        );
        await tx.query('UPDATE merchant_benefit_authorizations SET transaction_id = $1 WHERE id = $2', [inserted.id, authorization.id]);
        await tx.query('COMMIT');
        return {
            transactionId: inserted.id,
            status: inserted.status,
            amountNaira: reportedNaira,
            commission,
            earnings,
            createdAt: inserted.created_at,
            newlyCompleted: true,
            studentId: eligibility.studentId,
            productName: product.name,
            listPriceNaira: listPrice,
            discountNaira: discount,
        };
    } catch (error) {
        await tx.query('ROLLBACK').catch(() => undefined);
        if ((error as { code?: string }).code === '23505') {
            return await readCommittedReportAfterConflict(pool, auth, vendor.id, input, paymentSource);
        }
        throw error;
    } finally {
        tx.release();
    }
}
