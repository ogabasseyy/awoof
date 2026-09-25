import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import Awoof from './widget.js';

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
    const payload = { type: 'AWOOF_ELIGIBILITY_CODE', state: openedUrl.searchParams.get('state'), campaignId: 'student-2026', code: 'a'.repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    for (const event of [
      { origin: 'https://evil.example', source: popup, data: payload },
      { origin: 'https://app.awoof.test', source: {}, data: payload },
      { origin: 'https://app.awoof.test', source: popup, data: { ...payload, state: '0'.repeat(32) } },
      { origin: 'https://app.awoof.test', source: popup, data: { ...payload, code: 'awoof_legacy' } },
      { origin: 'https://app.awoof.test', source: popup, data: { ...payload, campaignId: 'other' } },
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
