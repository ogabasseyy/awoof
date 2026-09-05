import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMailbox, normalizeStudentDomain } from './eligibility-policy.service.js';

test('rejects non-exact student domains instead of widening policy', () => {
    for (const value of ['*.school.example', 'https://school.example', 'school.example:443']) {
        assert.throws(() => normalizeStudentDomain(value), /domain/i);
    }
    assert.equal(normalizeStudentDomain(' Students.School.Example '), 'students.school.example');
});

test('normalizes a mailbox but rejects URL-shaped values', () => {
    assert.equal(normalizeMailbox(' Student@Students.School.Example '), 'student@students.school.example');
    assert.throws(() => normalizeMailbox('https://student@school.example'), /mailbox/i);
});
