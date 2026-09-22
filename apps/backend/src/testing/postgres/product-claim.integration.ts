import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { createTestPool, inTransaction } from './test-database.js';
import { grantMerchantDisclosure, grantVerificationProcessing, withdrawConsent } from '../../services/verification/eligibility-consent.service.js';
import { updateInstitutionPolicy } from '../../services/verification/eligibility-policy.service.js';
import { lockStudentContext } from '../../services/verification/eligibility-context.service.js';
import { requestChallenge, consumeChallenge } from '../../services/verification/challenge.service.js';
import { applyEnrollmentDecision, beginEnrollmentCheck, recordEmailAssurance } from '../../services/verification/eligibility-evidence.service.js';
import { ENROLLMENT_SOURCE } from '../../services/verification/eligibility.types.js';
import { MERCHANT_DISCLOSURE_NOTICE_VERSION, VERIFICATION_NOTICE_VERSION } from '../../services/verification/verification-notices.js';
import { rotateReportingKey } from '../../services/auth/reporting-key.service.js';
import { exchangeMerchantAssertion, issueMerchantAssertion } from '../../services/verification/merchant-assertion.service.js';
import {
    MERCHANT_CLAIM_CALLBACK_PATH,
    claimProductBenefit,
    createMerchantClaimSession,
    readMerchantClaimSession,
} from '../../services/verification/product-claim.service.js';

const sha256hex = (value: string) => createHash('sha256').update(value).digest('hex');

type ClaimFixture = {
    label: string; student: string; studentEmail: string; owner: string; university: string;
    vendor: string; product: string; origin: string; disclosure: string; key: string;
};

async function createClaimFixture(
    client: PoolClient,
    pool: Pool,
    options: { enrollment?: 'verified' | 'email-only' | 'expired'; dealType?: 'product' | 'voucher' } = {},
): Promise<ClaimFixture> {
    const label = randomUUID();
    const enrollment = options.enrollment ?? 'verified';
    const studentEmail = `student-${label}@students.example`;
    const student = (await client.query(
        'INSERT INTO users (email,role) VALUES ($1,$2) RETURNING id', [studentEmail, 'student'],
    )).rows[0].id as string;
    const owner = (await client.query(
        'INSERT INTO users (email,role) VALUES ($1,$2) RETURNING id', [`vendor-${label}@example.invalid`, 'vendor'],
    )).rows[0].id as string;
    const admin = (await client.query(
        'INSERT INTO users (email,role) VALUES ($1,$2) RETURNING id', [`admin-${label}@example.invalid`, 'admin'],
    )).rows[0].id as string;
    const university = (await client.query(
        'INSERT INTO universities (name,is_active) VALUES ($1,true) RETURNING id', [label],
    )).rows[0].id as string;
    await client.query('INSERT INTO students (user_id,name,university_id) VALUES ($1,$2,$3)', [student, label, university]);
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
    if (enrollment !== 'email-only') {
        await client.query(`INSERT INTO university_verification_methods (university_id,method_type,api_endpoint,is_active)
            VALUES ($1,'registration','https://institution.example/verify',true)`, [university]);
        const snapshot = await inTransaction(client, () => beginEnrollmentCheck(client, student, processing));
        const decision = await inTransaction(client, () => applyEnrollmentDecision(client, snapshot, {
            outcome: 'verified', email: studentEmail.toLowerCase(), registrationNumber: `CLAIM-${label.slice(0, 8)}`,
            validUntil: enrollment === 'verified'
                ? new Date(Date.now() + 30 * 86_400_000)
                : new Date(Date.now() + 10_000),
            source: ENROLLMENT_SOURCE,
        }));
        assert.equal(decision.eligible, true);
        if (enrollment === 'expired') {
            // Enrollment evidence is immutable, so expiry is observed by
            // waiting past a short-lived deadline (same pattern as the
            // student-assurance suite).
            await new Promise((resolve) => setTimeout(resolve, 11_000));
        }
    }
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
        `INSERT INTO products (vendor_id,name,price,student_price,stock,status,deal_type)
         VALUES ($1,'Synthetic claim',100,80,4,'active',$2) RETURNING id`,
        [vendor, options.dealType ?? 'voucher'],
    )).rows[0].id as string;
    const key = await rotateReportingKey(pool, owner);
    return { label, student, studentEmail, owner, university, vendor, product, origin, disclosure, key };
}

