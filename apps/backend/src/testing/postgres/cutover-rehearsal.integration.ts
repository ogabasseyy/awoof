import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test, { after } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import type { Pool, PoolClient } from 'pg';
import { db } from '../../config/database.js';
import { errorHandler } from '../../common/middleware/errorHandler.js';
import vendorsRouter from '../../routes/vendors.routes.js';
import { AdminStudentController } from '../../controllers/admin-student.controller.js';
import { CheckoutController } from '../../controllers/checkout.controller.js';
import { StudentController } from '../../controllers/student.controller.js';
import type { AuthRequest } from '../../middleware/auth.middleware.js';
import { jwtService } from '../../services/auth/jwt.service.js';
import { rotateReportingKey } from '../../services/auth/reporting-key.service.js';
import { completeMarketplaceTransactionWithClient } from '../../services/payment/checkout.service.js';
import {
    grantMerchantDisclosure,
    grantVerificationProcessing,
    withdrawConsent,
} from '../../services/verification/eligibility-consent.service.js';
import { lockStudentContext } from '../../services/verification/eligibility-context.service.js';
import { requestChallenge, consumeChallenge } from '../../services/verification/challenge.service.js';
import {
    applyEnrollmentDecision,
    beginEnrollmentCheck,
    recordEmailAssurance,
} from '../../services/verification/eligibility-evidence.service.js';
import { updateInstitutionPolicy } from '../../services/verification/eligibility-policy.service.js';
import { ENROLLMENT_SOURCE } from '../../services/verification/eligibility.types.js';
import {
    exchangeMerchantAssertion,
    issueMerchantAssertion,
} from '../../services/verification/merchant-assertion.service.js';
import { claimProductBenefit, createMerchantClaimSession } from '../../services/verification/product-claim.service.js';
import {
    createVerificationToken,
    revokeUnusedLegacyTokens,
    validateAndConsumeToken,
} from '../../services/verification/verification-token.service.js';
import {
    MERCHANT_DISCLOSURE_NOTICE_VERSION,
    VERIFICATION_NOTICE_VERSION,
} from '../../services/verification/verification-notices.js';
import { assertFixtureDatabase, createTestPool, inTransaction } from './test-database.js';

after(() => db.close());

const response = { status() { return this; }, json() { return this; } } as unknown as Response;

type CutoverFixture = {
    label: string;
    emailOnly: string;
    emailOnlyProfile: string;
    emailOnlyDisclosure: string;
    enrolled: string;
    enrolledProfile: string;
    enrolledDisclosure: string;
    enrolledGrant: string;
    owner: string;
    ownerEmail: string;
    vendor: string;
    product: string;
    origin: string;
    key: string;
};

async function mailboxProof(client: PoolClient, userId: string, grantId: string): Promise<void> {
    await inTransaction(client, async () => {
        const context = await lockStudentContext(client, userId);
        const issued = await requestChallenge(client, {
            purpose: 'student_email', subjectKey: userId,
            bindings: { ...context, processingGrantId: grantId, noticeVersion: VERIFICATION_NOTICE_VERSION },
        });
        assert.equal(issued.status, 'issued');
        if (issued.status !== 'issued') throw new Error('Cutover challenge unavailable');
        assert.equal((await consumeChallenge(client, {
            purpose: 'student_email', subjectKey: userId,
            challengeId: issued.challengeId, code: issued.code,
        })).status, 'verified');
        await recordEmailAssurance(client, userId, { challengeId: issued.challengeId, processingGrantId: grantId });
    });
}

