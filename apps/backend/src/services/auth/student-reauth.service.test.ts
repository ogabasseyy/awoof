import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { encryptMicrosoftAttemptVerifier, hashMicrosoftAttemptSecret } from '../verification/microsoft-attempt-crypto.js';
import { assertFreshAuthTime, reauthAttemptIdFromState, StudentReauthService, studentReauthCookieName } from './student-reauth.service.js';

const startedAt = new Date('2026-09-26T12:00:00.000Z');
const now = new Date('2026-09-26T12:01:00.000Z');
const userId = '11111111-1111-4111-8111-111111111111';
const sid = '22222222-2222-4222-8222-222222222222';
const identityId = '33333333-3333-4333-8333-333333333333';
const policyId = '44444444-4444-4444-8444-444444444444';
const attemptKey = Buffer.alloc(32, 7).toString('base64url');
const issuer = 'https://login.microsoftonline.com/55555555-5555-4555-8555-555555555555/v2.0';

function pendingAttempt(overrides: Record<string, unknown> = {}) {
    const id = randomUUID();
    return {
        id, user_id: userId, sid, credential_generation: 0, purpose: 'link', policy_id: policyId, policy_version: 1,
        provider: 'microsoft', state_hash: hashMicrosoftAttemptSecret('state'), callback_cookie_hash: hashMicrosoftAttemptSecret('browser'),
        encrypted_verifier: encryptMicrosoftAttemptVerifier('verifier', attemptKey, id), nonce: 'nonce', proof_identity_id: identityId,
        target_identity_id: null, pending_code_id: null, status: 'pending', expires_at: new Date(Date.now() + 60_000), created_at: new Date(Date.now() - 1_000),
        identity_provider: 'microsoft', identity_issuer: issuer, identity_subject: 'subject', policy_issuer: issuer,
        policy_realm: '55555555-5555-4555-8555-555555555555', university_id: randomUUID(), policy_enabled: true,
        approved_until: new Date(Date.now() + 60_000), policy_approved_by: randomUUID(), now: new Date(),
        ...overrides,
    };
}

