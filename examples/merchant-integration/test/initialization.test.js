import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createMerchant } from '../server.js';
async function freePort() { const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise(r => server.close(r)); return port; }
test('independent merchant initialization and cookie-bound return verify test domain and exact binding', async () => {
  const port = await freePort(); const origin = `https://127.0.0.1:${port}`; let checkoutId; let reference; let initializes = 0; let reports = 0; let domain = 'live';
  const metadata = { awoofVendorId: 'vendor', awoofProductId: 'product', awoofBenefitAuthorizationId: 'benefit' };
  const app = createMerchant({ origin, apiOrigin: 'https://api.test', webOrigin: 'https://awoof.test', privateKey: 'awoof_test', productId: 'product', vendorId: 'vendor', amountKobo: 80000, paymentGateway: 'paystack_merchant', paystackSecret: 'sk_test_fixture', dbPath: ':memory:', fetchImpl: async (url, init) => {
    if (url.endsWith('/transaction/initialize')) {
      initializes++; const body = JSON.parse(init.body); reference = body.reference;
      assert.match(reference, /^awoof-[a-f0-9-]+$/); assert.equal(body.email, 'checkout@example.test'); assert.equal(body.amount, '80000'); assert.equal(body.currency, 'NGN'); assert.equal(body.callback_url, `${origin}/payments/paystack-return`); assert.deepEqual(JSON.parse(body.metadata), metadata);
      assert.equal(init.headers.Authorization, 'Bearer sk_test_fixture');
      return Response.json({ status: true, data: { authorization_url: 'https://checkout.paystack.com/test-payment', reference } });
    }
    if (url.includes('/transaction/verify/')) return Response.json({ status: true, data: { status: 'success', domain, reference, currency: 'NGN', amount: 80000, metadata } });
    const body = JSON.parse(init.body);
    if (url.endsWith('/claim-sessions')) { checkoutId = body.merchantCheckoutId; assert.equal(body.email, undefined); return Response.json({ success: true, data: { claimSessionId: 'session' } }); }
    if (url.endsWith('/exchange')) return Response.json({ success: true, data: { eligible: true, assuranceMethod: 'enrollment', campaignId: checkoutId, benefitAuthorizationId: 'benefit', validUntil: new Date(Date.now() + 600000).toISOString() } });
    reports++; assert.equal(body.email, undefined); assert.equal(body.paymentReference, reference); return Response.json({ success: true, data: { transactionId: 'transaction' } });
  } });
  await new Promise(r => app.server.listen(port, '127.0.0.1', r));
  const request = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', ...init });
  try {
    const start = await request('/checkout', { method: 'POST', headers: { Origin: origin } }); const cookie = start.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/payments/paystack-initialize', { method: 'POST', headers: { Origin: origin, Cookie: cookie }, body: 'email=checkout%40example.test' })).status, 409);
    await request('/awoof/student-claim?assertion=' + 'a'.repeat(43), { headers: { Cookie: cookie } });
    const initialize = await request('/payments/paystack-initialize', { method: 'POST', headers: { Origin: origin, Cookie: cookie }, body: 'email=checkout%40example.test' });
    assert.equal(initialize.status, 303); assert.equal(initialize.headers.get('location'), 'https://checkout.paystack.com/test-payment');
    const retry = await request('/payments/paystack-initialize', { method: 'POST', headers: { Origin: origin, Cookie: cookie } }); assert.equal(retry.status, 303); assert.equal(initializes, 1);
    assert.equal(JSON.stringify(app.store.get(checkoutId)).includes('checkout@example.test'), false);
    assert.equal((await request(`/payments/paystack-return?reference=${reference}`)).status, 403);
    assert.equal((await request('/payments/paystack-return?reference=another', { headers: { Cookie: cookie } })).status, 400);
    assert.equal((await request(`/payments/paystack-return?reference=${reference}`, { headers: { Cookie: cookie } })).status, 400); assert.equal(reports, 0);
    domain = 'test';
    assert.equal((await request(`/payments/paystack-return?reference=${reference}&trxref=${reference}`, { headers: { Cookie: cookie } })).status, 303); assert.equal(reports, 1);
    await request(`/payments/paystack-return?reference=${reference}`, { headers: { Cookie: cookie } }); assert.equal(reports, 1);
    assert.equal(app.store.get(checkoutId).state, 'reported');
  } finally { await new Promise(r => app.server.close(r)); app.store.close(); }
});
test('evidence expiry does not extend the product authorization payment deadline', async () => {
  const port = await freePort(); const origin = `https://127.0.0.1:${port}`; let checkoutId; let providerCalls = 0;
  const app = createMerchant({ origin, apiOrigin: 'https://api.test', webOrigin: 'https://awoof.test', privateKey: 'awoof_test', productId: 'product', vendorId: 'vendor', amountKobo: 80000, paymentGateway: 'paystack_merchant', paystackSecret: 'sk_test_fixture', dbPath: ':memory:', fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith('/claim-sessions')) { checkoutId = body.merchantCheckoutId; return Response.json({ success: true, data: { claimSessionId: 'session' } }); }
    if (url.endsWith('/exchange')) return Response.json({ success: true, data: { eligible: true, assuranceMethod: 'enrollment', campaignId: checkoutId, benefitAuthorizationId: 'benefit', validUntil: new Date(Date.now() + 3600000).toISOString(), benefitValidUntil: new Date(Date.now() - 1).toISOString() } });
    providerCalls++; throw new Error('Must not initialize an expired benefit');
  } });
  await new Promise(r => app.server.listen(port, '127.0.0.1', r)); const request = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', ...init });
  try {
    const start = await request('/checkout', { method: 'POST', headers: { Origin: origin } }); const cookie = start.headers.get('set-cookie').split(';')[0];
    await request('/awoof/student-claim?assertion=' + 'a'.repeat(43), { headers: { Cookie: cookie } });
    assert.equal((await request('/payments/paystack-initialize', { method: 'POST', headers: { Origin: origin, Cookie: cookie }, body: 'email=checkout%40example.test' })).status, 409); assert.equal(providerCalls, 0);
  } finally { await new Promise(r => app.server.close(r)); app.store.close(); }
});
test('ambiguous exchange preserves original retry binding while a changed code fails', async () => {
  const port = await freePort(); const origin = `https://127.0.0.1:${port}`; let checkoutId; let exchanges = 0; let key;
  const app = createMerchant({ origin, apiOrigin: 'https://api.test', webOrigin: 'https://awoof.test', privateKey: 'awoof_test', productId: 'product', vendorId: 'vendor', amountKobo: 80000, dbPath: ':memory:', fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith('/claim-sessions')) { checkoutId = body.merchantCheckoutId; return Response.json({ success: true, data: { claimSessionId: 'session' } }); }
    exchanges++; key ??= body.idempotencyKey; assert.equal(body.idempotencyKey, key);
    if (exchanges === 1) throw new Error('Ambiguous connection loss');
    return Response.json({ success: true, data: { eligible: true, assuranceMethod: 'enrollment', campaignId: checkoutId, benefitAuthorizationId: 'benefit', validUntil: new Date(Date.now() + 600000).toISOString() } });
  } });
  await new Promise(r => app.server.listen(port, '127.0.0.1', r)); const request = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', ...init });
  try {
    const start = await request('/checkout', { method: 'POST', headers: { Origin: origin } }); const cookie = start.headers.get('set-cookie').split(';')[0]; const original = '/awoof/student-claim?assertion=' + 'a'.repeat(43);
    assert.equal((await request(original, { headers: { Cookie: cookie } })).status, 502);
    assert.equal((await request('/awoof/student-claim?assertion=' + 'b'.repeat(43), { headers: { Cookie: cookie } })).status, 409); assert.equal(exchanges, 1);
    assert.equal((await request(original, { headers: { Cookie: cookie } })).status, 303); assert.equal(exchanges, 2);
  } finally { await new Promise(r => app.server.close(r)); app.store.close(); }
});
test('live merchant keys cannot enable this test-only reference', () => {
  assert.throws(() => createMerchant({ origin: 'https://merchant.test', apiOrigin: 'https://api.test', webOrigin: 'https://awoof.test', privateKey: 'awoof_test', productId: 'product', vendorId: 'vendor', amountKobo: 1, paystackSecret: 'sk_live_not_allowed', dbPath: ':memory:' }), /test secrets/);
});
test('ambiguous initialization timeout abandons the taken reference for a fresh one', async () => {
  const port = await freePort(); const origin = `https://127.0.0.1:${port}`; let checkoutId; const references = []; let verifies = 0; let lost = true;
  const app = createMerchant({ origin, apiOrigin: 'https://api.test', webOrigin: 'https://awoof.test', privateKey: 'awoof_test', productId: 'product', vendorId: 'vendor', amountKobo: 80000, paymentGateway: 'paystack_merchant', paystackSecret: 'sk_test_fixture', dbPath: ':memory:', fetchImpl: async (url, init) => {
    if (url.endsWith('/transaction/initialize')) { const reference = JSON.parse(init.body).reference; references.push(reference); if (lost) { lost = false; throw new Error('Ambiguous connection loss'); } return Response.json({ status: true, data: { authorization_url: 'https://checkout.paystack.com/fresh-payment', reference } }); }
    if (url.includes('/transaction/verify/')) { verifies++; assert.equal(url, `https://api.paystack.co/transaction/verify/${references[0]}`); return Response.json({ status: true, data: { reference: references[0], status: 'abandoned' } }); }
    const body = JSON.parse(init.body);
    if (url.endsWith('/claim-sessions')) { checkoutId = body.merchantCheckoutId; return Response.json({ success: true, data: { claimSessionId: 'session' } }); }
    if (url.endsWith('/exchange')) return Response.json({ success: true, data: { eligible: true, assuranceMethod: 'enrollment', campaignId: checkoutId, benefitAuthorizationId: 'benefit', validUntil: new Date(Date.now() + 600000).toISOString() } });
    throw new Error(`unexpected backend call ${url}`);
  } });
  await new Promise(r => app.server.listen(port, '127.0.0.1', r));
  const request = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', ...init });
  try {
    const start = await request('/checkout', { method: 'POST', headers: { Origin: origin } }); const cookie = start.headers.get('set-cookie').split(';')[0];
    await request('/awoof/student-claim?assertion=' + 'a'.repeat(43), { headers: { Cookie: cookie } });
    const headers = { Origin: origin, Cookie: cookie }; const form = 'email=checkout%40example.test';
    assert.equal((await request('/payments/paystack-initialize', { method: 'POST', headers, body: form })).status, 502);
    assert.equal(app.store.get(checkoutId).state, 'payment_initialization_unknown');
    const retry = await request('/payments/paystack-initialize', { method: 'POST', headers, body: form });
    assert.equal(retry.status, 303); assert.equal(retry.headers.get('location'), 'https://checkout.paystack.com/fresh-payment');
    assert.equal(references.length, 2); assert.notEqual(references[0], references[1]); assert.equal(verifies, 1);
    assert.equal(app.store.get(checkoutId).state, 'payment_initialized');
  } finally { await new Promise(r => app.server.close(r)); app.store.close(); }
});
test('duplicate initialization rejection renews the reference instead of reposting', async () => {
  const port = await freePort(); const origin = `https://127.0.0.1:${port}`; let checkoutId; const references = []; let verifies = 0; let duplicate = true;
  const app = createMerchant({ origin, apiOrigin: 'https://api.test', webOrigin: 'https://awoof.test', privateKey: 'awoof_test', productId: 'product', vendorId: 'vendor', amountKobo: 80000, paymentGateway: 'paystack_merchant', paystackSecret: 'sk_test_fixture', dbPath: ':memory:', fetchImpl: async (url, init) => {
    if (url.endsWith('/transaction/initialize')) { const reference = JSON.parse(init.body).reference; references.push(reference); if (duplicate) { duplicate = false; return Response.json({ status: false, message: 'Duplicate Transaction Reference' }, { status: 400 }); } return Response.json({ status: true, data: { authorization_url: 'https://checkout.paystack.com/renewed-payment', reference } }); }
    if (url.includes('/transaction/verify/')) { verifies++; return Response.json({ status: true, data: { reference: references[0], status: 'abandoned' } }); }
    const body = JSON.parse(init.body);
    if (url.endsWith('/claim-sessions')) { checkoutId = body.merchantCheckoutId; return Response.json({ success: true, data: { claimSessionId: 'session' } }); }
    if (url.endsWith('/exchange')) return Response.json({ success: true, data: { eligible: true, assuranceMethod: 'enrollment', campaignId: checkoutId, benefitAuthorizationId: 'benefit', validUntil: new Date(Date.now() + 600000).toISOString() } });
    throw new Error(`unexpected backend call ${url}`);
  } });
  await new Promise(r => app.server.listen(port, '127.0.0.1', r));
  const request = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', ...init });
  try {
    const start = await request('/checkout', { method: 'POST', headers: { Origin: origin } }); const cookie = start.headers.get('set-cookie').split(';')[0];
    await request('/awoof/student-claim?assertion=' + 'a'.repeat(43), { headers: { Cookie: cookie } });
    const headers = { Origin: origin, Cookie: cookie }; const form = 'email=checkout%40example.test';
    assert.equal((await request('/payments/paystack-initialize', { method: 'POST', headers, body: form })).status, 502);
    assert.equal(app.store.get(checkoutId).state, 'payment_initialization_unknown');
    const retry = await request('/payments/paystack-initialize', { method: 'POST', headers, body: form });
    assert.equal(retry.status, 303); assert.equal(retry.headers.get('location'), 'https://checkout.paystack.com/renewed-payment');
    assert.equal(references.length, 2); assert.notEqual(references[0], references[1]); assert.equal(verifies, 1);
  } finally { await new Promise(r => app.server.close(r)); app.store.close(); }
});
test('definitive initialization rejection releases inputs so the email can be corrected', async () => {
  const port = await freePort(); const origin = `https://127.0.0.1:${port}`; let checkoutId; const emails = [];
  const app = createMerchant({ origin, apiOrigin: 'https://api.test', webOrigin: 'https://awoof.test', privateKey: 'awoof_test', productId: 'product', vendorId: 'vendor', amountKobo: 80000, paymentGateway: 'paystack_merchant', paystackSecret: 'sk_test_fixture', dbPath: ':memory:', fetchImpl: async (url, init) => {
    if (url.endsWith('/transaction/initialize')) { const body = JSON.parse(init.body); emails.push(body.email); if (body.email === 'rejected@example.test') return Response.json({ status: false, message: 'Invalid email address' }, { status: 400 }); return Response.json({ status: true, data: { authorization_url: 'https://checkout.paystack.com/corrected-payment', reference: body.reference } }); }
    if (url.includes('/transaction/verify/')) throw new Error('definitive rejection must not reconcile');
    const body = JSON.parse(init.body);
    if (url.endsWith('/claim-sessions')) { checkoutId = body.merchantCheckoutId; return Response.json({ success: true, data: { claimSessionId: 'session' } }); }
    if (url.endsWith('/exchange')) return Response.json({ success: true, data: { eligible: true, assuranceMethod: 'enrollment', campaignId: checkoutId, benefitAuthorizationId: 'benefit', validUntil: new Date(Date.now() + 600000).toISOString() } });
    throw new Error(`unexpected backend call ${url}`);
  } });
  await new Promise(r => app.server.listen(port, '127.0.0.1', r));
  const request = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', ...init });
  try {
    const start = await request('/checkout', { method: 'POST', headers: { Origin: origin } }); const cookie = start.headers.get('set-cookie').split(';')[0];
    await request('/awoof/student-claim?assertion=' + 'a'.repeat(43), { headers: { Cookie: cookie } });
    const headers = { Origin: origin, Cookie: cookie };
    assert.equal((await request('/payments/paystack-initialize', { method: 'POST', headers, body: 'email=rejected%40example.test' })).status, 400);
    assert.equal(app.store.get(checkoutId).state, 'authorized');
    const retry = await request('/payments/paystack-initialize', { method: 'POST', headers, body: 'email=corrected%40example.test' });
    assert.equal(retry.status, 303); assert.equal(retry.headers.get('location'), 'https://checkout.paystack.com/corrected-payment');
    assert.deepEqual(emails, ['rejected@example.test', 'corrected@example.test']);
  } finally { await new Promise(r => app.server.close(r)); app.store.close(); }
});
test('references unknown upstream initialize with the held reference after reconcile', async () => {
  const port = await freePort(); const origin = `https://127.0.0.1:${port}`; let checkoutId; const references = []; let verifies = 0; let lost = true;
  const app = createMerchant({ origin, apiOrigin: 'https://api.test', webOrigin: 'https://awoof.test', privateKey: 'awoof_test', productId: 'product', vendorId: 'vendor', amountKobo: 80000, paymentGateway: 'paystack_merchant', paystackSecret: 'sk_test_fixture', dbPath: ':memory:', fetchImpl: async (url, init) => {
    if (url.endsWith('/transaction/initialize')) { const reference = JSON.parse(init.body).reference; references.push(reference); if (lost) { lost = false; throw new Error('Ambiguous connection loss'); } return Response.json({ status: true, data: { authorization_url: 'https://checkout.paystack.com/fresh-payment', reference } }); }
    if (url.includes('/transaction/verify/')) { verifies++; return Response.json({ status: false, message: 'Transaction reference not found' }, { status: 404 }); }
    const body = JSON.parse(init.body);
    if (url.endsWith('/claim-sessions')) { checkoutId = body.merchantCheckoutId; return Response.json({ success: true, data: { claimSessionId: 'session' } }); }
    if (url.endsWith('/exchange')) return Response.json({ success: true, data: { eligible: true, assuranceMethod: 'enrollment', campaignId: checkoutId, benefitAuthorizationId: 'benefit', validUntil: new Date(Date.now() + 600000).toISOString() } });
    throw new Error(`unexpected backend call ${url}`);
  } });
  await new Promise(r => app.server.listen(port, '127.0.0.1', r));
  const request = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', ...init });
  try {
    const start = await request('/checkout', { method: 'POST', headers: { Origin: origin } }); const cookie = start.headers.get('set-cookie').split(';')[0];
    await request('/awoof/student-claim?assertion=' + 'a'.repeat(43), { headers: { Cookie: cookie } });
    const headers = { Origin: origin, Cookie: cookie }; const form = 'email=checkout%40example.test';
    assert.equal((await request('/payments/paystack-initialize', { method: 'POST', headers, body: form })).status, 502);
    const retry = await request('/payments/paystack-initialize', { method: 'POST', headers, body: form });
    assert.equal(retry.status, 303); assert.equal(retry.headers.get('location'), 'https://checkout.paystack.com/fresh-payment');
    assert.deepEqual(references, [references[0], references[0]]);
    assert.equal(verifies, 1); assert.equal(app.store.get(checkoutId).state, 'payment_initialized');
  } finally { await new Promise(r => app.server.close(r)); app.store.close(); }
});
test('revoked merchant credentials hold the reference with a retryable configuration error', async () => {
  const port = await freePort(); const origin = `https://127.0.0.1:${port}`; let checkoutId; const references = []; let verifies = 0; let credentialsFixed = false;
  const app = createMerchant({ origin, apiOrigin: 'https://api.test', webOrigin: 'https://awoof.test', privateKey: 'awoof_test', productId: 'product', vendorId: 'vendor', amountKobo: 80000, paymentGateway: 'paystack_merchant', paystackSecret: 'sk_test_fixture', dbPath: ':memory:', fetchImpl: async (url, init) => {
    if (url.endsWith('/transaction/initialize')) { const reference = JSON.parse(init.body).reference; references.push(reference); if (!credentialsFixed) return Response.json({ status: false, message: 'Invalid key' }, { status: 401 }); return Response.json({ status: true, data: { authorization_url: 'https://checkout.paystack.com/recovered-payment', reference } }); }
    if (url.includes('/transaction/verify/')) { verifies++; return Response.json({ status: false, message: 'Transaction reference not found' }, { status: 404 }); }
    const body = JSON.parse(init.body);
    if (url.endsWith('/claim-sessions')) { checkoutId = body.merchantCheckoutId; return Response.json({ success: true, data: { claimSessionId: 'session' } }); }
    if (url.endsWith('/exchange')) return Response.json({ success: true, data: { eligible: true, assuranceMethod: 'enrollment', campaignId: checkoutId, benefitAuthorizationId: 'benefit', validUntil: new Date(Date.now() + 600000).toISOString() } });
    throw new Error(`unexpected backend call ${url}`);
  } });
  await new Promise(r => app.server.listen(port, '127.0.0.1', r));
  const request = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', ...init });
  try {
    const start = await request('/checkout', { method: 'POST', headers: { Origin: origin } }); const cookie = start.headers.get('set-cookie').split(';')[0];
    await request('/awoof/student-claim?assertion=' + 'a'.repeat(43), { headers: { Cookie: cookie } });
    const headers = { Origin: origin, Cookie: cookie }; const form = 'email=checkout%40example.test';
    const rejected = await request('/payments/paystack-initialize', { method: 'POST', headers, body: form });
    assert.equal(rejected.status, 503);
    assert.match(await rejected.text(), /credentials rejected/);
    assert.equal(app.store.get(checkoutId).state, 'payment_initialization_unknown');
    assert.ok(app.store.get(checkoutId).initializedReference);
    assert.equal((await request('/payments/paystack-initialize', { method: 'POST', headers, body: 'email=other%40example.test' })).status, 409);
    credentialsFixed = true;
    const retry = await request('/payments/paystack-initialize', { method: 'POST', headers, body: form });
    assert.equal(retry.status, 303); assert.equal(retry.headers.get('location'), 'https://checkout.paystack.com/recovered-payment');
    assert.deepEqual(references, [references[0], references[0]]);
    assert.equal(verifies, 1); assert.equal(app.store.get(checkoutId).state, 'payment_initialized');
  } finally { await new Promise(r => app.server.close(r)); app.store.close(); }
});
test('trailing-slash merchant origin is normalized for Origin and Host checks', async () => {
  const port = await freePort(); const canonical = `https://127.0.0.1:${port}`;
  const app = createMerchant({ origin: `${canonical}/`, apiOrigin: 'https://api.test', webOrigin: 'https://awoof.test', privateKey: 'awoof_test', productId: 'product', vendorId: 'vendor', amountKobo: 80000, synthetic: true, dbPath: ':memory:', fetchImpl: async () => Response.json({ success: true, data: { claimSessionId: 'session' } }) });
  await new Promise(r => app.server.listen(port, '127.0.0.1', r));
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/checkout`, { method: 'POST', redirect: 'manual', headers: { Origin: canonical } })).status, 303);
  } finally { await new Promise(r => app.server.close(r)); app.store.close(); }
});
