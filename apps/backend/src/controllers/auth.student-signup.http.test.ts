import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { AuthController } from './auth.controller.js';
import { errorHandler } from '../common/middleware/errorHandler.js';
import { createAuthRouter } from '../routes/auth.routes.js';
import { StudentSignupRateLimitError } from '../services/auth/student-signup.service.js';
import { STUDENT_TERMS_VERSION, VERIFICATION_NOTICE_TEXT, VERIFICATION_NOTICE_VERSION } from '../services/verification/verification-notices.js';

const universityId = '4f088fa7-79d9-4c64-a48c-9ecbbbc3c4a3';

async function withServer(
    controller: AuthController,
    operation: (baseUrl: string) => Promise<void>,
): Promise<void> {
    const app = express();
    app.use(express.json());
    app.use('/auth', createAuthRouter(controller));
    app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture did not expose a loopback port');
    try {
        await operation(`http://127.0.0.1:${address.port}/auth`);
    } finally {
        server.close();
        await once(server, 'close');
    }
}

function controller(overrides: Partial<ConstructorParameters<typeof AuthController>[0]> = {}): AuthController {
    return new AuthController({
        studentSignupService: {
            request: async () => ({
                email: 'ada@students.school.example',
                challengeId: 'f996cc5f-04e8-4a74-a11e-4de10f00af10',
                expiresAt: new Date('2026-09-05T12:10:00.000Z'),
                resendAvailableAt: new Date('2026-09-05T12:01:00.000Z'),
            }),
            confirm: async () => ({
                user: { id: '250c68b1-9164-4a99-9780-3b646a750ea5', email: 'ada@students.school.example', role: 'student' as const },
                eligibility: {
                    eligible: false as const,
                    reason: 'unverified' as const,
                },
                expectedPasswordHash: '$2a$12$still-internal-only',
            }),
        },
        studentEmailPreflight: async () => ({ supported: false, reason: 'This school email domain is not approved.' }),
        issueSession: async () => ({ accessToken: 'access-token', refreshToken: 'refresh-token' }),
        readStudentAssurance: async () => ({
            schoolAccountStatus: 'verified' as const,
            schoolAccountMethod: 'email_otp' as const,
            schoolAccountValidUntil: '2026-10-01T00:00:00.000Z',
            studentStatus: 'pending' as const,
            enrollmentMethod: null,
            studentValidUntil: null,
            reason: 'awaiting_enrollment' as const,
        }),
        ...overrides,
    });
}

test('uses the production student handlers for preflight, request, confirm, and the retired generic route', async () => {
    await withServer(controller(), async (baseUrl) => {
        const missingAge = await fetch(`${baseUrl}/student/register-request`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                universityId, email: 'ada@students.school.example', name: 'Ada Student',
                verificationConsent: true, noticeVersion: VERIFICATION_NOTICE_VERSION,
                termsAccepted: true, termsVersion: STUDENT_TERMS_VERSION,
            }),
        });
        assert.equal(missingAge.status, 422);
        assert.equal(((await missingAge.json()) as { error: { code: string } }).error.code, 'SIGNUP_CONTRACT_OUTDATED');

        const underAge = await fetch(`${baseUrl}/student/register-request`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                universityId, email: 'ada@students.school.example', name: 'Ada Student',
                verificationConsent: true, noticeVersion: VERIFICATION_NOTICE_VERSION,
                ageAttested: false, termsAccepted: true, termsVersion: STUDENT_TERMS_VERSION,
            }),
        });
        assert.equal(underAge.status, 422);
        assert.equal(((await underAge.json()) as { error: { code: string } }).error.code, 'SIGNUP_CONTRACT_OUTDATED');

        const invalidEmail = await fetch(`${baseUrl}/student/register-request`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                universityId, email: 'not-an-email', name: 'Ada Student',
                verificationConsent: true, noticeVersion: VERIFICATION_NOTICE_VERSION,
                ageAttested: true, termsAccepted: true, termsVersion: STUDENT_TERMS_VERSION,
            }),
        });
        assert.equal(invalidEmail.status, 422);
        assert.equal(((await invalidEmail.json()) as { error: { code: string } }).error.code, 'VALIDATION_ERROR');

        const preflight = await fetch(`${baseUrl}/verify-student-email`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ universityId, email: 'ada@students.school.example' }),
        });
        assert.equal(preflight.status, 200);
        assert.deepEqual((await preflight.json()).data, {
            supported: false,
            reason: 'This school email domain is not approved.',
            verificationNotice: { version: VERIFICATION_NOTICE_VERSION, text: VERIFICATION_NOTICE_TEXT },
            studentTerms: { version: STUDENT_TERMS_VERSION },
        });

        const request = await fetch(`${baseUrl}/student/register-request`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                universityId, email: 'ada@students.school.example', name: 'Ada Student',
                verificationConsent: true, noticeVersion: VERIFICATION_NOTICE_VERSION,
                ageAttested: true, termsAccepted: true, termsVersion: STUDENT_TERMS_VERSION,
            }),
        });
        assert.equal(request.status, 200);
        assert.deepEqual((await request.json()).data, {
            email: 'ada@students.school.example',
            challengeId: 'f996cc5f-04e8-4a74-a11e-4de10f00af10',
            expiresAt: '2026-09-05T12:10:00.000Z',
            resendAvailableAt: '2026-09-05T12:01:00.000Z',
        });

        const confirmation = await fetch(`${baseUrl}/student/register-confirm`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                universityId, email: 'ada@students.school.example', name: 'Ada Student', password: 'StrongPass123!',
                challengeId: 'f996cc5f-04e8-4a74-a11e-4de10f00af10', otp: '123456',
                verificationConsent: true, noticeVersion: VERIFICATION_NOTICE_VERSION,
                ageAttested: true, termsAccepted: true, termsVersion: STUDENT_TERMS_VERSION,
            }),
        });
        assert.equal(confirmation.status, 201);
        const confirmationBody = await confirmation.json();
        assert.deepEqual(confirmationBody.data.user.eligibility, { eligible: false, reason: 'unverified' });
        assert.deepEqual(confirmationBody.data.user.studentAssurance, {
            schoolAccountStatus: 'verified',
            schoolAccountMethod: 'email_otp',
            schoolAccountValidUntil: '2026-10-01T00:00:00.000Z',
            studentStatus: 'pending',
            enrollmentMethod: null,
            studentValidUntil: null,
            reason: 'awaiting_enrollment',
        });
        assert.equal(confirmationBody.data.tokens.accessToken, 'access-token');
        assert.equal(confirmationBody.data.redirectTo, '/marketplace');
        assert.equal(JSON.stringify(confirmationBody).includes('expectedPasswordHash'), false);

        const retired = await fetch(`${baseUrl}/register`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ role: 'student', email: 'student@example.com', password: 'StrongPass123!', name: 'Student', university: universityId }),
        });
        assert.equal(retired.status, 410);
    });
});

