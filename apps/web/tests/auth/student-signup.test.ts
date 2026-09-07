import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseSignupAuthentication,
  parseSignupPreflight,
  parseSignupReceipt,
  signupRetryAt,
  studentSignupFormSchema,
} from '../../src/lib/student-signup';

const notice = { version: '2026-09-05.v1', text: 'Synthetic verification processing notice.' };
const email = 'student@alpha.approved.test';
const challengeId = '20000000-0000-4000-8000-000000000001';
const validForm = {
  name: ' Synthetic Student ',
  email: ' STUDENT@ALPHA.APPROVED.TEST ',
  university: '10000000-0000-4000-8000-000000000001',
  matricNumber: '   ',
  password: ' Synthetic!Pass9 ',
  confirmPassword: ' Synthetic!Pass9 ',
};

function hasValidCanonicalOutput(value: unknown): boolean {
  const parsed = studentSignupFormSchema.safeParse(value);
  return parsed.success
    && parsed.data.name === 'Synthetic Student'
    && parsed.data.email === email
    && parsed.data.university === validForm.university
    && parsed.data.matricNumber === null
    && parsed.data.password === validForm.password
    && parsed.data.confirmPassword === validForm.confirmPassword;
}

test('preflight requires explicit support and a usable server notice', () => {
  assert.equal(parseSignupPreflight({ success: true, data: { supported: 'true', verificationNotice: notice } }), null);
  assert.equal(parseSignupPreflight({ success: false, data: { supported: true, verificationNotice: notice } }), null);
  assert.equal(parseSignupPreflight({ success: true, data: { supported: true, verificationNotice: { version: '', text: 'x' } } }), null);
  const unsupported = parseSignupPreflight({ success: true, data: { supported: false, verificationNotice: notice } });
  assert.equal(
    unsupported !== null
      && unsupported.supported === false
      && unsupported.verificationNotice.version === notice.version
      && unsupported.verificationNotice.text === notice.text,
    true,
  );
});

test('receipt binds exact mailbox, UUID and finite server deadlines', () => {
  const data = {
    email,
    challengeId,
    expiresAt: '2030-01-01T00:10:00.000Z',
    resendAvailableAt: '2030-01-01T00:01:00.000Z',
  };
  const receipt = parseSignupReceipt({ success: true, data }, email);
  assert.equal(
    receipt !== null
      && receipt.email === data.email
      && receipt.challengeId === data.challengeId
      && receipt.expiresAt === data.expiresAt
      && receipt.resendAvailableAt === data.resendAvailableAt,
    true,
  );
  for (const invalid of [
    { ...data, email: 'other@alpha.approved.test' },
    { ...data, challengeId: 'not-a-uuid' },
    { ...data, expiresAt: 'not-a-date' },
    { ...data, resendAvailableAt: null },
  ]) {
    assert.equal(parseSignupReceipt({ success: true, data: invalid }, email), null);
  }
});

test('signup authentication requires exact 201 outer success and student mailbox', () => {
  const user = { id: 'synthetic-account', email, role: 'student' };
  const body = {
    success: true,
    data: { user, tokens: { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' } },
  };
  assert.equal(!!parseSignupAuthentication(201, body, email), true);
  assert.equal(parseSignupAuthentication(200, body, email), null);
  assert.equal(parseSignupAuthentication(201, { ...body, success: false }, email), null);
  for (const changed of [{ ...user, role: 'vendor' }, { ...user, email: 'other@alpha.approved.test' }]) {
    assert.equal(parseSignupAuthentication(201, { ...body, data: { ...body.data, user: changed } }, email), null);
  }
});

test('retry deadline prefers operational details and never guesses one', () => {
  assert.equal(
    signupRetryAt({ error: { details: { retryAt: '2030-01-01T00:01:00Z' } } }, '99', 0),
    Date.parse('2030-01-01T00:01:00Z'),
  );
  assert.equal(signupRetryAt({}, '60', 1000), 61_000);
  for (const invalid of [undefined, 'nonsense', '-1', Infinity]) {
    assert.equal(signupRetryAt({}, invalid, 1000), null);
  }
});

test('student form canonicalizes identity while retaining the untrimmed password in memory', () => {
  assert.equal(hasValidCanonicalOutput(validForm), true);
});

test('student form enforces canonical bounds, university identity, and the backend password classes', () => {
  const cases = [
    { ...validForm, name: 'A' },
    { ...validForm, name: 'A'.repeat(256) },
    { ...validForm, matricNumber: 'M'.repeat(101) },
    { ...validForm, university: 'not-a-uuid' },
    { ...validForm, password: 'synthetic!pass9', confirmPassword: 'synthetic!pass9' },
    { ...validForm, password: 'SYNTHETIC!PASS9', confirmPassword: 'SYNTHETIC!PASS9' },
    { ...validForm, password: 'SyntheticPass9', confirmPassword: 'SyntheticPass9' },
    { ...validForm, password: 'Synthetic!Pass', confirmPassword: 'Synthetic!Pass' },
    { ...validForm, password: 'Synthetic!Pass9', confirmPassword: 'Synthetic!Pass8' },
  ];
  for (const candidate of cases) {
    assert.equal(studentSignupFormSchema.safeParse(candidate).success, false);
  }
});
