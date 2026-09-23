import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AppError, BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../../common/errors/AppError.js';
import { authenticateReportingKey } from '../auth/reporting-key.service.js';
import { prepareMerchantDisclosure } from './eligibility-merchant-context.service.js';
import { getEffectiveEligibility } from './eligibility-read.service.js';

/** Fixed merchant callback path every protected claim hands off to. Never accept this from request input. */
export const MERCHANT_CLAIM_CALLBACK_PATH = '/awoof/student-claim';
export const CLAIM_SESSION_TTL_MINUTES = 10;
export const PRODUCT_CLAIM_TTL_MINUTES = 2;

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function integrationRequired(): AppError {
    return new AppError('Merchant integration unavailable for protected claims', 409, 'MERCHANT_INTEGRATION_REQUIRED');
}

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

// ---------------------------------------------------------------------------
// Public product projection: advertised prices stay visible while reusable
// voucher codes, discount-bearing URL queries and protected fulfillment
// fields never leave the server, including inside nested payloads.
// ---------------------------------------------------------------------------

const PUBLIC_PRODUCT_FIELDS = [
    'id', 'name', 'description', 'price', 'student_price',
    'category_id', 'category_name', 'category_slug',
    'image_url', 'stock', 'status', 'deal_type',
    'created_at', 'updated_at',
    'vendor_id', 'vendor_name', 'vendor_description', 'vendor_website', 'vendor_logo_url',
    'vendor_payment_method',
] as const;

export type PublicProduct = {
    [key in (typeof PUBLIC_PRODUCT_FIELDS)[number]]?: unknown;
};

export function toPublicProduct(row: Record<string, unknown>): PublicProduct {
    const projected: PublicProduct = {};
    for (const field of PUBLIC_PRODUCT_FIELDS) {
        if (field in row) projected[field] = row[field];
    }
    return projected;
}

// ---------------------------------------------------------------------------
// Merchant claim sessions (server-to-server bootstrap)
// ---------------------------------------------------------------------------

export type ClaimSessionInput = {
    productId: string;
    merchantCheckoutId: string;
    browserNonceHash: string;
    /** Initiating merchant site; must exactly match an active allowed origin. */
    origin: string;
};

export type ClaimSessionResult = {
    claimSessionId: string; expiresAt: string; created: boolean;
};

export async function createMerchantClaimSession(
    pool: Pool,
    merchantKey: string,
    input: ClaimSessionInput,
): Promise<ClaimSessionResult> {
    const owner = await authenticateReportingKey(pool, merchantKey);
    return transaction(pool, async (tx) => {
        const vendor = await tx.query<{ id: string }>(
            `SELECT id FROM vendors WHERE user_id = $1 AND status = 'active' AND deleted_at IS NULL FOR UPDATE`,
            [owner.user_id],
        );
        if (vendor.rowCount !== 1) throw new UnauthorizedError('Merchant unavailable');
        const vendorId = vendor.rows[0]!.id;
        const reconcile = (session: {
            id: string; product_id: string; browser_nonce_hash: string; origin: string | null; expires_at: Date; consumed_at: Date | null;
        }) => {
            if (session.product_id !== input.productId || session.browser_nonce_hash !== input.browserNonceHash
                || (session.origin ?? null) !== input.origin) {
                throw new ConflictError('Merchant checkout is already bound to a different claim; start a new checkout');
            }
            if (session.consumed_at !== null || session.expires_at.getTime() <= Date.now()) {
                throw new ConflictError('Merchant checkout already used or expired; start a new checkout');
            }
            return { claimSessionId: session.id, expiresAt: session.expires_at.toISOString(), created: false };
        };
        const existing = await tx.query<{
            id: string; product_id: string; browser_nonce_hash: string; origin: string | null; expires_at: Date; consumed_at: Date | null;
        }>(
            `SELECT id, product_id, browser_nonce_hash, origin, expires_at, consumed_at
             FROM merchant_claim_sessions WHERE vendor_id = $1 AND checkout_id = $2 FOR UPDATE`,
            [vendorId, input.merchantCheckoutId],
        );
        // A checkout that already exists is reconciled against its binding
        // before any availability check: if the first creation committed
        // but its response was lost, a retry must return the live session
        // even when the catalog has since changed. Availability governs
        // only genuinely new sessions.
        if (existing.rows[0]) return reconcile(existing.rows[0]);
        // The checkout starts only against sellable stock, and the session
        // quotes the catalog prices now: the later authorization binds
        // this quote instead of resampling a possibly edited catalog.
        const product = await tx.query<{ id: string; price: string; student_price: string }>(
            `SELECT id, price, student_price FROM products
             WHERE id = $1 AND vendor_id = $2 AND status = 'active' AND deleted_at IS NULL AND stock > 0 FOR UPDATE`,
            [input.productId, vendorId],
        );
        const quoted = product.rows[0];
        if (!quoted) throw new BadRequestError('Product is not available for this merchant');
        // The initiating site is merchant-declared but server-validated: it
        // must exactly match one of the vendor's active allowed origins, so
        // a multi-site merchant cannot be handed another site's handoff.
        const allowed = await tx.query<{ origin: string }>(
            `SELECT unnest(allowed_origins) AS origin FROM widget_configs
             WHERE vendor_id = $1 AND status = 'active'`,
            [vendorId],
        );
        if (!allowed.rows.some((row) => row.origin === input.origin)) {
            throw new BadRequestError('Claim origin is not an active allowed origin for this merchant');
        }
        const inserted = await tx.query<{ id: string; expires_at: Date }>(
            `INSERT INTO merchant_claim_sessions
                 (vendor_id, product_id, checkout_id, browser_nonce_hash, origin,
                  list_price_snapshot, student_price_snapshot, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp() + interval '10 minutes')
             ON CONFLICT (vendor_id, checkout_id) DO NOTHING
             RETURNING id, expires_at`,
            [vendorId, input.productId, input.merchantCheckoutId, input.browserNonceHash, input.origin,
                quoted.price, quoted.student_price],
        );
        if (inserted.rows[0]) {
            return { claimSessionId: inserted.rows[0].id, expiresAt: inserted.rows[0].expires_at.toISOString(), created: true };
        }
        // Lost an insert race with a concurrent create for the same checkout:
        // reconcile against the winner's binding instead of failing.
        const raced = await tx.query<{
            id: string; product_id: string; browser_nonce_hash: string; origin: string | null; expires_at: Date; consumed_at: Date | null;
        }>(
            `SELECT id, product_id, browser_nonce_hash, origin, expires_at, consumed_at
             FROM merchant_claim_sessions WHERE vendor_id = $1 AND checkout_id = $2 FOR UPDATE`,
            [vendorId, input.merchantCheckoutId],
        );
        if (!raced.rows[0]) throw new ConflictError('Merchant checkout conflict; start a new checkout');
        return reconcile(raced.rows[0]);
    });
}

