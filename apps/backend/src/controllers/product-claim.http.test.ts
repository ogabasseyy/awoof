import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import type { Router } from 'express';
import { errorHandler } from '../common/middleware/errorHandler.js';
import { AppError, ForbiddenError, NotFoundError, UnauthorizedError } from '../common/errors/AppError.js';
import { jwtService } from '../services/auth/jwt.service.js';
import { createProductsRouter } from '../routes/products.routes.js';
import { createMerchantVerificationRouter } from '../routes/merchant-verification.routes.js';

const studentId = '4f088fa7-79d9-4c64-a48c-9ecbbbc3c4a3';
const vendorUserId = '6b1c2d3e-4f5a-4c64-a48c-9ecbbbc3c4a3';
const productId = '7c2d3e4f-5a6b-4c64-a48c-9ecbbbc3c4a3';
const sessionId = '8d3e4f5a-6b7c-4c64-a48c-9ecbbbc3c4a3';
const grantId = '9e4f5a6b-7c8d-4c64-a48c-9ecbbbc3c4a3';
const nonceHash = 'ab'.repeat(32);

function studentToken(): string {
    return jwtService.generateAccessToken({ userId: studentId, email: 'ada@students.school.example', role: 'student' });
}

function vendorToken(): string {
    return jwtService.generateAccessToken({ userId: vendorUserId, email: 'vendor@example.invalid', role: 'vendor' });
}

async function withServer(router: Router, mount: string, operation: (baseUrl: string) => Promise<void>): Promise<void> {
    const app = express();
    app.use(express.json());
    app.use(mount, router);
    app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture did not expose a loopback port');
    try {
        await operation(`http://127.0.0.1:${address.port}${mount}`);
    } finally {
        server.close();
        await once(server, 'close');
    }
}

function hostileProductRow(): Record<string, unknown> {
    return {
        id: productId,
        name: 'Campus deal',
        description: 'A redeemable campus offer',
        price: '100.00',
        student_price: '80.00',
        category_id: null,
        category_name: 'Food',
        image_url: null,
        stock: 5,
        status: 'active',
        deal_type: 'voucher',
        created_at: new Date('2026-09-01T00:00:00.000Z'),
        updated_at: new Date('2026-09-02T00:00:00.000Z'),
        vendor_id: 'aa3e4f5a-6b7c-4c64-a48c-9ecbbbc3c4a3',
        vendor_name: 'Campus vendor',
        vendor_website: 'https://vendor.example',
        vendor_logo_url: null,
        vendor_payment_method: 'vendor_website',
        api_id: 'internal-vendor-sku-7',
        voucher_code: 'VOUCHER-SECRET-ABC123',
        redemption_url: 'https://vendor.example/redeem?code=VOUCHER-SECRET-ABC123',
        discount_url: 'https://vendor.example/claim?discount=90&token=secret-token',
        fulfillment: { code: 'VOUCHER-SECRET-ABC123', instructions: 'show this code' },
    };
}

test('anonymous product list strips voucher codes, protected URLs and nested fulfillment secrets', async () => {
    const seen: Array<{ text: string; params?: Array<string | number> }> = [];
    const router = createProductsRouter(async (text, params) => {
        seen.push({ text, params });
        if (text.includes('COUNT(*)')) return { rows: [{ total: '1' }] };
        return { rows: [hostileProductRow()] };
    });
    await withServer(router, '/products', async (baseUrl) => {
        const response = await fetch(`${baseUrl}/?limit=20`);
        assert.equal(response.status, 200);
        const body = await response.json() as { data: { products: Array<Record<string, unknown>> } };
        assert.equal(body.data.products.length, 1);
        const product = body.data.products[0]!;
        for (const leaked of ['api_id', 'voucher_code', 'redemption_url', 'discount_url', 'fulfillment']) {
            assert.equal(leaked in product, false, `public list must not contain ${leaked}`);
        }
        assert.equal(JSON.stringify(body).includes('VOUCHER-SECRET-ABC123'), false);
        assert.equal(JSON.stringify(body).includes('secret-token'), false);
        assert.equal(product.name, 'Campus deal');
        assert.equal(product.student_price, '80.00');
        assert.equal(product.vendor_website, 'https://vendor.example');
    });
});