type StubRequest = { method: string | undefined; url: string | undefined; headers: Record<string, string | string[] | undefined>; body: string };

function readStubRequest(req: IncomingMessage): Promise<StubRequest> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
        req.on('end', () => resolve({ method: req.method, url: req.url, headers: req.headers as StubRequest['headers'], body }));
        req.on('error', reject);
    });
}

function parseCookies(header: string | string[] | undefined): Record<string, string> {
    const raw = Array.isArray(header) ? header.join('; ') : (header ?? '');
    const cookies: Record<string, string> = {};
    for (const part of raw.split(';')) {
        const index = part.indexOf('=');
        if (index > 0) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    }
    return cookies;
}

function json(res: ServerResponse, status: number, payload: unknown, setCookies: string[] = []): void {
    if (setCookies.length > 0) res.setHeader('set-cookie', setCookies);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
}

/**
 * Durable test merchant: a real HTTP server with cookie-bound browser state
 * and an append-only file redemption ledger. Its backend calls the real
 * Awoof services in-process; the browser-facing HTTP boundary (cookies,
 * handoff URLs, replays) is genuinely exercised over the loopback network.
 */
async function startMerchantStub(pool: Pool, merchantKey: string, origin: string): Promise<{
    baseUrl: string; close: () => Promise<void>; ledger: () => Array<Record<string, unknown>>;
}> {
    const scratch = mkdtempSync(join(tmpdir(), 'awoof-merchant-stub-'));
    const ledgerPath = join(scratch, 'redemptions.jsonl');
    const ledger = (): Array<Record<string, unknown>> => {
        try {
            return readFileSync(ledgerPath, 'utf8').trim().split('\n')
                .filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
        }
    };
    const redeemed = new Set<string>();
    const server: Server = createServer((req, res) => {
        void (async () => {
            const request = await readStubRequest(req);
            const url = new URL(request.url ?? '/', 'http://merchant.test');
            if (request.method === 'POST' && url.pathname === '/bootstrap') {
                const payload = JSON.parse(request.body) as { productId: string; checkoutId: string };
                const nonce = randomBytes(32).toString('base64url');
                const session = await createMerchantClaimSession(pool, merchantKey, {
                    productId: payload.productId,
                    merchantCheckoutId: payload.checkoutId,
                    browserNonceHash: sha256hex(nonce),
                    origin,
                });
                json(res, session.created ? 201 : 200, { claimSessionId: session.claimSessionId }, [
                    `merchant_nonce=${encodeURIComponent(nonce)}; HttpOnly; SameSite=Lax; Path=/`,
                    `merchant_checkout=${encodeURIComponent(payload.checkoutId)}; HttpOnly; SameSite=Lax; Path=/`,
                ]);
                return;
            }
            if (request.method === 'GET' && url.pathname === MERCHANT_CLAIM_CALLBACK_PATH) {
                const cookies = parseCookies(request.headers.cookie);
                const nonce = cookies.merchant_nonce;
                const checkoutId = cookies.merchant_checkout;
                const params = [...url.searchParams.keys()];
                if (!nonce || !checkoutId) {
                    json(res, 403, { redeemed: false, reason: 'merchant session required' });
                    return;
                }
                if (params.length !== 1 || params[0] !== 'assertion') {
                    json(res, 400, { redeemed: false, reason: 'unexpected handoff parameters' });
                    return;
                }
                const code = url.searchParams.get('assertion') ?? '';
                if (!/^[A-Za-z0-9_-]{43}$/.test(code)) {
                    json(res, 400, { redeemed: false, reason: 'malformed assertion' });
                    return;
                }
                if (redeemed.has(checkoutId)) {
                    json(res, 409, { redeemed: false, reason: 'checkout already redeemed' });
                    return;
                }
                try {
                    const receipt = await exchangeMerchantAssertion(pool, merchantKey, {
                        code, campaignId: checkoutId, idempotencyKey: `redeem-${checkoutId}`,
                        browserNonce: nonce, merchantCheckoutId: checkoutId,
                    });
                    redeemed.add(checkoutId);
                    const { appendFileSync } = await import('node:fs');
                    appendFileSync(ledgerPath, `${JSON.stringify({
                        checkoutId, receiptId: receipt.receiptId,
                        benefitAuthorizationId: receipt.benefitAuthorizationId ?? null,
                        redeemedAt: new Date().toISOString(),
                    })}\n`);
                    json(res, 200, { redeemed: true, receipt });
                } catch (error) {
                    const status = (error as { statusCode?: number }).statusCode ?? 500;
                    json(res, status, { redeemed: false, reason: (error as Error).message });
                }
                return;
            }
            json(res, 404, { redeemed: false, reason: 'unknown merchant route' });
        })().catch((error: Error) => json(res, 500, { redeemed: false, reason: error.message }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo | null;
    if (!address || typeof address === 'string') throw new Error('Merchant stub did not expose a loopback port');
    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: async () => { server.close(); await once(server, 'close'); rmSync(scratch, { recursive: true, force: true }); },
        ledger,
    };
}

test('claim sessions bind one checkout to one product with exact-retry semantics', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const fixture = await createClaimFixture(client, pool);
        const checkoutId = `checkout-${fixture.label.slice(0, 8)}`;
        const nonceHash = sha256hex('browser-nonce-fixture');
        const created = await createMerchantClaimSession(pool, fixture.key, {
            productId: fixture.product, merchantCheckoutId: checkoutId, browserNonceHash: nonceHash,
            origin: fixture.origin,
        });
        assert.equal(created.created, true);
        const retry = await createMerchantClaimSession(pool, fixture.key, {
            productId: fixture.product, merchantCheckoutId: checkoutId, browserNonceHash: nonceHash,
            origin: fixture.origin,
        });
        assert.equal(retry.created, false);
        assert.equal(retry.claimSessionId, created.claimSessionId);
        const otherProduct = (await client.query(
            `INSERT INTO products (vendor_id,name,price,student_price,stock,status) VALUES ($1,'Other',50,40,2,'active') RETURNING id`,
            [fixture.vendor],
        )).rows[0].id as string;
        await assert.rejects(createMerchantClaimSession(pool, fixture.key, {
            productId: otherProduct, merchantCheckoutId: checkoutId, browserNonceHash: nonceHash,
            origin: fixture.origin,
        }), /already bound to a different claim/);
        await assert.rejects(createMerchantClaimSession(pool, fixture.key, {
            productId: fixture.product, merchantCheckoutId: checkoutId, browserNonceHash: sha256hex('different-nonce'),
            origin: fixture.origin,
        }), /already bound to a different claim/);
        await assert.rejects(createMerchantClaimSession(pool, fixture.key, {
            productId: fixture.product, merchantCheckoutId: checkoutId, browserNonceHash: nonceHash,
            origin: 'https://other-site.example',
        }), /already bound to a different claim/);
        await assert.rejects(createMerchantClaimSession(pool, 'awoof_' + '0'.repeat(64), {
            productId: fixture.product, merchantCheckoutId: `other-${checkoutId}`, browserNonceHash: nonceHash,
            origin: fixture.origin,
        }), /Authentication failed/);
        await assert.rejects(createMerchantClaimSession(pool, fixture.key, {
            productId: randomUUID(), merchantCheckoutId: `other-${checkoutId}`, browserNonceHash: nonceHash,
            origin: fixture.origin,
        }), /not available for this merchant/);
        await assert.rejects(createMerchantClaimSession(pool, fixture.key, {
            productId: fixture.product, merchantCheckoutId: `other-${checkoutId}`, browserNonceHash: nonceHash,
            origin: 'https://unlisted.example',
        }), /not an active allowed origin/);
        const stranger = await createClaimFixture(client, pool);
        await assert.rejects(createMerchantClaimSession(pool, fixture.key, {
            productId: stranger.product, merchantCheckoutId: `other-${checkoutId}`, browserNonceHash: nonceHash,
            origin: fixture.origin,
        }), /not available for this merchant/);
        await client.query("UPDATE merchant_claim_sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [created.claimSessionId]);
        await assert.rejects(createMerchantClaimSession(pool, fixture.key, {
            productId: fixture.product, merchantCheckoutId: checkoutId, browserNonceHash: nonceHash,
            origin: fixture.origin,
        }), /already used or expired/);
    } finally { client.release(); await pool.end(); }
});

test('protected redemption flows through a durable merchant server with one redemption per checkout', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const fixture = await createClaimFixture(client, pool);
        const live = await startMerchantStub(pool, fixture.key, fixture.origin);
        try {
            const baseUrl = live.baseUrl;
            const checkoutId = `order-${fixture.label.slice(0, 8)}`;
            const bootstrap = await fetch(`${baseUrl}/bootstrap`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ productId: fixture.product, checkoutId }),
            });
            assert.equal(bootstrap.status, 201);
            const bootstrapped = await bootstrap.json() as { claimSessionId: string };
            const setCookies = bootstrap.headers.getSetCookie();
            assert.equal(setCookies.length, 2);
            const jar = setCookies.map((cookie) => cookie.split(';')[0]).join('; ');
            const claim = await claimProductBenefit(pool, fixture.student, {
                merchantClaimSessionId: bootstrapped.claimSessionId, disclosureGrantId: fixture.disclosure,
            });
            const handoff = new URL(claim.handoffUrl);
            assert.equal(handoff.origin, fixture.origin);
            assert.equal(handoff.pathname, MERCHANT_CLAIM_CALLBACK_PATH);
            assert.deepEqual([...handoff.searchParams.keys()], ['assertion']);
            assert.equal(claim.handoffUrl.includes('@'), false);
            // TLS/hosting of the registered merchant origin is deployment-owned;
            // exercise the identical path/query/cookie binding against the stub.
            const callbackUrl = `${baseUrl}${handoff.pathname}${handoff.search}`;
            const direct = await fetch(callbackUrl);
            assert.equal(direct.status, 403);
            const callback = await fetch(callbackUrl, { headers: { cookie: jar } });
            assert.equal(callback.status, 200);
            const redeemed = await callback.json() as { redeemed: boolean; receipt: Record<string, unknown> };
            assert.equal(redeemed.redeemed, true);
            assert.equal(typeof redeemed.receipt.benefitAuthorizationId, 'string');
            assert.equal(JSON.stringify(redeemed.receipt).includes('@'), false);
            assert.equal(live.ledger().length, 1);
            assert.equal(live.ledger()[0]!.checkoutId, checkoutId);
            const stored = await client.query(
                'SELECT consumed_at FROM merchant_claim_sessions WHERE id = $1', [bootstrapped.claimSessionId],
            );
            assert.notEqual(stored.rows[0].consumed_at, null);
            const authorization = await client.query(
                'SELECT claim_session_id FROM merchant_benefit_authorizations WHERE id = $1',
                [redeemed.receipt.benefitAuthorizationId as string],
            );
            assert.equal(authorization.rows[0].claim_session_id, bootstrapped.claimSessionId);
            const replay = await fetch(callbackUrl, { headers: { cookie: jar } });
            assert.equal(replay.status, 409);
            assert.equal(live.ledger().length, 1);
            const code = handoff.searchParams.get('assertion')!;
            const sameOperation = await exchangeMerchantAssertion(pool, fixture.key, {
                code, campaignId: checkoutId, idempotencyKey: `redeem-${checkoutId}`,
                browserNonce: decodeURIComponent(jar.split(';')[0]!.split('=')[1]!), merchantCheckoutId: checkoutId,
            });
            assert.equal(sameOperation.receiptId, redeemed.receipt.receiptId);
            await assert.rejects(exchangeMerchantAssertion(pool, fixture.key, {
                code, campaignId: checkoutId, idempotencyKey: `redeem-${checkoutId}-second`,
                browserNonce: decodeURIComponent(jar.split(';')[0]!.split('=')[1]!), merchantCheckoutId: checkoutId,
            }), /expired or already used|already redeemed/);
            await assert.rejects(exchangeMerchantAssertion(pool, fixture.key, {
                code, campaignId: 'wrong-campaign', idempotencyKey: `redeem-${checkoutId}-third`,
                browserNonce: 'x'.repeat(43), merchantCheckoutId: checkoutId,
            }), /Campaign mismatch/);
        } finally { await live.close(); }
    } finally { client.release(); await pool.end(); }
});

