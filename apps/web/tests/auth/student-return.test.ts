import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    STUDENT_PROFILE_COMPLETION_PATH,
    isStudentProfileCompletionDestination,
    resolveStudentPostAuthDestination,
    resolveStudentReturn,
} from '../../src/lib/student-return';

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

test('rejects encoded-separator and lookalike returns that decode into auth or external routes', () => {
  for (const candidate of [
    // Encoded separators in the pathname (single encoded).
    '/auth%2Fstudent%2Flogin',
    '/auth%2fstudent%2flogin',
    '/auth%5Cstudent%5Clogin',
    '/auth/student%2Flogin',
    '%2Fauth%2Fstudent%2Flogin',
    '/%2Fauth/student/login',
    // Double encoded: one downstream decode reveals the separator.
    '/auth%252Fstudent%252Flogin',
    '%252F%252Fevil.test',
    // Encoded controls and lookalike separators.
    '/auth%0A/student/login',
    '/auth%00/student/login',
    '/auth;/student/login',
    '/AUTH/student/login',
    // Encoded external hosts must never survive as return paths.
    '%2F%2Fevil.test/phish',
    '/%2Fevil.test/phish',
    '/%5Cevil.test/phish',
  ]) {
    assert.equal(resolveStudentReturn(candidate, origin), '/marketplace', candidate);
  }
});

test('still permits ordinary encoded characters outside the pathname separators', () => {
  assert.equal(
    resolveStudentReturn('/marketplace?q=hello%20world&next=%2Fstudent%2Fverification', origin),
    '/marketplace?q=hello%20world&next=%2Fstudent%2Fverification',
  );
  assert.equal(resolveStudentReturn('/student/verification', origin), '/student/verification');
});

test('normalizes an invalid fallback to marketplace', () => {
  assert.equal(resolveStudentReturn(null, origin, 'https://evil.test'), '/marketplace');
});

test('completion destinations cover the exact, trailing-slash, deep, query, and hash forms', () => {
  assert.equal(STUDENT_PROFILE_COMPLETION_PATH, '/student/profile/complete');
  for (const candidate of [
    '/student/profile/complete',
    '/student/profile/complete/',
    '/student/profile/complete/extra',
    '/student/profile/complete?redirect=%2Fmarketplace',
    '/student/profile/complete#form',
  ]) {
    assert.equal(isStudentProfileCompletionDestination(candidate), true, candidate);
  }
  for (const candidate of [
    '/marketplace',
    '/student/profile',
    '/student/profile/completed',
    '/student/verification',
  ]) {
    assert.equal(isStudentProfileCompletionDestination(candidate), false, candidate);
  }
});

test('a completion decision routes to the full screen with the validated continuation', () => {
  assert.equal(
    resolveStudentPostAuthDestination({ decision: 'complete_profile', safeDestination: '/marketplace' }),
    '/student/profile/complete?redirect=%2Fmarketplace',
  );
  assert.equal(
    resolveStudentPostAuthDestination({ decision: 'complete_profile', safeDestination: '/marketplace?from=sso' }),
    '/student/profile/complete?redirect=%2Fmarketplace%3Ffrom%3Dsso',
  );
});

test('a continue decision passes the safe destination through without wrapping', () => {
  for (const safeDestination of [
    '/marketplace',
    '/student/verification',
    '/student/profile/complete?redirect=%2Fmarketplace',
    '/student/profile/complete/extra',
  ]) {
    assert.equal(
      resolveStudentPostAuthDestination({ decision: 'continue', safeDestination }),
      safeDestination,
      safeDestination,
    );
  }
});
