import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import { db } from '../config/database.js';
import { redis } from '../config/redis.js';
import { AuthController } from './auth.controller.js';
import { jwtService } from '../services/auth/jwt.service.js';
import { passwordService } from '../services/auth/password.service.js';

test('refresh rejects an unregistered token when Redis is unavailable', async (t) => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const token = jwtService.generateRefreshToken({
        userId,
        email: 'student@example.invalid',
        role: 'student',
    });
    const responses: unknown[] = [];
    const responseRecorder = {
        status: () => responseRecorder,
        json: (body: unknown) => { responses.push(body); },
    };

    t.mock.method(redis, 'getClient', () => ({}) as ReturnType<typeof redis.getClient>);
    t.mock.method(redis, 'isConnected', () => false);
    t.mock.method(db, 'query', async () => ({ rows: [], rowCount: 0 }) as never);

    await assert.rejects(new AuthController().refreshToken(
        { body: { refreshToken: token } } as Request,
        responseRecorder as unknown as Response,
    ));
    assert.deepEqual(responses, []);
});

test('password reset atomically clears the durable refresh session', async (t) => {
    const calls: Array<{ text: string; params: unknown[] | undefined }> = [];
    const userId = '11111111-1111-4111-8111-111111111111';
    t.mock.method(db, 'query', async (text: string, params?: unknown[]) => {
        calls.push({ text, params });
        if (calls.length === 1) {
            return {
                rows: [{
                    id: userId,
                    email: 'student@example.invalid',
                    password_reset_otp: '123456',
                    password_reset_otp_expires_at: new Date(Date.now() + 60_000),
                    credential_generation: 1,
                }],
                rowCount: 1,
            } as never;
        }
        return { rows: [], rowCount: 1 } as never;
    });
    t.mock.method(passwordService, 'hashPassword', async () => 'new-password-hash');
    t.mock.method(redis, 'getClient', () => ({}) as ReturnType<typeof redis.getClient>);
    t.mock.method(redis, 'isConnected', () => false);
    const responses: unknown[] = [];
    const responseRecorder = {
        status: () => responseRecorder,
        json: (body: unknown) => { responses.push(body); },
    };

    await new AuthController().resetPassword({
        body: { email: 'student@example.invalid', otp: '123456', newPassword: 'ValidNew1!' },
    } as Request, responseRecorder as unknown as Response);

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].params, ['new-password-hash', userId, '123456', 1]);
    assert.match(calls[1].text, /password_reset_otp = \$3 AND credential_generation = \$4/);
    assert.match(calls[1].text, /password_reset_otp_expires_at > CURRENT_TIMESTAMP/);
    assert.match(calls[1].text, /refresh_token_hash = NULL/);
    assert.match(calls[1].text, /refresh_token_expires_at = NULL/);
    assert.match(calls[1].text, /active_session_id = NULL/);
    assert.match(calls[1].text, /credential_generation = credential_generation \+ 1/);
    assert.equal((responses[0] as { message: string }).message, 'Password reset successfully');
});

test('password reset fails closed when the OTP is consumed before the write lands', async (t) => {
    const userId = '11111111-1111-4111-8111-111111111111';
    t.mock.method(db, 'query', async (text: string) => {
        if (text.startsWith('SELECT')) {
            return {
                rows: [{
                    id: userId,
                    email: 'student@example.invalid',
                    password_reset_otp: '123456',
                    password_reset_otp_expires_at: new Date(Date.now() + 60_000),
                    credential_generation: 1,
                }],
                rowCount: 1,
            } as never;
        }
        // Recovery or a superseding OTP landed during hashing: the
        // conditional update matches nothing instead of overwriting it.
        return { rows: [], rowCount: 0 } as never;
    });
    t.mock.method(passwordService, 'hashPassword', async () => 'new-password-hash');
    const responseRecorder = { status: () => responseRecorder, json: () => undefined };
    await assert.rejects(new AuthController().resetPassword({
        body: { email: 'student@example.invalid', otp: '123456', newPassword: 'ValidNew1!' },
    } as Request, responseRecorder as unknown as Response), /Invalid OTP/);
});

test('legacy password-reset lookup excludes recovery-code marker accounts after a password exists', async (t) => {
    const calls: string[] = [];
    t.mock.method(db, 'query', async (text: string) => {
        calls.push(text);
        return { rows: [], rowCount: 0 } as never;
    });
    const responseRecorder = { status: () => responseRecorder, json: () => undefined };
    await assert.rejects(new AuthController().resetPassword({
        body: { email: 'student@example.invalid', otp: '123456', newPassword: 'ValidNew1!' },
    } as Request, responseRecorder as unknown as Response));
    assert.match(calls[0]!, /password_setup_requires_recovery_code = false/);
});

test('authenticated password change atomically clears the durable refresh session', async (t) => {
    const calls: Array<{ text: string; params: unknown[] | undefined }> = [];
    const userId = '11111111-1111-4111-8111-111111111111';
    t.mock.method(db, 'query', async (text: string, params?: unknown[]) => {
        calls.push({ text, params });
        if (calls.length === 1) {
            return { rows: [{ id: userId, password_hash: 'old-password-hash', credential_generation: 1 }], rowCount: 1 } as never;
        }
        return { rows: [], rowCount: 1 } as never;
    });
    t.mock.method(passwordService, 'comparePassword', async () => true);
    t.mock.method(passwordService, 'hashPassword', async () => 'new-password-hash');
    const responses: unknown[] = [];
    const responseRecorder = {
        status: () => responseRecorder,
        json: (body: unknown) => { responses.push(body); },
    };

    await new AuthController().updatePassword({
        user: { userId, email: 'student@example.invalid', role: 'student' },
        body: { oldPassword: 'old-password', newPassword: 'ValidNew1!' },
    } as Request, responseRecorder as unknown as Response);

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].params, ['new-password-hash', userId, 'old-password-hash', 1]);
    assert.match(calls[1].text, /password_hash = \$3 AND credential_generation = \$4/);
    assert.match(calls[1].text, /refresh_token_hash = NULL/);
    assert.match(calls[1].text, /refresh_token_expires_at = NULL/);
    assert.match(calls[1].text, /active_session_id = NULL/);
    assert.match(calls[1].text, /credential_generation = credential_generation \+ 1/);
    assert.equal((responses[0] as { message: string }).message, 'Password updated successfully');
});

test('authenticated password change fails closed when recovery commits during hashing', async (t) => {
    const userId = '11111111-1111-4111-8111-111111111111';
    t.mock.method(db, 'query', async (text: string) => {
        if (text.startsWith('SELECT')) {
            return { rows: [{ id: userId, password_hash: 'old-password-hash', credential_generation: 1 }], rowCount: 1 } as never;
        }
        // Recovery committed between verification and the write: the
        // conditional update matches nothing instead of overwriting the
        // recovered password.
        return { rows: [], rowCount: 0 } as never;
    });
    t.mock.method(passwordService, 'comparePassword', async () => true);
    t.mock.method(passwordService, 'hashPassword', async () => 'new-password-hash');
    const responseRecorder = { status: () => responseRecorder, json: () => undefined };
    await assert.rejects(new AuthController().updatePassword({
        user: { userId, email: 'student@example.invalid', role: 'student' },
        body: { oldPassword: 'old-password', newPassword: 'ValidNew1!' },
    } as Request, responseRecorder as unknown as Response), /Password changed during this update/);
});