test('claims fail closed for pending, expired and consent-withdrawn students', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        for (const enrollment of ['email-only', 'expired'] as const) {
            const fixture = await createClaimFixture(client, pool, { enrollment });
            const checkoutId = `closed-${enrollment}-${fixture.label.slice(0, 8)}`;
            const session = await createMerchantClaimSession(pool, fixture.key, {
                productId: fixture.product, merchantCheckoutId: checkoutId,
                browserNonceHash: sha256hex(`nonce-${checkoutId}`), origin: fixture.origin,
            });
            await assert.rejects(claimProductBenefit(pool, fixture.student, {
                merchantClaimSessionId: session.claimSessionId, disclosureGrantId: fixture.disclosure,
            }), /Current student enrollment required/);
            const assertions = await client.query('SELECT count(*)::int AS count FROM merchant_assertions WHERE vendor_id = $1', [fixture.vendor]);
            assert.equal(assertions.rows[0].count, 0);
            const live = await client.query(
                'SELECT consumed_at FROM merchant_claim_sessions WHERE id = $1', [session.claimSessionId],
            );
            assert.equal(live.rows[0].consumed_at, null);
        }
        const fixture = await createClaimFixture(client, pool);
        await inTransaction(client, () => withdrawConsent(client, fixture.student, fixture.disclosure));
        const session = await createMerchantClaimSession(pool, fixture.key, {
            productId: fixture.product, merchantCheckoutId: `closed-withdrawn-${fixture.label.slice(0, 8)}`,
            browserNonceHash: sha256hex('nonce-withdrawn'), origin: fixture.origin,
        });
        await assert.rejects(claimProductBenefit(pool, fixture.student, {
            merchantClaimSessionId: session.claimSessionId, disclosureGrantId: fixture.disclosure,
        }), /Current student enrollment required/);
    } finally { client.release(); await pool.end(); }
});

