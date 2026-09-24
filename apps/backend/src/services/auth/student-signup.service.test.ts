import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeLegacySignupInput, normalizeStudentSignupRequest } from './student-signup.service.js';
import { isEmailConfigured } from '../email/email.service.js';
import { STUDENT_TERMS_VERSION, VERIFICATION_NOTICE_VERSION } from '../verification/verification-notices.js';

test('normalizes the mailbox and preserves a null or trimmed self-declared matric number', () => {
    const nullMatric = normalizeStudentSignupRequest({
        email: '  Ada@Students.School.Example ',
        name: '  Ada Student  ',
        universityId: '4f088fa7-79d9-4c64-a48c-9ecbbbc3c4a3',
        matricNumber: '   ',
        verificationConsent: true,
        noticeVersion: VERIFICATION_NOTICE_VERSION,
        ageAttested: true,
        termsAccepted: true,
        termsVersion: STUDENT_TERMS_VERSION,
    });
    assert.deepEqual(nullMatric, {
        email: 'ada@students.school.example',
        name: 'Ada Student',
        universityId: '4f088fa7-79d9-4c64-a48c-9ecbbbc3c4a3',
        matricNumber: null,
        verificationConsent: true,
        noticeVersion: VERIFICATION_NOTICE_VERSION,
        ageAttested: true,
        termsAccepted: true,
        termsVersion: STUDENT_TERMS_VERSION,
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
        ageAttested: true,
        termsAccepted: true,
        termsVersion: STUDENT_TERMS_VERSION,
    };
    assert.throws(() => normalizeStudentSignupRequest(input), /Current verification processing consent required/);
    assert.throws(() => normalizeStudentSignupRequest({
        ...input,
        verificationConsent: true,
        noticeVersion: 'stale-notice',
    }), /Current verification processing consent required/);
});

test('rejects a missing terms acceptance and stale terms version', () => {
    const input = {
        email: 'ada@students.school.example',
        name: 'Ada Student',
        universityId: '4f088fa7-79d9-4c64-a48c-9ecbbbc3c4a3',
        matricNumber: null,
        verificationConsent: true,
        noticeVersion: VERIFICATION_NOTICE_VERSION,
        ageAttested: true,
        termsAccepted: false,
        termsVersion: STUDENT_TERMS_VERSION,
    };
    assert.throws(() => normalizeStudentSignupRequest(input), /Current student terms acceptance required/);
    assert.throws(() => normalizeStudentSignupRequest({
        ...input,
        termsAccepted: true,
        termsVersion: 'stale-terms',
    }), /Current student terms acceptance required/);
});

test('rejects signup unless the applicant affirmatively declares they are at least 18', () => {
    const input = {
        email: 'ada@students.school.example',
        name: 'Ada Student',
        universityId: '4f088fa7-79d9-4c64-a48c-9ecbbbc3c4a3',
        matricNumber: null,
        verificationConsent: true,
        noticeVersion: VERIFICATION_NOTICE_VERSION,
        termsAccepted: true,
        termsVersion: STUDENT_TERMS_VERSION,
    };
    assert.throws(() => normalizeStudentSignupRequest(input), /18 or older/);
    assert.throws(() => normalizeStudentSignupRequest({ ...input, ageAttested: false }), /18 or older/);
    assert.equal(normalizeStudentSignupRequest({ ...input, ageAttested: true }).ageAttested, true);
});

test('rejects non-six-digit signup confirmation codes', () => {
    assert.throws(() => normalizeStudentSignupRequest({
        email: 'ada@students.school.example',
        name: 'Ada Student',
        universityId: '4f088fa7-79d9-4c64-a48c-9ecbbbc3c4a3',
        matricNumber: null,
        verificationConsent: true,
        noticeVersion: VERIFICATION_NOTICE_VERSION,
        ageAttested: true,
        termsAccepted: true,
        termsVersion: STUDENT_TERMS_VERSION,
        otp: '12345x',
    }), /six digits/);
});

test('normalizes the exact pre-cutover confirmation shape as unattested Terms 1.0', () => {
    const legacy = normalizeLegacySignupInput({
        email: '  Ada@Students.School.Example ',
        name: '  Ada Student  ',
        universityId: '4f088fa7-79d9-4c64-a48c-9ecbbbc3c4a3',
        matricNumber: '   ',
        verificationConsent: true,
        noticeVersion: VERIFICATION_NOTICE_VERSION,
        ageAttested: false,
        termsAccepted: true,
        termsVersion: '1.0',
    });
    assert.deepEqual(legacy, {
        email: 'ada@students.school.example',
        name: 'Ada Student',
        universityId: '4f088fa7-79d9-4c64-a48c-9ecbbbc3c4a3',
        matricNumber: null,
        verificationConsent: true,
        noticeVersion: VERIFICATION_NOTICE_VERSION,
        ageAttested: false,
        termsAccepted: true,
        termsVersion: '1.0',
    });
});

test('legacy confirmation fails closed on mixed contracts and stale consent', () => {
    const input = {
        email: 'ada@students.school.example',
        name: 'Ada Student',
        universityId: '4f088fa7-79d9-4c64-a48c-9ecbbbc3c4a3',
        matricNumber: null,
        verificationConsent: true,
        noticeVersion: VERIFICATION_NOTICE_VERSION,
        ageAttested: false,
        termsAccepted: true,
        termsVersion: '1.0',
    };
    assert.throws(() => normalizeLegacySignupInput({ ...input, ageAttested: true }), /must not carry an age declaration/);
    assert.throws(() => normalizeLegacySignupInput({ ...input, termsVersion: STUDENT_TERMS_VERSION }), /Terms version 1.0/);
    assert.throws(() => normalizeLegacySignupInput({ ...input, termsAccepted: false }), /Terms version 1.0/);
    assert.throws(() => normalizeLegacySignupInput({ ...input, noticeVersion: 'stale-notice' }), /Current verification processing consent required/);
    assert.throws(() => normalizeLegacySignupInput({ ...input, name: 'A' }), /between 2 and 255/);
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
