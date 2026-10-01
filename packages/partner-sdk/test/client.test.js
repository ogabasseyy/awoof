import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { AwoofPartnerClient, AwoofApiError, nonceHash, merchantPaystackMetadata, verifyPaystackWebhook, partnerCapabilities, invokeConfiguredAdapter } from '../index.js';
test('claim/exchange/report contract and secret placement', async () => {
  const calls = []; const client = new AwoofPartnerClient({ apiOrigin: 'https://api.example.test', webOrigin: 'https://awoof.example.test', privateKey: 'awoof_private', fetch: async (url, options) => { calls.push({ url, options, body: JSON.parse(options.body) }); return Response.json({ success: true, data: { claimSessionId: 'session' } }); } });
  const nonce = 'a'.repeat(64);
  await client.createClaimSession({ productId: 'product', merchantCheckoutId: 'checkout', browserNonce: nonce, origin: 'https://merchant.test' });
  assert.deepEqual(calls[0].body, { productId: 'product', merchantCheckoutId: 'checkout', browserNonceHash: nonceHash(nonce), origin: 'https://merchant.test' });
  const hosted = client.buildHostedClaimUrl('product', 'session');
  assert.equal(hosted, 'https://awoof.example.test/marketplace/product?claimSession=session');
  assert.equal(hosted.includes(nonce), false); assert.equal(hosted.includes('private'), false);
  await client.exchangeClaim({ code: 'code', merchantCheckoutId: 'checkout', browserNonce: nonce, idempotencyKey: 'stable' });
  assert.equal(calls[1].body.campaignId, 'checkout'); assert.equal(calls[1].options.headers.Authorization, 'Bearer awoof_private');
  const report = { benefitAuthorizationId: 'auth', productId: 'product', paymentReference: 'ref', amount: 80000, paymentGateway: 'paystack_merchant' };
  await client.reportTransaction(report); assert.deepEqual(calls[2].body, report);
  assert.throws(() => client.reportTransaction({ ...report, amount: 1.1 }));
});
test('transport fails closed and never follows credential redirects', async () => {
  assert.throws(() => new AwoofPartnerClient({ apiOrigin: 'http://example.com', webOrigin: 'https://test.com', privateKey: 'awoof_x', allowLoopbackHttp: true }));
  assert.throws(() => new AwoofPartnerClient({ apiOrigin: 'https://test.com/path', webOrigin: 'https://test.com', privateKey: 'awoof_x' }));
  const client = new AwoofPartnerClient({ apiOrigin: 'https://test.com', webOrigin: 'https://test.com', privateKey: 'awoof_x', fetch: async (_, options) => { assert.equal(options.redirect, 'error'); return Response.json({ success: false }, { status: 409 }); } });
  await assert.rejects(client.reportTransaction({ amount: 1 }), error => error instanceof AwoofApiError && error.status === 409);
});
test('raw-body Paystack HMAC and metadata are exact', () => {
  const body = Buffer.from('{"event":"charge.success"}'); const secret = 'sk_test_fixture'; const signature = createHmac('sha512', secret).update(body).digest('hex');
  assert.equal(verifyPaystackWebhook(body, signature, secret), true);
  assert.equal(verifyPaystackWebhook(Buffer.from('{}'), signature, secret), false);
  assert.equal(verifyPaystackWebhook(body, 'bad', secret), false);
  assert.equal(verifyPaystackWebhook(body, signature, ''), false);
  assert.deepEqual(merchantPaystackMetadata({ vendorId: 'v', productId: 'p', benefitAuthorizationId: 'a' }), { awoofVendorId: 'v', awoofProductId: 'p', awoofBenefitAuthorizationId: 'a' });
});
test('every provider capability defaults unconfigured; contract reference gate blocks execution', async () => {
  for (const adapter of Object.values(partnerCapabilities())) assert.equal((await invokeConfiguredAdapter(adapter, { identity: 'google_account' })).status, 'unconfigured');
  let executed = false;
  const result = await invokeConfiguredAdapter({ status: 'configured', capability: 'verve_cashback', execute: async () => { executed = true; } }, {});
  assert.equal(result.status, 'unconfigured'); assert.equal(executed, false);
  assert.equal((await invokeConfiguredAdapter({ status: 'configured', capability: 'google_entitlement', contractReference: ' ', execute: async () => { executed = true; } }, {})).status, 'unconfigured'); assert.equal(executed, false);
});
