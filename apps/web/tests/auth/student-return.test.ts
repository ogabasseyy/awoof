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
  ]) {
    assert.equal(resolveStudentReturn(candidate, origin), '/marketplace');
  }
});

test('normalizes an invalid fallback to marketplace', () => {
  assert.equal(resolveStudentReturn(null, origin, 'https://evil.test'), '/marketplace');
});
