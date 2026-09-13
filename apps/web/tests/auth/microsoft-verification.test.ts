import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMicrosoftAuthorizationUrl, readMicrosoftAttempt, writeMicrosoftAttempt } from '../../src/lib/microsoft-verification';

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