async function cutoverFixture(pool: Pool, client: PoolClient): Promise<CutoverFixture> {
    const label = randomUUID();
    const admin = (await client.query(
        `INSERT INTO users (email, role) VALUES ($1, 'admin') RETURNING id`,
        [`cutover-admin-${label}@example.invalid`],
    )).rows[0].id as string;
    const ownerEmail = `cutover-vendor-${label}@example.invalid`;
    const owner = (await client.query(
        `INSERT INTO users (email, role) VALUES ($1, 'vendor') RETURNING id`, [ownerEmail],
    )).rows[0].id as string;
    const university = (await client.query(
        `INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id`, [`Cutover ${label}`],
    )).rows[0].id as string;
    await client.query(
        `INSERT INTO university_verification_methods (university_id, method_type, api_endpoint, is_active)
         VALUES ($1, 'registration', 'https://institution.example/verify', true)`,
        [university],
    );
    await inTransaction(client, () => updateInstitutionPolicy(client, admin, university, {
        domains: ['students.example'], emailEvidenceValidityDays: 90, enrollmentValidityDays: 30,
        registrationNormalization: 'trim_upper', isActive: true,
    }));
    async function student(kind: string): Promise<{ user: string; profile: string; grant: string }> {
        const email = `cutover-${kind}-${label}@students.example`;
        const user = (await client.query(
            `INSERT INTO users (email, role) VALUES ($1, 'student') RETURNING id`, [email],
        )).rows[0].id as string;
        const profile = (await client.query(
            `INSERT INTO students (user_id, name, university_id) VALUES ($1, $2, $3) RETURNING id`,
            [user, `Cutover ${kind} ${label}`, university],
        )).rows[0].id as string;
        const grant = await inTransaction(client, () => grantVerificationProcessing(client, user, university,
            { accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION }));
        await mailboxProof(client, user, grant);
        return { user, profile, grant };
    }
    const emailOnly = await student('emailonly');
    const enrolled = await student('enrolled');
    const snapshot = await inTransaction(client, () => beginEnrollmentCheck(client, enrolled.user, enrolled.grant));
    const decision = await inTransaction(client, () => applyEnrollmentDecision(client, snapshot, {
        outcome: 'verified', email: `cutover-enrolled-${label}@students.example`,
        registrationNumber: `CUTOVER-${label.slice(0, 8)}`,
        validUntil: new Date(Date.now() + 30 * 86_400_000), source: ENROLLMENT_SOURCE,
    }));
    assert.equal(decision.eligible, true);
    const vendor = (await client.query(
        `INSERT INTO vendors (user_id, name, status) VALUES ($1, $2, 'active') RETURNING id`,
        [owner, `Cutover ${label}`],
    )).rows[0].id as string;
    const host = `cutover-${label}.example`.toLowerCase();
    const origin = `https://${host}`;
    await client.query(
        `INSERT INTO widget_configs (vendor_id, allowed_domains, allowed_origins, api_key, status)
         VALUES ($1, $2, $3, $4, 'active')`,
        [vendor, [host], [origin], label],
    );
    async function disclosure(userId: string): Promise<string> {
        return inTransaction(client, () => grantMerchantDisclosure(client, userId, {
            vendorId: vendor, origin, purpose: 'student-discount', accepted: true,
            noticeVersion: MERCHANT_DISCLOSURE_NOTICE_VERSION,
        }));
    }
    const product = (await client.query(
        `INSERT INTO products (vendor_id, name, price, student_price, stock, status)
         VALUES ($1, 'Cutover', 100, 80, 4, 'active') RETURNING id`,
        [vendor],
    )).rows[0].id as string;
    const key = await rotateReportingKey(pool, owner);
    return {
        label,
        emailOnly: emailOnly.user,
        emailOnlyProfile: emailOnly.profile,
        emailOnlyDisclosure: await disclosure(emailOnly.user),
        enrolled: enrolled.user,
        enrolledProfile: enrolled.profile,
        enrolledDisclosure: await disclosure(enrolled.user),
        enrolledGrant: enrolled.grant,
        owner, ownerEmail, vendor, product, origin, key,
    };
}

async function startReportServer(): Promise<{ endpoint: string; close: () => Promise<void> }> {
    const app = express();
    app.use(express.json());
    app.use('/vendors', vendorsRouter);
    app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo | null;
    if (!address || typeof address === 'string') throw new Error('Expected a loopback test port');
    return {
        endpoint: `http://127.0.0.1:${address.port}/vendors/transactions/report`,
        close: async () => { server.close(); await once(server, 'close'); },
    };
}

function nonceHash(nonce: string): string {
    return createHash('sha256').update(nonce).digest('hex');
}

test('cutover retains historical purchases and savings for email-only students', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        await assertFixtureDatabase(client);
        const fixture = await cutoverFixture(pool, client);
        // A preexisting completed order from before the enrollment-only
        // release: history stays readable even though no new discount is due.
        await client.query(
            `INSERT INTO transactions
                 (student_id, product_id, vendor_id, amount, commission, status,
                  list_price_snapshot, recorded_savings_delta, paystack_reference)
             VALUES ($1, $2, $3, 80, 8, 'completed', 100, 20, $4)`,
            [fixture.emailOnlyProfile, fixture.product, fixture.vendor, `cutover-history-${fixture.label}`],
        );
        await client.query(
            `INSERT INTO savings_stats (student_id, total_savings, total_purchases)
             VALUES ($1, 20, 1)`,
            [fixture.emailOnlyProfile],
        );
        let body = {} as {
            summary: { recordedSavings: number };
            students: { email: string; totalSavings: number | null; recordedSavings: number }[];
        };
        const capture = {
            status() { return this; },
            json(value: { data: typeof body }) { body = value.data; return this; },
        } as unknown as Response;
        await new StudentController().getSavings(
            { user: { userId: fixture.emailOnly, role: 'student' }, query: {} } as unknown as AuthRequest,
            capture,
        );
        assert.equal(body.summary.recordedSavings, 20);
        await new AdminStudentController().getStudents(
            { query: { search: fixture.label } } as unknown as Request, capture,
        );
        const row = body.students.find((entry) => entry.email.includes('emailonly'));
        assert.ok(row);
        assert.equal(row.totalSavings, 20);
        assert.equal(row.recordedSavings, 20);
    } finally {
        client.release();
        await pool.end();
    }
});

