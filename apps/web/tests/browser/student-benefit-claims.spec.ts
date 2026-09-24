import { expect, test, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { apiOrigin, installSyntheticApi, seedSession, storageTabPath } from './fixtures';

type StubHit = { url: string; cookie: string | undefined };

type ClaimStub = {
    baseUrl: string;
    hits: StubHit[];
    redemptions: string[];
    close: () => Promise<void>;
};

async function startClaimStub(): Promise<ClaimStub> {
    const hits: StubHit[] = [];
    const redemptions: string[] = [];
    const server: Server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://stub.test');
        if (req.method === 'GET' && url.pathname === '/test/prepare') {
            const nonce = url.searchParams.get('nonce') ?? 'test-nonce';
            res.writeHead(200, {
                'content-type': 'text/html',
                'set-cookie': `merchant_nonce=${encodeURIComponent(nonce)}; HttpOnly; SameSite=Lax; Path=/`,
            });
            res.end('<html><body>prepared</body></html>');
            return;
        }
        if (req.method === 'GET' && url.pathname === '/awoof/student-claim') {
            hits.push({ url: req.url ?? '', cookie: req.headers.cookie });
            // Null prototype: cookie names are remote input and must never
            // resolve through Object.prototype when used as lookup keys.
            const cookies: Record<string, string> = Object.create(null);
            for (const part of (req.headers.cookie ?? '').split(';')) {
                const index = part.indexOf('=');
                if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
            }
            if (!cookies.merchant_nonce) {
                res.writeHead(403, { 'content-type': 'text/html' });
                res.end('<html><body>Merchant session required</body></html>');
                return;
            }
            const keys = [...url.searchParams.keys()];
            const assertion = url.searchParams.get('assertion') ?? '';
            if (keys.length !== 1 || keys[0] !== 'assertion' || !/^[A-Za-z0-9_-]{43}$/.test(assertion)) {
                res.writeHead(400, { 'content-type': 'text/html' });
                res.end('<html><body>Malformed handoff</body></html>');
                return;
            }
            if (redemptions.includes(assertion)) {
                res.writeHead(409, { 'content-type': 'text/html' });
                res.end('<html><body>Checkout already redeemed</body></html>');
                return;
            }
            redemptions.push(assertion);
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end('<html><body>Discount applied</body></html>');
            return;
        }
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<html><body>unknown merchant route</body></html>');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Claim stub did not expose a loopback port');
    }
    const port = (address as AddressInfo).port;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        hits,
        redemptions,
        close: async () => { server.close(); await once(server, 'close'); },
    };
}

const sessionId = '30000000-0000-4000-8000-000000000001';
const productId = '30000000-0000-4000-8000-000000000002';
const vendorId = '30000000-0000-4000-8000-000000000003';
const grantId = '30000000-0000-4000-8000-000000000004';
const notice = { version: '2026-09-05.v1', text: 'Synthetic merchant disclosure notice.' };

async function stubClaimSession(page: Page, origin: string): Promise<void> {
    await page.route(`${apiOrigin}/api/merchant-verification/claim-sessions/${sessionId}`, (route) => route.fulfill({
        json: {
            success: true,
            data: {
                claimSessionId: sessionId, vendorId, vendorName: 'Synthetic vendor',
                productId, productName: 'Synthetic voucher', listPrice: '100.00', studentPrice: '80.00',
                handoffOrigin: origin, expiresAt: new Date(Date.now() + 600_000).toISOString(),
            },
        },
        headers: { 'access-control-allow-origin': '*' },
    }));
}

