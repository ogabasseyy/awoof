import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { Request, Response } from 'express';
import { VerificationController } from './verification.controller.js';
import { db } from '../config/database.js';
import type { AuthRequest } from '../middleware/auth.middleware.js';

it('rejects a phone OTP without university enrollment evidence', async () => {
    const controller = new VerificationController();
    await assert.rejects(controller.verifyWhatsAppOTP({
        body: { phoneNumber: '+2348000000000', otp: '123456' },
    } as Request, {} as Response));
});

it('returns the authenticated student ID with the widget token', async (t) => {
    const studentId = '11111111-1111-4111-8111-111111111111';
    const vendorId = '22222222-2222-4222-8222-222222222222';
    const replies = [
        [{ vendor_id: vendorId }],
        [{ id: studentId, status: 'active' }],
        [{ verification_status: 'verified' }],
        [{ id: studentId, status: 'active', verification_status: 'verified' }],
        [{ id: vendorId }],
        [],
    ];
    t.mock.method(db, 'query', async () => {
        const rows = replies.shift();
        assert.ok(rows, 'unexpected database query');
        return { rows };
    });
    let responseBody: { data: { studentId: string; token: string } } | undefined;
    const res = {
        status: () => res,
        json: (body: typeof responseBody) => { responseBody = body; },
    };
    await new VerificationController().generateWidgetToken({
        user: { userId: 'authenticated-user', role: 'student' },
        body: { vendorId, apiKey: 'test-widget-key', origin: 'https://vendor.example', studentId: 'untrusted-input' },
    } as AuthRequest, res as unknown as Response);
    assert.equal(responseBody?.data.studentId, studentId);
    assert.ok(responseBody?.data.token);
    assert.equal(replies.length, 0);
});
