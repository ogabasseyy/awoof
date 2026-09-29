import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import { db } from '../config/database.js';
import { ServiceUnavailableError, UnauthorizedError } from '../common/errors/AppError.js';
import { jwtService } from '../services/auth/jwt.service.js';
import { authenticate, optionalAuth } from './auth.middleware.js';

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

test('legacy sid-less student JWT stays revoked after recovery re-enrollment clears its marker', async (t) => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const token = jwtService.generateAccessToken({ userId, email: 'student@example.invalid', role: 'student' });
    // Re-enrollment cleared the UX marker, but the persistent binding it
    // imposed outlives it: the attacker's pre-recovery token cannot
    // resurrect once the owner finishes re-enrollment.
    t.mock.method(db, 'getPool', () => ({
        query: async () => ({ rows: [{
            password_setup_requires_recovery_code: false,
            recovery_reenrollment_requires_password: false,
            recovery_session_binding_required: true,
            active_session_id: null,
            deleted_at: null,
        }], rowCount: 1 }),
    }) as never);
    const error = await new Promise<unknown>((resolve) => {
        authenticate({ headers: { authorization: `Bearer ${token}` } } as Request, {} as Response, resolve);
    });
    assert.ok(error instanceof UnauthorizedError);
});

test('session-bound student JWT remains valid while its session is live', async (t) => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const liveSid = '22222222-2222-4222-8222-222222222222';
    const token = jwtService.generateAccessToken({ userId, email: 'student@example.invalid', role: 'student', sid: liveSid });
    t.mock.method(db, 'getPool', () => ({ query: async () => ({ rows: [{
        password_setup_requires_recovery_code: false, recovery_reenrollment_requires_password: false,
        recovery_session_binding_required: true, active_session_id: liveSid, deleted_at: null,
    }], rowCount: 1 }) }) as never);
    const req = { headers: { authorization: `Bearer ${token}` } } as Request;
    const result = await new Promise<unknown>((resolve) => authenticate(req, {} as Response, resolve));
    assert.equal(result, undefined);
    assert.equal(req.user?.userId, userId);
});

test('vendor JWT authentication remains crypto-only and does not query student session state', async (t) => {
    const token = jwtService.generateAccessToken({ userId: '11111111-1111-4111-8111-111111111111', email: 'vendor@example.invalid', role: 'vendor' });
    t.mock.method(db, 'getPool', () => { throw new Error('vendor must not query student sessions'); });
    const result = await new Promise<unknown>((resolve) => {
        authenticate({ headers: { authorization: `Bearer ${token}` } } as Request, {} as Response, resolve);
    });
    assert.equal(result, undefined);
});

test('ordinary student JWT remains valid after a successful durable policy lookup', async (t) => {
    const token = jwtService.generateAccessToken({ userId: '11111111-1111-4111-8111-111111111111', email: 'student@example.invalid', role: 'student' });
    t.mock.method(db, 'getPool', () => ({ query: async () => ({ rows: [{
        password_setup_requires_recovery_code: false, recovery_reenrollment_requires_password: false,
        active_session_id: null, deleted_at: null,
    }], rowCount: 1 }) }) as never);
    const req = { headers: { authorization: `Bearer ${token}` } } as Request;
    const result = await new Promise<unknown>((resolve) => authenticate(req, {} as Response, resolve));
    assert.equal(result, undefined);
    assert.equal(req.user?.userId, '11111111-1111-4111-8111-111111111111');
});

test('ordinary student access JWT is rejected once its session is revoked', async (t) => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const staleSid = '22222222-2222-4222-8222-222222222222';
    const token = jwtService.generateAccessToken({ userId, email: 'student@example.invalid', role: 'student', sid: staleSid });
    // Unlinking the identity that issued this password-backed session
    // cleared the server session without setting any policy flag.
    t.mock.method(db, 'getPool', () => ({
        query: async () => ({ rows: [{
            password_setup_requires_recovery_code: false,
            recovery_reenrollment_requires_password: false,
            active_session_id: null,
            deleted_at: null,
        }], rowCount: 1 }),
    }) as never);
    const error = await new Promise<unknown>((resolve) => {
        authenticate({ headers: { authorization: `Bearer ${token}` } } as Request, {} as Response, resolve);
    });
    assert.ok(error instanceof UnauthorizedError);
});

test('ordinary student access JWT remains valid while its session is live', async (t) => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const liveSid = '22222222-2222-4222-8222-222222222222';
    const token = jwtService.generateAccessToken({ userId, email: 'student@example.invalid', role: 'student', sid: liveSid });
    t.mock.method(db, 'getPool', () => ({ query: async () => ({ rows: [{
        password_setup_requires_recovery_code: false, recovery_reenrollment_requires_password: false,
        active_session_id: liveSid, deleted_at: null,
    }], rowCount: 1 }) }) as never);
    const req = { headers: { authorization: `Bearer ${token}` } } as Request;
    const result = await new Promise<unknown>((resolve) => authenticate(req, {} as Response, resolve));
    assert.equal(result, undefined);
    assert.equal(req.user?.userId, userId);
});

test('student session lookup outages surface 503 and optional authentication does not attach identity', async (t) => {
    const token = jwtService.generateAccessToken({ userId: '11111111-1111-4111-8111-111111111111', email: 'student@example.invalid', role: 'student', sid: '22222222-2222-4222-8222-222222222222' });
    t.mock.method(db, 'getPool', () => ({ query: async () => { throw new Error('database unavailable'); } }) as never);
    const strict = await new Promise<unknown>((resolve) => authenticate({ headers: { authorization: `Bearer ${token}` } } as Request, {} as Response, resolve));
    assert.ok(strict instanceof ServiceUnavailableError);
    const optionalRequest = { headers: { authorization: `Bearer ${token}` } } as Request;
    const optional = await new Promise<unknown>((resolve) => optionalAuth(optionalRequest, {} as Response, resolve));
    assert.ok(optional instanceof ServiceUnavailableError);
    assert.equal(optionalRequest.user, undefined);
});