export type ClaimSessionPublic = {
    claimSessionId: string; vendorId: string; vendorName: string;
    productId: string; productName: string; listPrice: string; studentPrice: string;
    handoffOrigin: string; expiresAt: string;
};

export async function readMerchantClaimSession(pool: Pool, sessionId: string): Promise<ClaimSessionPublic> {
    const session = await pool.query<{
        id: string; vendor_id: string; product_id: string; origin: string | null;
        list_price_snapshot: string | null; student_price_snapshot: string | null;
        expires_at: Date; consumed_at: Date | null;
    }>(
        `SELECT id, vendor_id, product_id, origin, list_price_snapshot, student_price_snapshot, expires_at, consumed_at
         FROM merchant_claim_sessions WHERE id = $1`,
        [sessionId],
    );
    const row = session.rows[0];
    if (!row) throw new NotFoundError('Claim session not found');
    // Sessions predate the origin binding stay unusable: the initiating site
    // is unknowable, so no handoff destination is guessed for them.
    if (row.origin == null) throw new ConflictError('Claim session expired or already redeemed');
    if (row.consumed_at !== null || row.expires_at.getTime() <= Date.now()) {
        throw new ConflictError('Claim session expired or already redeemed');
    }
    const vendor = await pool.query<{ name: string; status: string; deleted_at: Date | null }>(
        `SELECT name, status, deleted_at FROM vendors WHERE id = $1`,
        [row.vendor_id],
    );
    const product = await pool.query<{ name: string; price: string; student_price: string; status: string; deleted_at: Date | null; vendor_id: string }>(
        `SELECT name, price, student_price, status, deleted_at, vendor_id FROM products WHERE id = $1`,
        [row.product_id],
    );
    const vendorRow = vendor.rows[0];
    const productRow = product.rows[0];
    if (!vendorRow || vendorRow.status !== 'active' || vendorRow.deleted_at !== null
        || !productRow || productRow.status !== 'active' || productRow.deleted_at !== null
        || productRow.vendor_id !== row.vendor_id) {
        throw new NotFoundError('Claim is no longer available');
    }
    return {
        claimSessionId: row.id,
        vendorId: row.vendor_id,
        vendorName: vendorRow.name,
        productId: row.product_id,
        productName: productRow.name,
        // The review shows the session's quote when present, so the
        // student approves exactly what the authorization will bind.
        // Legacy sessions without a quote fall back to live prices.
        listPrice: row.list_price_snapshot ?? productRow.price,
        studentPrice: row.student_price_snapshot ?? productRow.student_price,
        handoffOrigin: row.origin,
        expiresAt: row.expires_at.toISOString(),
    };
}

// ---------------------------------------------------------------------------
// Protected product claims (student browser)
// ---------------------------------------------------------------------------

export type ProductClaimInput = {
    merchantClaimSessionId: string; disclosureGrantId: string;
};

