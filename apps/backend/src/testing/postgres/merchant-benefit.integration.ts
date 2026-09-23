import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test, { after } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Pool, PoolClient } from 'pg';
import { db } from '../../config/database.js';
import { errorHandler } from '../../common/middleware/errorHandler.js';
import vendorsRouter from '../../routes/vendors.routes.js';
import { jwtService } from '../../services/auth/jwt.service.js';
import { rotateReportingKey } from '../../services/auth/reporting-key.service.js';
import { grantMerchantDisclosure, grantVerificationProcessing, withdrawConsent } from '../../services/verification/eligibility-consent.service.js';
import { updateInstitutionPolicy } from '../../services/verification/eligibility-policy.service.js';
import { lockStudentContext } from '../../services/verification/eligibility-context.service.js';
import { requestChallenge, consumeChallenge } from '../../services/verification/challenge.service.js';
import { applyEnrollmentDecision, beginEnrollmentCheck, recordEmailAssurance } from '../../services/verification/eligibility-evidence.service.js';
import { ENROLLMENT_SOURCE } from '../../services/verification/eligibility.types.js';
import { MERCHANT_DISCLOSURE_NOTICE_VERSION, VERIFICATION_NOTICE_VERSION } from '../../services/verification/verification-notices.js';
import { issueMerchantAssertion, exchangeMerchantAssertion } from '../../services/verification/merchant-assertion.service.js';
import {
    BENEFIT_CURRENCY,
    computePricingVersion,
    deleteExpiredUnusedBenefitAuthorizations,
    restoreExpiredBenefitReservations,
} from '../../services/verification/merchant-benefit.service.js';
import {
    createVerificationToken,
    revokeUnusedLegacyTokens,
    validateAndConsumeToken,
    validateToken,
} from '../../services/verification/verification-token.service.js';
import { createTestPool, inTransaction, assertFixtureDatabase } from './test-database.js';

after(() => db.close());

type BenefitFixture = {
    label: string;
    student: string;
    studentEmail: string;
    owner: string;
    ownerEmail: string;
    admin: string;
    university: string;
    studentProfile: string;
    vendor: string;
    product: string;
    origin: string;
    disclosure: string;
    processing: string;
    key: string;
};

async function enrolledFixture(
    pool: Pool,
    client: PoolClient,
    prices: { listPrice?: number; studentPrice?: number; stock?: number } = {},
): Promise<BenefitFixture> {
    const label = randomUUID();
    const studentEmail = `student-${label}@students.example`;
    const ownerEmail = `vendor-${label}@example.invalid`;
    const student = (await client.query(
        'INSERT INTO users (email,role) VALUES ($1,$2) RETURNING id', [studentEmail, 'student'],
    )).rows[0].id as string;
    const owner = (await client.query(
        'INSERT INTO users (email,role) VALUES ($1,$2) RETURNING id', [ownerEmail, 'vendor'],
    )).rows[0].id as string;
    const admin = (await client.query(
        'INSERT INTO users (email,role) VALUES ($1,$2) RETURNING id', [`admin-${label}@example.invalid`, 'admin'],
    )).rows[0].id as string;
    const university = (await client.query(
        'INSERT INTO universities (name,is_active) VALUES ($1,true) RETURNING id', [label],
    )).rows[0].id as string;
    const studentProfile = (await client.query(
        'INSERT INTO students (user_id,name,university_id) VALUES ($1,$2,$3) RETURNING id', [student, label, university],
    )).rows[0].id as string;
    await inTransaction(client, () => updateInstitutionPolicy(client, admin, university, {
        domains: ['students.example'], emailEvidenceValidityDays: 90, enrollmentValidityDays: 30,
        registrationNormalization: 'trim_upper', isActive: true,
    }));
    const processing = await inTransaction(client, () => grantVerificationProcessing(client, student, university,
        { accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION }));
    await inTransaction(client, async () => {
        const context = await lockStudentContext(client, student);
        const issued = await requestChallenge(client, {
            purpose: 'student_email', subjectKey: student,
            bindings: { ...context, processingGrantId: processing, noticeVersion: VERIFICATION_NOTICE_VERSION },
        });
        assert.equal(issued.status, 'issued');
        if (issued.status !== 'issued') throw new Error('Challenge fixture failed');
        await consumeChallenge(client, {
            purpose: 'student_email', subjectKey: student, challengeId: issued.challengeId, code: issued.code,
        });
        await recordEmailAssurance(client, student, { challengeId: issued.challengeId, processingGrantId: processing });
    });
    await client.query(`INSERT INTO university_verification_methods (university_id,method_type,api_endpoint,is_active)
        VALUES ($1,'registration','https://institution.example/verify',true)`, [university]);
    const snapshot = await inTransaction(client, () => beginEnrollmentCheck(client, student, processing));
    const decision = await inTransaction(client, () => applyEnrollmentDecision(client, snapshot, {
        outcome: 'verified', email: studentEmail.toLowerCase(), registrationNumber: `BENEFIT-${label.slice(0, 8)}`,
        validUntil: new Date(Date.now() + 30 * 86_400_000), source: ENROLLMENT_SOURCE,
    }));
    assert.equal(decision.eligible, true);
    const vendor = (await client.query(
        "INSERT INTO vendors (user_id,name,status) VALUES ($1,$2,'active') RETURNING id", [owner, label],
    )).rows[0].id as string;
    const host = `shop-${label}.example`.toLowerCase();
    const origin = `https://${host}`;
    await client.query(
        "INSERT INTO widget_configs (vendor_id,allowed_domains,allowed_origins,api_key,status) VALUES ($1,$2,$3,$4,'active')",
        [vendor, [host], [origin], label],
    );
    const disclosure = await inTransaction(client, () => grantMerchantDisclosure(client, student, {
        vendorId: vendor, origin, purpose: 'student-discount', accepted: true,
        noticeVersion: MERCHANT_DISCLOSURE_NOTICE_VERSION,
    }));
    const product = (await client.query(
        `INSERT INTO products (vendor_id,name,price,student_price,stock,status) VALUES ($1,'Synthetic benefit',$2,$3,$4,'active') RETURNING id`,
        [vendor, prices.listPrice ?? 100, prices.studentPrice ?? 80, prices.stock ?? 4],
    )).rows[0].id as string;
    const key = await rotateReportingKey(pool, owner);
    return {
        label, student, studentEmail, owner, ownerEmail, admin, university,
        studentProfile, vendor, product, origin, disclosure, processing, key,
    };
}

