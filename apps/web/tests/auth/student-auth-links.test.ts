import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStudentAuthLinks } from '../../src/lib/student-auth-links';

const origin = 'https://awoof.test';

test('student auth links preserve a same-origin widget return path', () => {
  assert.deepEqual(createStudentAuthLinks('/marketplace?source=widget', origin), {
    loginPath: '/auth/student/login?redirect=%2Fmarketplace%3Fsource%3Dwidget',
    registerPath: '/auth/student/register?redirect=%2Fmarketplace%3Fsource%3Dwidget',
  });
  assert.deepEqual(createStudentAuthLinks('https://awoof.test/marketplace?source=widget', origin), {
    loginPath: '/auth/student/login?redirect=%2Fmarketplace%3Fsource%3Dwidget',
    registerPath: '/auth/student/register?redirect=%2Fmarketplace%3Fsource%3Dwidget',
  });
});

test('student auth links reject unsafe, malformed, and auth-loop return paths', () => {
  for (const candidate of [
    'https://other.test/marketplace',
    '//other.test/marketplace',
    'javascript:alert(1)',
    '\\marketplace',
    '/marketplace?source=%',
    '/auth/student/login',
  ]) {
    assert.deepEqual(createStudentAuthLinks(candidate, origin), {
      loginPath: '/auth/student/login?redirect=%2Fmarketplace',
      registerPath: '/auth/student/register?redirect=%2Fmarketplace',
    });
  }
});

test('student auth links remain plain routes until a browser origin is available', () => {
  assert.deepEqual(createStudentAuthLinks('/marketplace?source=widget', null), {
    loginPath: '/auth/student/login',
    registerPath: '/auth/student/register',
  });
});
