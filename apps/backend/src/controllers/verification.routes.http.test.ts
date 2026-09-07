import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { VerificationController } from './verification.controller.js';
import { createVerificationRouter } from '../routes/verification.routes.js';
import { errorHandler } from '../common/middleware/errorHandler.js';
import { jwtService } from '../services/auth/jwt.service.js';
import type { VerificationFlowService } from '../services/verification/verification-flow.service.js';
import { MERCHANT_DISCLOSURE_NOTICE_VERSION, VERIFICATION_NOTICE_VERSION } from '../services/verification/verification-notices.js';

const userId = '4f088fa7-79d9-4c64-a48c-9ecbbbc3c4a3';
const universityId = 'b9c35781-9f75-44b6-98ca-0c928fb993a9';
const grantId = 'd0a31f59-4b5c-4424-bb59-f841295384c7';
const challengeId = 'f996cc5f-04e8-4a74-a11e-4de10f00af10';

function token(): string {
    return jwtService.generateAccessToken({ userId, email: 'ada@students.school.example', role: 'student' });
}

function flow(calls: string[]): VerificationFlowService {
    return {
        initiate: async (subject, input) => {
            calls.push(`initiate:${subject}:${input.universityId}`);
            return {
                email: 'ada@students.school.example', universityId, processingGrantId: grantId,
                eligibility: { eligible: false as const, reason: 'unverified' as const },
                notices: {
                    verification: { version: VERIFICATION_NOTICE_VERSION, text: 'current verification notice' },
                    merchantDisclosure: { version: MERCHANT_DISCLOSURE_NOTICE_VERSION, text: 'current disclosure notice' },
                },
            };
        },
        requestEmail: async () => ({
            challengeId, expiresAt: new Date('2026-09-05T12:10:00.000Z'), resendAvailableAt: new Date('2026-09-05T12:01:00.000Z'),
        }),
        confirmEmail: async () => ({ eligible: false as const, reason: 'unverified' as const }),
        verifyRegistration: async (subject, input) => {
            calls.push(`registration:${subject}:${input.registrationNumber}:${input.processingGrantId}`);
            return { eligibility: { eligible: false as const, reason: 'unverified' as const }, reason: 'provider_unknown' as const };
        },
        status: async () => ({
            email: 'ada@students.school.example', universityId,
            eligibility: { eligible: false as const, reason: 'unverified' as const },
            notices: {
                verification: { version: VERIFICATION_NOTICE_VERSION, text: 'current verification notice' },
                merchantDisclosure: { version: MERCHANT_DISCLOSURE_NOTICE_VERSION, text: 'current disclosure notice' },
            },
        }),
        grantDisclosure: async () => ({ grantId }),
        withdrawConsent: async () => undefined,
    };
}

async function withServer(controller: VerificationController, operation: (baseUrl: string) => Promise<void>): Promise<void> {
    const app = express();
    app.use(express.json());
    app.use('/verification', createVerificationRouter(controller));
    app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture did not expose a loopback port');
    try {
        await operation(`http://127.0.0.1:${address.port}/verification`);
    } finally {
        server.close();
        await once(server, 'close');
    }
}

test('retires the public magic-link and WhatsApp verification routes without reading caller identity', async () => {
    await withServer(new VerificationController({ flow: flow([]) }), async (baseUrl) => {
        for (const request of [
            { path: '/email', init: { method: 'POST', body: {} } },
            { path: '/email/verify', init: { method: 'GET' } },
            { path: '/whatsapp/request', init: { method: 'POST', body: {} } },
            { path: '/whatsapp/verify', init: { method: 'POST', body: {} } },
            { path: '/status/54e75b23-9ad0-4a94-8aa3-f720225296af', init: { method: 'GET' } },
        ]) {
            const response = await fetch(`${baseUrl}${request.path}`, {
                method: request.init.method,
                headers: request.init.method === 'POST' ? { 'content-type': 'application/json' } : undefined,
                body: request.init.method === 'POST' ? JSON.stringify(request.init.body) : undefined,
            });
            assert.equal(response.status, 410, `${request.path} must be permanently retired`);
            const body = await response.json() as { success: boolean; error?: { message?: string } };
            assert.equal(body.success, false);
            assert.match(body.error?.message ?? '', /upgrade|unavailable/i);
        }
    });
});