async function productAuthorization(
    pool: Pool, fixture: BenefitFixture, productId: string = fixture.product,
): Promise<{ receipt: Record<string, unknown>; benefitAuthorizationId: string }> {
    const issued = await issueMerchantAssertion(pool, fixture.student, {
        vendorId: fixture.vendor, origin: fixture.origin, purpose: 'student-discount',
        campaignId: `benefit-${fixture.label.slice(0, 8)}`, disclosureGrantId: fixture.disclosure,
        productId,
    });
    const receipt = await exchangeMerchantAssertion(pool, fixture.key, {
        code: issued.code, campaignId: `benefit-${fixture.label.slice(0, 8)}`,
        idempotencyKey: `benefit-${randomUUID()}`,
    }) as unknown as Record<string, unknown>;
    assert.equal(typeof receipt.benefitAuthorizationId, 'string');
    return { receipt, benefitAuthorizationId: receipt.benefitAuthorizationId as string };
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

type ReportResponse = { status: number; body: Record<string, unknown> };

async function postReport(endpoint: string, auth: string, payload: unknown): Promise<ReportResponse> {
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    return { status: response.status, body };
}

function vendorJwt(fixture: BenefitFixture): string {
    return jwtService.generateAccessToken({ userId: fixture.owner, email: fixture.ownerEmail, role: 'vendor' });
}

async function lapseEnrollmentToExpired(client: PoolClient, fixture: BenefitFixture): Promise<void> {
    // Evidence rows are immutable, so lapse is simulated by revoking the live
    // enrollment rows and letting a historical expired row take the pointer.
    await client.query(
        `UPDATE eligibility_evidence SET revoked_at = clock_timestamp()
         WHERE student_id = $1 AND method = 'enrollment'`,
        [fixture.studentProfile],
    );
    const original = (await client.query(
        `SELECT email_proof_id, identity_version, policy_version
         FROM eligibility_evidence
         WHERE student_id = $1 AND method = 'enrollment'
         ORDER BY verified_at DESC LIMIT 1`,
        [fixture.studentProfile],
    )).rows[0];
    const expired = (await client.query(
        `INSERT INTO eligibility_evidence
             (student_id, university_id, email_proof_id, processing_grant_id,
              method, outcome, identity_version, policy_version, source, expires_at)
         VALUES ($1, $2, $3, $4, 'enrollment', 'verified', $5, $6, $7,
                 clock_timestamp() - interval '1 minute')
         RETURNING id`,
        [
            fixture.studentProfile, fixture.university, original.email_proof_id,
            fixture.processing, original.identity_version, original.policy_version,
            ENROLLMENT_SOURCE,
        ],
    )).rows[0];
    await client.query(
        'UPDATE student_eligibility_state SET current_evidence_id = $3 WHERE student_id = $1 AND university_id = $2',
        [fixture.studentProfile, fixture.university, expired.id],
    );
}

async function ledgerSnapshot(client: PoolClient, fixture: BenefitFixture): Promise<{
    transactions: number; stock: number; savings: { total: string; purchases: number } | null;
}> {
    const transactions = (await client.query(
        'SELECT count(*)::int AS count FROM transactions WHERE vendor_id = $1', [fixture.vendor],
    )).rows[0].count as number;
    const stock = (await client.query('SELECT stock FROM products WHERE id = $1', [fixture.product])).rows[0].stock as number;
    const savings = (await client.query(
        'SELECT total_savings, total_purchases FROM savings_stats WHERE student_id = $1', [fixture.studentProfile],
    )).rows[0] as { total_savings: string; total_purchases: number } | undefined;
    return {
        transactions,
        stock,
        savings: savings ? { total: String(savings.total_savings), purchases: savings.total_purchases } : null,
    };
}

test('payment references are trimmed and bounded at the request boundary', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    const server = await startReportServer();
    try {
        await assertFixtureDatabase(client);
        const fixture = await enrolledFixture(pool, client);
        const { benefitAuthorizationId } = await productAuthorization(pool, fixture);
        const auth = `Bearer ${vendorJwt(fixture)}`;
        const base = {
            benefitAuthorizationId, productId: fixture.product, amount: 8000, paymentGateway: 'other',
        };
        assert.equal((await postReport(server.endpoint, auth, { ...base, paymentReference: 'x'.repeat(256) })).status, 422);
        assert.equal((await postReport(server.endpoint, auth, { ...base, paymentReference: '   ' })).status, 422);
        const reference = randomUUID();
        const stored = await postReport(server.endpoint, auth, { ...base, paymentReference: `  ${reference}  ` });
        assert.equal(stored.status, 201);
        assert.equal((await client.query('SELECT vendor_payment_reference FROM transactions WHERE vendor_id = $1', [fixture.vendor])).rows[0].vendor_payment_reference, reference);
    } finally {
        await server.close();
        client.release();
        await pool.end();
    }
});

test('legacy verification tokens fail closed on the reporting route and retired entrypoints stay sealed', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    const server = await startReportServer();
    try {
        await assertFixtureDatabase(client);
        const fixture = await enrolledFixture(pool, client);
        const legacyToken = `awoof_${randomBytes(32).toString('hex')}`;
        await client.query(`INSERT INTO verification_tokens (token,student_id,vendor_id,product_id,expires_at)
            VALUES ($1,$2,$3,$4,now() + interval '10 minutes')`,
            [legacyToken, fixture.studentProfile, fixture.vendor, fixture.product]);
        const uuidShapedLegacy = randomUUID();
        await client.query(`INSERT INTO verification_tokens (token,student_id,vendor_id,product_id,expires_at)
            VALUES ($1,$2,$3,$4,now() + interval '10 minutes')`,
            [uuidShapedLegacy, fixture.studentProfile, fixture.vendor, fixture.product]);
        const { benefitAuthorizationId } = await productAuthorization(pool, fixture);
        // The mint above reserves one unit; rejected reports must not move
        // the ledger (including stock) from here on.
        const before = await ledgerSnapshot(client, fixture);
        const auth = `Bearer ${vendorJwt(fixture)}`;
        const base = { productId: fixture.product, paymentReference: randomUUID(), amount: 8000, paymentGateway: 'other' };
        assert.equal((await postReport(server.endpoint, auth, { ...base, verificationToken: legacyToken })).status, 422);
        assert.equal((await postReport(server.endpoint, auth, { ...base, benefitAuthorizationId: legacyToken })).status, 422);
        assert.equal((await postReport(server.endpoint, auth, { ...base, benefitAuthorizationId: uuidShapedLegacy })).status, 404);
        assert.equal((await postReport(server.endpoint, auth, { ...base, benefitAuthorizationId: randomUUID() })).status, 404);
        const strict = await postReport(server.endpoint, auth, {
            ...base, benefitAuthorizationId, injected: 'nope',
        });
        assert.equal(strict.status, 422);
        assert.deepEqual(await ledgerSnapshot(client, fixture), before);
        await assert.rejects(createVerificationToken(fixture.studentProfile, fixture.vendor, fixture.product), /retired/);
        await assert.rejects(validateAndConsumeToken(legacyToken, fixture.vendor), /retired/);
        const retired = await validateToken(legacyToken, fixture.vendor);
        assert.equal(retired.valid, false);
        assert.match(retired.error ?? '', /retired/);
    } finally {
        await server.close();
        client.release();
        await pool.end();
    }
});

test('token retirement revokes only unused legacy tokens and never marks them used', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        await assertFixtureDatabase(client);
        const fixture = await enrolledFixture(pool, client);
        const unused = randomUUID();
        const used = randomUUID();
        await client.query(`INSERT INTO verification_tokens (token,student_id,vendor_id,product_id,expires_at)
            VALUES ($1,$2,$3,$4,now() + interval '10 minutes')`,
            [unused, fixture.studentProfile, fixture.vendor, fixture.product]);
        await client.query(`INSERT INTO verification_tokens (token,student_id,vendor_id,product_id,expires_at,used_at)
            VALUES ($1,$2,$3,$4,now() + interval '10 minutes',now() - interval '1 hour')`,
            [used, fixture.studentProfile, fixture.vendor, fixture.product]);
        assert.ok(await revokeUnusedLegacyTokens(client) >= 1);
        assert.equal(await revokeUnusedLegacyTokens(client), 0);
        const rows = (await client.query(
            'SELECT token, used_at, revoked_at FROM verification_tokens WHERE token = ANY($1::text[])',
            [[unused, used]],
        )).rows as { token: string; used_at: Date | null; revoked_at: Date | null }[];
        const unusedRow = rows.find((row) => row.token === unused);
        const usedRow = rows.find((row) => row.token === used);
        assert.ok(unusedRow?.revoked_at instanceof Date);
        assert.equal(unusedRow.used_at, null);
        assert.equal(usedRow?.revoked_at, null);
        assert.ok(usedRow?.used_at instanceof Date);
    } finally {
        client.release();
        await pool.end();
    }
});

