import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { AwoofPartnerClient, merchantPaystackMetadata, nonceHash, trustedBase, verifyPaystackWebhook } from '../../packages/partner-sdk/index.js';
import { Store } from './store.js';
import { rawBody, json, redirect, html, escape } from './http.js';

export const CALLBACK_PATH = '/awoof/student-claim';
const COOKIE = 'awoof_reference_nonce';
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
export function createMerchant({ origin, apiOrigin, webOrigin, privateKey, productId, vendorId, amountKobo, synthetic = false, paymentGateway = 'other', paystackSecret, reportSecret, dbPath = './.local/merchant.sqlite', fetchImpl = fetch }) {
  origin = trustedBase(origin, synthetic);
  if (!Number.isSafeInteger(amountKobo) || amountKobo < 1) throw new Error('Configure the agreed student price in integer NGN kobo');
  if (!['paystack', 'paystack_merchant', 'other'].includes(paymentGateway)) throw new Error('Unsupported payment gateway');
  if (synthetic && paymentGateway !== 'other') throw new Error('Synthetic payments use the merchant-attested other label only');
  if (paystackSecret && !paystackSecret.startsWith('sk_test_')) throw new Error('Only merchant Paystack test secrets are accepted by this reference');
  if (reportSecret && reportSecret.length < 32) throw new Error('Use at least 32 random characters for the server-to-server report secret');
  const client = new AwoofPartnerClient({ apiOrigin, webOrigin, privateKey, fetch: fetchImpl, allowLoopbackHttp: synthetic });
  const store = new Store(dbPath); const active = new Map();
  // Serialize each operation and re-evaluate its own payload against fresh state.
  // Sharing a previous operation's promise would hide conflicting callbacks/events.
  async function once(id, work) { const previous = active.get(id); const promise = Promise.resolve(previous).catch(() => {}).then(work); active.set(id, promise); try { return await promise; } finally { if (active.get(id) === promise) active.delete(id); } }
  function benefitDeadline(row) {
    if (row.receipt?.benefitValidUntil !== undefined) return Date.parse(row.receipt.benefitValidUntil);
    // Older backend receipts omit the benefit TTL. Never substitute evidence TTL.
    return Date.parse(row.exchangeStartedAt ?? '') + 120000;
  }
  function checkout(req) {
    const nonce = (req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!nonce || !/^[a-f0-9]{64}$/.test(nonce)) throw fail('Checkout nonce cookie required', 403);
    const row = store.find(row => row.nonceHash === nonceHash(nonce));
    if (!row) throw fail('Checkout not found', 403); return { row, nonce };
  }
  function requireOrigin(req) { if (req.headers.origin !== origin) throw fail('Expected merchant Origin', 403); }
  async function report(row) {
    if (row.state === 'reported') return row;
    if (!row.paymentReference || !row.receipt?.benefitAuthorizationId) throw fail('Confirmed payment and product authorization required');
    try {
      row.report = await client.reportTransaction({ benefitAuthorizationId: row.receipt.benefitAuthorizationId, paymentReference: row.paymentReference, amount: row.amountKobo, productId: row.productId, paymentGateway: row.paymentGateway });
      row.state = 'reported'; delete row.reconciliation;
    } catch (error) { row.state = 'reconciliation_required'; row.reconciliation = { reason: 'Awoof report not confirmed', httpStatus: error.status ?? null }; }
    store.put(row.id, row); return row;
  }
  async function verifiedPaystack(reference, row) {
    if (!paystackSecret) throw fail('Merchant Paystack verification is unconfigured', 503);
    const response = await fetchImpl(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${paystackSecret}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    const body = await response.json(); const payment = body.data;
    const expected = merchantPaystackMetadata({ vendorId, productId: row.productId, benefitAuthorizationId: row.receipt.benefitAuthorizationId });
    if (!response.ok || body.status !== true || payment?.status !== 'success' || payment.reference !== reference || payment.amount !== row.amountKobo || payment.currency !== 'NGN' || payment.domain !== 'test' || !Object.entries(expected).every(([key, value]) => payment.metadata?.[key] === value)) throw fail('Payment verification or checkout binding mismatch', 400);
  }
  async function reconcileInitialization(current) {
    // Paystack returns the authorization URL only from initialization, never
    // from verification, so a held reference found upstream is abandoned and
    // replaced: only a reference unknown upstream is safe to initialize.
    let response; let body;
    try {
      response = await fetchImpl(`https://api.paystack.co/transaction/verify/${encodeURIComponent(current.initializedReference)}`, { headers: { Authorization: `Bearer ${paystackSecret}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      body = await response.json();
    } catch (error) {
      throw fail('Test payment initialization outcome still unknown; retry later', 502);
    }
    if (response.status === 404 || (response.status === 400 && /not.?found/i.test(body?.message ?? ''))) return;
    const payment = body?.data;
    if (!response.ok || body?.status !== true || payment?.reference !== current.initializedReference) throw fail('Test payment initialization outcome still unknown; retry later', 502);
    current.initializedReference = `awoof-${randomUUID()}`;
  }
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(origin).host) throw fail('Unexpected Host', 400);
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/') {
        html(res, `<h1>Awoof merchant reference</h1><p>${synthetic ? 'Synthetic local simulator. No enrollment authority or real money.' : 'Real Awoof sandbox backend. Test payments only; no live money.'}</p><p>One item; student price ${amountKobo} NGN kobo. This price must match the Awoof product quote.</p><form method="post" action="/checkout"><button>Start student checkout</button></form><p><a href="/checkout">Resume checkout</a></p>`); return;
      }
      if (req.method === 'POST' && url.pathname === '/checkout') {
        requireOrigin(req);
        const nonce = randomBytes(32).toString('hex'); const id = randomUUID();
        const row = { id, productId, amountKobo, paymentGateway, nonceHash: nonceHash(nonce), exchangeKey: randomUUID(), state: 'creating', createdAt: new Date().toISOString() };
        store.put(id, row);
        res.setHeader('Set-Cookie', `${COOKIE}=${nonce}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600${synthetic ? '' : '; Secure'}`);
        const session = await client.createClaimSession({ productId, merchantCheckoutId: id, browserNonce: nonce, origin });
        row.session = session; row.state = 'awaiting_claim'; store.put(id, row);
        redirect(res, client.buildHostedClaimUrl(productId, session.claimSessionId)); return;
      }
      if (req.method === 'POST' && url.pathname === '/resume-claim') {
        requireOrigin(req); const { row, nonce } = checkout(req);
        await once(row.id, async () => {
          const current = store.get(row.id); if (!['creating', 'awaiting_claim'].includes(current.state) || current.codeHash) throw fail('Claim already exchanged or underway');
          current.session = await client.createClaimSession({ productId: current.productId, merchantCheckoutId: current.id, browserNonce: nonce, origin });
          current.state = 'awaiting_claim'; store.put(current.id, current);
        });
        redirect(res, client.buildHostedClaimUrl(row.productId, store.get(row.id).session.claimSessionId)); return;
      }
      if (req.method === 'GET' && url.pathname === CALLBACK_PATH) {
        const { row, nonce } = checkout(req); const code = url.searchParams.get('assertion');
        if (!code || !/^[A-Za-z0-9_-]{43}$/.test(code) || [...url.searchParams.keys()].some(key => key !== 'assertion')) throw fail('Invalid callback assertion', 400);
        await once(row.id, async () => {
          const current = store.get(row.id);
          // Store only a hash of callback code; never accept a different claim into this checkout.
          const codeHash = nonceHash(code);
          if (current.codeHash && current.codeHash !== codeHash) throw fail('Checkout already bound to another assertion');
          if (current.receipt) return;
          current.codeHash = codeHash; current.exchangeStartedAt ??= new Date().toISOString(); store.put(row.id, current);
          let receipt;
          try { receipt = await client.exchangeClaim({ code, merchantCheckoutId: row.id, browserNonce: nonce, idempotencyKey: row.exchangeKey }); }
          catch (error) {
            // A definitive rejection never reserves this checkout for a bad code.
            // A timeout/5xx is ambiguous: retain the hash and stable retry key.
            if (error.status >= 400 && error.status < 500) { delete current.codeHash; delete current.exchangeStartedAt; store.put(row.id, current); }
            throw error;
          }
          if (receipt.eligible !== true || receipt.assuranceMethod !== 'enrollment' || receipt.campaignId !== row.id || !receipt.benefitAuthorizationId || !(Date.parse(receipt.validUntil) > Date.now())) throw fail('Current product enrollment authorization required', 403);
          current.receipt = receipt; current.state = 'authorized'; store.put(row.id, current);
        });
        redirect(res, '/checkout'); return;
      }
      if (req.method === 'GET' && url.pathname === '/checkout') {
        const { row } = checkout(req);
        html(res, `<h1>Checkout ${escape(row.state)}</h1><p>${escape(row.id)}</p><p>Payment model: ${escape(row.paymentGateway)}${row.paymentGateway === 'other' ? ` (merchant-attested${synthetic ? '; synthetic in this walkthrough' : '; no external provider verification by Awoof'})` : row.paymentGateway === 'paystack_merchant' ? ' (independent merchant account)' : ' (Awoof-account collection)'}</p>${['creating', 'awaiting_claim'].includes(row.state) ? '<form method="post" action="/resume-claim"><button>Resume the same claim session</button></form>' : ''}${row.state === 'authorized' && synthetic ? '<form method="post" action="/payments/simulate"><button>Simulate payment and report</button></form>' : ''}${['authorized', 'payment_initializing'].includes(row.state) && !synthetic && row.paymentGateway === 'paystack_merchant' ? '<form method="post" action="/payments/paystack-initialize"><label>Payment email (sent only to Paystack)<input name="email" type="email" required autocomplete="email"></label><button>Start merchant Paystack test payment</button></form><p>Test keys only. No live payments. After payment, the merchant verifies the exact order before reporting.</p>' : ''}${row.state === 'payment_initialized' ? '<form method="post" action="/payments/paystack-initialize"><button>Resume the same test payment</button></form>' : ''}${row.state === 'payment_initialization_unknown' && !synthetic && row.paymentGateway === 'paystack_merchant' ? '<form method="post" action="/payments/paystack-initialize"><label>Payment email (sent only to Paystack)<input name="email" type="email" required autocomplete="email"></label><button>Reconcile the pending test payment</button></form><p>Initialization outcome unknown. Retrying reconciles the held reference instead of starting a duplicate payment.</p>' : ''}${row.state === 'authorized' && !synthetic && row.paymentGateway !== 'paystack_merchant' ? `<p>Your existing payment backend must confirm the payment in the configured collection model, then use the authenticated server reporting endpoint.</p>` : ''}${['reconciliation_required', 'paid_pending_report'].includes(row.state) ? '<p>Payment exists but Awoof settlement is not confirmed. Do not re-charge or obtain a new authorization. Investigate eligibility/expiry/provider state first.</p><form method="post" action="/reconcile"><button>Retry the identical report</button></form>' : ''}${row.state === 'reported' ? `<p>Report recorded once.${synthetic ? ' Synthetic results do not prove real backend or merchant activation.' : ''}</p>` : ''}`); return;
      }
      if (req.method === 'POST' && url.pathname === '/payments/paystack-initialize') {
        requireOrigin(req); const { row } = checkout(req);
        if (synthetic || paymentGateway !== 'paystack_merchant' || !paystackSecret) throw fail('Merchant test payment initialization is unconfigured', 503);
        const form = new URLSearchParams((await rawBody(req)).toString()); const email = form.get('email')?.trim();
        await once(row.id, async () => {
          const current = store.get(row.id);
          if (!current.receipt || !['authorized', 'payment_initializing', 'payment_initialized', 'payment_initialization_unknown'].includes(current.state)) throw fail('A current claimed checkout is required');
          if (!(Date.parse(current.receipt.validUntil) > Date.now()) || !(benefitDeadline(current) > Date.now())) throw fail('Benefit authorization expired; do not start payment');
          if (current.paymentUrl) return;
          if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('Payment email required', 400);
          const emailHash = createHash('sha256').update(email).digest('hex');
          if (current.paymentEmailHash && current.paymentEmailHash !== emailHash) throw fail('Retry with the original payment email');
          current.paymentEmailHash = emailHash;
          // A held reference without a URL has an unknown outcome: reconcile
          // it before posting, so an ambiguous retry never strands on a
          // duplicate or creates a second payment.
          if (current.initializedReference && !current.paymentUrl) {
            await reconcileInitialization(current);
          }
          current.initializedReference ??= `awoof-${randomUUID()}`; current.state = 'payment_initializing'; store.put(current.id, current);
          let response; let initialized;
          try {
            response = await fetchImpl('https://api.paystack.co/transaction/initialize', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${paystackSecret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, amount: String(current.amountKobo), currency: 'NGN', reference: current.initializedReference, callback_url: `${origin}/payments/paystack-return`, metadata: JSON.stringify(merchantPaystackMetadata({ vendorId, productId: current.productId, benefitAuthorizationId: current.receipt.benefitAuthorizationId })) }) });
            initialized = await response.json();
          } catch (error) {
            current.state = 'payment_initialization_unknown'; store.put(current.id, current);
            throw fail('Test payment initialization outcome unknown; retry to reconcile the held reference', 502);
          }
          if (!response.ok || initialized.status !== true || initialized.data?.reference !== current.initializedReference) {
            const detail = `${initialized?.code ?? ''} ${initialized?.message ?? ''}`;
            // A duplicate-text, throttled, timed-out, 5xx, or mismatched
            // success-shape response may already exist upstream: hold the
            // reference and reconcile on retry.
            const ambiguous = /duplicate|already|in.use|used|exists/i.test(detail)
              || (!response.ok && (response.status >= 500 || response.status === 408 || response.status === 429))
              || (response.ok && initialized?.status === true);
            if (ambiguous) {
              current.state = 'payment_initialization_unknown'; store.put(current.id, current);
              throw fail('Test payment initialization outcome unknown; retry to reconcile the held reference', 502);
            }
            // A definitive rejection releases the held inputs so the form can
            // be corrected instead of reposting the same invalid request.
            delete current.paymentEmailHash; delete current.initializedReference; current.state = 'authorized'; store.put(current.id, current);
            throw fail('Test payment initialization was rejected; correct the payment email and retry', 400);
          }
          const destination = new URL(initialized.data.authorization_url);
          if (destination.protocol !== 'https:' || destination.hostname !== 'checkout.paystack.com' || destination.port || destination.username || destination.password) throw fail('Unexpected payment checkout destination', 502);
          current.paymentUrl = destination.href; current.state = 'payment_initialized'; store.put(current.id, current);
        });
        redirect(res, store.get(row.id).paymentUrl); return;
      }
      if (req.method === 'GET' && url.pathname === '/payments/paystack-return') {
        const { row } = checkout(req); const reference = url.searchParams.get('reference');
        if (synthetic || paymentGateway !== 'paystack_merchant' || !reference || reference !== row.initializedReference || (url.searchParams.has('trxref') && url.searchParams.get('trxref') !== reference) || [...url.searchParams.keys()].some(key => !['reference', 'trxref'].includes(key))) throw fail('Payment return does not match this checkout', 400);
        await once(row.id, async () => {
          const current = store.get(row.id); if (current.state === 'reported') return;
          await verifiedPaystack(reference, current);
          current.paymentReference = reference; current.state = 'paid_pending_report'; store.put(current.id, current); await report(current);
        });
        redirect(res, '/checkout'); return;
      }
      if (req.method === 'POST' && url.pathname === '/payments/simulate') {
        requireOrigin(req); if (!synthetic) throw fail('Synthetic payments disabled', 404);
        const { row } = checkout(req);
        await once(row.id, async () => { const current = store.get(row.id); if (!current.receipt) throw fail('Claim first'); if (!current.paymentReference && !(benefitDeadline(current) > Date.now())) throw fail('Benefit authorization expired; do not start payment'); current.paymentReference ??= `synthetic_${current.id}`; current.state = current.state === 'reported' ? 'reported' : 'paid_pending_report'; store.put(current.id, current); await report(current); });
        redirect(res, '/checkout'); return;
      }
      if (req.method === 'POST' && url.pathname === '/reconcile') {
        requireOrigin(req); const { row } = checkout(req);
        await once(row.id, () => report(store.get(row.id))); redirect(res, '/checkout'); return;
      }
      if (req.method === 'POST' && url.pathname === '/payments/report') {
        // An existing merchant payment backend may attest `other`, or report an
        // Awoof-account Paystack reference. This shared secret never goes to UI.
        const supplied = Buffer.from(req.headers.authorization ?? ''); const expected = Buffer.from(`Bearer ${reportSecret ?? ''}`);
        if (synthetic || !reportSecret || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw fail('Server reporting is unconfigured or unauthorized', 401);
        const body = JSON.parse((await rawBody(req)).toString()); const row = store.get(body.merchantCheckoutId);
        if (!row?.receipt || typeof body.paymentReference !== 'string' || !body.paymentReference || body.paymentReference.length > 200 || row.paymentGateway === 'paystack_merchant') throw fail('Invalid server payment report', 400);
        await once(row.id, async () => {
          const current = store.get(row.id);
          if (current.paymentReference && current.paymentReference !== body.paymentReference) throw fail('Checkout already has a payment');
          current.paymentReference = body.paymentReference; current.state = current.state === 'reported' ? 'reported' : 'paid_pending_report'; store.put(current.id, current); await report(current);
        });
        json(res, 200, { state: store.get(row.id).state }); return;
      }
      if (req.method === 'POST' && url.pathname === '/webhooks/paystack') {
        if (synthetic || paymentGateway !== 'paystack_merchant' || !paystackSecret) throw fail('Independent merchant Paystack webhook unconfigured', 503);
        const bytes = await rawBody(req);
        if (!verifyPaystackWebhook(bytes, req.headers['x-paystack-signature'], paystackSecret)) throw fail('Invalid webhook signature', 401);
        const event = JSON.parse(bytes.toString());
        if (event.event !== 'charge.success') {
          // Retain a minimal deduplicated review record, never raw provider data.
          const reviewId = `provider-review:${createHash('sha256').update(bytes).digest('hex')}`;
          if (!store.get(reviewId)) store.put(reviewId, { id: reviewId, kind: 'provider_review', eventType: String(event.event ?? 'unknown').slice(0, 100), paymentReference: String(event.data?.transaction?.reference ?? event.data?.reference ?? '').slice(0, 200), receivedAt: new Date().toISOString(), state: 'reconciliation_required' });
          json(res, 202, { accepted: true, reconciliation: 'Refund/dispute/reversal events recorded for merchant review; this example does not settle them.' }); return;
        }
        const authorizationId = event.data?.metadata?.awoofBenefitAuthorizationId;
        if (typeof authorizationId !== 'string' || !authorizationId) throw fail('Unknown checkout', 404);
        const row = store.find(row => row.receipt?.benefitAuthorizationId === authorizationId);
        if (!row) throw fail('Unknown checkout', 404);
        await once(row.id, async () => {
          const current = store.get(row.id); const reference = event.data.reference;
          if (current.initializedReference && current.initializedReference !== reference) throw fail('Webhook reference differs from the initialized checkout');
          if (current.paymentReference && current.paymentReference !== reference) throw fail('Checkout already has a payment');
          if (current.state === 'reported') return;
          await verifiedPaystack(reference, current);
          current.paymentReference = reference; current.state = 'paid_pending_report'; store.put(current.id, current);
          await report(current);
        });
        json(res, 200, { accepted: true }); return;
      }
      json(res, 404, { error: 'Not found' });
    } catch (error) { json(res, error.status ?? 502, { error: error.status ? error.message : 'Integration request failed; inspect configuration and retry safely' }); }
  });
  return { server, store };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const synthetic = process.env.AWOOF_SYNTHETIC === '1'; const port = Number(process.env.PORT ?? 4100);
  const app = createMerchant({ origin: process.env.MERCHANT_ORIGIN ?? `http://127.0.0.1:${port}`, apiOrigin: process.env.AWOOF_API_ORIGIN ?? 'http://localhost:4200', webOrigin: process.env.AWOOF_WEB_ORIGIN ?? 'http://localhost:4200', privateKey: process.env.AWOOF_PRIVATE_KEY ?? (synthetic ? 'awoof_synthetic_local_only' : ''), productId: process.env.AWOOF_PRODUCT_ID ?? '11111111-1111-4111-8111-111111111111', vendorId: process.env.AWOOF_VENDOR_ID ?? '22222222-2222-4222-8222-222222222222', amountKobo: Number(process.env.STUDENT_PRICE_KOBO ?? 80000), synthetic, paymentGateway: process.env.PAYMENT_GATEWAY ?? 'other', paystackSecret: process.env.MERCHANT_PAYSTACK_TEST_SECRET, reportSecret: process.env.REFERENCE_REPORT_SECRET, dbPath: process.env.MERCHANT_DB_PATH ?? './.local/merchant.sqlite' });
  app.server.listen(port, '127.0.0.1', () => console.log(`Reference merchant on loopback port ${port}; ${synthetic ? 'SYNTHETIC ONLY' : 'sandbox integration'}`));
}