test('disclosure withdrawn immediately before commit cannot authorize a claim', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const fixture = await createClaimFixture(client, pool);
        const session = await createMerchantClaimSession(pool, fixture.key, {
            productId: fixture.product, merchantCheckoutId: `race-${fixture.label.slice(0, 8)}`,
            browserNonceHash: sha256hex('nonce-race'), origin: fixture.origin,
        });
        await inTransaction(client, () => withdrawConsent(client, fixture.student, fixture.disclosure));
        await assert.rejects(claimProductBenefit(pool, fixture.student, {
            merchantClaimSessionId: session.claimSessionId, disclosureGrantId: fixture.disclosure,
        }), /Current student enrollment required/);
        const stranger = await createClaimFixture(client, pool);
        await assert.rejects(claimProductBenefit(pool, fixture.student, {
            merchantClaimSessionId: session.claimSessionId, disclosureGrantId: stranger.disclosure,
        }), /another user|different merchant/);
        const assertions = await client.query('SELECT count(*)::int AS count FROM merchant_assertions WHERE vendor_id = $1', [fixture.vendor]);
        assert.equal(assertions.rows[0].count, 0);
    } finally { client.release(); await pool.end(); }
});

test('claims require a deployed merchant integration at commit time', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const revoked = await createClaimFixture(client, pool);
        const revokedSession = await createMerchantClaimSession(pool, revoked.key, {
            productId: revoked.product, merchantCheckoutId: `nokey-${revoked.label.slice(0, 8)}`,
            browserNonceHash: sha256hex('nonce-nokey'), origin: revoked.origin,
        });
        await client.query("UPDATE api_keys SET status = 'revoked' WHERE vendor_id = $1", [revoked.vendor]);
        await assert.rejects(claimProductBenefit(pool, revoked.student, {
            merchantClaimSessionId: revokedSession.claimSessionId, disclosureGrantId: revoked.disclosure,
        }), /Merchant integration unavailable/);
        try {
            await claimProductBenefit(pool, revoked.student, {
                merchantClaimSessionId: revokedSession.claimSessionId, disclosureGrantId: revoked.disclosure,
            });
            assert.fail('expected MERCHANT_INTEGRATION_REQUIRED');
        } catch (error) {
            assert.equal((error as { code?: string }).code, 'MERCHANT_INTEGRATION_REQUIRED');
        }
        const suspended = await createClaimFixture(client, pool);
        const suspendedSession = await createMerchantClaimSession(pool, suspended.key, {
            productId: suspended.product, merchantCheckoutId: `nowidget-${suspended.label.slice(0, 8)}`,
            browserNonceHash: sha256hex('nonce-nowidget'), origin: suspended.origin,
        });
        await client.query("UPDATE widget_configs SET status = 'suspended' WHERE vendor_id = $1", [suspended.vendor]);
        await assert.rejects(claimProductBenefit(pool, suspended.student, {
            merchantClaimSessionId: suspendedSession.claimSessionId, disclosureGrantId: suspended.disclosure,
        }), /Merchant integration unavailable/);
    } finally { client.release(); await pool.end(); }
});

