import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAuthenticationResponse } from '../../src/lib/auth-response';

test('unwraps the real login response envelope before validating the account and tokens', () => {
  assert.deepEqual(
    parseAuthenticationResponse({
      success: true,
      data: {
        user: { id: 'student-id', email: 'student@approved.test', role: 'student', verificationStatus: 'verified' },
        tokens: { accessToken: 'access-token', refreshToken: 'refresh-token' },
      },
    }),
    {
      user: { id: 'student-id', email: 'student@approved.test', role: 'student', verificationStatus: 'verified' },
      tokens: { accessToken: 'access-token', refreshToken: 'refresh-token' },
      requiresEmailVerification: false,
    },
  );
});

test('keeps vendor onboarding metadata from the same validated inner payload', () => {
  const parsed = parseAuthenticationResponse({
    success: true,
    data: {
      user: { id: 'vendor-id', email: 'vendor@approved.test', role: 'vendor' },
      tokens: { accessToken: 'vendor-access', refreshToken: 'vendor-refresh' },
      requiresEmailVerification: true,
    },
  });

  assert.equal(parsed?.user.role, 'vendor');
  assert.equal(parsed?.requiresEmailVerification, true);
});

test('rejects a nested or malformed authentication payload', () => {
  assert.equal(parseAuthenticationResponse({ user: {}, tokens: {} }), null);
  assert.equal(parseAuthenticationResponse({ success: true, data: { user: {}, tokens: {} } }), null);
});