test('product-bound exchange mints a server-quoted authorization while generic receipts stay unchanged', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        await assertFixtureDatabase(client);
        const fixture = await enrolledFixture(pool, client);
        const generic = await issueMerchantAssertion(pool, fixture.student, {
            vendorId: fixture.vendor, origin: fixture.origin, purpose: 'student-discount',
            campaignId: 'generic-campaign', disclosureGrantId: fixture.disclosure,
        });
        const genericReceipt = await exchangeMerchantAssertion(pool, fixture.key, {
            code: generic.code, campaignId: 'generic-campaign', idempotencyKey: `generic-${randomUUID()}`,
        }) as unknown as Record<string, unknown>;
        assert.equal('benefitAuthorizationId' in genericReceipt, false);
        const genericRow = (await client.query(
            'SELECT product_id FROM merchant_assertions WHERE vendor_id = $1 AND campaign_id = $2',
            [fixture.vendor, 'generic-campaign'],
        )).rows[0];
        assert.equal(genericRow.product_id, null);
        const { receipt, benefitAuthorizationId } = await productAuthorization(pool, fixture);
        assert.equal(typeof benefitAuthorizationId, 'string');
        const stored = (await client.query('SELECT * FROM merchant_benefit_authorizations WHERE id = $1', [benefitAuthorizationId])).rows[0];
        assert.equal(stored.vendor_id, fixture.vendor);
        assert.equal(stored.product_id, fixture.product);
        assert.equal(stored.currency, 'NGN');
        assert.equal(stored.currency, BENEFIT_CURRENCY);
        assert.equal(Number(stored.list_price_snapshot), 100);
        assert.equal(Number(stored.student_price_snapshot), 80);
        assert.equal(stored.pricing_version, computePricingVersion(fixture.product, 'NGN', 100, 80));
        assert.equal(stored.transaction_id, null);
        const current = (await client.query(
            `SELECT e.id, e.expires_at FROM student_eligibility_state s
             JOIN eligibility_evidence e ON e.id = s.current_evidence_id
             WHERE s.student_id = $1`,
            [fixture.studentProfile],
        )).rows[0];
        assert.equal(stored.evidence_id, current.id);
        assert.ok(stored.expires_at <= current.expires_at);
        assert.ok((stored.expires_at as Date).getTime() <= Date.now() + 2 * 60_000 + 5_000);
        assert.equal(receipt.benefitAuthorizationId, benefitAuthorizationId);
        assert.equal(receipt.eligible, true);
        await assert.rejects(issueMerchantAssertion(pool, fixture.student, {
            vendorId: fixture.vendor, origin: fixture.origin, purpose: 'student-discount',
            campaignId: 'wrong-product', disclosureGrantId: fixture.disclosure, productId: randomUUID(),
        }), /Product|product/);
    } finally {
        client.release();
        await pool.end();
    }
});

test('reporting route settles a discounted transaction with vendor JWT', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    const server = await startReportServer();
    try {
        await assertFixtureDatabase(client);
        const fixture = await enrolledFixture(pool, client);
        const { benefitAuthorizationId } = await productAuthorization(pool, fixture);
        const reference = randomUUID();
        const first = await postReport(server.endpoint, `Bearer ${vendorJwt(fixture)}`, {
            benefitAuthorizationId, productId: fixture.product, paymentReference: reference,
            amount: 8000, paymentGateway: 'other',
        });
        assert.equal(first.status, 201);
        const data = first.body.data as Record<string, unknown>;
        assert.equal(typeof data.transactionId, 'string');
        assert.equal(data.status, 'completed');
        assert.equal(data.amount, 80);
        const stored = (await client.query('SELECT * FROM transactions WHERE id = $1', [data.transactionId])).rows[0];
        assert.equal(stored.student_id, fixture.studentProfile);
        assert.equal(stored.vendor_id, fixture.vendor);
        assert.equal(stored.product_id, fixture.product);
        assert.equal(Number(stored.amount), 80);
        assert.equal(stored.payment_source, 'vendor_other');
        assert.equal(stored.vendor_payment_reference, reference);
        assert.equal(Number(stored.list_price_snapshot), 100);
        assert.equal(Number(stored.recorded_savings_delta), 20);
        assert.equal(stored.inventory_consumed, true);
        assert.equal(stored.verification_token, null);
        assert.equal((await client.query('SELECT stock FROM products WHERE id = $1', [fixture.product])).rows[0].stock, 3);
        const savings = (await client.query('SELECT total_savings, total_purchases FROM savings_stats WHERE student_id = $1', [fixture.studentProfile])).rows[0];
        assert.equal(Number(savings.total_savings), 20);
        assert.equal(savings.total_purchases, 1);
        assert.equal((await client.query('SELECT transaction_id FROM merchant_benefit_authorizations WHERE id = $1', [benefitAuthorizationId])).rows[0].transaction_id, data.transactionId);
    } finally {
        await server.close();
        client.release();
        await pool.end();
    }
});

test('reporting route settles with a vendor API key', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    const server = await startReportServer();
    try {
        await assertFixtureDatabase(client);
        const fixture = await enrolledFixture(pool, client);
        const { benefitAuthorizationId } = await productAuthorization(pool, fixture);
        const first = await postReport(server.endpoint, `Bearer ${fixture.key}`, {
            benefitAuthorizationId, productId: fixture.product, paymentReference: randomUUID(),
            amount: 8000, paymentGateway: 'other',
        });
        assert.equal(first.status, 201);
        assert.equal((first.body.data as Record<string, unknown>).status, 'completed');
    } finally {
        await server.close();
        client.release();
        await pool.end();
    }
});

test('factor-of-100 money errors are rejected without ledger writes', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    const server = await startReportServer();
    try {
        await assertFixtureDatabase(client);
        const fixture = await enrolledFixture(pool, client);
        const auth = `Bearer ${vendorJwt(fixture)}`;
        for (const wrongAmount of [80, 800000]) {
            const { benefitAuthorizationId } = await productAuthorization(pool, fixture);
            const before = await ledgerSnapshot(client, fixture);
            const refused = await postReport(server.endpoint, auth, {
                benefitAuthorizationId, productId: fixture.product, paymentReference: randomUUID(),
                amount: wrongAmount, paymentGateway: 'other',
            });
            assert.equal(refused.status, 400);
            assert.match(JSON.stringify(refused.body), /match|amount/i);
            assert.deepEqual(await ledgerSnapshot(client, fixture), before);
            assert.equal((await client.query('SELECT transaction_id FROM merchant_benefit_authorizations WHERE id = $1', [benefitAuthorizationId])).rows[0].transaction_id, null);
        }
    } finally {
        await server.close();
        client.release();
        await pool.end();
    }
});

