import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import { db } from '../config/database.js';
import { UnauthorizedError } from '../common/errors/AppError.js';
import { jwtService } from '../services/auth/jwt.service.js';
import { authenticate } from './auth.middleware.js';

test('passwordless-policy student access JWT becomes invalid immediately when recovery clears its session', async (t) => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const staleSid = '22222222-2222-4222-8222-222222222222';
    const token = jwtService.generateAccessToken({ userId, email: 'student@example.invalid', role: 'student', sid: staleSid });
    t.mock.method(db, 'getPool', () => ({
        query: async () => ({ rows: [{
            password_setup_requires_recovery_code: true,
            recovery_reenrollment_requires_password: true,
            active_session_id: null,
            deleted_at: null,
        }], rowCount: 1 }),
    }) as never);
    const error = await new Promise<unknown>((resolve) => {
        authenticate({ headers: { authorization: `Bearer ${token}` } } as Request, {} as Response, resolve);
    });
    assert.ok(error instanceof UnauthorizedError);
});

test('vendor JWT authentication remains crypto-only and does not query student session state', async (t) => {
    const token = jwtService.generateAccessToken({ userId: '11111111-1111-4111-8111-111111111111', email: 'vendor@example.invalid', role: 'vendor' });
    t.mock.method(db, 'getPool', () => { throw new Error('vendor must not query student sessions'); });
    const result = await new Promise<unknown>((resolve) => {
        authenticate({ headers: { authorization: `Bearer ${token}` } } as Request, {} as Response, resolve);
    });
    assert.equal(result, undefined);
});