test('a student claims a protected deal and hands only an opaque assertion to the merchant', async ({ page }) => {
    const stub = await startClaimStub();
    try {
        await installSyntheticApi(page);
        await seedSession(page, 'student');
        // Let browser traffic to the real merchant stub through the synthetic API.
        await page.route(`${stub.baseUrl}/**`, (route) => route.continue());
        await page.route(`${apiOrigin}/api/products/${productId}`, (route) => route.fulfill({
            status: 404, json: { success: false, error: { message: 'Product not found', code: 'NOT_FOUND', statusCode: 404 } },
            headers: { 'access-control-allow-origin': '*' },
        }));
        await stubClaimSession(page, stub.baseUrl);
        await page.route(`${apiOrigin}/api/verification/status`, (route) => route.fulfill({
            json: { success: true, data: { notices: { merchantDisclosure: notice } } },
            headers: { 'access-control-allow-origin': '*' },
        }));
        const disclosures: unknown[] = [];
        await page.route(`${apiOrigin}/api/verification/disclosures`, async (route) => {
            disclosures.push(route.request().postDataJSON());
            await route.fulfill({
                status: 201, json: { success: true, data: { grantId } },
                headers: { 'access-control-allow-origin': '*' },
            });
        });
        const code = 'H'.repeat(43);
        const claims: unknown[] = [];
        await page.route(`${apiOrigin}/api/merchant-verification/product-claims`, async (route) => {
            claims.push(route.request().postDataJSON());
            await route.fulfill({
                status: 201,
                json: { success: true, data: { code, expiresAt: new Date(Date.now() + 120_000).toISOString(), handoffUrl: `${stub.baseUrl}/awoof/student-claim?assertion=${code}` } },
                headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
            });
        });
        // Land on the app origin first so the seeded session sticks, then replay
        // the merchant bootstrap cookie before opening the claim page.
        await page.goto(storageTabPath);
        await page.goto(`${stub.baseUrl}/test/prepare?nonce=browser-nonce-fixture`);
        await page.goto(`/marketplace/${productId}?claimSession=${sessionId}`);
        await expect(page.getByTestId('student-claim-card')).toBeVisible();
        await expect(page.getByText('Synthetic voucher')).toBeVisible();
        await page.getByText(notice.text).click();
        await page.getByRole('button', { name: 'Claim student discount' }).click();
        await page.waitForURL(`${stub.baseUrl}/awoof/student-claim**`);
        await expect(page.getByText('Discount applied')).toBeVisible();
        expect(disclosures).toEqual([{
            vendorId, origin: stub.baseUrl, purpose: 'Student discount claim',
            accepted: true, noticeVersion: notice.version,
        }]);
        expect(claims).toEqual([{ merchantClaimSessionId: sessionId, disclosureGrantId: grantId }]);
        expect(stub.hits).toHaveLength(1);
        expect(stub.hits[0]!.url).toBe(`/awoof/student-claim?assertion=${code}`);
        expect(stub.hits[0]!.url.includes('@')).toBe(false);
        expect(stub.hits[0]!.cookie ?? '').toContain('merchant_nonce=');
        expect(stub.redemptions).toEqual([code]);
    } finally {
        await stub.close();
    }
});

test('pending students get explicit verification with a return path and no auto-submit', async ({ page }) => {
    await installSyntheticApi(page);
    await seedSession(page, 'student');
    await page.route(`${apiOrigin}/api/products/${productId}`, (route) => route.fulfill({
        status: 404, json: { success: false, error: { message: 'Product not found', code: 'NOT_FOUND', statusCode: 404 } },
        headers: { 'access-control-allow-origin': '*' },
    }));
    await stubClaimSession(page, 'https://merchant.example');
    await page.route(`${apiOrigin}/api/verification/status`, (route) => route.fulfill({
        json: { success: true, data: { notices: { merchantDisclosure: notice } } },
        headers: { 'access-control-allow-origin': '*' },
    }));
    await page.route(`${apiOrigin}/api/verification/disclosures`, (route) => route.fulfill({
        status: 201, json: { success: true, data: { grantId } },
        headers: { 'access-control-allow-origin': '*' },
    }));
    let claims = 0;
    await page.route(`${apiOrigin}/api/merchant-verification/product-claims`, (route) => {
        claims += 1;
        return route.fulfill({
            status: 403,
            json: { success: false, error: { message: 'Current student enrollment required for this discount', code: 'FORBIDDEN', statusCode: 403, details: { reason: 'unverified' } } },
            headers: { 'access-control-allow-origin': '*' },
        });
    });
    await page.goto(`/marketplace/${productId}?claimSession=${sessionId}`);
    await page.getByText(notice.text).click();
    await page.getByRole('button', { name: 'Claim student discount' }).click();
    const verify = page.getByRole('link', { name: 'Verify student status' });
    await expect(verify).toBeVisible();
    const href = await verify.getAttribute('href');
    expect(href ?? '').toContain('/student/verification?redirect=');
    expect(decodeURIComponent(href ?? '')).toContain(`/marketplace/${productId}?claimSession=${sessionId}`);
    await expect(page.getByText('School-account sign-in alone does not unlock student discounts.')).toBeVisible();
    expect(claims).toBe(1);
    // No automatic second attempt happens after the failure.
    await page.waitForTimeout(500);
    expect(claims).toBe(1);
    await page.getByRole('button', { name: 'Retry claim' }).click();
    await expect(page.getByRole('button', { name: 'Retry claim' })).toBeVisible();
    expect(claims).toBe(1);
});

test('unintegrated merchants fall back to ordinary partner navigation without a discount promise', async ({ page }) => {
    await installSyntheticApi(page);
    await seedSession(page, 'student');
    await page.route(`${apiOrigin}/api/products/${productId}`, (route) => route.fulfill({
        json: {
            success: true,
            data: {
                product: {
                    id: productId, name: 'Partner deal', description: 'Redeemed off-site',
                    price: 100, student_price: 80, image_url: null, stock: 0,
                    category_id: 'c1', category_name: 'Food', category_slug: 'food',
                    vendor_id: vendorId, vendor_name: 'Synthetic vendor', vendor_description: null,
                    vendor_website: 'https://partner.example/deals', vendor_payment_method: 'vendor_website',
                    deal_type: 'product', created_at: new Date().toISOString(),
                },
            },
        },
        headers: { 'access-control-allow-origin': '*' },
    }));
    await page.route(`${apiOrigin}/api/merchant-verification/claim-sessions/${sessionId}`, (route) => route.fulfill({
        status: 409,
        json: { success: false, error: { message: 'Merchant integration unavailable for protected claims', code: 'MERCHANT_INTEGRATION_REQUIRED', statusCode: 409 } },
        headers: { 'access-control-allow-origin': '*' },
    }));
    await page.route(`${apiOrigin}/api/verification/status`, (route) => route.fulfill({
        json: { success: true, data: { notices: { merchantDisclosure: notice } } },
        headers: { 'access-control-allow-origin': '*' },
    }));
    await page.goto(`/marketplace/${productId}?claimSession=${sessionId}`);
    await expect(page.getByText('Verified student discounts are not available with this partner yet.')).toBeVisible();
    const visit = page.getByRole('link', { name: 'Visit partner site' });
    await expect(visit).toBeVisible();
    expect(await visit.getAttribute('href')).toBe('https://partner.example/deals');
    await expect(page.getByRole('button', { name: 'Claim student discount' })).toHaveCount(0);
});