test('anonymous product detail strips protected fields and reports unknown products as 404', async () => {
    const router = createProductsRouter(async (text) => {
        if (text.includes('WHERE p.id = $1')) return { rows: [hostileProductRow()] };
        return { rows: [] };
    });
    await withServer(router, '/products', async (baseUrl) => {
        const response = await fetch(`${baseUrl}/${productId}`);
        assert.equal(response.status, 200);
        const body = await response.json() as { data: { product: Record<string, unknown> } };
        assert.equal('voucher_code' in body.data.product, false);
        assert.equal('fulfillment' in body.data.product, false);
        assert.equal(JSON.stringify(body).includes('VOUCHER-SECRET-ABC123'), false);
    });
    const missing = createProductsRouter(async () => ({ rows: [] }));
    await withServer(missing, '/products', async (baseUrl) => {
        assert.equal((await fetch(`${baseUrl}/${productId}`)).status, 404);
    });
});

test('claim-session creation requires a merchant server key', async () => {
    const router = createMerchantVerificationRouter({
        createClaimSession: async (merchantKey) => {
            if (merchantKey !== 'awoof_valid_test_key') throw new UnauthorizedError('Authentication failed');
            return { claimSessionId: sessionId, expiresAt: new Date('2026-09-21T12:10:00.000Z').toISOString(), created: true };
        },
    });
    await withServer(router, '/merchant-verification', async (baseUrl) => {
        const body = JSON.stringify({
            productId,
            merchantCheckoutId: 'checkout-1',
            browserNonceHash: nonceHash,
            origin: 'https://shop.example',
        });
        assert.equal((await fetch(`${baseUrl}/claim-sessions`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body,
        })).status, 401);
        assert.equal((await fetch(`${baseUrl}/claim-sessions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${vendorToken()}` },
            body,
        })).status, 401);
        const created = await fetch(`${baseUrl}/claim-sessions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer awoof_valid_test_key' },
            body,
        });
        assert.equal(created.status, 201);
    });
});

test('claim-session creation requires the initiating origin and rejects malformed bindings', async () => {
    let calls = 0;
    const router = createMerchantVerificationRouter({
        createClaimSession: async () => {
            calls += 1;
            return { claimSessionId: sessionId, expiresAt: new Date().toISOString(), created: true };
        },
    });
    await withServer(router, '/merchant-verification', async (baseUrl) => {
        const headers = { 'content-type': 'application/json', authorization: 'Bearer awoof_valid_test_key' };
        for (const body of [
            { productId, merchantCheckoutId: 'checkout-1', browserNonceHash: nonceHash, vendorId: productId },
            { productId, merchantCheckoutId: 'checkout-1', browserNonceHash: nonceHash, origin: 42 },
            { productId, merchantCheckoutId: 'checkout-1', browserNonceHash: nonceHash },
            { productId, merchantCheckoutId: 'checkout-1', browserNonceHash: 'not-a-hash', origin: 'https://shop.example' },
            { productId, merchantCheckoutId: '', browserNonceHash: nonceHash, origin: 'https://shop.example' },
            { productId, browserNonceHash: nonceHash, origin: 'https://shop.example' },
        ]) {
            const response = await fetch(`${baseUrl}/claim-sessions`, { method: 'POST', headers, body: JSON.stringify(body) });
            assert.equal(response.status, 422, JSON.stringify(body));
        }
        assert.equal(calls, 0);
    });
});

test('claim-session creation returns 201 for new sessions and 200 for exact retries', async () => {
    let calls = 0;
    const router = createMerchantVerificationRouter({
        createClaimSession: async () => {
            calls += 1;
            return { claimSessionId: sessionId, expiresAt: new Date().toISOString(), created: calls === 1 };
        },
    });
    await withServer(router, '/merchant-verification', async (baseUrl) => {
        const init = {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer awoof_valid_test_key' },
            body: JSON.stringify({
                productId,
                merchantCheckoutId: 'checkout-1',
                browserNonceHash: nonceHash,
                origin: 'https://shop.example',
            }),
        };
        assert.equal((await fetch(`${baseUrl}/claim-sessions`, init)).status, 201);
        const retry = await fetch(`${baseUrl}/claim-sessions`, init);
        assert.equal(retry.status, 200);
        const body = await retry.json() as { data: { claimSessionId: string } };
        assert.equal(body.data.claimSessionId, sessionId);
    });
});

test('product claims require a signed-in student', async () => {
    let calls = 0;
    const router = createMerchantVerificationRouter({
        claimProduct: async () => {
            calls += 1;
            return { code: 'C'.repeat(43), expiresAt: new Date().toISOString(), handoffUrl: 'https://merchant.example/awoof/student-claim' };
        },
    });
    await withServer(router, '/merchant-verification', async (baseUrl) => {
        const body = JSON.stringify({ merchantClaimSessionId: sessionId, disclosureGrantId: grantId });
        assert.equal((await fetch(`${baseUrl}/product-claims`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body,
        })).status, 401);
        assert.equal((await fetch(`${baseUrl}/product-claims`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${vendorToken()}` },
            body,
        })).status, 401);
        const response = await fetch(`${baseUrl}/product-claims`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${studentToken()}` },
            body,
        });
        assert.equal(response.status, 201);
        assert.equal(calls, 1);
    });
});

test('product claims reject client-supplied vendor, origin and product bindings', async () => {
    let calls = 0;
    const router = createMerchantVerificationRouter({
        claimProduct: async () => {
            calls += 1;
            return { code: 'C'.repeat(43), expiresAt: new Date().toISOString(), handoffUrl: 'https://merchant.example/awoof/student-claim' };
        },
    });
    await withServer(router, '/merchant-verification', async (baseUrl) => {
        const headers = { 'content-type': 'application/json', authorization: `Bearer ${studentToken()}` };
        for (const body of [
            { merchantClaimSessionId: sessionId, disclosureGrantId: grantId, vendorId: productId },
            { merchantClaimSessionId: sessionId, disclosureGrantId: grantId, origin: 'https://evil.example' },
            { merchantClaimSessionId: sessionId, disclosureGrantId: grantId, productId },
            { merchantClaimSessionId: sessionId },
        ]) {
            assert.equal((await fetch(`${baseUrl}/product-claims`, { method: 'POST', headers, body: JSON.stringify(body) })).status, 422);
        }
        assert.equal(calls, 0);
    });
});

test('pending students cannot claim: 403 names enrollment and keeps school-account assurance separate', async () => {
    const router = createMerchantVerificationRouter({
        claimProduct: async () => {
            throw new ForbiddenError('Current student enrollment required for this discount', { reason: 'unverified' });
        },
    });
    await withServer(router, '/merchant-verification', async (baseUrl) => {
        const response = await fetch(`${baseUrl}/product-claims`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${studentToken()}` },
            body: JSON.stringify({ merchantClaimSessionId: sessionId, disclosureGrantId: grantId }),
        });
        assert.equal(response.status, 403);
        const body = await response.json() as { error: { message: string; code: string; details: { reason: string } } };
        assert.equal(body.error.code, 'FORBIDDEN');
        assert.match(body.error.message, /enrollment/);
        assert.doesNotMatch(body.error.message, /school account/i);
        assert.equal(body.error.details.reason, 'unverified');
    });
});