test('provider minor units convert explicitly at the paystack boundary', async () => {
    const { default: axios } = await import('axios');
    const { config } = await import('../../config/env.js');
    const originalGet = axios.get;
    const oldKey = config.paystack.secretKey;
    Object.assign(config.paystack, { secretKey: 'synthetic-test-key' });
    const pool = createTestPool();
    const client = await pool.connect();
    const server = await startReportServer();
    try {
        await assertFixtureDatabase(client);
        const fixture = await enrolledFixture(pool, client);
        const auth = `Bearer ${vendorJwt(fixture)}`;
        const paystackSuccess = (amountKobo: number) => {
            axios.get = (async () => ({
                data: { data: { status: 'success', amount: amountKobo, customer: { email: 'student@example.invalid' }, metadata: {} } },
            })) as typeof axios.get;
        };
        const firstAuth = await productAuthorization(pool, fixture);
        paystackSuccess(8000);
        assert.equal((await postReport(server.endpoint, auth, {
            benefitAuthorizationId: firstAuth.benefitAuthorizationId, productId: fixture.product,
            paymentReference: randomUUID(), amount: 8000, paymentGateway: 'paystack',
        })).status, 201);
        const boundaryAuth = await productAuthorization(pool, fixture);
        paystackSuccess(8000);
        const boundary = await postReport(server.endpoint, auth, {
            benefitAuthorizationId: boundaryAuth.benefitAuthorizationId, productId: fixture.product,
            paymentReference: randomUUID(), amount: 80, paymentGateway: 'paystack',
        });
        assert.equal(boundary.status, 400);
        const providerAuth = await productAuthorization(pool, fixture);
        paystackSuccess(80);
        const provider = await postReport(server.endpoint, auth, {
            benefitAuthorizationId: providerAuth.benefitAuthorizationId, productId: fixture.product,
            paymentReference: randomUUID(), amount: 8000, paymentGateway: 'paystack',
        });
        assert.equal(provider.status, 400);
        assert.match(JSON.stringify(provider.body), /match/i);
        const deniedAuth = await productAuthorization(pool, fixture);
        axios.get = (async () => ({ data: { data: { status: 'failed' } } })) as typeof axios.get;
        assert.equal((await postReport(server.endpoint, auth, {
            benefitAuthorizationId: deniedAuth.benefitAuthorizationId, productId: fixture.product,
            paymentReference: randomUUID(), amount: 8000, paymentGateway: 'paystack',
        })).status, 400);
        assert.equal((await client.query('SELECT count(*)::int AS count FROM transactions WHERE vendor_id = $1', [fixture.vendor])).rows[0].count, 1);
    } finally {
        axios.get = originalGet;
        Object.assign(config.paystack, { secretKey: oldKey });
        await server.close();
        client.release();
        await pool.end();
    }
});

for (const lapsed of ['expired', 'denied', 'processing_withdrawn', 'disclosure_withdrawn', 'inactive'] as const) {
    test(`lapsed enrollment (${lapsed}) cannot authorize a product report`, async () => {
        const pool = createTestPool();
        const client = await pool.connect();
        const server = await startReportServer();
        try {
            await assertFixtureDatabase(client);
            const fixture = await enrolledFixture(pool, client);
            const { benefitAuthorizationId } = await productAuthorization(pool, fixture);
            if (lapsed === 'expired') {
                await lapseEnrollmentToExpired(client, fixture);
            } else if (lapsed === 'denied') {
                await client.query('UPDATE student_eligibility_state SET authoritative_denial = true WHERE student_id = $1',
                    [fixture.studentProfile]);
            } else if (lapsed === 'processing_withdrawn') {
                await inTransaction(client, () => withdrawConsent(client, fixture.student, fixture.processing));
            } else if (lapsed === 'disclosure_withdrawn') {
                await inTransaction(client, () => withdrawConsent(client, fixture.student, fixture.disclosure));
            } else {
                await client.query("UPDATE students SET status = 'suspended' WHERE id = $1", [fixture.studentProfile]);
            }
            const before = await ledgerSnapshot(client, fixture);
            const reference = randomUUID();
            const refused = await postReport(server.endpoint, `Bearer ${vendorJwt(fixture)}`, {
                benefitAuthorizationId, productId: fixture.product, paymentReference: reference,
                amount: 8000, paymentGateway: 'other',
            });
            assert.equal(refused.status, 409);
            assert.match(JSON.stringify(refused.body), /reconcil/i);
            assert.equal(((refused.body.error as Record<string, unknown>).details as Record<string, unknown>).paymentReference, reference);
            assert.deepEqual(await ledgerSnapshot(client, fixture), before);
            assert.equal((await client.query('SELECT transaction_id FROM merchant_benefit_authorizations WHERE id = $1', [benefitAuthorizationId])).rows[0].transaction_id, null);
        } finally {
            await server.close();
            client.release();
            await pool.end();
        }
    });
}

test('paystack reports reconcile when consent lapses after a verified payment', async () => {
    const { default: axios } = await import('axios');
    const { config } = await import('../../config/env.js');
    const originalGet = axios.get;
    const oldKey = config.paystack.secretKey;
    Object.assign(config.paystack, { secretKey: 'synthetic-test-key' });
    const pool = createTestPool();
    const client = await pool.connect();
    const server = await startReportServer();
    try {
        await assertFixtureDatabase(client);
        const fixture = await enrolledFixture(pool, client);
        const { benefitAuthorizationId } = await productAuthorization(pool, fixture);
        await inTransaction(client, () => withdrawConsent(client, fixture.student, fixture.disclosure));
        axios.get = (async () => ({
            data: { data: { status: 'success', amount: 8000, customer: { email: 'student@example.invalid' }, metadata: {} } },
        })) as typeof axios.get;
        const reference = randomUUID();
        const refused = await postReport(server.endpoint, `Bearer ${vendorJwt(fixture)}`, {
            benefitAuthorizationId, productId: fixture.product, paymentReference: reference,
            amount: 8000, paymentGateway: 'paystack',
        });
        assert.equal(refused.status, 409);
        assert.match(JSON.stringify(refused.body), /reconcil/i);
        assert.equal(((refused.body.error as Record<string, unknown>).details as Record<string, unknown>).paymentReference, reference);
        assert.equal((await client.query('SELECT count(*)::int AS count FROM transactions WHERE vendor_id = $1', [fixture.vendor])).rows[0].count, 0);
        assert.equal((await client.query('SELECT transaction_id FROM merchant_benefit_authorizations WHERE id = $1', [benefitAuthorizationId])).rows[0].transaction_id, null);
    } finally {
        axios.get = originalGet;
        Object.assign(config.paystack, { secretKey: oldKey });
        await server.close();
        client.release();
        await pool.end();
    }
});

