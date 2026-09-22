import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMicrosoftAuthorizationUrl, isTerminalFinishStatus, readMicrosoftAttempt, tabAttemptExpiresAt, writeMicrosoftAttempt } from '../../src/lib/microsoft-verification';

test('only accepts an HTTPS Microsoft authorization host', () => {
  assert.equal(isMicrosoftAuthorizationUrl('https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize'), true);
  assert.equal(isMicrosoftAuthorizationUrl('http://login.microsoftonline.com/tenant/oauth2/v2.0/authorize'), false);
  assert.equal(isMicrosoftAuthorizationUrl('https://login.microsoftonline.com.attacker.test/authorize'), false);
  assert.equal(isMicrosoftAuthorizationUrl('https://login.microsoftonline.com@attacker.test/authorize'), false);
});

test('tab state is bounded to its browser session and expires without retaining a finish secret', () => {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; }, clear() { values.clear(); }, key() { return null; },
    getItem(key) { return values.get(key) ?? null; }, setItem(key, value) { values.set(key, value); }, removeItem(key) { values.delete(key); },
  };
  const expiresAt = Date.now() + 200;
  writeMicrosoftAttempt(storage, { attemptId: 'attempt-a', finishSecret: 'secret-a', browserSessionId: 'browser-a', expiresAt });
  assert.deepEqual(readMicrosoftAttempt(storage, expiresAt - 100), { attemptId: 'attempt-a', finishSecret: 'secret-a', browserSessionId: 'browser-a', expiresAt });
  assert.equal(readMicrosoftAttempt(storage, expiresAt), null);
  assert.equal(storage.getItem('awoof.microsoft.verification.attempt.v1'), null);
});

test('tab state serializes exactly the four approved fields', () => {
  const values = new Map<string, string>();
  const storage: Storage = { get length() { return values.size; }, clear: () => values.clear(), key: () => null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  writeMicrosoftAttempt(storage, { attemptId: 'attempt', finishSecret: 'finish', browserSessionId: 'browser', expiresAt: Date.now() + 1_000, authorizationUrl: 'https://login.microsoftonline.com/never-store' } as never);
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem('awoof.microsoft.verification.attempt.v1') ?? '{}')).sort(), ['attemptId', 'browserSessionId', 'expiresAt', 'finishSecret']);
});

test('a 429 finish response stays retryable while other 4xx responses are terminal', () => {
  assert.equal(isTerminalFinishStatus(429), false);
  assert.equal(isTerminalFinishStatus(400), true);
  assert.equal(isTerminalFinishStatus(409), true);
  assert.equal(isTerminalFinishStatus(500), false);
});

test('tab deadline derives a server-measured lifetime regardless of device offset', () => {
  const serverNow = '2026-09-19T12:00:00.000Z';
  const serverExpiry = '2026-09-19T12:09:30.000Z';
  // A device behind the server still gets the full remaining lifetime.
  assert.equal(tabAttemptExpiresAt(serverExpiry, serverNow, Date.parse('2026-09-19T11:55:00.000Z')), Date.parse('2026-09-19T11:55:00.000Z') + 570_000);
  // A device ahead of the server is not cut short either.
  assert.equal(tabAttemptExpiresAt(serverExpiry, serverNow, Date.parse('2026-09-19T12:05:00.000Z')), Date.parse('2026-09-19T12:05:00.000Z') + 570_000);
  // Unusable server timing falls back to a nine-minute local window.
  assert.equal(tabAttemptExpiresAt('not-a-date', serverNow, 1_000), 1_000 + 9 * 60 * 1000);
  assert.equal(tabAttemptExpiresAt(serverNow, serverExpiry, 1_000), 1_000 + 9 * 60 * 1000);
});