test('expired evidence, withdrawn consent and wrong-merchant grants fail closed without a handoff', async () => {
    const failures: Array<() => never> = [
        () => { throw new ForbiddenError('Current student enrollment required for this discount', { reason: 'expired' }); },
        () => { throw new ForbiddenError('Current student enrollment required for this discount', { reason: 'consent_required' }); },
        () => { throw new ForbiddenError('Disclosure grant is for a different merchant'); },
        () => { throw new NotFoundError('Claim session not found'); },
    ];
    for (const fail of failures) {
        const router = createMerchantVerificationRouter({ claimProduct: async () => fail() });
        await withServer(router, '/merchant-verification', async (baseUrl) => {
            const response = await fetch(`${baseUrl}/product-claims`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${studentToken()}` },
                body: JSON.stringify({ merchantClaimSessionId: sessionId, disclosureGrantId: grantId }),
            });
            assert.ok(response.status === 403 || response.status === 404);
            const body = await response.json() as { success: boolean; data?: unknown };
            assert.equal(body.success, false);
            assert.equal(body.data, undefined);
        });
    }
});

test('unintegrated merchants yield 409 MERCHANT_INTEGRATION_REQUIRED for protected claims', async () => {
    const router = createMerchantVerificationRouter({
        claimProduct: async () => {
            throw new AppError('Merchant integration unavailable for protected claims', 409, 'MERCHANT_INTEGRATION_REQUIRED');
        },
    });
    await withServer(router, '/merchant-verification', async (baseUrl) => {
        const response = await fetch(`${baseUrl}/product-claims`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${studentToken()}` },
            body: JSON.stringify({ merchantClaimSessionId: sessionId, disclosureGrantId: grantId }),
        });
        assert.equal(response.status, 409);
        const body = await response.json() as { error: { code: string } };
        assert.equal(body.error.code, 'MERCHANT_INTEGRATION_REQUIRED');
    });
});