test('email-only students cannot mint product authorizations or report', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    const server = await startReportServer();
    try {
        await assertFixtureDatabase(client);
        const label = randomUUID();
        const student = (await client.query('INSERT INTO users (email,role) VALUES ($1,$2) RETURNING id',
            [`student-${label}@students.example`, 'student'])).rows[0].id as string;
        const owner = (await client.query('INSERT INTO users (email,role) VALUES ($1,$2) RETURNING id',
            [`vendor-${label}@example.invalid`, 'vendor'])).rows[0].id as string;
        const admin = (await client.query('INSERT INTO users (email,role) VALUES ($1,$2) RETURNING id',
            [`admin-${label}@example.invalid`, 'admin'])).rows[0].id as string;
        const university = (await client.query('INSERT INTO universities (name,is_active) VALUES ($1,true) RETURNING id',
            [label])).rows[0].id as string;
        const studentProfile = (await client.query('INSERT INTO students (user_id,name,university_id) VALUES ($1,$2,$3) RETURNING id',
            [student, label, university])).rows[0].id as string;
        await inTransaction(client, () => updateInstitutionPolicy(client, admin, university, {
            domains: ['students.example'], emailEvidenceValidityDays: 90, enrollmentValidityDays: 30,
            registrationNormalization: null, isActive: true,
        }));
        const processing = await inTransaction(client, () => grantVerificationProcessing(client, student, university,
            { accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION }));
        await inTransaction(client, async () => {
            const context = await lockStudentContext(client, student);
            const issued = await requestChallenge(client, {
                purpose: 'student_email', subjectKey: student,
                bindings: { ...context, processingGrantId: processing, noticeVersion: VERIFICATION_NOTICE_VERSION },
            });
            assert.equal(issued.status, 'issued');
            if (issued.status !== 'issued') throw new Error('Challenge fixture failed');
            await consumeChallenge(client, {
                purpose: 'student_email', subjectKey: student, challengeId: issued.challengeId, code: issued.code,
            });
            await recordEmailAssurance(client, student, { challengeId: issued.challengeId, processingGrantId: processing });
        });
        const vendor = (await client.query("INSERT INTO vendors (user_id,name,status) VALUES ($1,$2,'active') RETURNING id",
            [owner, label])).rows[0].id as string;
        const origin = `https://pending-${label}.example`.toLowerCase();
        await client.query("INSERT INTO widget_configs (vendor_id,allowed_domains,allowed_origins,api_key,status) VALUES ($1,$2,$3,$4,'active')",
            [vendor, [origin.replace('https://', '')], [origin], label]);
        const disclosure = await inTransaction(client, () => grantMerchantDisclosure(client, student, {
            vendorId: vendor, origin, purpose: 'student-discount', accepted: true,
            noticeVersion: MERCHANT_DISCLOSURE_NOTICE_VERSION,
        }));
        const product = (await client.query(
            `INSERT INTO products (vendor_id,name,price,student_price,stock,status) VALUES ($1,'Synthetic pending',100,80,4,'active') RETURNING id`,
            [vendor])).rows[0].id as string;
        await assert.rejects(issueMerchantAssertion(pool, student, {
            vendorId: vendor, origin, purpose: 'student-discount',
            campaignId: 'pending-product', disclosureGrantId: disclosure, productId: product,
        }), /Current student eligibility/);
        const token = jwtService.generateAccessToken({ userId: owner, email: `vendor-${label}@example.invalid`, role: 'vendor' });
        const refused = await postReport(server.endpoint, `Bearer ${token}`, {
            benefitAuthorizationId: randomUUID(), productId: product, paymentReference: randomUUID(),
            amount: 8000, paymentGateway: 'other',
        });
        assert.equal(refused.status, 404);
        assert.equal((await client.query('SELECT count(*)::int AS count FROM transactions WHERE vendor_id = $1', [vendor])).rows[0].count, 0);
        assert.equal((await client.query('SELECT count(*)::int AS count FROM savings_stats WHERE student_id = $1', [studentProfile])).rows[0].count, 0);
        assert.equal((await client.query('SELECT stock FROM products WHERE id = $1', [product])).rows[0].stock, 4);
    } finally {
        await server.close();
        client.release();
        await pool.end();
    }
});

test('concurrent identical reports grant a single transaction and return the original result', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    const server = await startReportServer();
    try {
        await assertFixtureDatabase(client);
        const fixture = await enrolledFixture(pool, client);
        const { benefitAuthorizationId } = await productAuthorization(pool, fixture);
        const payload = {
            benefitAuthorizationId, productId: fixture.product, paymentReference: randomUUID(),
            amount: 8000, paymentGateway: 'other',
        };
        const auth = `Bearer ${vendorJwt(fixture)}`;
        const attempts = await Promise.all([postReport(server.endpoint, auth, payload), postReport(server.endpoint, auth, payload)]);
        assert.deepEqual(attempts.map((attempt) => attempt.status).sort(), [200, 201]);
        assert.deepEqual(attempts[0]?.body.data, attempts[1]?.body.data);
        assert.equal((await client.query('SELECT count(*)::int AS count FROM transactions WHERE vendor_id = $1', [fixture.vendor])).rows[0].count, 1);
        assert.equal((await client.query('SELECT stock FROM products WHERE id = $1', [fixture.product])).rows[0].stock, 3);
        const savings = (await client.query('SELECT total_savings, total_purchases FROM savings_stats WHERE student_id = $1', [fixture.studentProfile])).rows[0];
        assert.equal(Number(savings.total_savings), 20);
        assert.equal(savings.total_purchases, 1);
    } finally {
        await server.close();
        client.release();
        await pool.end();
    }
});

test('concurrent reports with different references grant one transaction and conflict the other', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    const server = await startReportServer();
    try {
        await assertFixtureDatabase(client);
        const fixture = await enrolledFixture(pool, client);
        const { benefitAuthorizationId } = await productAuthorization(pool, fixture);
        const auth = `Bearer ${vendorJwt(fixture)}`;
        const attemptFor = (reference: string) => postReport(server.endpoint, auth, {
            benefitAuthorizationId, productId: fixture.product, paymentReference: reference,
            amount: 8000, paymentGateway: 'other',
        });
        const attempts = await Promise.all([attemptFor(randomUUID()), attemptFor(randomUUID())]);
        assert.deepEqual(attempts.map((attempt) => attempt.status).sort(), [201, 409]);
        assert.equal((await client.query('SELECT count(*)::int AS count FROM transactions WHERE vendor_id = $1', [fixture.vendor])).rows[0].count, 1);
        assert.equal((await client.query('SELECT stock FROM products WHERE id = $1', [fixture.product])).rows[0].stock, 3);
    } finally {
        await server.close();
        client.release();
        await pool.end();
    }
});

test('exact committed retries return the original result while changed bindings conflict', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    const server = await startReportServer();
    try {
        await assertFixtureDatabase(client);
        const fixture = await enrolledFixture(pool, client);
        const otherProduct = (await client.query(
            `INSERT INTO products (vendor_id,name,price,student_price,stock,status) VALUES ($1,'Synthetic other',200,150,4,'active') RETURNING id`,
            [fixture.vendor])).rows[0].id as string;
        const { benefitAuthorizationId } = await productAuthorization(pool, fixture);
        const auth = `Bearer ${vendorJwt(fixture)}`;
        const committed = {
            benefitAuthorizationId, productId: fixture.product, paymentReference: randomUUID(),
            amount: 8000, paymentGateway: 'other',
        };
        const first = await postReport(server.endpoint, auth, committed);
        assert.equal(first.status, 201);
        const retry = await postReport(server.endpoint, auth, committed);
        assert.equal(retry.status, 200);
        assert.deepEqual(retry.body.data, first.body.data);
        const conflicts = [
            { ...committed, amount: 8100 },
            { ...committed, productId: otherProduct },
            { ...committed, paymentGateway: 'paystack' },
            { ...committed, paymentReference: randomUUID() },
        ];
        for (const payload of conflicts) {
            assert.equal((await postReport(server.endpoint, auth, payload)).status, 409);
        }
        assert.equal((await client.query('SELECT count(*)::int AS count FROM transactions WHERE vendor_id = $1', [fixture.vendor])).rows[0].count, 1);
        assert.equal((await client.query('SELECT stock FROM products WHERE id = $1', [fixture.product])).rows[0].stock, 3);
        assert.equal((await client.query('SELECT stock FROM products WHERE id = $1', [otherProduct])).rows[0].stock, 4);
    } finally {
        await server.close();
        client.release();
        await pool.end();
    }
});

test('committed retries return the original result after the origin is removed', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    const server = await startReportServer();
    try {
        await assertFixtureDatabase(client);
        const fixture = await enrolledFixture(pool, client);
        const { benefitAuthorizationId } = await productAuthorization(pool, fixture);
        const fresh = await productAuthorization(pool, fixture);
        const auth = `Bearer ${vendorJwt(fixture)}`;
        const committed = {
            benefitAuthorizationId, productId: fixture.product, paymentReference: randomUUID(),
            amount: 8000, paymentGateway: 'other',
        };
        const first = await postReport(server.endpoint, auth, committed);
        assert.equal(first.status, 201);
        // The merchant later removes the site from its integration. A lost
        // 201 response must still replay the settled result, not 401.
        await client.query('UPDATE widget_configs SET allowed_origins = $2 WHERE vendor_id = $1', [fixture.vendor, ['https://elsewhere.example']]);
        const retry = await postReport(server.endpoint, auth, committed);
        assert.equal(retry.status, 200);
        assert.deepEqual(retry.body.data, first.body.data);
        assert.equal((await client.query('SELECT count(*)::int AS count FROM transactions WHERE vendor_id = $1', [fixture.vendor])).rows[0].count, 1);
        // Fresh settlements still require a live origin configuration.
        const refused = await postReport(server.endpoint, auth, {
            benefitAuthorizationId: fresh.benefitAuthorizationId, productId: fixture.product,
            paymentReference: randomUUID(), amount: 8000, paymentGateway: 'other',
        });
        assert.equal(refused.status, 401);
    } finally {
        await server.close();
        client.release();
        await pool.end();
    }
});

