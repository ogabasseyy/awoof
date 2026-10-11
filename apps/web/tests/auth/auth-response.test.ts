import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAuthenticationResponse, parseCurrentAccountResponse } from '../../src/lib/auth-response';

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

test('exposes an optional validated student profile name', () => {
  const parsed = parseAuthenticationResponse({
    success: true,
    data: {
      user: { id: 'student-id', email: 'student@approved.test', role: 'student', profile: { name: 'Adaeze Obi' } },
      tokens: { accessToken: 'access-token', refreshToken: 'refresh-token' },
    },
  });
  assert.deepEqual(parsed?.user.profile, { name: 'Adaeze Obi' });
});

test('keeps password and SSO authentication valid when the profile name is absent or blank', () => {
  for (const profile of [undefined, null, {}, { name: '' }, { name: '   ' }]) {
    const user: Record<string, unknown> = { id: 'student-id', email: 'student@approved.test', role: 'student' };
    if (profile !== undefined) user.profile = profile;
    const parsed = parseAuthenticationResponse({
      success: true,
      data: { user, tokens: { accessToken: 'access-token', refreshToken: 'refresh-token' } },
    });
    assert.notEqual(parsed, null);
  }
  assert.deepEqual(parseCurrentAccountResponse({
    success: true,
    data: { id: 'student-id', email: 'student@approved.test', role: 'student' },
  }), { id: 'student-id', email: 'student@approved.test', role: 'student' });
});

test('accepts a null profile on the current-account response without clearing the session', () => {
  assert.deepEqual(parseCurrentAccountResponse({
    success: true,
    data: { id: 'admin-id', email: 'admin@example.invalid', role: 'admin', profile: null },
  }), { id: 'admin-id', email: 'admin@example.invalid', role: 'admin' });
  assert.deepEqual(parseCurrentAccountResponse({
    success: true,
    data: { id: 'student-id', email: 'student@approved.test', role: 'student', profile: null },
  }), { id: 'student-id', email: 'student@approved.test', role: 'student' });
});

test('rejects malformed profile metadata without breaking account validation', () => {
  for (const profile of ['Adaeze', 42, { name: 42 }, { name: ['Adaeze'] }]) {
    assert.equal(parseAuthenticationResponse({
      success: true,
      data: {
        user: { id: 'student-id', email: 'student@approved.test', role: 'student', profile },
        tokens: { accessToken: 'access-token', refreshToken: 'refresh-token' },
      },
    }), null);
    assert.equal(parseCurrentAccountResponse({
      success: true,
      data: { id: 'student-id', email: 'student@approved.test', role: 'student', profile },
    }), null);
  }
  assert.notEqual(parseAuthenticationResponse({
    success: true,
    data: {
      user: { id: 'student-id', email: 'student@approved.test', role: 'student' },
      tokens: { accessToken: 'access-token', refreshToken: 'refresh-token' },
    },
  }), null);
});

test('reads the stored profile name from the current-account response', () => {
  assert.deepEqual(parseCurrentAccountResponse({
    success: true,
    data: { id: 'student-id', email: 'student@approved.test', role: 'student', profile: { name: 'Adaeze Obi' } },
  }), { id: 'student-id', email: 'student@approved.test', role: 'student', profile: { name: 'Adaeze Obi' } });
});