test('email-only proofs fail every benefit consumer on the upgraded database', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    const server = await startReportServer();
    try {
        await assertFixtureDatabase(client);
        const fixture = await cutoverFixture(pool, client);
        // Checkout start.
        await assert.rejects(
            new CheckoutController().createCheckout(
                { user: { userId: fixture.emailOnly, role: 'student' }, body: { productId: randomUUID() } } as AuthRequest,
                response,
            ),
            /Current student eligibility is required/,
        );
        // Assertion issuance.
        await assert.rejects(
            issueMerchantAssertion(pool, fixture.emailOnly, {
                vendorId: fixture.vendor, origin: fixture.origin, purpose: 'student-discount',
                campaignId: `cutover-${fixture.label.slice(0, 8)}`, disclosureGrantId: fixture.emailOnlyDisclosure,
            }),
            /Current student eligibility/,
        );
        // Product claim.
        const session = await createMerchantClaimSession(pool, fixture.key, {
            productId: fixture.product,
            merchantCheckoutId: `cutover-checkout-${fixture.label}`,
            browserNonceHash: nonceHash(`cutover-nonce-${fixture.label}`),
            origin: fixture.origin,
        });
        await assert.rejects(
            claimProductBenefit(pool, fixture.emailOnly, {
                merchantClaimSessionId: session.claimSessionId,
                disclosureGrantId: fixture.emailOnlyDisclosure,
            }),
            /Current student enrollment required/,
        );
        // Transaction reporting with a legacy token.
        const legacyToken = `cutover_legacy_${randomUUID()}`;
        await client.query(
            `INSERT INTO verification_tokens (token, student_id, vendor_id, product_id, expires_at)
             VALUES ($1, $2, $3, $4, now() + interval '10 minutes')`,
            [legacyToken, fixture.emailOnlyProfile, fixture.vendor, fixture.product],
        );
        const auth = `Bearer ${jwtService.generateAccessToken({ userId: fixture.owner, email: fixture.ownerEmail, role: 'vendor' })}`;
        const base = { productId: fixture.product, paymentReference: randomUUID(), amount: 8000, paymentGateway: 'other' };
        const rejected = await fetch(server.endpoint, {
            method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
            body: JSON.stringify({ ...base, verificationToken: legacyToken }),
        });
        assert.equal(rejected.status, 422);
        const unknown = await fetch(server.endpoint, {
            method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
            body: JSON.stringify({ ...base, benefitAuthorizationId: randomUUID() }),
        });
        assert.equal(unknown.status, 404);
        // Retired token entrypoints stay sealed.
        await assert.rejects(
            createVerificationToken(fixture.emailOnlyProfile, fixture.vendor, fixture.product),
            /retired/,
        );
        await assert.rejects(validateAndConsumeToken(legacyToken, fixture.vendor), /retired/);
        // Payment fulfillment reconciles instead of completing a discount.
        const reference = `cutover-fulfill-${fixture.label}`;
        await client.query(
            `INSERT INTO transactions
                 (student_id, product_id, vendor_id, amount, commission, status,
                  list_price_snapshot, paystack_reference, payment_source)
             VALUES ($1, $2, $3, 80, 8, 'pending', 100, $4, 'awoof')`,
            [fixture.emailOnlyProfile, fixture.product, fixture.vendor, reference],
        );
        const stockBefore = (await client.query(
            `SELECT stock FROM products WHERE id = $1`, [fixture.product],
        )).rows[0].stock;
        const settled = await completeMarketplaceTransactionWithClient(client, reference, 80);
        assert.equal(settled.completed, false);
        assert.equal((await client.query(
            `SELECT status FROM transactions WHERE paystack_reference = $1`, [reference],
        )).rows[0].status, 'requires_refund');
        assert.equal((await client.query(
            `SELECT reason FROM payment_reconciliation_queue WHERE transaction_id = $1`, [settled.transactionId],
        )).rows[0].reason, 'eligibility_not_current');
        assert.equal((await client.query(
            `SELECT stock FROM products WHERE id = $1`, [fixture.product],
        )).rows[0].stock, stockBefore);
    } finally {
        await server.close();
        client.release();
        await pool.end();
    }
});

