import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const loopback = (url) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
export function trustedBase(value, allowLoopbackHttp = false) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Expected a bare trusted origin');
  if (url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && loopback(url))) throw new Error('HTTPS required outside explicit loopback simulation');
  return url.origin;
}
export function nonceHash(nonce) {
  if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 512) throw new Error('Invalid browser nonce');
  return createHash('sha256').update(nonce).digest('hex');
}
export class AwoofApiError extends Error {
  constructor(status, body) { super(`Awoof request failed (${status})`); this.name = 'AwoofApiError'; this.status = status; this.body = body; }
}
export class AwoofPartnerClient {
  #key; #fetch; #api; #web;
  constructor({ apiOrigin, webOrigin, privateKey, fetch: fetchImpl = globalThis.fetch, allowLoopbackHttp = false }) {
    this.#api = trustedBase(apiOrigin, allowLoopbackHttp); this.#web = trustedBase(webOrigin, allowLoopbackHttp);
    if (typeof privateKey !== 'string' || !privateKey.startsWith('awoof_')) throw new Error('A private awoof_ server key is required');
    this.#key = privateKey; this.#fetch = fetchImpl;
  }
  async #post(path, input) {
    const response = await this.#fetch(`${this.#api}${path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${this.#key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const body = await response.json();
    if (!response.ok || body.success !== true) throw new AwoofApiError(response.status, body);
    return body.data;
  }
  createClaimSession({ productId, merchantCheckoutId, browserNonce, origin }) {
    return this.#post('/api/merchant-verification/claim-sessions', { productId, merchantCheckoutId, browserNonceHash: nonceHash(browserNonce), origin });
  }
  buildHostedClaimUrl(productId, claimSessionId) {
    const url = new URL(`/marketplace/${encodeURIComponent(productId)}`, this.#web);
    url.searchParams.set('claimSession', claimSessionId); return url.href;
  }
  exchangeClaim({ code, merchantCheckoutId, browserNonce, idempotencyKey }) {
    nonceHash(browserNonce);
    return this.#post('/api/merchant-verification/exchange', { code, campaignId: merchantCheckoutId, merchantCheckoutId, browserNonce, idempotencyKey });
  }
  reportTransaction(input) {
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new Error('amount must be positive integer NGN kobo');
    return this.#post('/api/vendors/transactions/report', input);
  }
}
export function merchantPaystackMetadata({ vendorId, productId, benefitAuthorizationId }) {
  if (![vendorId, productId, benefitAuthorizationId].every(value => typeof value === 'string' && value.length > 0)) throw new Error('Missing payment binding');
  return { awoofVendorId: vendorId, awoofProductId: productId, awoofBenefitAuthorizationId: benefitAuthorizationId };
}
export function verifyPaystackWebhook(rawBody, signature, secret) {
  if (!Buffer.isBuffer(rawBody) || typeof secret !== 'string' || !secret || typeof signature !== 'string' || !/^[a-f0-9]{128}$/i.test(signature)) return false;
  const expected = createHmac('sha512', secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

// These contracts never turn account identity or a provider name into eligibility/value.
export const PARTNER_CAPABILITIES = Object.freeze(['enrollment', 'offers', 'redemption', 'payment_events', 'google_entitlement', 'verve_cashback']);
export function unconfiguredAdapter(capability) {
  if (!PARTNER_CAPABILITIES.includes(capability)) throw new Error('Unknown capability');
  return Object.freeze({ capability, status: 'unconfigured', execute: async () => ({ status: 'unconfigured', capability }) });
}
export function partnerCapabilities() { return Object.fromEntries(PARTNER_CAPABILITIES.map(capability => [capability, unconfiguredAdapter(capability)])); }
export async function invokeConfiguredAdapter(adapter, input) {
  if (!adapter || !PARTNER_CAPABILITIES.includes(adapter.capability) || adapter.status !== 'configured' || typeof adapter.contractReference !== 'string' || !adapter.contractReference.trim() || typeof adapter.execute !== 'function') return { status: 'unconfigured', capability: adapter?.capability };
  return adapter.execute(input);
}