test('claim-session introspection exposes review data without hashes, codes or handoff URLs', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const fixture = await createClaimFixture(client, pool);
        const session = await createMerchantClaimSession(pool, fixture.key, {
            productId: fixture.product, merchantCheckoutId: `intro-${fixture.label.slice(0, 8)}`,
            browserNonceHash: sha256hex('nonce-intro'), origin: fixture.origin,
        });
        const multiOrigin = 'https://z-shop.example';
        await client.query(
            `UPDATE widget_configs SET allowed_origins = array_append(allowed_origins, $2)
             WHERE vendor_id = $1 AND status = 'active'`,
            [fixture.vendor, multiOrigin],
        );
        const second = await createMerchantClaimSession(pool, fixture.key, {
            productId: fixture.product, merchantCheckoutId: `second-${fixture.label.slice(0, 8)}`,
            browserNonceHash: sha256hex('nonce-second'), origin: multiOrigin,
        });
        // The handoff goes to the stored initiating site even when it sorts
        // after the vendor's other allowed origin: never the alphabetical pick.
        assert.equal((await readMerchantClaimSession(pool, second.claimSessionId)).handoffOrigin, multiOrigin);
        // A session predating the origin binding stays unusable instead of
        // guessing a destination.
        const legacyId = (await client.query<{ id: string }>(
            `INSERT INTO merchant_claim_sessions (vendor_id, product_id, checkout_id, browser_nonce_hash, expires_at)
             VALUES ($1, $2, $3, $4, clock_timestamp() + interval '10 minutes') RETURNING id`,
            [fixture.vendor, fixture.product, `legacy-${fixture.label.slice(0, 8)}`, sha256hex('nonce-legacy')],
        )).rows[0]!.id;
        await assert.rejects(readMerchantClaimSession(pool, legacyId), /expired or already redeemed/);
        const view = await readMerchantClaimSession(pool, session.claimSessionId);
        assert.deepEqual(Object.keys(view).sort(), [
            'claimSessionId', 'expiresAt', 'handoffOrigin', 'listPrice', 'productId',
            'productName', 'studentPrice', 'vendorId', 'vendorName',
        ]);
        assert.equal(view.handoffOrigin, fixture.origin);
        assert.equal(view.vendorName, fixture.label);
        const serialized = JSON.stringify(view);
        assert.equal(serialized.includes('?'), false);
        assert.equal(serialized.toLowerCase().includes('nonce'), false);
        await assert.rejects(readMerchantClaimSession(pool, randomUUID()), /Claim session not found/);
        await client.query('UPDATE merchant_claim_sessions SET consumed_at = clock_timestamp() WHERE id = $1', [session.claimSessionId]);
        await assert.rejects(readMerchantClaimSession(pool, session.claimSessionId), /expired or already redeemed/);
    } finally { client.release(); await pool.end(); }
});