test('rejects stale notice data before confirmation and maps a service cooldown to Retry-After', async () => {
    await withServer(controller({
        studentSignupService: {
            request: async () => { throw new StudentSignupRateLimitError('Please wait before requesting another signup code.', new Date(Date.now() + 60_000)); },
            confirm: async () => { throw new Error('not reached'); },
        },
    }), async (baseUrl) => {
        const missingAge = await fetch(`${baseUrl}/student/register-confirm`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                universityId, email: 'ada@students.school.example', name: 'Ada Student', password: 'StrongPass123!',
                challengeId: 'f996cc5f-04e8-4a74-a11e-4de10f00af10', otp: '123456',
                verificationConsent: true, noticeVersion: VERIFICATION_NOTICE_VERSION,
                termsAccepted: true, termsVersion: STUDENT_TERMS_VERSION,
            }),
        });
        assert.equal(missingAge.status, 422);
        assert.equal(((await missingAge.json()) as { error: { code: string } }).error.code, 'SIGNUP_CONTRACT_OUTDATED');

        const underAge = await fetch(`${baseUrl}/student/register-confirm`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                universityId, email: 'ada@students.school.example', name: 'Ada Student', password: 'StrongPass123!',
                challengeId: 'f996cc5f-04e8-4a74-a11e-4de10f00af10', otp: '123456',
                verificationConsent: true, noticeVersion: VERIFICATION_NOTICE_VERSION,
                ageAttested: false, termsAccepted: true, termsVersion: STUDENT_TERMS_VERSION,
            }),
        });
        assert.equal(underAge.status, 422);
        assert.equal(((await underAge.json()) as { error: { code: string } }).error.code, 'SIGNUP_CONTRACT_OUTDATED');

        const stale = await fetch(`${baseUrl}/student/register-confirm`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                universityId, email: 'ada@students.school.example', name: 'Ada Student', password: 'StrongPass123!',
                challengeId: 'f996cc5f-04e8-4a74-a11e-4de10f00af10', otp: '123456',
                verificationConsent: true, noticeVersion: 'stale-notice',
                ageAttested: true, termsAccepted: true, termsVersion: STUDENT_TERMS_VERSION,
            }),
        });
        assert.equal(stale.status, 422);
        assert.equal(((await stale.json()) as { error: { code: string } }).error.code, 'SIGNUP_CONTRACT_OUTDATED');

        const staleTerms = await fetch(`${baseUrl}/student/register-confirm`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                universityId, email: 'ada@students.school.example', name: 'Ada Student', password: 'StrongPass123!',
                challengeId: 'f996cc5f-04e8-4a74-a11e-4de10f00af10', otp: '123456',
                verificationConsent: true, noticeVersion: VERIFICATION_NOTICE_VERSION,
                ageAttested: true, termsAccepted: true, termsVersion: 'stale-terms',
            }),
        });
        assert.equal(staleTerms.status, 422);
        assert.equal(((await staleTerms.json()) as { error: { code: string } }).error.code, 'SIGNUP_CONTRACT_OUTDATED');

        const cooldown = await fetch(`${baseUrl}/student/register-request`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                universityId, email: 'ada@students.school.example', name: 'Ada Student',
                verificationConsent: true, noticeVersion: VERIFICATION_NOTICE_VERSION,
                ageAttested: true, termsAccepted: true, termsVersion: STUDENT_TERMS_VERSION,
            }),
        });
        assert.equal(cooldown.status, 429);
        assert.match(cooldown.headers.get('retry-after') ?? '', /^\d+$/);
    });
});

test('returns the current notice for a supported preflight without claiming verified mailbox ownership', async () => {
    await withServer(controller({
        studentEmailPreflight: async () => ({ supported: true }),
    }), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/verify-student-email`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ universityId, email: 'ada@students.school.example' }),
        });
        assert.equal(response.status, 200);
        const body = await response.json() as { data: Record<string, unknown> };
        assert.deepEqual(body.data, {
            supported: true,
            verificationNotice: { version: VERIFICATION_NOTICE_VERSION, text: VERIFICATION_NOTICE_TEXT },
            studentTerms: { version: STUDENT_TERMS_VERSION },
        });
        assert.equal('verified' in body.data, false);
        assert.equal('studentData' in body.data, false);
    });
});
