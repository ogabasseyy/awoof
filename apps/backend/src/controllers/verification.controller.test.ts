import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import { ForbiddenError } from '../common/errors/AppError.js';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import { VerificationController } from './verification.controller.js';

function responseRecorder() {
    const bodies: unknown[] = [];
    const recorder = {
        status: () => recorder,
        set: () => recorder,
        json: (body: unknown) => { bodies.push(body); },
    };
    return { bodies, res: recorder as unknown as Response };
}

const disclosureBody = {
    vendorId: '4f088fa7-79d9-4c64-a48c-9ecbbbc3c4a3',
    origin: 'https://shop.example.com',
    purpose: 'Check eligibility for this test checkout',
    accepted: true as const,
    noticeVersion: 'pilot-notice-v1',
};

test('grantMerchantDisclosure records consent when the session still matches', async () => {
    const calls: Array<{ userId: string }> = [];
    const controller = new VerificationController({
        flow: { grantDisclosure: async (userId: string) => { calls.push({ userId }); return { grantId: 'grant-1' }; } } as never,
    });
    const { bodies, res } = responseRecorder();
    const req = {
        user: { userId: '00000000-0000-4000-8000-000000000001' },
        body: { ...disclosureBody, expectedUserId: '00000000-0000-4000-8000-000000000001' },
    } as unknown as AuthRequest;
    await controller.grantMerchantDisclosure(req, res);
    assert.equal(calls.length, 1);
    assert.deepEqual((bodies[0] as { data: unknown }).data, { grantId: 'grant-1' });
});

test('grantMerchantDisclosure refuses to record consent after a session switch', async () => {
    const calls: Array<{ userId: string }> = [];
    const controller = new VerificationController({
        flow: { grantDisclosure: async (userId: string) => { calls.push({ userId }); return { grantId: 'grant-1' }; } } as never,
    });
    const { res } = responseRecorder();
    const req = {
        user: { userId: '11111111-1111-4111-8111-111111111111' },
        body: { ...disclosureBody, expectedUserId: '00000000-0000-4000-8000-000000000001' },
    } as unknown as AuthRequest;
    await assert.rejects(controller.grantMerchantDisclosure(req, res), ForbiddenError);
    assert.equal(calls.length, 0);
});

test('grantMerchantDisclosure without an expected identity keeps legacy behavior', async () => {
    const calls: Array<{ userId: string }> = [];
    const controller = new VerificationController({
        flow: { grantDisclosure: async (userId: string) => { calls.push({ userId }); return { grantId: 'grant-1' }; } } as never,
    });
    const { res } = responseRecorder();
    const req = {
        user: { userId: '00000000-0000-4000-8000-000000000001' },
        body: { ...disclosureBody },
    } as unknown as AuthRequest;
    await controller.grantMerchantDisclosure(req, res);
    assert.equal(calls.length, 1);
});