test('concurrent duplicate exchanges grant a single redemption per checkout', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const fixture = await createClaimFixture(client, pool);
        const checkoutId = `conc-${fixture.label.slice(0, 8)}`;
        const nonce = randomBytes(32).toString('base64url');
        const session = await createMerchantClaimSession(pool, fixture.key, {
            productId: fixture.product, merchantCheckoutId: checkoutId, browserNonceHash: sha256hex(nonce),
            origin: fixture.origin,
        });
        const claim = await claimProductBenefit(pool, fixture.student, {
            merchantClaimSessionId: session.claimSessionId, disclosureGrantId: fixture.disclosure,
        });
        const duplicate = await Promise.allSettled([0, 1].map(() => exchangeMerchantAssertion(pool, fixture.key, {
            code: claim.code, campaignId: checkoutId, idempotencyKey: `conc-${checkoutId}`,
            browserNonce: nonce, merchantCheckoutId: checkoutId,
        })));
        assert.equal(duplicate.filter((result) => result.status === 'fulfilled').length, 2);
        const receipts = duplicate.map((result) => {
            assert.equal(result.status, 'fulfilled');
            if (result.status !== 'fulfilled') throw new Error('Exchange fixture failed');
            return result.value;
        });
        assert.equal(receipts[0]!.receiptId, receipts[1]!.receiptId);
        const second = await claimProductBenefit(pool, fixture.student, {
            merchantClaimSessionId: session.claimSessionId, disclosureGrantId: fixture.disclosure,
        }).catch(() => null);
        assert.equal(second, null);
        const stored = await client.query(
            'SELECT count(*)::int AS count FROM merchant_assertion_receipts WHERE vendor_id = $1', [fixture.vendor],
        );
        assert.equal(stored.rows[0].count, 1);
        const authorizations = await client.query(
            'SELECT count(*)::int AS count FROM merchant_benefit_authorizations WHERE vendor_id = $1', [fixture.vendor],
        );
        assert.equal(authorizations.rows[0].count, 1);
    } finally { client.release(); await pool.end(); }
});