test('direct and shared handoff links cannot redeem without the merchant session', async ({ page, context }) => {
    const stub = await startClaimStub();
    try {
        const code = 'J'.repeat(43);
        const handoff = `${stub.baseUrl}/awoof/student-claim?assertion=${code}`;
        await page.goto(handoff);
        await expect(page.getByText('Merchant session required')).toBeVisible();
        expect(stub.redemptions).toEqual([]);
        await page.goto(`${stub.baseUrl}/test/prepare?nonce=shared-browser-nonce`);
        await page.goto(handoff);
        await expect(page.getByText('Discount applied')).toBeVisible();
        expect(stub.redemptions).toEqual([code]);
        // A shared copy of the same redeemed link is refused.
        const second = await context.newPage();
        try {
            await second.goto(`${stub.baseUrl}/test/prepare?nonce=another-browser-nonce`);
            await second.goto(handoff);
            await expect(second.getByText('Checkout already redeemed')).toBeVisible();
            expect(stub.redemptions).toEqual([code]);
        } finally {
            await second.close();
        }
    } finally {
        await stub.close();
    }
});

test('anonymous visitors are asked to sign in with the claim preserved', async ({ page }) => {
    await installSyntheticApi(page);
    let claims = 0;
    await page.route(`${apiOrigin}/api/merchant-verification/product-claims`, (route) => {
        claims += 1;
        return route.fulfill({
            status: 401, json: { success: false, error: { message: 'Authentication required', code: 'UNAUTHORIZED', statusCode: 401 } },
            headers: { 'access-control-allow-origin': '*' },
        });
    });
    await page.goto(`/marketplace/${productId}?claimSession=${sessionId}`);
    const signIn = page.getByRole('link', { name: 'Sign in' });
    await expect(signIn).toBeVisible();
    const href = await signIn.getAttribute('href');
    expect(decodeURIComponent(href ?? '')).toContain(`claimSession=${sessionId}`);
    expect(claims).toBe(0);
});

test('a claim link for another product redirects to the session product', async ({ page }) => {
    await installSyntheticApi(page);
    await seedSession(page, 'student');
    await stubClaimSession(page, 'https://merchant.example');
    await page.route(`${apiOrigin}/api/verification/status`, (route) => route.fulfill({
        json: { success: true, data: { notices: { merchantDisclosure: notice } } },
        headers: { 'access-control-allow-origin': '*' },
    }));
    const otherProduct = '30000000-0000-4000-8000-000000000009';
    for (const id of [otherProduct, productId]) {
        await page.route(`${apiOrigin}/api/products/${id}`, (route) => route.fulfill({
            status: 404, json: { success: false, error: { message: 'Product not found', code: 'NOT_FOUND', statusCode: 404 } },
            headers: { 'access-control-allow-origin': '*' },
        }));
    }
    await page.goto(`/marketplace/${otherProduct}?claimSession=${sessionId}`);
    await page.waitForURL(`/marketplace/${productId}?claimSession=${sessionId}`);
    await expect(page.getByTestId('student-claim-card')).toBeVisible();
});

test('a malformed claim session never reaches the claim-sessions API', async ({ page }) => {
    await installSyntheticApi(page);
    await seedSession(page, 'student');
    await page.route(`${apiOrigin}/api/products/${productId}`, (route) => route.fulfill({
        status: 404, json: { success: false, error: { message: 'Product not found', code: 'NOT_FOUND', statusCode: 404 } },
        headers: { 'access-control-allow-origin': '*' },
    }));
    let sessionRequests = 0;
    await page.route(`${apiOrigin}/api/merchant-verification/claim-sessions/**`, (route) => {
        sessionRequests += 1;
        return route.fulfill({
            status: 500, json: { success: false, error: { message: 'must not be requested', code: 'UNREACHABLE', statusCode: 500 } },
            headers: { 'access-control-allow-origin': '*' },
        });
    });
    await page.goto(`/marketplace/${productId}?claimSession=${encodeURIComponent('../../admin/users')}`);
    await expect(page.getByText('unknown, expired, or already redeemed')).toBeVisible();
    await page.goto(`/marketplace/${productId}?claimSession=${encodeURIComponent('not-a-uuid')}`);
    await expect(page.getByText('unknown, expired, or already redeemed')).toBeVisible();
    expect(sessionRequests).toBe(0);
});