test('successful claims are no-store and hand over only an opaque assertion', async () => {
    const code = 'D'.repeat(43);
    const router = createMerchantVerificationRouter({
        claimProduct: async () => ({
            code,
            expiresAt: new Date('2026-09-21T12:02:00.000Z').toISOString(),
            handoffUrl: `https://merchant.example/awoof/student-claim?assertion=${code}`,
        }),
    });
    await withServer(router, '/merchant-verification', async (baseUrl) => {
        const response = await fetch(`${baseUrl}/product-claims`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${studentToken()}` },
            body: JSON.stringify({ merchantClaimSessionId: sessionId, disclosureGrantId: grantId }),
        });
        assert.equal(response.status, 201);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
        const body = await response.json() as { data: Record<string, unknown> };
        assert.deepEqual(Object.keys(body.data).sort(), ['code', 'expiresAt', 'handoffUrl']);
        const handoff = new URL(body.data.handoffUrl as string);
        assert.equal(handoff.origin, 'https://merchant.example');
        assert.equal(handoff.pathname, '/awoof/student-claim');
        assert.equal([...handoff.searchParams.keys()].join(','), 'assertion');
        assert.equal(JSON.stringify(body).includes('@'), false);
    });
});

test('claim-session introspection requires student auth and leaks no hashes or codes', async () => {
    const router = createMerchantVerificationRouter({
        readClaimSession: async (id) => {
            assert.equal(id, sessionId);
            return {
                claimSessionId: sessionId,
                vendorId: productId,
                vendorName: 'Campus vendor',
                productId,
                productName: 'Campus deal',
                listPrice: '100.00',
                studentPrice: '80.00',
                handoffOrigin: 'https://merchant.example',
                expiresAt: new Date('2026-09-21T12:10:00.000Z').toISOString(),
            };
        },
    });
    await withServer(router, '/merchant-verification', async (baseUrl) => {
        assert.equal((await fetch(`${baseUrl}/claim-sessions/${sessionId}`)).status, 401);
        const headers = { authorization: `Bearer ${studentToken()}` };
        assert.equal((await fetch(`${baseUrl}/claim-sessions/not-a-uuid`, { headers })).status, 422);
        const response = await fetch(`${baseUrl}/claim-sessions/${sessionId}`, { headers });
        assert.equal(response.status, 200);
        const body = await response.json() as { data: Record<string, unknown> };
        for (const value of Object.values(body.data)) {
            if (typeof value === 'string') assert.equal(value.includes('?'), false, `introspection must not carry URLs with queries: ${value}`);
        }
        assert.equal(JSON.stringify(body).toLowerCase().includes('nonce'), false);
        assert.equal('browserNonceHash' in body.data, false);
        assert.equal('merchantCheckoutId' in body.data, false);
    });
});

test('assertion exchange accepts claim-session proof and validates its shape', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const router = createMerchantVerificationRouter({
        exchange: async (_key, input) => {
            seen.push({ ...input });
            return {
                receiptId: sessionId, merchantSubject: grantId, eligible: true as const,
                assuranceMethod: 'enrollment', institutionId: productId,
                verifiedAt: new Date().toISOString(), validUntil: new Date().toISOString(), campaignId: 'checkout-1',
            };
        },
    });
    await withServer(router, '/merchant-verification', async (baseUrl) => {
        const headers = { 'content-type': 'application/json', authorization: 'Bearer awoof_valid_test_key' };
        const valid = { code: 'E'.repeat(43), campaignId: 'checkout-1', idempotencyKey: 'order-1', browserNonce: 'F'.repeat(43), merchantCheckoutId: 'checkout-1' };
        assert.equal((await fetch(`${baseUrl}/exchange`, { method: 'POST', headers, body: JSON.stringify(valid) })).status, 200);
        assert.equal(seen.length, 1);
        assert.equal(seen[0]!.browserNonce, 'F'.repeat(43));
        assert.equal(seen[0]!.merchantCheckoutId, 'checkout-1');
        const short = { ...valid, browserNonce: 'too-short' };
        assert.equal((await fetch(`${baseUrl}/exchange`, { method: 'POST', headers, body: JSON.stringify(short) })).status, 422);
        const extra = { ...valid, vendorId: productId };
        assert.equal((await fetch(`${baseUrl}/exchange`, { method: 'POST', headers, body: JSON.stringify(extra) })).status, 422);
    });
});

test('hosted pilot assertion requires synthetic student and merchant allowlists before normal issuance', async () => {
    const vendorId = 'aa3e4f5a-6b7c-4c64-a48c-9ecbbbc3c4a3';
    const old = {
        enabled: process.env.AWOOF_WIDGET_PILOT_ENABLED,
        students: process.env.AWOOF_WIDGET_PILOT_STUDENT_IDS,
        vendors: process.env.AWOOF_WIDGET_PILOT_VENDOR_IDS,
    };
    const restore = () => {
        for (const [key, value] of Object.entries({
            AWOOF_WIDGET_PILOT_ENABLED: old.enabled,
            AWOOF_WIDGET_PILOT_STUDENT_IDS: old.students,
            AWOOF_WIDGET_PILOT_VENDOR_IDS: old.vendors,
        })) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    };
    let issued = 0;
    const router = createMerchantVerificationRouter({ issue: async () => {
        issued += 1;
        return { code: 'a'.repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    } });
    try {
        await withServer(router, '/merchant-verification', async (baseUrl) => {
            const request = () => fetch(`${baseUrl}/pilot-assertions`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${studentToken()}` },
                body: JSON.stringify({ vendorId, origin: 'https://shop.example', purpose: 'Student checkout', campaignId: 'fall', disclosureGrantId: grantId }),
            });
            delete process.env.AWOOF_WIDGET_PILOT_ENABLED;
            assert.equal((await request()).status, 403);
            process.env.AWOOF_WIDGET_PILOT_ENABLED = 'true';
            process.env.AWOOF_WIDGET_PILOT_STUDENT_IDS = studentId;
            assert.equal((await request()).status, 403);
            process.env.AWOOF_WIDGET_PILOT_VENDOR_IDS = vendorId;
            const response = await request();
            assert.equal(response.status, 201);
            assert.equal(response.headers.get('cache-control'), 'no-store');
            const productBound = await fetch(`${baseUrl}/pilot-assertions`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${studentToken()}` },
                body: JSON.stringify({ vendorId, origin: 'https://shop.example', purpose: 'Student checkout', campaignId: 'fall', disclosureGrantId: grantId, productId }),
            });
            assert.equal(productBound.status, 400);
            assert.equal(issued, 1);
        });
    } finally { restore(); }
});
