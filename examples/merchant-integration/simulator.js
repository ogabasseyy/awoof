// Disposable synthetic behavior only. This is not a student verification service.
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { nonceHash } from '../../packages/partner-sdk/index.js';
import { Store } from './store.js';
import { rawBody, json, redirect, html, escape } from './http.js';
const PRODUCT = '11111111-1111-4111-8111-111111111111';
export function createSimulator({ origin = 'http://localhost:4200', merchantOrigin = 'http://127.0.0.1:4100', dbPath = './.local/simulator.sqlite' } = {}) {
  for (const value of [origin, merchantOrigin]) { const url = new URL(value); if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/') throw new Error('Simulator requires bare loopback HTTP origins'); }
  const store = new Store(dbPath);
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(origin).host) { json(res, 400, { error: 'Loopback Host required' }); return; }
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === `/marketplace/${PRODUCT}`) {
        const id = url.searchParams.get('claimSession'); const session = store.get(id);
        if (!session) { json(res, 404, { error: 'Unknown synthetic claim session' }); return; }
        html(res, `<h1>Synthetic Awoof simulator</h1><p>No authentication, consent or enrollment authority is exercised. Never use this as real verification or deploy it.</p><p>Disposable student price: 80000 NGN kobo.</p><form method="post" action="/synthetic/claim"><input type="hidden" name="session" value="${escape(id)}"><label>Simulated outcome <select name="scenario"><option>eligible</option><option>ineligible</option><option>expired</option></select></label><button>Simulate claim</button></form>`); return;
      }
      if (req.method === 'POST' && url.pathname === '/synthetic/claim') {
        if (req.headers.origin !== origin) { json(res, 403, { error: 'Synthetic Origin required' }); return; }
        const form = new URLSearchParams((await rawBody(req)).toString()); const session = store.get(form.get('session'));
        if (!session) { json(res, 404, { error: 'Unknown synthetic session' }); return; }
        if (form.get('scenario') !== 'eligible') { json(res, form.get('scenario') === 'expired' ? 409 : 403, { error: `Synthetic ${form.get('scenario')} rejection; no claim or value issued` }); return; }
        if (session.expiresAt < Date.now() || session.receipt) { json(res, 409, { error: 'Synthetic session expired or consumed' }); return; }
        session.code = randomBytes(32).toString('base64url'); store.put(session.id, session);
        redirect(res, `${merchantOrigin}/awoof/student-claim?assertion=${session.code}`); return;
      }
      if (req.method !== 'POST' || req.headers.authorization !== 'Bearer awoof_synthetic_local_only') { json(res, 401, { success: false, error: 'Synthetic-only key required' }); return; }
      const body = JSON.parse((await rawBody(req)).toString());
      if (url.pathname === '/api/merchant-verification/claim-sessions') {
        if (body.productId !== PRODUCT || body.origin !== merchantOrigin || !/^[a-f0-9]{64}$/.test(body.browserNonceHash) || !body.merchantCheckoutId) { json(res, 400, { success: false }); return; }
        const previous = store.find(row => row.checkout === body.merchantCheckoutId);
        if (previous) {
          if (previous.nonceHash !== body.browserNonceHash || previous.receipt || previous.expiresAt < Date.now()) { json(res, 409, { success: false }); return; }
          json(res, 200, { success: true, data: { claimSessionId: previous.id, expiresAt: new Date(previous.expiresAt).toISOString() } }); return;
        }
        const session = { id: randomUUID(), checkout: body.merchantCheckoutId, productId: PRODUCT, nonceHash: body.browserNonceHash, expiresAt: Date.now() + 600000 };
        store.put(session.id, session); json(res, 201, { success: true, data: { claimSessionId: session.id, expiresAt: new Date(session.expiresAt).toISOString() } }); return;
      }
      if (url.pathname === '/api/merchant-verification/exchange') {
        const session = store.find(row => row.code === body.code);
        if (!session || session.checkout !== body.merchantCheckoutId || body.campaignId !== session.checkout || nonceHash(body.browserNonce) !== session.nonceHash || !body.idempotencyKey) { json(res, 400, { success: false, error: 'Synthetic claim binding mismatch' }); return; }
        if (session.receipt && session.exchangeKey !== body.idempotencyKey) { json(res, 409, { success: false }); return; }
        if (!session.receipt && session.expiresAt < Date.now()) { json(res, 409, { success: false }); return; }
        session.exchangeKey = body.idempotencyKey;
        session.receipt ??= { receiptId: randomUUID(), merchantSubject: randomUUID(), eligible: true, assuranceMethod: 'enrollment', institutionId: randomUUID(), verifiedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 600000).toISOString(), campaignId: session.checkout, benefitAuthorizationId: randomUUID(), benefitValidUntil: new Date(Date.now() + 120000).toISOString() };
        store.put(session.id, session); json(res, 200, { success: true, data: session.receipt }); return;
      }
      if (url.pathname === '/api/vendors/transactions/report') {
        const session = store.find(row => row.receipt?.benefitAuthorizationId === body.benefitAuthorizationId);
        if (!session || body.productId !== PRODUCT || body.amount !== 80000 || body.paymentGateway !== 'other' || !body.paymentReference?.startsWith('synthetic_')) { json(res, 400, { success: false, error: 'Synthetic report binding mismatch' }); return; }
        if (session.report && JSON.stringify(session.report.input) !== JSON.stringify(body)) { json(res, 409, { success: false }); return; }
        if (!session.report && Date.parse(session.receipt.benefitValidUntil) <= Date.now()) { json(res, 409, { success: false, reconciliation: 'Synthetic first report expired' }); return; }
        session.report ??= { input: body, transactionId: randomUUID(), status: 'synthetic_recorded' }; store.put(session.id, session);
        json(res, 200, { success: true, data: { transactionId: session.report.transactionId, status: 'synthetic_recorded' } }); return;
      }
      json(res, 404, { success: false });
    } catch { json(res, 400, { success: false, error: 'Invalid synthetic input' }); }
  });
  return { server, store };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.AWOOF_SYNTHETIC !== '1') throw new Error('Set AWOOF_SYNTHETIC=1 to acknowledge disposable simulation');
  const app = createSimulator(); app.server.listen(4200, '127.0.0.1', () => console.log('SYNTHETIC ONLY simulator on http://localhost:4200; no real enrollment or money'));
}