function callbackService(observation: { issuer: string; subject: string; authTime: number }, attempt = pendingAttempt()) {
    const calls: string[] = [];
    const query = async (text: string) => {
        calls.push(text);
        if (text.includes('WHERE attempt.state_hash')) return { rows: [attempt], rowCount: 1 };
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
        // The claim transaction observes pending; the post-redemption
        // transaction observes the claimed processing row.
        if (text.includes("SET status = 'processing'")) return { rows: [], rowCount: 1 };
        if (text.includes('WHERE attempt.id = $1 FOR UPDATE')) return { rows: [{ ...attempt, status: 'processing' }], rowCount: 1 };
        if (text.includes('FROM student_auth_reauth_attempts WHERE id = $1 FOR UPDATE')) return { rows: [attempt], rowCount: 1 };
        if (text.includes('clock_timestamp')) return { rows: [{ now: new Date() }], rowCount: 1 };
        if (text.includes('SELECT active_session_id')) return { rows: [{ active_session_id: sid, credential_generation: 0, deleted_at: null }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
    };
    const service = new StudentReauthService({
        pool: { query, connect: async () => ({ query, release: () => undefined }) } as never,
        attemptKey, completionUrl: new URL('https://app.example.invalid/auth/student/sso/complete'),
        isProviderEnabled: () => true,
        oidcForPolicy: () => ({ authorize: async () => new URL('https://provider.example.invalid'), redeem: async () => { throw new Error('ordinary login must not be used'); }, redeemFresh: async () => ({ provider: 'microsoft', issuer: observation.issuer, subject: observation.subject, email: 'student@example.invalid', mailboxVerified: true, realm: '55555555-5555-4555-8555-555555555555', schoolMembershipAttested: false, objectId: 'object', authTime: observation.authTime }) }),
    });
    return { service, calls, attempt };
}

test('accepts the exact sixty-second freshness-skew boundaries', () => {
    assert.doesNotThrow(() => assertFreshAuthTime(Math.floor(startedAt.getTime() / 1000) - 60, startedAt, now));
    assert.doesNotThrow(() => assertFreshAuthTime(Math.floor(now.getTime() / 1000) + 60, startedAt, now));
});

for (const [name, value] of [
    ['missing auth_time', undefined],
    ['auth_time 61 seconds before start', Math.floor(startedAt.getTime() / 1000) - 61],
    ['auth_time 61 seconds in the future', Math.floor(now.getTime() / 1000) + 61],
] as const) {
    test(`rejects ${name}`, () => {
        assert.throws(() => assertFreshAuthTime(value, startedAt, now), /Fresh Microsoft authentication/);
    });
}

test('fresh callback binds browser, issuer and subject and never issues a login session', async () => {
    const { service, calls, attempt } = callbackService({ issuer, subject: 'subject', authTime: Math.floor(Date.now() / 1000) });
    const result = await service.callback({ callbackUrl: new URL('https://api.example.invalid/callback?state=state&code=code'), callbackCookie: 'browser' });
    assert.equal(result.attemptId, attempt.id);
    assert.equal(result.completionUrl.searchParams.get('reauth'), attempt.id);
    assert.ok(calls.some((text) => text.includes("SET status = 'ready'")));
    assert.ok(!calls.some((text) => text.includes('SET active_session_id')));
    assert.ok(!calls.some((text) => text.includes('refresh_token_hash')));
});

test('fresh callback rejects a different Microsoft identity and a different browser', async () => {
    const mismatch = callbackService({ issuer, subject: 'other-subject', authTime: Math.floor(Date.now() / 1000) });
    await assert.rejects(
        mismatch.service.callback({ callbackUrl: new URL('https://api.example.invalid/callback?state=state&code=code'), callbackCookie: 'browser' }),
        /reauthentication is no longer valid/,
    );
    const wrongBrowser = callbackService({ issuer, subject: 'subject', authTime: Math.floor(Date.now() / 1000) });
    await assert.rejects(
        wrongBrowser.service.callback({ callbackUrl: new URL('https://api.example.invalid/callback?state=state&code=code'), callbackCookie: 'other-browser' }),
        /reauthentication is no longer valid/,
    );
    assert.ok(!wrongBrowser.calls.some((text) => text === 'BEGIN'));
});

test('fresh start constrains the identity lookup to Microsoft before selecting the newest row', async () => {
    const calls: string[] = [];
    const identity = {
        identity_id: identityId, provider: 'microsoft', observed_email: 'student@example.invalid',
        policy_id: policyId, policy_version: 1, issuer, realm: '55555555-5555-4555-8555-555555555555',
        university_id: randomUUID(), credential_generation: 0,
    };
    const query = async (text: string) => {
        calls.push(text);
        if (text.includes('FROM users')) return { rows: [identity], rowCount: 1 };
        return { rows: [], rowCount: 1 };
    };
    const service = new StudentReauthService({
        pool: { query, connect: async () => ({ query, release: () => undefined }) } as never,
        attemptKey, completionUrl: new URL('https://app.example.invalid/auth/student/sso/complete'),
        isProviderEnabled: () => true,
        oidcForPolicy: () => ({ authorizeFresh: async () => new URL('https://provider.example.invalid/authorize') }) as never,
    });
    const result = await service.start({ userId, sid, purpose: 'recovery_code_generate' });
    assert.ok(result.authorizationUrl.startsWith('https://'));
    assert.ok(calls.some((text) => text.includes("identity.provider = 'microsoft'")));
    assert.ok(calls.some((text) => text.includes('policy.issuer = identity.issuer')),
        'a replaced tenant must not select a stale-issuer identity for the fresh proof');
    assert.ok(calls.some((text) => text.includes('policy.approved_by IS NOT NULL')),
        'a withdrawn institutional approval must not select the identity for the fresh proof');
});

test('fresh start rejects foreign or missing action targets before issuing an attempt', async () => {
    const ownedTarget = '77777777-7777-4777-8777-777777777777';
    const ownedCode = '88888888-8888-4888-8888-888888888888';
    const identity = {
        identity_id: identityId, provider: 'microsoft', observed_email: 'student@example.invalid',
        policy_id: policyId, policy_version: 1, issuer, realm: '55555555-5555-4555-8555-555555555555',
        university_id: randomUUID(), credential_generation: 0,
    };
    const query = async (text: string, params: unknown[] = []) => {
        if (text.includes('FROM users')) return { rows: [identity], rowCount: 1 };
        if (text.includes('FROM student_auth_identities WHERE id = $1')) {
            return params[0] === ownedTarget ? { rows: [{ id: ownedTarget }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (text.includes('FROM student_auth_recovery_codes WHERE id = $1')) {
            return params[0] === ownedCode ? { rows: [{ id: ownedCode }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 1 };
    };
    const service = new StudentReauthService({
        pool: { query, connect: async () => ({ query, release: () => undefined }) } as never,
        attemptKey, completionUrl: new URL('https://app.example.invalid/auth/student/sso/complete'),
        isProviderEnabled: () => true,
        oidcForPolicy: () => ({ authorizeFresh: async () => new URL('https://provider.example.invalid/authorize') }) as never,
    });
    await assert.rejects(
        service.start({ userId, sid, purpose: 'unlink', targetIdentityId: randomUUID() }),
        /login identity not found/,
    );
    await assert.rejects(
        service.start({ userId, sid, purpose: 'recovery_code_activate', pendingCodeId: randomUUID() }),
        /recovery code not found/,
    );
    await assert.rejects(
        service.start({ userId, sid, purpose: 'unlink', targetIdentityId: 'not-a-uuid' }),
        /reauthentication is no longer valid/,
    );
    const issued = await service.start({ userId, sid, purpose: 'unlink', targetIdentityId: ownedTarget });
    assert.ok(issued.authorizationUrl.startsWith('https://'));
});

test('fresh callback and finish lock the owner before the attempt', async () => {
    const ready = callbackService({ issuer, subject: 'subject', authTime: Math.floor(Date.now() / 1000) });
    await ready.service.callback({ callbackUrl: new URL('https://api.example.invalid/callback?state=state&code=code'), callbackCookie: 'browser' });
    const callbackUser = ready.calls.findIndex((text) => text.includes('FROM users WHERE id = $1 FOR UPDATE'));
    const callbackAttempt = ready.calls.findIndex((text) => text.includes('WHERE attempt.id = $1 FOR UPDATE'));
    assert.ok(callbackUser !== -1 && callbackAttempt !== -1 && callbackUser < callbackAttempt);

    const consumed = pendingAttempt({ status: 'consumed' });
    const finished = callbackService({ issuer, subject: 'subject', authTime: Math.floor(Date.now() / 1000) }, consumed);
    await assert.rejects(
        finished.service.finish({ userId, sid, attemptId: consumed.id, callbackCookie: 'browser' }),
        /reauthentication is no longer valid/,
    );
    const finishUser = finished.calls.findIndex((text) => text.includes('FROM users WHERE id = $1 FOR UPDATE'));
    const finishAttempt = finished.calls.findIndex((text) => text.includes('FROM student_auth_reauth_attempts WHERE id = $1 FOR UPDATE'));
    assert.ok(finishUser !== -1 && finishAttempt !== -1 && finishUser < finishAttempt);
});

test('fresh start binds the issued state to its attempt for scrubbed-callback routing', async () => {
    const identity = {
        identity_id: identityId, provider: 'microsoft', observed_email: 'student@example.invalid',
        policy_id: policyId, policy_version: 1, issuer, realm: '55555555-5555-4555-8555-555555555555',
        university_id: randomUUID(), credential_generation: 0,
    };
    const query = async (text: string) => {
        if (text.includes('FROM users')) return { rows: [identity], rowCount: 1 };
        return { rows: [], rowCount: 1 };
    };
    let issuedState = '';
    const service = new StudentReauthService({
        pool: { query, connect: async () => ({ query, release: () => undefined }) } as never,
        attemptKey, completionUrl: new URL('https://app.example.invalid/auth/student/sso/complete'),
        isProviderEnabled: () => true,
        oidcForPolicy: () => ({
            authorizeFresh: async (input: { state: string }) => { issuedState = input.state; return new URL('https://provider.example.invalid/authorize'); },
        }) as never,
    });
    const result = await service.start({ userId, sid, purpose: 'link' });
    assert.equal(reauthAttemptIdFromState(issuedState), result.attemptId);
});

test('state attempt binding accepts only a single uuid suffix', () => {
    const id = '66666666-6666-4666-8666-666666666666';
    assert.equal(reauthAttemptIdFromState(`random-part.${id}`), id);
    assert.equal(reauthAttemptIdFromState('no-suffix-state'), null);
    assert.equal(reauthAttemptIdFromState(`${id}`), null);
    assert.equal(reauthAttemptIdFromState(`a.${id}.extra`), null);
    assert.equal(reauthAttemptIdFromState('a.not-a-uuid'), null);
    assert.equal(reauthAttemptIdFromState(null), null);
});

test('callback cookie resolution selects the state-selected attempt only', async () => {
    const attemptId = '66666666-6666-4666-8666-666666666666';
    const query = async (text: string, params: unknown[]) => {
        if (text.includes('FROM student_auth_reauth_attempts WHERE state_hash')) {
            const match = params[0] === hashMicrosoftAttemptSecret('matching-state');
            return match ? { rows: [{ id: attemptId }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        throw new Error(`unexpected query: ${text}`);
    };
    const service = new StudentReauthService({
        pool: { query } as never, attemptKey,
        completionUrl: new URL('https://app.example.invalid/auth/student/sso/complete'),
        isProviderEnabled: () => true, oidcForPolicy: () => { throw new Error('must not redeem'); },
    });
    assert.equal(await service.callbackCookieNameForState('matching-state'), studentReauthCookieName(attemptId));
    assert.equal(await service.callbackCookieNameForState('other-state'), null);
    assert.equal(await service.callbackCookieNameForState(null), null);
    assert.equal(await service.isReauthState('matching-state'), true);
    assert.equal(await service.isReauthState('other-state'), false);
});

test('fresh finish rejects a consumed attempt before any action grant is issued', async () => {
    const consumed = pendingAttempt({ status: 'consumed' });
    const { service, calls } = callbackService({ issuer, subject: 'subject', authTime: Math.floor(Date.now() / 1000) }, consumed);
    await assert.rejects(
        service.finish({ userId, sid, attemptId: consumed.id, callbackCookie: 'browser' }),
        /reauthentication is no longer valid/,
    );
    assert.ok(calls.some((text) => text.includes('FROM student_auth_reauth_attempts WHERE id = $1 FOR UPDATE')));
    assert.ok(!calls.some((text) => text.includes('INSERT INTO student_auth_action_grants')));
});
