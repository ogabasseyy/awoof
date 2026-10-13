import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { createMerchant } from '../server.js';
async function port() { const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
test('merchant test Paystack signature, verification, durable acceptance and exact reconciliation retry', async () => {
  const p = await port(); const origin = `https://127.0.0.1:${p}`; const secret = 'sk_test_fixture'; let expectedAmount = 70000; let reports = 0; let checkoutId;
  const metadata = { awoofVendorId: 'vendor', awoofProductId: 'product', awoofBenefitAuthorizationId: 'benefit' };
  const app = createMerchant({ origin, apiOrigin: 'https://awoof-api.test', webOrigin: 'https://awoof.test', privateKey: 'awoof_test', productId: 'product', vendorId: 'vendor', amountKobo: 80000, paymentGateway: 'paystack_merchant', paystackSecret: secret, dbPath: ':memory:', fetchImpl: async (url, init) => {
    if (url.startsWith('https://api.paystack.co/')) return Response.json({ status: true, data: { status: 'success', domain: 'test', reference: 'payment', amount: expectedAmount, currency: 'NGN', metadata } });
    const body = JSON.parse(init.body);
    if (url.endsWith('/claim-sessions')) { checkoutId = body.merchantCheckoutId; return Response.json({ success: true, data: { claimSessionId: 'session', expiresAt: new Date(Date.now() + 600000).toISOString() } }); }
    if (url.endsWith('/exchange')) return Response.json({ success: true, data: { eligible: true, assuranceMethod: 'enrollment', campaignId: checkoutId, benefitAuthorizationId: 'benefit', validUntil: new Date(Date.now() + 600000).toISOString() } });
    reports++; assert.equal(body.paymentGateway, 'paystack_merchant'); assert.equal(body.paymentReference, 'payment'); assert.equal(body.amount, 80000);
    if (reports === 1) { await new Promise(resolve => setTimeout(resolve, 30)); return Response.json({ success: false, error: 'reconciliation' }, { status: 409 }); }
    return Response.json({ success: true, data: { transactionId: 'transaction' } });
  } });
  await new Promise(r => app.server.listen(p, '127.0.0.1', r));
  const request = (path, init = {}) => fetch(`http://127.0.0.1:${p}${path}`, { redirect: 'manual', ...init });
  try {
    const start = await request('/checkout', { method: 'POST', headers: { Origin: origin } }); const cookie = start.headers.get('set-cookie').split(';')[0]; assert.match(start.headers.get('set-cookie'), /Secure/);
    await request('/awoof/student-claim?assertion=' + 'a'.repeat(43), { headers: { Cookie: cookie } });
    const body = JSON.stringify({ event: 'charge.success', data: { reference: 'payment', metadata } });
    const webhook = signature => request('/webhooks/paystack', { method: 'POST', headers: { 'x-paystack-signature': signature }, body });
    assert.equal((await webhook('bad')).status, 401); assert.equal(reports, 0);
    const signature = createHmac('sha512', secret).update(body).digest('hex');
    assert.equal((await webhook(signature)).status, 400); assert.equal(reports, 0);
    expectedAmount = 80000;
    const conflictingBody = JSON.stringify({ event: 'charge.success', data: { reference: 'different', metadata } }); const conflictingSig = createHmac('sha512', secret).update(conflictingBody).digest('hex');
    const events = await Promise.all([webhook(signature), request('/webhooks/paystack', { method: 'POST', headers: { 'x-paystack-signature': conflictingSig }, body: conflictingBody })]);
    const eventStatuses = events.map(response => response.status);
    assert.equal(eventStatuses.filter(status => status === 200).length, 1);
    assert.ok([400, 409].includes(eventStatuses.find(status => status !== 200)));
    assert.equal(app.store.get(checkoutId).paymentReference, 'payment');
    assert.equal(app.store.get(checkoutId).state, 'reconciliation_required'); assert.equal(reports, 1);
    await request('/reconcile', { method: 'POST', headers: { Cookie: cookie, Origin: origin } });
    assert.equal(app.store.get(checkoutId).state, 'reported'); assert.equal(reports, 2);
    const duplicateEvents = await Promise.all([webhook(signature), webhook(signature)]);
    assert.deepEqual(duplicateEvents.map(response => response.status), [200, 200]); assert.equal(reports, 2);
    const reversalBody = JSON.stringify({ event: 'refund.processed', data: {} }); const reversalSig = createHmac('sha512', secret).update(reversalBody).digest('hex');
    assert.equal((await request('/webhooks/paystack', { method: 'POST', headers: { 'x-paystack-signature': reversalSig }, body: reversalBody })).status, 202); assert.equal(reports, 2);
    assert.equal(app.store.find(row => row.kind === 'provider_review').state, 'reconciliation_required');
    const noMetadataBody = JSON.stringify({ event: 'charge.success', data: { reference: 'payment' } }); const noMetadataSig = createHmac('sha512', secret).update(noMetadataBody).digest('hex');
    assert.equal((await request('/webhooks/paystack', { method: 'POST', headers: { 'x-paystack-signature': noMetadataSig }, body: noMetadataBody })).status, 202); assert.equal(reports, 2);
    const malformedBody = 'not-json'; const malformedSig = createHmac('sha512', secret).update(malformedBody).digest('hex');
    assert.equal((await request('/webhooks/paystack', { method: 'POST', headers: { 'x-paystack-signature': malformedSig }, body: malformedBody })).status, 400); assert.equal(reports, 2);
  } finally { await new Promise(r => app.server.close(r)); app.store.close(); }
});
for (const gateway of ['paystack', 'other']) test(`${gateway} server report requires independent merchant authorization and preserves payment mode`, async () => {
  const p = await port(); const origin = `https://127.0.0.1:${p}`; const reportSecret = 's'.repeat(40); let checkoutId; let reports = 0;
  const app = createMerchant({ origin, apiOrigin: 'https://api.test', webOrigin: 'https://awoof.test', privateKey: 'awoof_test', productId: 'product', vendorId: 'vendor', amountKobo: 80000, paymentGateway: gateway, reportSecret, dbPath: ':memory:', fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith('/claim-sessions')) { checkoutId = body.merchantCheckoutId; return Response.json({ success: true, data: { claimSessionId: 'session' } }); }
    if (url.endsWith('/exchange')) return Response.json({ success: true, data: { eligible: true, assuranceMethod: 'enrollment', campaignId: checkoutId, benefitAuthorizationId: 'benefit', validUntil: new Date(Date.now() + 600000).toISOString() } });
    reports++; assert.equal(body.paymentGateway, gateway); return Response.json({ success: true, data: { transactionId: 'same' } });
  } });
  await new Promise(r => app.server.listen(p, '127.0.0.1', r)); const request = (path, init = {}) => fetch(`http://127.0.0.1:${p}${path}`, { redirect: 'manual', ...init });
  try {
    const start = await request('/checkout', { method: 'POST', headers: { Origin: origin } }); const cookie = start.headers.get('set-cookie').split(';')[0];
    await request('/awoof/student-claim?assertion=' + 'b'.repeat(43), { headers: { Cookie: cookie } });
    const body = JSON.stringify({ merchantCheckoutId: checkoutId, paymentReference: 'r'.repeat(255) });
    assert.equal((await request('/payments/report', { method: 'POST', body })).status, 401); assert.equal(reports, 0);
    assert.equal((await request('/payments/report', { method: 'POST', headers: { Authorization: `Bearer ${reportSecret}` }, body: 'not-json' })).status, 400); assert.equal(reports, 0);
    assert.equal((await request('/payments/report', { method: 'POST', headers: { Authorization: `Bearer ${reportSecret}` }, body: 'x'.repeat(64 * 1024 + 1) })).status, 413); assert.equal(reports, 0);
    assert.equal((await request('/payments/report', { method: 'POST', headers: { Authorization: `Bearer ${reportSecret}` }, body: JSON.stringify({ merchantCheckoutId: checkoutId, paymentReference: 'r'.repeat(256) }) })).status, 400); assert.equal(reports, 0);
    const headers = { Authorization: `Bearer ${reportSecret}` };
    const simultaneous = await Promise.all([request('/payments/report', { method: 'POST', headers, body }), request('/payments/report', { method: 'POST', headers, body: JSON.stringify({ merchantCheckoutId: checkoutId, paymentReference: 'conflicting' }) })]);
    const reportStatuses = simultaneous.map(response => response.status);
    assert.equal(reportStatuses.filter(status => status === 200).length, 1);
    assert.equal(reportStatuses.filter(status => status === 409).length, 1);
    assert.equal(app.store.get(checkoutId).paymentReference, simultaneous[0].status === 200 ? 'r'.repeat(255) : 'conflicting');
    assert.equal(reports, 1);
    const acceptedReference = simultaneous[0].status === 200 ? 'r'.repeat(255) : 'conflicting';
    const retry = await request('/payments/report', { method: 'POST', headers, body: JSON.stringify({ merchantCheckoutId: checkoutId, paymentReference: acceptedReference }) });
    assert.equal(retry.status, 200); assert.equal(reports, 1);
    assert.equal((await request('/payments/report', { method: 'POST', headers, body: JSON.stringify({ merchantCheckoutId: checkoutId, paymentReference: 'different' }) })).status, 409);
  } finally { await new Promise(r => app.server.close(r)); app.store.close(); }
});
test('merchant verification keeps transient Paystack failures retryable and definitive mismatches rejected', async () => {
  const p = await port(); const origin = `https://127.0.0.1:${p}`; const secret = 'sk_test_fixture'; let checkoutId; let reports = 0; let verifyBehavior = 'transient';
  const metadata = { awoofVendorId: 'vendor', awoofProductId: 'product', awoofBenefitAuthorizationId: 'benefit' };
  const app = createMerchant({ origin, apiOrigin: 'https://awoof-api.test', webOrigin: 'https://awoof.test', privateKey: 'awoof_test', productId: 'product', vendorId: 'vendor', amountKobo: 80000, paymentGateway: 'paystack_merchant', paystackSecret: secret, dbPath: ':memory:', fetchImpl: async (url, init) => {
    if (url.startsWith('https://api.paystack.co/')) {
      if (verifyBehavior === 'transport') throw new Error('synthetic-transport-failure');
      if (verifyBehavior === 'transient') return Response.json({ status: false, message: 'upstream' }, { status: 503 });
      if (verifyBehavior === 'auth') return Response.json({ status: false, message: 'invalid key' }, { status: 401 });
      if (verifyBehavior === 'malformed-ok') return new Response('not-json{', { status: 200, headers: { 'content-type': 'application/json' } });
      if (verifyBehavior === 'malformed-missing') return new Response('not-json{', { status: 404 });
      return Response.json({ status: true, data: { status: 'success', domain: 'test', reference: 'payment', amount: 80000, currency: 'NGN', metadata } });
    }
    const body = JSON.parse(init.body);
    if (url.endsWith('/claim-sessions')) { checkoutId = body.merchantCheckoutId; return Response.json({ success: true, data: { claimSessionId: 'session', expiresAt: new Date(Date.now() + 600000).toISOString() } }); }
    if (url.endsWith('/exchange')) return Response.json({ success: true, data: { eligible: true, assuranceMethod: 'enrollment', campaignId: checkoutId, benefitAuthorizationId: 'benefit', validUntil: new Date(Date.now() + 600000).toISOString() } });
    reports++; return Response.json({ success: true, data: { transactionId: 'transaction' } });
  } });
  await new Promise(r => app.server.listen(p, '127.0.0.1', r));
  const request = (path, init = {}) => fetch(`http://127.0.0.1:${p}${path}`, { redirect: 'manual', ...init });
  try {
    const start = await request('/checkout', { method: 'POST', headers: { Origin: origin } }); const cookie = start.headers.get('set-cookie').split(';')[0];
    await request('/awoof/student-claim?assertion=' + 'c'.repeat(43), { headers: { Cookie: cookie } });
    const body = JSON.stringify({ event: 'charge.success', data: { reference: 'payment', metadata } });
    const signature = createHmac('sha512', secret).update(body).digest('hex');
    const webhook = () => request('/webhooks/paystack', { method: 'POST', headers: { 'x-paystack-signature': signature }, body });
    for (const behavior of ['transient', 'transport', 'auth', 'malformed-ok']) {
      verifyBehavior = behavior;
      assert.equal((await webhook()).status, 503);
    }
    assert.equal(reports, 0);
    assert.equal(app.store.get(checkoutId).state, 'authorized');
    verifyBehavior = 'malformed-missing';
    assert.equal((await webhook()).status, 400);
    verifyBehavior = 'success';
    assert.equal((await webhook()).status, 200);
    assert.equal(reports, 1);
    assert.equal(app.store.get(checkoutId).state, 'reported');
  } finally { await new Promise(r => app.server.close(r)); app.store.close(); }
});
test('quota failure keeps the callback binding so only the exact assertion retries', async () => {
  const p = await port(); const origin = `https://127.0.0.1:${p}`; let checkoutId; let exchanges = 0;
  const app = createMerchant({ origin, apiOrigin: 'https://api.test', webOrigin: 'https://awoof.test', privateKey: 'awoof_test', productId: 'product', vendorId: 'vendor', amountKobo: 80000, paymentGateway: 'other', dbPath: ':memory:', fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith('/claim-sessions')) { checkoutId = body.merchantCheckoutId; return Response.json({ success: true, data: { claimSessionId: 'session' } }); }
    if (url.endsWith('/exchange')) {
      exchanges++;
      if (exchanges === 1) return Response.json({ success: false, error: 'quota' }, { status: 429 });
      return Response.json({ success: true, data: { eligible: true, assuranceMethod: 'enrollment', campaignId: checkoutId, benefitAuthorizationId: 'benefit', validUntil: new Date(Date.now() + 600000).toISOString() } });
    }
    return Response.json({ success: true, data: { transactionId: 'same' } });
  } });
  await new Promise(r => app.server.listen(p, '127.0.0.1', r)); const request = (path, init = {}) => fetch(`http://127.0.0.1:${p}${path}`, { redirect: 'manual', ...init });
  try {
    const start = await request('/checkout', { method: 'POST', headers: { Origin: origin } }); const cookie = start.headers.get('set-cookie').split(';')[0];
    const callback = code => request('/awoof/student-claim?assertion=' + code, { headers: { Cookie: cookie } });
    assert.equal((await callback('d'.repeat(43))).status, 429);
    assert.ok(app.store.get(checkoutId).codeHash, '429 keeps the pending binding');
    assert.equal((await callback('e'.repeat(43))).status, 409);
    assert.equal((await callback('d'.repeat(43))).status, 303);
    assert.ok(app.store.get(checkoutId).receipt);
    assert.equal(exchanges, 2);
  } finally { await new Promise(r => app.server.close(r)); app.store.close(); }
});
test('real-mode entrypoint refuses fixture product, vendor and price defaults', () => {
  const serverPath = new URL('../server.js', import.meta.url).pathname;
  const base = { ...process.env, MERCHANT_ORIGIN: 'https://shop.example.test', AWOOF_API_ORIGIN: 'https://api.example.test', AWOOF_WEB_ORIGIN: 'https://awoof.example.test', AWOOF_PRIVATE_KEY: 'awoof_test_only', AWOOF_PRODUCT_ID: '11111111-1111-4111-8111-111111111111', STUDENT_PRICE_KOBO: '80000' };
  delete base.AWOOF_SYNTHETIC; delete base.AWOOF_VENDOR_ID;
  const result = spawnSync(process.execPath, [serverPath], { env: base, encoding: 'utf8', timeout: 15000 });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /AWOOF_VENDOR_ID/);
});
test('authentication failure keeps the callback binding and purpose mismatch never authorizes', async () => {
  const p = await port(); const origin = `https://127.0.0.1:${p}`; const reportSecret = 's'.repeat(40); let checkoutId; let exchanges = 0; let reports = 0;
  const app = createMerchant({ origin, apiOrigin: 'https://api.test', webOrigin: 'https://awoof.test', privateKey: 'awoof_test', productId: 'product', vendorId: 'vendor', amountKobo: 80000, expectedPurpose: '10% student discount', paymentGateway: 'other', reportSecret, dbPath: ':memory:', fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith('/claim-sessions')) { checkoutId = body.merchantCheckoutId; return Response.json({ success: true, data: { claimSessionId: 'session' } }); }
    if (url.endsWith('/exchange')) {
      exchanges++;
      if (exchanges === 1) return Response.json({ success: false, error: 'key' }, { status: 401 });
      const purpose = exchanges === 2 ? 'Different consent wording' : '10% student discount';
      return Response.json({ success: true, data: { eligible: true, assuranceMethod: 'enrollment', campaignId: checkoutId, purpose, benefitAuthorizationId: 'benefit', validUntil: new Date(Date.now() + 600000).toISOString() } });
    }
    reports++; return Response.json({ success: true, data: { transactionId: 'same' } });
  } });
  await new Promise(r => app.server.listen(p, '127.0.0.1', r)); const request = (path, init = {}) => fetch(`http://127.0.0.1:${p}${path}`, { redirect: 'manual', ...init });
  try {
    const start = await request('/checkout', { method: 'POST', headers: { Origin: origin } }); const cookie = start.headers.get('set-cookie').split(';')[0];
    const callback = code => request('/awoof/student-claim?assertion=' + code, { headers: { Cookie: cookie } });
    // 401 fails before the assertion is consumed: binding survives for exact retry.
    assert.equal((await callback('f'.repeat(43))).status, 401);
    assert.ok(app.store.get(checkoutId).codeHash, '401 keeps the pending binding');
    assert.equal((await callback('a'.repeat(43))).status, 409);
    // Exact retry reaches exchange, but a different consent purpose never
    // authorizes and never frees the checkout for a replacement assertion:
    // the spent checkout stays bound (fail closed) with no receipt stored.
    assert.equal((await callback('f'.repeat(43))).status, 403);
    assert.equal(app.store.get(checkoutId).receipt, undefined);
    assert.equal((await callback('b'.repeat(43))).status, 409);
    assert.equal(app.store.get(checkoutId).receipt, undefined);
    assert.equal(reports, 0);
    assert.equal(exchanges, 2);
  } finally { await new Promise(r => app.server.close(r)); app.store.close(); }
});