test('enrolled students keep issuance, exchange, and fulfillment as the positive canary', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        await assertFixtureDatabase(client);
        const fixture = await cutoverFixture(pool, client);
        const campaignId = `canary-${fixture.label.slice(0, 8)}`;
        const issued = await issueMerchantAssertion(pool, fixture.enrolled, {
            vendorId: fixture.vendor, origin: fixture.origin, purpose: 'student-discount',
            campaignId, disclosureGrantId: fixture.enrolledDisclosure, productId: fixture.product,
        });
        const receipt = await exchangeMerchantAssertion(pool, fixture.key, {
            code: issued.code, campaignId, idempotencyKey: `canary-${randomUUID()}`,
        }) as unknown as Record<string, unknown>;
        assert.equal(receipt.eligible, true);
        assert.equal(typeof receipt.benefitAuthorizationId, 'string');
        const reference = `canary-fulfill-${fixture.label}`;
        await client.query(
            `INSERT INTO transactions
                 (student_id, product_id, vendor_id, amount, commission, status,
                  list_price_snapshot, paystack_reference, payment_source)
             VALUES ($1, $2, $3, 80, 8, 'pending', 100, $4, 'awoof')`,
            [fixture.enrolledProfile, fixture.product, fixture.vendor, reference],
        );
        const settled = await completeMarketplaceTransactionWithClient(client, reference, 80);
        assert.equal(settled.completed, true);
        assert.equal((await client.query(
            `SELECT status, recorded_savings_delta FROM transactions WHERE paystack_reference = $1`, [reference],
        )).rows[0].status, 'completed');
    } finally {
        client.release();
        await pool.end();
    }
});

test('already-paid orders that lose enrollment reconcile instead of completing', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        await assertFixtureDatabase(client);
        const fixture = await cutoverFixture(pool, client);
        const reference = `cutover-lapsed-${fixture.label}`;
        await client.query(
            `INSERT INTO transactions
                 (student_id, product_id, vendor_id, amount, commission, status,
                  list_price_snapshot, paystack_reference, payment_source)
             VALUES ($1, $2, $3, 80, 8, 'pending', 100, $4, 'awoof')`,
            [fixture.enrolledProfile, fixture.product, fixture.vendor, reference],
        );
        await inTransaction(client, () => withdrawConsent(client, fixture.enrolled, fixture.enrolledGrant));
        const settled = await completeMarketplaceTransactionWithClient(client, reference, 80);
        assert.equal(settled.completed, false);
        assert.equal((await client.query(
            `SELECT status FROM transactions WHERE paystack_reference = $1`, [reference],
        )).rows[0].status, 'requires_refund');
        assert.equal((await client.query(
            `SELECT reason FROM payment_reconciliation_queue WHERE transaction_id = $1`, [settled.transactionId],
        )).rows[0].reason, 'eligibility_not_current');
        assert.equal((await client.query(
            `SELECT count(*)::int AS count FROM savings_stats WHERE student_id = $1`,
            [fixture.enrolledProfile],
        )).rows[0].count, 0);
    } finally {
        client.release();
        await pool.end();
    }
});

test('cutover token retirement revokes only unused legacy tokens', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        await assertFixtureDatabase(client);
        const fixture = await cutoverFixture(pool, client);
        const unused = `cutover_unused_${randomUUID()}`;
        const used = `cutover_used_${randomUUID()}`;
        await client.query(
            `INSERT INTO verification_tokens (token, student_id, vendor_id, product_id, expires_at)
             VALUES ($1, $2, $3, $4, now() + interval '10 minutes')`,
            [unused, fixture.enrolledProfile, fixture.vendor, fixture.product],
        );
        await client.query(
            `INSERT INTO verification_tokens (token, student_id, vendor_id, product_id, expires_at, used_at)
             VALUES ($1, $2, $3, $4, now() + interval '10 minutes', now() - interval '1 hour')`,
            [used, fixture.enrolledProfile, fixture.vendor, fixture.product],
        );
        assert.ok(await revokeUnusedLegacyTokens(client) >= 1);
        assert.equal(await revokeUnusedLegacyTokens(client), 0);
        const rows = (await client.query(
            `SELECT token, used_at, revoked_at FROM verification_tokens WHERE token = ANY($1::text[])`,
            [[unused, used]],
        )).rows as { token: string; used_at: Date | null; revoked_at: Date | null }[];
        assert.ok(rows.find((row) => row.token === unused)?.revoked_at instanceof Date);
        assert.equal(rows.find((row) => row.token === unused)?.used_at, null);
        assert.equal(rows.find((row) => row.token === used)?.revoked_at, null);
    } finally {
        client.release();
        await pool.end();
    }
});
