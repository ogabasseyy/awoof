import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import { BadRequestError } from '../common/errors/AppError.js';
import { bodyIds, issuanceUnavailableCompletion, isQuotaExcusedCallback } from './microsoft-verification.routes.js';

const START_IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';

function reqWith(body: unknown): Request {
    return { body } as Request;
}

test('bodyIds accepts UUID start identifiers', () => {
    const body = bodyIds(reqWith({ processingGrantId: START_IDS[0], providerConsentId: START_IDS[1] }), ['processingGrantId', 'providerConsentId']);
    assert.equal(body.processingGrantId, START_IDS[0]);
});

test('bodyIds rejects malformed start identifiers instead of leaking a database error', () => {
    assert.throws(
        () => bodyIds(reqWith({ processingGrantId: 'not-a-uuid', providerConsentId: START_IDS[1] }), ['processingGrantId', 'providerConsentId']),
        (error: unknown) => error instanceof BadRequestError,
    );
});

test('issuanceUnavailableCompletion clears only the cookie bound to the resolved attempt', async () => {
    const pool = { query: async () => ({ rows: [{ id: ATTEMPT_ID }] }) } as never;
    const completion = new URL('https://app.example.test/student/verification/microsoft/complete');
    const result = await issuanceUnavailableCompletion(pool, completion, 'some-state');
    assert.equal(result.location, `${completion.href}?attempt=${ATTEMPT_ID}&outcome=connection_not_completed`);
    assert.deepEqual(result.clearCookies, [`awoof_ms_${ATTEMPT_ID}`]);
});

test('issuanceUnavailableCompletion clears nothing when no attempt resolves', async () => {
    const pool = { query: async () => ({ rows: [] }) } as never;
    const completion = new URL('https://app.example.test/student/verification/microsoft/complete');
    const result = await issuanceUnavailableCompletion(pool, completion, 'unknown-state');
    assert.equal(result.location, completion.href);
    assert.deepEqual(result.clearCookies, []);
});

test('outage redirects count toward the callback quota while authenticated completions are excused', () => {
    const verdict = (statusCode: number, locals: object): boolean =>
        isQuotaExcusedCallback({} as Request, { statusCode, locals } as unknown as Response);
    assert.equal(verdict(303, {}), true);
    assert.equal(verdict(303, { outageRedirect: true }), false);
    assert.equal(verdict(500, {}), false);
    assert.equal(verdict(429, {}), false);
});

test('bodyIds keeps finishSecret opaque while requiring a UUID attemptId', () => {
    const body = bodyIds(reqWith({ attemptId: ATTEMPT_ID, finishSecret: 'opaque-secret-value' }), ['attemptId', 'finishSecret']);
    assert.equal(body.finishSecret, 'opaque-secret-value');
    assert.throws(
        () => bodyIds(reqWith({ attemptId: 'not-a-uuid', finishSecret: 'opaque-secret-value' }), ['attemptId', 'finishSecret']),
        (error: unknown) => error instanceof BadRequestError,
    );
});