test('rejects caller identity fields from every signed-in email challenge body', async () => {
    await withServer(new VerificationController({ flow: flow([]) }), async (baseUrl) => {
        const headers = { 'content-type': 'application/json', authorization: `Bearer ${token()}` };
        const request = await fetch(`${baseUrl}/email/request`, {
            method: 'POST', headers,
            body: JSON.stringify({ processingGrantId: grantId, email: 'victim@students.school.example' }),
        });
        assert.equal(request.status, 422);
        const confirm = await fetch(`${baseUrl}/email/confirm`, {
            method: 'POST', headers,
            body: JSON.stringify({ challengeId, otp: '123456', studentId: '54e75b23-9ad0-4a94-8aa3-f720225296af' }),
        });
        assert.equal(confirm.status, 422);
    });
});

test('requires a real access JWT and rejects body identity substitution before invoking the authenticated flow', async () => {
    const calls: string[] = [];
    await withServer(new VerificationController({ flow: flow(calls) }), async (baseUrl) => {
        const anonymous = await fetch(`${baseUrl}/initiate`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ universityId, accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION }),
        });
        assert.equal(anonymous.status, 401);

        const substituted = await fetch(`${baseUrl}/initiate`, {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
            body: JSON.stringify({
                universityId, accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION,
                email: 'victim@students.school.example', studentId: '54e75b23-9ad0-4a94-8aa3-f720225296af',
            }),
        });
        assert.equal(substituted.status, 422);
        assert.deepEqual(calls, []);

        const initiated = await fetch(`${baseUrl}/initiate`, {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
            body: JSON.stringify({ universityId, accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION }),
        });
        assert.equal(initiated.status, 200);
        assert.deepEqual(calls, [`initiate:${userId}:${universityId}`]);
        const body = await initiated.json() as { data: Record<string, unknown> };
        assert.equal(body.data.email, 'ada@students.school.example');
        assert.equal(JSON.stringify(body).toLowerCase().includes('token'), false);
    });
});

test('accepts only the strict authenticated registration body and keeps merchant-token unavailable', async () => {
    const calls: string[] = [];
    await withServer(new VerificationController({ flow: flow(calls) }), async (baseUrl) => {
        const headers = { 'content-type': 'application/json', authorization: `Bearer ${token()}` };
        const rejected = await fetch(`${baseUrl}/registration`, {
            method: 'POST', headers,
            body: JSON.stringify({ processingGrantId: grantId, registrationNumber: 'REG-1', email: 'victim@students.school.example' }),
        });
        assert.equal(rejected.status, 422);
        assert.deepEqual(calls, []);

        const registration = await fetch(`${baseUrl}/registration`, {
            method: 'POST', headers,
            body: JSON.stringify({ processingGrantId: grantId, registrationNumber: 'REG-1' }),
        });
        assert.equal(registration.status, 200);
        const registrationBody = await registration.json() as Record<string, unknown>;
        assert.match(JSON.stringify(registrationBody), /provider_unknown/);
        assert.deepEqual(calls, [`registration:${userId}:REG-1:${grantId}`]);

        const widget = await fetch(`${baseUrl}/widget/token`, { method: 'POST', headers, body: JSON.stringify({}) });
        assert.equal(widget.status, 503);
        const serialized = JSON.stringify(await widget.json()).toLowerCase();
        assert.equal(serialized.includes('accesstoken'), false);
        assert.equal(serialized.includes('refreshtoken'), false);
    });
});

test('rejects an invalid public institution identifier before availability SQL is invoked', async () => {
    let queried = false;
    await withServer(new VerificationController({
        flow: flow([]),
        getAvailableMethods: async () => {
            queried = true;
            return [];
        },
    }), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/methods/not-a-uuid`);
        assert.equal(response.status, 422);
        assert.equal(queried, false);
    });
});
