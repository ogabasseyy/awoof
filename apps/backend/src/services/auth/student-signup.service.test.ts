import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeStudentSignupRequest } from './student-signup.service.js';
import { isEmailConfigured } from '../email/email.service.js';
import { VERIFICATION_NOTICE_VERSION } from '../verification/verification-notices.js';

test('normalizes the mailbox and preserves a null or trimmed self-declared matric number', () => {
    const nullMatric = normalizeStudentSignupRequest({
        email: '  Ada@Students.School.Example ',
        name: '  Ada Student  ',
        universityId: '4f088fa7-79d9-4c64-a48c-9ecbbbc3c4a3',
        matricNumber: '   ',
        verificationConsent: true,
        noticeVersion: VERIFICATION_NOTICE_VERSION,
    });
    assert.deepEqual(nullMatric, {
        email: 'ada@students.school.example',
        name: 'Ada Student',
        universityId: '4f088fa7-79d9-4c64-a48c-9ecbbbc3c4a3',
        matricNumber: null,
        verificationConsent: true,
        noticeVersion: VERIFICATION_NOTICE_VERSION,
    });

    assert.equal(normalizeStudentSignupRequest({
        ...nullMatric,
        matricNumber: '  MAT-001  ',
    }).matricNumber, 'MAT-001');
});

test('rejects a missing affirmative notice action and stale notice version', () => {
    const input = {
        email: 'ada@students.school.example',
        name: 'Ada Student',
        universityId: '4f088fa7-79d9-4c64-a48c-9ecbbbc3c4a3',
        matricNumber: null,
        verificationConsent: false,
        noticeVersion: VERIFICATION_NOTICE_VERSION,
    };
    assert.throws(() => normalizeStudentSignupRequest(input), /Current verification processing consent required/);
    assert.throws(() => normalizeStudentSignupRequest({
        ...input,
        verificationConsent: true,
        noticeVersion: 'stale-notice',
    }), /Current verification processing consent required/);
});

test('rejects non-six-digit signup confirmation codes', () => {
    assert.throws(() => normalizeStudentSignupRequest({
        email: 'ada@students.school.example',
        name: 'Ada Student',
        universityId: '4f088fa7-79d9-4c64-a48c-9ecbbbc3c4a3',
        matricNumber: null,
        verificationConsent: true,
        noticeVersion: VERIFICATION_NOTICE_VERSION,
        otp: '12345x',
    }), /six digits/);
});

test('treats only a non-empty Brevo key as configured email delivery', () => {
    const original = process.env.BREVO_API_KEY;
    try {
        delete process.env.BREVO_API_KEY;
        assert.equal(isEmailConfigured(), false);
        process.env.BREVO_API_KEY = '   ';
        assert.equal(isEmailConfigured(), false);
        process.env.BREVO_API_KEY = 'synthetic-test-key';
        assert.equal(isEmailConfigured(), true);
    } finally {
        if (original === undefined) delete process.env.BREVO_API_KEY;
        else process.env.BREVO_API_KEY = original;
    }
});
