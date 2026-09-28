import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveStudentReturn } from '../../src/lib/student-return';

const origin = 'https://awoof.test';

test('preserves a same-origin student return path and its query context', () => {
  assert.equal(
    resolveStudentReturn('/verify/widget?flow=synthetic#step-two', origin),
    '/verify/widget?flow=synthetic#step-two',
  );
});

test('permits the onboarding continuation as the only auth-route return', () => {
  assert.equal(
    resolveStudentReturn('/auth/student/sso/onboarding', origin),
    '/auth/student/sso/onboarding',
  );
  assert.equal(
    resolveStudentReturn('/auth/student/sso/onboarding?mode=signup', origin),
    '/auth/student/sso/onboarding?mode=signup',
  );
});

test('rejects foreign, credentialed, malformed, and authentication-loop returns', () => {
  for (const candidate of [
    'https://evil.test',
    '//evil.test/path',
    'javascript:alert(1)',
    'data:text/plain,nope',
    'https://user@awoof.test/marketplace',
    'https://awoof.test/%',
    '/auth/student/login',
    '/auth/login?redirect=%2Fmarketplace',
    '/auth/student/sso/onboarding/extra',
  ]) {
    assert.equal(resolveStudentReturn(candidate, origin), '/marketplace');
  }
});

test('normalizes an invalid fallback to marketplace', () => {
  assert.equal(resolveStudentReturn(null, origin, 'https://evil.test'), '/marketplace');
});