test('exchange requires claim-session proof exactly for claim-bound codes', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const fixture = await createClaimFixture(client, pool);
        const legacy = await issueMerchantAssertion(pool, fixture.student, {
            vendorId: fixture.vendor, origin: fixture.origin, purpose: 'student-discount',
            campaignId: 'legacy', disclosureGrantId: fixture.disclosure,
        });
        await assert.rejects(exchangeMerchantAssertion(pool, fixture.key, {
            code: legacy.code, campaignId: 'legacy', idempotencyKey: 'legacy-proof',
            browserNonce: 'n'.repeat(43), merchantCheckoutId: 'legacy',
        }), /Unexpected claim session proof/);
        const checkoutId = `proof-${fixture.label.slice(0, 8)}`;
        const nonce = randomBytes(32).toString('base64url');
        const session = await createMerchantClaimSession(pool, fixture.key, {
            productId: fixture.product, merchantCheckoutId: checkoutId, browserNonceHash: sha256hex(nonce),
            origin: fixture.origin,
        });
        const claim = await claimProductBenefit(pool, fixture.student, {
            merchantClaimSessionId: session.claimSessionId, disclosureGrantId: fixture.disclosure,
        });
        await assert.rejects(exchangeMerchantAssertion(pool, fixture.key, {
            code: claim.code, campaignId: checkoutId, idempotencyKey: 'proof-missing',
        }), /Claim session proof required/);
        await assert.rejects(exchangeMerchantAssertion(pool, fixture.key, {
            code: claim.code, campaignId: checkoutId, idempotencyKey: 'proof-wrong-nonce',
            browserNonce: randomBytes(32).toString('base64url'), merchantCheckoutId: checkoutId,
        }), /bound to a different checkout/);
        await assert.rejects(exchangeMerchantAssertion(pool, fixture.key, {
            code: claim.code, campaignId: checkoutId, idempotencyKey: 'proof-wrong-checkout',
            browserNonce: nonce, merchantCheckoutId: 'another-checkout',
        }), /bound to a different checkout/);
        const receipt = await exchangeMerchantAssertion(pool, fixture.key, {
            code: claim.code, campaignId: checkoutId, idempotencyKey: 'proof-ok',
            browserNonce: nonce, merchantCheckoutId: checkoutId,
        });
        assert.equal(receipt.eligible, true);
        assert.equal(typeof receipt.benefitAuthorizationId, 'string');
    } finally { client.release(); await pool.end(); }
});