test('reported transactions surface vendor references in history with honest receipts', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    const server = await startReportServer();
    try {
        await assertFixtureDatabase(client);
        const fixture = await enrolledFixture(pool, client);
        const { benefitAuthorizationId } = await productAuthorization(pool, fixture);
        const auth = `Bearer ${vendorJwt(fixture)}`;
        const reference = randomUUID();
        const first = await postReport(server.endpoint, auth, {
            benefitAuthorizationId, productId: fixture.product, paymentReference: reference,
            amount: 8000, paymentGateway: 'other',
        });
        assert.equal(first.status, 201);
        const historyUrl = new URL('/vendors/payment/history', server.endpoint).href;
        const historyResponse = await fetch(historyUrl, { headers: { authorization: auth } });
        assert.equal(historyResponse.status, 200);
        const history = await historyResponse.json() as { data: { payments: Record<string, unknown>[] } };
        assert.equal(history.data.payments.length, 1);
        assert.equal(history.data.payments[0]!.vendorPaymentReference, reference);
        assert.equal(history.data.payments[0]!.paymentSource, 'vendor_other');
        assert.equal(history.data.payments[0]!.paystackReference, null);
        // The reporting path delivers no email: the confirmation must not
        // promise a receipt in the student's mailbox.
        const notice = (await client.query(
            'SELECT message FROM notifications WHERE user_id = $1 AND kind = $2 ORDER BY created_at DESC LIMIT 1',
            [fixture.student, 'purchase'],
        )).rows[0]?.message as string | undefined;
        assert.ok(notice);
        assert.doesNotMatch(notice, /email/i);
    } finally {
        await server.close();
        client.release();
        await pool.end();
    }
});

test('direct authorizations bind issuance prices, not later catalog edits', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        await assertFixtureDatabase(client);
        const fixture = await enrolledFixture(pool, client);
        const campaignId = `quote-${fixture.label.slice(0, 8)}`;
        const issued = await issueMerchantAssertion(pool, fixture.student, {
            vendorId: fixture.vendor, origin: fixture.origin, purpose: 'student-discount',
            campaignId, disclosureGrantId: fixture.disclosure, productId: fixture.product,
        });
        // The vendor edits the catalog after the student reviewed the quote.
        await client.query('UPDATE products SET price = 20000, student_price = 16000 WHERE id = $1', [fixture.product]);
        const receipt = await exchangeMerchantAssertion(pool, fixture.key, {
            code: issued.code, campaignId, idempotencyKey: `quote-${randomUUID()}`,
        }) as unknown as Record<string, unknown>;
        assert.equal(typeof receipt.benefitAuthorizationId, 'string');
        const snapshots = (await client.query(
            'SELECT list_price_snapshot, student_price_snapshot FROM merchant_benefit_authorizations WHERE id = $1',
            [receipt.benefitAuthorizationId as string],
        )).rows[0]!;
        assert.equal(parseFloat(snapshots.list_price_snapshot), 100);
        assert.equal(parseFloat(snapshots.student_price_snapshot), 80);
    } finally {
        client.release();
        await pool.end();
    }
});

test('committed exchange retries return the receipt after the origin is removed', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        await assertFixtureDatabase(client);
        const fixture = await enrolledFixture(pool, client);
        const campaignId = `retry-${fixture.label.slice(0, 8)}`;
        const issue = () => issueMerchantAssertion(pool, fixture.student, {
            vendorId: fixture.vendor, origin: fixture.origin, purpose: 'student-discount',
            campaignId, disclosureGrantId: fixture.disclosure, productId: fixture.product,
        });
        const first = await issue();
        const pending = await issue();
        const idempotencyKey = `retry-${randomUUID()}`;
        const receipt = await exchangeMerchantAssertion(pool, fixture.key, { code: first.code, campaignId, idempotencyKey });
        await client.query('UPDATE widget_configs SET allowed_origins = $2 WHERE vendor_id = $1', [fixture.vendor, ['https://elsewhere.example']]);
        const replayed = await exchangeMerchantAssertion(pool, fixture.key, { code: first.code, campaignId, idempotencyKey });
        assert.deepEqual(replayed, receipt);
        // Fresh exchanges still require a live origin configuration.
        await assert.rejects(
            exchangeMerchantAssertion(pool, fixture.key, { code: pending.code, campaignId, idempotencyKey: `retry-${randomUUID()}` }),
            /Merchant unavailable/,
        );
    } finally {
        client.release();
        await pool.end();
    }
});

test('retry after expiry returns the original result only with current merchant authentication', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    const server = await startReportServer();
    try {
        await assertFixtureDatabase(client);
        const fixture = await enrolledFixture(pool, client);
        const { benefitAuthorizationId } = await productAuthorization(pool, fixture);
        const payload = {
            benefitAuthorizationId, productId: fixture.product, paymentReference: randomUUID(),
            amount: 8000, paymentGateway: 'other',
        };
        const first = await postReport(server.endpoint, `Bearer ${fixture.key}`, payload);
        assert.equal(first.status, 201);
        await client.query('UPDATE merchant_benefit_authorizations SET expires_at = clock_timestamp() - interval \'1 second\' WHERE id = $1',
            [benefitAuthorizationId]);
        await lapseEnrollmentToExpired(client, fixture);
        const expired = await postReport(server.endpoint, `Bearer ${fixture.key}`, payload);
        assert.equal(expired.status, 200);
        assert.deepEqual(expired.body.data, first.body.data);
        await assert.rejects(issueMerchantAssertion(pool, fixture.student, {
            vendorId: fixture.vendor, origin: fixture.origin, purpose: 'student-discount',
            campaignId: 'no-renewal', disclosureGrantId: fixture.disclosure, productId: fixture.product,
        }), /Current student eligibility/);
        await rotateReportingKey(pool, fixture.owner);
        assert.equal((await postReport(server.endpoint, `Bearer ${fixture.key}`, payload)).status, 401);
        const replacement = await rotateReportingKey(pool, fixture.owner);
        const revived = await postReport(server.endpoint, `Bearer ${replacement}`, payload);
        assert.equal(revived.status, 200);
        assert.deepEqual(revived.body.data, first.body.data);
        assert.equal((await client.query('SELECT count(*)::int AS count FROM transactions WHERE vendor_id = $1', [fixture.vendor])).rows[0].count, 1);
    } finally {
        await server.close();
        client.release();
        await pool.end();
    }
});

