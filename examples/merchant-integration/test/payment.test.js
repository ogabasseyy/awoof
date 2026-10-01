import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
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
    assert.equal(events[0].status, 200); assert.equal(events[1].status, 409); assert.equal(app.store.get(checkoutId).state, 'reconciliation_required'); assert.equal(reports, 1);
    await request('/reconcile', { method: 'POST', headers: { Cookie: cookie, Origin: origin } });
    assert.equal(app.store.get(checkoutId).state, 'reported'); assert.equal(reports, 2);
    const duplicateEvents = await Promise.all([webhook(signature), webhook(signature)]);
    assert.deepEqual(duplicateEvents.map(response => response.status), [200, 200]); assert.equal(reports, 2);
    const reversalBody = JSON.stringify({ event: 'refund.processed', data: {} }); const reversalSig = createHmac('sha512', secret).update(reversalBody).digest('hex');
    assert.equal((await request('/webhooks/paystack', { method: 'POST', headers: { 'x-paystack-signature': reversalSig }, body: reversalBody })).status, 202); assert.equal(reports, 2);
    assert.equal(app.store.find(row => row.kind === 'provider_review').state, 'reconciliation_required');
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
    const body = JSON.stringify({ merchantCheckoutId: checkoutId, paymentReference: 'reference' });
    assert.equal((await request('/payments/report', { method: 'POST', body })).status, 401); assert.equal(reports, 0);
    const headers = { Authorization: `Bearer ${reportSecret}` };
    const simultaneous = await Promise.all([request('/payments/report', { method: 'POST', headers, body }), request('/payments/report', { method: 'POST', headers, body: JSON.stringify({ merchantCheckoutId: checkoutId, paymentReference: 'conflicting' }) })]);
    assert.equal(simultaneous[0].status, 200); assert.equal(simultaneous[1].status, 409); assert.equal(reports, 1);
    await request('/payments/report', { method: 'POST', headers, body }); assert.equal(reports, 1);
    assert.equal((await request('/payments/report', { method: 'POST', headers, body: JSON.stringify({ merchantCheckoutId: checkoutId, paymentReference: 'different' }) })).status, 409);
  } finally { await new Promise(r => app.server.close(r)); app.store.close(); }
});
