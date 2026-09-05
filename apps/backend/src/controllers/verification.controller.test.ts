import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { Request, Response } from 'express';
import { VerificationController } from './verification.controller.js';

it('rejects a phone OTP without university enrollment evidence', async () => {
    const controller = new VerificationController();
    await assert.rejects(controller.verifyWhatsAppOTP({
        body: { phoneNumber: '+2348000000000', otp: '123456' },
    } as Request, {} as Response));
});
