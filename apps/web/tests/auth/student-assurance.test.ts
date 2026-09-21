import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isStudentVerified, parseAuthenticatedAssurance, parseStudentAssurance, schoolAccountLabel, studentStatusLabel } from '../../src/lib/student-assurance';

const mailboxConfirmed = {
  schoolAccountStatus: 'verified',
  schoolAccountMethod: 'email_otp',
  schoolAccountValidUntil: '2026-10-01T00:00:00.000Z',
  studentStatus: 'pending',
  enrollmentMethod: null,
  studentValidUntil: null,
  reason: 'awaiting_enrollment',
};

test('parses a mailbox-confirmed pending student without conflating the two checks', () => {
  assert.deepEqual(parseStudentAssurance(mailboxConfirmed), mailboxConfirmed);
  assert.equal(isStudentVerified(parseStudentAssurance(mailboxConfirmed)), false);
});

test('parses a fully verified student with enrollment expiry', () => {
  const verified = {
    ...mailboxConfirmed,
    studentStatus: 'verified',
    enrollmentMethod: 'registration',
    studentValidUntil: '2026-10-15T00:00:00.000Z',
    reason: null,
  };
  assert.deepEqual(parseStudentAssurance(verified), verified);
  assert.equal(isStudentVerified(parseStudentAssurance(verified)), true);
});

test('rejects unknown statuses, methods, and reasons', () => {
  assert.equal(parseStudentAssurance({ ...mailboxConfirmed, schoolAccountStatus: 'verified_by_email' }), null);
  assert.equal(parseStudentAssurance({ ...mailboxConfirmed, studentStatus: 'verified_by_email' }), null);
  assert.equal(parseStudentAssurance({ ...mailboxConfirmed, schoolAccountMethod: 'password' }), null);
  assert.equal(parseStudentAssurance({ ...mailboxConfirmed, enrollmentMethod: 'student_email' }), null);
  assert.equal(parseStudentAssurance({ ...mailboxConfirmed, reason: 'unknown' }), null);
});

test('rejects malformed expiry timestamps but allows null', () => {
  assert.equal(parseStudentAssurance({ ...mailboxConfirmed, schoolAccountValidUntil: 'soon' }), null);
  assert.equal(parseStudentAssurance({ ...mailboxConfirmed, studentValidUntil: 'not-a-date' }), null);
  assert.deepEqual(
    parseStudentAssurance({ ...mailboxConfirmed, schoolAccountStatus: 'unverified', schoolAccountMethod: null, schoolAccountValidUntil: null }),
    { ...mailboxConfirmed, schoolAccountStatus: 'unverified', schoolAccountMethod: null, schoolAccountValidUntil: null },
  );
});

test('rejects non-objects and missing fields without throwing', () => {
  assert.equal(parseStudentAssurance(null), null);
  assert.equal(parseStudentAssurance('verified'), null);
  assert.equal(parseStudentAssurance([]), null);
  const { reason, ...withoutReason } = mailboxConfirmed;
  void reason;
  assert.equal(parseStudentAssurance(withoutReason), null);
});

test('school verification alone never counts as student verification', () => {
  for (const studentStatus of ['pending', 'expired', 'denied', 'revoked', 'inactive'] as const) {
    const parsed = parseStudentAssurance({ ...mailboxConfirmed, studentStatus });
    assert.ok(parsed);
    assert.equal(isStudentVerified(parsed), false);
  }
});

test('labels keep the two checks and their expiry separate', () => {
  const parsed = parseStudentAssurance(mailboxConfirmed);
  assert.ok(parsed);
  assert.match(schoolAccountLabel(parsed), /Verified.*school email code.*2026/);
  assert.match(studentStatusLabel(parsed), /Pending.*enrollment/);
  assert.doesNotMatch(schoolAccountLabel(parsed), /enrollment/i);
});

test('labels describe expiry, denial, and revocation without inventing a method', () => {
  const expiredSchool = parseStudentAssurance({ ...mailboxConfirmed, schoolAccountStatus: 'expired', schoolAccountValidUntil: '2026-08-01T00:00:00.000Z' });
  assert.ok(expiredSchool);
  assert.match(schoolAccountLabel(expiredSchool), /Expired.*2026/);
  const denied = parseStudentAssurance({ ...mailboxConfirmed, studentStatus: 'denied', reason: 'enrollment_denied' });
  assert.ok(denied);
  assert.match(studentStatusLabel(denied), /Denied/);
  const revoked = parseStudentAssurance({ ...mailboxConfirmed, studentStatus: 'revoked', reason: 'consent_withdrawn' });
  assert.ok(revoked);
  assert.match(studentStatusLabel(revoked), /Revoked.*consent/i);
});

test('unverified school account has no expiry or method claim', () => {
  const parsed = parseStudentAssurance({ ...mailboxConfirmed, schoolAccountStatus: 'unverified', schoolAccountMethod: null, schoolAccountValidUntil: null });
  assert.ok(parsed);
  assert.equal(schoolAccountLabel(parsed), 'Not verified');
});

test('SSO login union keeps assurance null only while unavailable', () => {
  assert.deepEqual(
    parseAuthenticatedAssurance({ studentAssurance: mailboxConfirmed, assuranceStatus: 'available' }),
    { studentAssurance: mailboxConfirmed, assuranceStatus: 'available' },
  );
  assert.deepEqual(
    parseAuthenticatedAssurance({ studentAssurance: null, assuranceStatus: 'unavailable' }),
    { studentAssurance: null, assuranceStatus: 'unavailable' },
  );
});

test('SSO login union rejects null-with-available and malformed pairs', () => {
  assert.equal(parseAuthenticatedAssurance({ studentAssurance: null, assuranceStatus: 'available' }), null);
  assert.equal(parseAuthenticatedAssurance({ studentAssurance: mailboxConfirmed, assuranceStatus: 'unavailable' }), null);
  assert.equal(parseAuthenticatedAssurance({ studentAssurance: mailboxConfirmed, assuranceStatus: 'verified' }), null);
  assert.equal(parseAuthenticatedAssurance({ studentAssurance: { ...mailboxConfirmed, studentStatus: 'bogus' }, assuranceStatus: 'available' }), null);
  assert.equal(parseAuthenticatedAssurance(null), null);
  assert.equal(parseAuthenticatedAssurance({ studentAssurance: mailboxConfirmed }), null);
});
