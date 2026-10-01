import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import Awoof from './widget.js';
import { checkDomain, DOMAIN_CHECK_TIMEOUT_MS } from './api.js';

test('an overlapping init cannot replace a pending merchant approval', async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const requests = [];
  let finish;
  globalThis.window = { location: { origin: 'https://shop.example', hostname: 'shop.example' } };
  globalThis.fetch = (url, request) => {
    requests.push({ url, body: JSON.parse(request.body) });
    return new Promise((resolve) => { finish = resolve; });
  };
  try {
    const first = Awoof.init({ apiKey: 'first-public-key', apiBaseUrl: 'https://api.awoof.test', webAppUrl: 'https://app.awoof.test' });
    assert.throws(() => Awoof.init({ apiKey: 'second-public-key', apiBaseUrl: 'https://other-api.example', webAppUrl: 'https://other-app.example' }), /initialization is already in progress/);
    assert.equal(requests.length, 1);
    finish({ ok: true, json: async () => ({ data: { allowed: true, vendorId: 'first-merchant' } }) });
    assert.deepEqual(await first, { allowed: true, vendorId: 'first-merchant' });
    globalThis.fetch = async (url, request) => {
      assert.equal(url, 'https://api.awoof.test/api/widget/domain-check');
      assert.equal(JSON.parse(request.body).apiKey, 'first-public-key');
      return { ok: true, json: async () => ({ data: { allowed: true, vendorId: 'first-merchant' } }) };
    };
    assert.deepEqual(await Awoof.checkDomain(), { allowed: true, vendorId: 'first-merchant' });
  } finally { globalThis.window = originalWindow; globalThis.fetch = originalFetch; }
});

test('a failed approval releases the init lock so another merchant can retry', async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  globalThis.window = { location: { origin: 'https://shop.example', hostname: 'shop.example' } };
  try {
    globalThis.fetch = async () => { throw new Error('Network unavailable'); };
    await assert.rejects(Awoof.init({ apiKey: 'first-public-key', apiBaseUrl: 'https://api.awoof.test', webAppUrl: 'https://app.awoof.test' }), /Network unavailable/);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: { allowed: true, vendorId: 'retry-merchant' } }) });
    assert.deepEqual(await Awoof.init({ apiKey: 'retry-public-key', apiBaseUrl: 'https://api.awoof.test', webAppUrl: 'https://app.awoof.test' }), { allowed: true, vendorId: 'retry-merchant' });
  } finally { globalThis.window = originalWindow; globalThis.fetch = originalFetch; }
});

test('popup accepts only a fresh code from its Awoof window, matching state and campaign', async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const listeners = new Set();
  const popup = { closed: false, close() { this.closed = true; } };
  let openedUrl;
  let successes = 0;
  globalThis.window = {
    location: { origin: 'https://shop.example', hostname: 'shop.example' },
    crypto: webcrypto,
    open(url) { openedUrl = new URL(url); return popup; },
    addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
  };
  globalThis.fetch = async (_url, request) => {
    assert.deepEqual(JSON.parse(request.body), { domain: 'shop.example', origin: 'https://shop.example', apiKey: 'public-key' });
    return { ok: true, json: async () => ({ data: { allowed: true, vendorId: '4f088fa7-79d9-4c64-a48c-9ecbbbc3c4a3' } }) };
  };
  try {
    await Awoof.init({ apiKey: 'public-key', apiBaseUrl: 'https://api.awoof.test', webAppUrl: 'https://app.awoof.test', onSuccess: () => { successes += 1; } });
    const result = Awoof.verify({ campaignId: 'student-2026', purpose: 'Check test checkout eligibility' });
    assert.equal(openedUrl.origin, 'https://app.awoof.test');
    assert.equal(openedUrl.searchParams.get('origin'), 'https://shop.example');
    assert.equal(openedUrl.searchParams.get('campaignId'), 'student-2026');
    assert.equal(openedUrl.searchParams.has('apiKey'), false);
    // Simulate a merchant browser clock ahead of the issuing server. Exchange owns expiry.
    const payload = { type: 'AWOOF_ELIGIBILITY_CODE', state: openedUrl.searchParams.get('state'), campaignId: 'student-2026', code: 'a'.repeat(43), expiresAt: new Date(Date.now() - 60_000).toISOString() };
    for (const event of [
      { origin: 'https://evil.example', source: popup, data: payload },
      { origin: 'https://app.awoof.test', source: {}, data: payload },
      { origin: 'https://app.awoof.test', source: popup, data: { ...payload, state: '0'.repeat(32) } },
      { origin: 'https://app.awoof.test', source: popup, data: { ...payload, code: 'awoof_legacy' } },
      { origin: 'https://app.awoof.test', source: popup, data: { ...payload, campaignId: 'other' } },
      { origin: 'https://app.awoof.test', source: popup, data: { ...payload, expiresAt: 'not-a-date' } },
    ]) for (const listener of listeners) listener(event);
    assert.equal(successes, 0);
    assert.equal(popup.closed, false);
    for (const listener of listeners) listener({ origin: 'https://app.awoof.test', source: popup, data: payload });
    assert.deepEqual(await result, { code: payload.code, campaignId: payload.campaignId, expiresAt: payload.expiresAt });
    assert.equal(successes, 1);
    assert.equal(popup.closed, true);
    assert.equal(listeners.size, 0);
  } finally { globalThis.window = originalWindow; globalThis.fetch = originalFetch; }
});

test('a stalled merchant approval fails bounded so init can retry', async () => {
  assert.ok(Number.isFinite(DOMAIN_CHECK_TIMEOUT_MS) && DOMAIN_CHECK_TIMEOUT_MS <= 30000);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_url, request) => new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
  });
  try {
    await assert.rejects(
      checkDomain('https://api.awoof.test', 'shop.example', 'public-key', 'https://shop.example', { timeoutMs: 20 }),
      /Merchant approval timed out/,
    );
  } finally { globalThis.fetch = originalFetch; }
});

test('isolated popup fails closed with a COOP configuration hint', async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const popup = { closed: true, close() {} };
  globalThis.window = {
    location: { origin: 'https://shop.example', hostname: 'shop.example' },
    crypto: webcrypto,
    open() { return popup; },
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: { allowed: true, vendorId: '4f088fa7-79d9-4c64-a48c-9ecbbbc3c4a3' } }) });
  try {
    await Awoof.init({ apiKey: 'public-key', apiBaseUrl: 'https://api.awoof.test', webAppUrl: 'https://app.awoof.test' });
    await assert.rejects(Awoof.verify({ campaignId: 'student-2026', purpose: 'Check test checkout eligibility' }), /Cross-Origin-Opener-Policy: same-origin/);
  } finally { globalThis.window = originalWindow; globalThis.fetch = originalFetch; }
});