export type ProductClaimResult = {
    code: string; expiresAt: string; handoffUrl: string;
};

export function timingSafeHashEqual(actualHash: string, expectedHash: string): boolean {
    const actual = Buffer.from(actualHash, 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    return actual.length === expected.length && actual.length > 0 && timingSafeEqual(actual, expected);
}

export async function claimProductBenefit(pool: Pool, userId: string, input: ProductClaimInput): Promise<ProductClaimResult> {
    const candidateSession = await pool.query<{
        id: string; vendor_id: string; product_id: string; checkout_id: string;
        origin: string | null; expires_at: Date; consumed_at: Date | null;
    }>(
        `SELECT id, vendor_id, product_id, checkout_id, origin, expires_at, consumed_at
         FROM merchant_claim_sessions WHERE id = $1`,
        [input.merchantClaimSessionId],
    );
    const session = candidateSession.rows[0];
    if (!session) throw new NotFoundError('Claim session not found');
    // Sessions that predate the origin binding stay unusable, matching
    // the read path: the initiating site is unknowable, so no handoff
    // destination is guessed for them.
    if (session.origin == null) throw new ConflictError('Claim session expired or already redeemed');
    if (session.consumed_at !== null || session.expires_at.getTime() <= Date.now()) {
        throw new ConflictError('Claim session expired or already redeemed');
    }
    const candidateGrant = await pool.query<{
        user_id: string; kind: string; vendor_id: string | null; origin: string | null; purpose: string | null;
    }>(
        `SELECT user_id, kind, vendor_id, origin, purpose FROM verification_consents WHERE id = $1`,
        [input.disclosureGrantId],
    );
    const grant = candidateGrant.rows[0];
    if (!grant || grant.kind !== 'disclosure') throw new NotFoundError('Disclosure grant not found');
    if (grant.user_id !== userId) throw new ForbiddenError('Disclosure grant belongs to another user');
    if (grant.vendor_id !== session.vendor_id || !grant.origin || !grant.purpose) {
        throw new ForbiddenError('Disclosure grant is for a different merchant');
    }
    // A multi-site vendor's grant for origin B must not redeem a session
    // initiated on origin A: the assertion and handoff URL would go to the
    // wrong site. Exact match only; both sides are server-validated.
    if (grant.origin !== session.origin) {
        throw new ForbiddenError('Disclosure grant is for a different origin');
    }
    return transaction(pool, async (tx) => {
        const merchant = await prepareMerchantDisclosure(tx, userId, session.vendor_id, grant.origin!);
        if (!merchant) throw integrationRequired();
        const lockedSession = await tx.query<{ id: string }>(
            `SELECT id FROM merchant_claim_sessions
             WHERE id = $1 AND consumed_at IS NULL AND expires_at > clock_timestamp() FOR UPDATE`,
            [session.id],
        );
        if (lockedSession.rowCount !== 1) {
            throw new ConflictError('Claim session expired or already redeemed');
        }
        const eligibility = await getEffectiveEligibility(tx, userId, {
            vendorId: session.vendor_id, origin: grant.origin!, purpose: grant.purpose!, grantId: input.disclosureGrantId,
        });
        if (!eligibility.eligible) {
            throw new ForbiddenError('Current student enrollment required for this discount', { reason: eligibility.reason });
        }
        const integration = await tx.query(
            `SELECT 1 FROM api_keys WHERE vendor_id = $1 AND status = 'active'
             AND (expires_at IS NULL OR expires_at > clock_timestamp())`,
            [session.vendor_id],
        );
        if (integration.rowCount !== 1) throw integrationRequired();
        const product = await tx.query<{ id: string }>(
            `SELECT id FROM products
             WHERE id = $1 AND vendor_id = $2 AND status = 'active' AND deleted_at IS NULL FOR UPDATE`,
            [session.product_id, session.vendor_id],
        );
        if (product.rowCount !== 1) throw new BadRequestError('Product is no longer available');
        const code = randomBytes(32).toString('base64url');
        const inserted = await tx.query<{ expires_at: Date }>(
            `INSERT INTO merchant_assertions
             (code_hash, user_id, vendor_id, origin, purpose, campaign_id, disclosure_grant_id,
              evidence_id, processing_grant_id, product_id, claim_session_id, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                     LEAST($12::timestamptz, clock_timestamp() + interval '2 minutes'))
             RETURNING expires_at`,
            [hash(code), userId, session.vendor_id, grant.origin!, grant.purpose!, session.checkout_id,
                input.disclosureGrantId, eligibility.evidenceId, eligibility.processingGrantId,
                session.product_id, session.id, eligibility.expiresAt],
        );
        return {
            code,
            expiresAt: inserted.rows[0]!.expires_at.toISOString(),
            handoffUrl: `${grant.origin!}${MERCHANT_CLAIM_CALLBACK_PATH}?assertion=${code}`,
        };
    });
}