test('late first reports require explicit reconciliation without minting new authorizations', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    const server = await startReportServer();
    try {
        await assertFixtureDatabase(client);
        const fixture = await enrolledFixture(pool, client);
        const { benefitAuthorizationId } = await productAuthorization(pool, fixture);
        await client.query('UPDATE merchant_benefit_authorizations SET expires_at = clock_timestamp() - interval \'1 second\' WHERE id = $1',
            [benefitAuthorizationId]);
        const before = await ledgerSnapshot(client, fixture);
        const reference = randomUUID();
        const late = await postReport(server.endpoint, `Bearer ${vendorJwt(fixture)}`, {
            benefitAuthorizationId, productId: fixture.product, paymentReference: reference,
            amount: 8000, paymentGateway: 'other',
        });
        assert.equal(late.status, 409);
        assert.match(JSON.stringify(late.body), /reconcil/i);
        assert.equal(((late.body.error as Record<string, unknown>).details as Record<string, unknown>).paymentReference, reference);
        assert.deepEqual(await ledgerSnapshot(client, fixture), before);
        assert.equal((await client.query('SELECT transaction_id FROM merchant_benefit_authorizations WHERE id = $1', [benefitAuthorizationId])).rows[0].transaction_id, null);
        assert.equal((await client.query('SELECT count(*)::int AS count FROM merchant_benefit_authorizations WHERE vendor_id = $1', [fixture.vendor])).rows[0].count, 1);
    } finally {
        await server.close();
        client.release();
        await pool.end();
    }
});

test('legacy unreserved authorizations still reconcile on stock-out without ledger writes', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    const server = await startReportServer();
    try {
        await assertFixtureDatabase(client);
        const fixture = await enrolledFixture(pool, client, { stock: 1 });
        const { benefitAuthorizationId } = await productAuthorization(pool, fixture);
        // Reshape the row into a pre-reservation authorization (no unit was
        // set aside), then let another channel sell the last unit.
        await client.query('UPDATE merchant_benefit_authorizations SET stock_reserved = false WHERE id = $1', [benefitAuthorizationId]);
        await client.query('UPDATE products SET stock = 1 WHERE id = $1', [fixture.product]);
        await client.query('UPDATE products SET stock = 0 WHERE id = $1', [fixture.product]);
        const reference = randomUUID();
        const refused = await postReport(server.endpoint, `Bearer ${vendorJwt(fixture)}`, {
            benefitAuthorizationId, productId: fixture.product, paymentReference: reference,
            amount: 8000, paymentGateway: 'other',
        });
        assert.equal(refused.status, 409);
        assert.match(JSON.stringify(refused.body), /reconcil/i);
        assert.equal(((refused.body.error as Record<string, unknown>).details as Record<string, unknown>).paymentReference, reference);
        assert.equal((await client.query('SELECT count(*)::int AS count FROM transactions WHERE vendor_id = $1', [fixture.vendor])).rows[0].count, 0);
        assert.equal((await client.query('SELECT stock FROM products WHERE id = $1', [fixture.product])).rows[0].stock, 0);
        assert.equal((await client.query('SELECT transaction_id FROM merchant_benefit_authorizations WHERE id = $1', [benefitAuthorizationId])).rows[0].transaction_id, null);
    } finally {
        await server.close();
        client.release();
        await pool.end();
    }
});

test('exchange reserves stock so outstanding authorizations cannot exceed availability', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    const server = await startReportServer();
    try {
        await assertFixtureDatabase(client);
        const fixture = await enrolledFixture(pool, client, { stock: 1 });
        const first = await productAuthorization(pool, fixture);
        assert.equal((await client.query('SELECT stock FROM products WHERE id = $1', [fixture.product])).rows[0].stock, 0);
        assert.equal((await client.query('SELECT stock_reserved FROM merchant_benefit_authorizations WHERE id = $1', [first.benefitAuthorizationId])).rows[0].stock_reserved, true);
        await assert.rejects(productAuthorization(pool, fixture), /no longer available/);
        assert.equal((await client.query('SELECT count(*)::int AS count FROM merchant_benefit_authorizations WHERE vendor_id = $1', [fixture.vendor])).rows[0].count, 1);
        const settled = await postReport(server.endpoint, `Bearer ${vendorJwt(fixture)}`, {
            benefitAuthorizationId: first.benefitAuthorizationId, productId: fixture.product,
            paymentReference: randomUUID(), amount: 8000, paymentGateway: 'other',
        });
        assert.equal(settled.status, 201);
        // Settling consumes the reservation without decrementing again.
        assert.equal((await client.query('SELECT stock FROM products WHERE id = $1', [fixture.product])).rows[0].stock, 0);
        assert.equal((await client.query('SELECT count(*)::int AS count FROM transactions WHERE vendor_id = $1', [fixture.vendor])).rows[0].count, 1);
    } finally {
        await server.close();
        client.release();
        await pool.end();
    }
});

test('historical receipt retries mint no new authorization and generic receipts cannot report', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    const server = await startReportServer();
    try {
        await assertFixtureDatabase(client);
        const fixture = await enrolledFixture(pool, client);
        const issued = await issueMerchantAssertion(pool, fixture.student, {
            vendorId: fixture.vendor, origin: fixture.origin, purpose: 'student-discount',
            campaignId: 'replay-campaign', disclosureGrantId: fixture.disclosure, productId: fixture.product,
        });
        const idempotencyKey = `replay-${randomUUID()}`;
        const first = await exchangeMerchantAssertion(pool, fixture.key, {
            code: issued.code, campaignId: 'replay-campaign', idempotencyKey,
        }) as unknown as Record<string, unknown>;
        const replay = await exchangeMerchantAssertion(pool, fixture.key, {
            code: issued.code, campaignId: 'replay-campaign', idempotencyKey,
        }) as unknown as Record<string, unknown>;
        assert.deepEqual(replay, first);
        assert.equal((await client.query('SELECT count(*)::int AS count FROM merchant_benefit_authorizations WHERE vendor_id = $1', [fixture.vendor])).rows[0].count, 1);
        const generic = await issueMerchantAssertion(pool, fixture.student, {
            vendorId: fixture.vendor, origin: fixture.origin, purpose: 'student-discount',
            campaignId: 'old-campaign', disclosureGrantId: fixture.disclosure,
        });
        const genericReceipt = await exchangeMerchantAssertion(pool, fixture.key, {
            code: generic.code, campaignId: 'old-campaign', idempotencyKey: `old-${randomUUID()}`,
        }) as unknown as Record<string, unknown>;
        const refused = await postReport(server.endpoint, `Bearer ${vendorJwt(fixture)}`, {
            benefitAuthorizationId: genericReceipt.receiptId, productId: fixture.product,
            paymentReference: randomUUID(), amount: 8000, paymentGateway: 'other',
        });
        assert.equal(refused.status, 404);
        assert.equal((await client.query('SELECT count(*)::int AS count FROM transactions WHERE vendor_id = $1', [fixture.vendor])).rows[0].count, 0);
    } finally {
        await server.close();
        client.release();
        await pool.end();
    }
});

test('edited catalog prices never rewrite quoted historical savings', async () => {
    const { OrderController } = await import('../../controllers/order.controller.js');
    const pool = createTestPool();
    const client = await pool.connect();
    const server = await startReportServer();
    const response = { status() { return this; }, json() { return this; } } as unknown as import('express').Response;
    try {
        await assertFixtureDatabase(client);
        const fixture = await enrolledFixture(pool, client);
        const { benefitAuthorizationId } = await productAuthorization(pool, fixture);
        await client.query('UPDATE products SET price = 500, student_price = 400 WHERE id = $1', [fixture.product]);
        const first = await postReport(server.endpoint, `Bearer ${vendorJwt(fixture)}`, {
            benefitAuthorizationId, productId: fixture.product, paymentReference: randomUUID(),
            amount: 8000, paymentGateway: 'other',
        });
        assert.equal(first.status, 201);
        const transactionId = (first.body.data as Record<string, unknown>).transactionId as string;
        assert.equal(Number((await client.query('SELECT recorded_savings_delta FROM transactions WHERE id = $1', [transactionId])).rows[0].recorded_savings_delta), 20);
        await new OrderController().updateOrderStatus({
            user: { userId: fixture.owner, role: 'vendor' }, params: { id: transactionId }, body: { status: 'refunded' },
        } as unknown as import('../../middleware/auth.middleware.js').AuthRequest, response);
        const savings = (await client.query('SELECT total_savings, total_purchases FROM savings_stats WHERE student_id = $1', [fixture.studentProfile])).rows[0];
        assert.equal(Number(savings.total_savings), 0);
        assert.equal(savings.total_purchases, 0);
        assert.equal((await client.query('SELECT stock FROM products WHERE id = $1', [fixture.product])).rows[0].stock, 4);
    } finally {
        await server.close();
        client.release();
        await pool.end();
    }
});

test('migration 056 stays additive over legacy rows and binds claim sessions', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        await assertFixtureDatabase(client);
        const fixture = await enrolledFixture(pool, client);
        const legacy = randomUUID();
        await client.query(`INSERT INTO verification_tokens (token,student_id,vendor_id,product_id,expires_at)
            VALUES ($1,$2,$3,$4,now() + interval '10 minutes')`,
            [legacy, fixture.studentProfile, fixture.vendor, fixture.product]);
        assert.equal((await client.query('SELECT revoked_at FROM verification_tokens WHERE token = $1', [legacy])).rows[0].revoked_at, null);
        const generic = await issueMerchantAssertion(pool, fixture.student, {
            vendorId: fixture.vendor, origin: fixture.origin, purpose: 'student-discount',
            campaignId: 'legacy-shape', disclosureGrantId: fixture.disclosure,
        });
        await exchangeMerchantAssertion(pool, fixture.key, {
            code: generic.code, campaignId: 'legacy-shape', idempotencyKey: `legacy-${randomUUID()}`,
        });
        assert.equal((await client.query('SELECT count(*)::int AS count FROM merchant_benefit_authorizations WHERE vendor_id = $1', [fixture.vendor])).rows[0].count, 0);
        const checkoutId = `checkout-${randomUUID()}`;
        await client.query(`INSERT INTO merchant_claim_sessions (vendor_id,product_id,checkout_id,browser_nonce_hash,expires_at)
            VALUES ($1,$2,$3,$4,clock_timestamp() + interval '10 minutes')`,
            [fixture.vendor, fixture.product, checkoutId, randomUUID()]);
        await assert.rejects(client.query(`INSERT INTO merchant_claim_sessions (vendor_id,product_id,checkout_id,browser_nonce_hash,expires_at)
            VALUES ($1,$2,$3,$4,clock_timestamp() + interval '10 minutes')`,
            [fixture.vendor, fixture.product, checkoutId, randomUUID()]), { code: '23505' });
        const columns = (await client.query(`SELECT column_name FROM information_schema.columns
            WHERE table_name = 'merchant_assertions' AND column_name = 'claim_session_id'`)).rows;
        assert.equal(columns.length, 1);
    } finally {
        client.release();
        await pool.end();
    }
});

test('authorization cleanup deletes only expired unused rows past retention', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    const server = await startReportServer();
    try {
        await assertFixtureDatabase(client);
        const fixture = await enrolledFixture(pool, client);
        const aged = await productAuthorization(pool, fixture);
        const used = await productAuthorization(pool, fixture);
        const fresh = await productAuthorization(pool, fixture);
        const committed = await postReport(server.endpoint, `Bearer ${vendorJwt(fixture)}`, {
            benefitAuthorizationId: used.benefitAuthorizationId, productId: fixture.product,
            paymentReference: randomUUID(), amount: 8000, paymentGateway: 'other',
        });
        assert.equal(committed.status, 201);
        await client.query("UPDATE merchant_benefit_authorizations SET expires_at = clock_timestamp() - interval '8 days' WHERE id = ANY($1::uuid[])",
            [[aged.benefitAuthorizationId, used.benefitAuthorizationId]]);
        // Three exchanges reserved three of four units; settling the used
        // authorization consumed its reservation without a second decrement.
        assert.equal((await client.query('SELECT stock FROM products WHERE id = $1', [fixture.product])).rows[0].stock, 1);
        const cutoff = new Date(Date.now() - 7 * 86_400_000);
        assert.equal(await deleteExpiredUnusedBenefitAuthorizations(client, { expiredBefore: cutoff }), 1);
        // Only the abandoned reservation is restored; the settled unit and
        // the live reservation stay out of stock.
        assert.equal((await client.query('SELECT stock FROM products WHERE id = $1', [fixture.product])).rows[0].stock, 2);
        const remaining = (await client.query('SELECT id FROM merchant_benefit_authorizations WHERE vendor_id = $1 ORDER BY created_at', [fixture.vendor])).rows
            .map((row) => row.id as string);
        assert.equal(remaining.includes(aged.benefitAuthorizationId), false);
        assert.equal(remaining.includes(used.benefitAuthorizationId), true);
        assert.equal(remaining.includes(fresh.benefitAuthorizationId), true);
    } finally {
        await server.close();
        client.release();
        await pool.end();
    }
});

test('expired reservations release stock at authorization expiry, independent of row retention', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    const server = await startReportServer();
    try {
        await assertFixtureDatabase(client);
        const fixture = await enrolledFixture(pool, client);
        const abandoned = await productAuthorization(pool, fixture);
        const settled = await productAuthorization(pool, fixture);
        const live = await productAuthorization(pool, fixture);
        const committed = await postReport(server.endpoint, `Bearer ${vendorJwt(fixture)}`, {
            benefitAuthorizationId: settled.benefitAuthorizationId, productId: fixture.product,
            paymentReference: randomUUID(), amount: 8000, paymentGateway: 'other',
        });
        assert.equal(committed.status, 201);
        assert.equal((await client.query('SELECT stock FROM products WHERE id = $1', [fixture.product])).rows[0].stock, 1);
        await client.query("UPDATE merchant_benefit_authorizations SET expires_at = clock_timestamp() - interval '1 minute' WHERE id = ANY($1::uuid[])",
            [[abandoned.benefitAuthorizationId, settled.benefitAuthorizationId]]);
        // The restore sweeps every vendor, so only fixture-scoped effects
        // are asserted exactly; the global count is a lower bound.
        assert.ok(await restoreExpiredBenefitReservations(client, { expiredBefore: new Date() }) >= 1);
        assert.equal((await client.query('SELECT stock FROM products WHERE id = $1', [fixture.product])).rows[0].stock, 2);
        const flags = (await client.query(
            'SELECT id, stock_restored_at FROM merchant_benefit_authorizations WHERE vendor_id = $1',
            [fixture.vendor],
        )).rows as { id: string; stock_restored_at: Date | null }[];
        const flagById = new Map(flags.map((row) => [row.id, row.stock_restored_at]));
        const restoredAt = flagById.get(abandoned.benefitAuthorizationId);
        assert.ok(restoredAt instanceof Date);
        assert.equal(flagById.get(settled.benefitAuthorizationId), null);
        assert.equal(flagById.get(live.benefitAuthorizationId), null);
        // Idempotent: a second pass never re-restores this fixture's rows.
        await restoreExpiredBenefitReservations(client, { expiredBefore: new Date() });
        assert.equal((await client.query('SELECT stock FROM products WHERE id = $1', [fixture.product])).rows[0].stock, 2);
        const reread = (await client.query<{ stock_restored_at: Date }>(
            'SELECT stock_restored_at FROM merchant_benefit_authorizations WHERE id = $1', [abandoned.benefitAuthorizationId],
        )).rows[0]!.stock_restored_at;
        assert.equal(reread.getTime(), (restoredAt as Date).getTime());
    } finally {
        await server.close();
        client.release();
        await pool.end();
    }
});
