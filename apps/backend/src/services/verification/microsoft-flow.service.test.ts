import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { ConflictError } from '../../common/errors/AppError.js';
import { encryptMicrosoftAttemptVerifier, hashMicrosoftAttemptSecret } from './microsoft-attempt-crypto.js';
import { MicrosoftAuthorityInvalidatedError } from './microsoft-authority.service.js';
import { MicrosoftFlowService, canonicalizeEducationObservation, linkMicrosoftIdentity } from './microsoft-flow.service.js';

const userId = '11111111-1111-4111-8111-111111111111';
const sid = '22222222-2222-4222-8222-222222222222';
const universityId = '33333333-3333-4333-8333-333333333333';
const processingGrantId = '44444444-4444-4444-8444-444444444444';
const providerConsentId = '55555555-5555-4555-8555-555555555555';
const tenantId = '66666666-6666-4666-8666-666666666666';

function startService(noticeVersion: string): { service: MicrosoftFlowService; inserted: () => unknown[] | undefined } {
    let insert: unknown[] | undefined;
    const tx = { query: async (text: string, values: unknown[] = []) => {
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rowCount: 0, rows: [] };
        if (text.trimStart().startsWith('SELECT clock_timestamp()')) return { rowCount: 1, rows: [{ now: new Date() }] };
        if (text.includes('FROM users')) return { rowCount: 1, rows: [{ id: userId, email: 'student@example.invalid', role: 'student', deleted_at: null }] };
        if (text.includes('FROM students')) return { rowCount: 1, rows: [{ id: 'student-id', university_id: universityId, identity_version: 1, status: 'active' }] };
        if (text.includes('FROM universities')) return { rowCount: 1, rows: [{ id: universityId, is_active: true, verification_policy_version: 1 }] };
        if (text.includes('student_eligibility_state')) return { rowCount: 1, rows: [{}] };
        if (text.includes('JOIN institution_microsoft_policies')) return { rowCount: 1, rows: [{ mode: 'identity_only' }] };
        if (text.includes('FROM verification_consents')) return { rowCount: 1, rows: [{}] };
        if (text.includes('FROM institution_microsoft_policies')) return { rowCount: 1, rows: [{ tenant_id: tenantId, version: 1, enabled: true, mode: 'identity_only', approved_until: new Date(Date.now() + 60_000), scopes: ['openid', 'profile'], notice_version: noticeVersion }] };
        if (text.includes('FROM microsoft_verification_consents')) return { rowCount: 1, rows: [{}] };
        if (text.includes('count(*)')) return { rowCount: 1, rows: [{ count: '0' }] };
        if (text.includes('INSERT INTO microsoft_verification_attempts')) { insert = values; const now = new Date(); return { rowCount: 1, rows: [{ expires_at: new Date(now.getTime() + 600_000), now }] }; }
        if (text.includes('FROM microsoft_verification_attempts')) {
            if (text.includes('SELECT id')) return { rowCount: 1, rows: [{ id: insert?.[0] }] };
            return { rowCount: 1, rows: [{ id: insert?.[0], user_id: userId, university_id: universityId, institution_policy_version: 1, provider_policy_version: 1, identity_version: 1, processing_grant_id: processingGrantId, provider_consent_id: providerConsentId, server_session_id: sid, encrypted_verifier: 'x', nonce: 'x', expires_at: new Date(Date.now() + 60_000), status: 'pending', result: null }] };
        }
        throw new Error(`Unexpected query ${text}`);
    }, release: () => undefined };
    const pool = {
        connect: async () => tx,
        query: async (text: string) => {
            if (text.includes('SELECT diagnostic_correlation_id')) {
                return { rowCount: 1, rows: [{ diagnostic_correlation_id: insert?.[9], university_id: universityId, institution_policy_version: 1 }] };
            }
            if (text.includes('INSERT INTO verification_diagnostic_events')) return { rowCount: 1, rows: [] };
            throw new Error(`Unexpected direct pool query ${text}`);
        },
    };
    const service = new MicrosoftFlowService({
        pool: pool as never,
        oidc: { authorize: async () => 'https://login.microsoftonline.com/authorize', redeem: async () => { throw new Error('not used'); } },
        verifierEncryptionKey: randomBytes(32).toString('base64url'), callbackUrl: new URL('https://api.example.test/api/verification/microsoft/callback'), completionUrl: new URL('https://app.example.test/student/verification/microsoft/complete'),
        isEnabled: () => true,
        diagnostics: { record: async () => undefined },
    });
    return { service, inserted: () => insert };
}

test('start keeps the browser secret exclusively in typed cookie instructions and persists only hashes', async () => {
    const { service, inserted } = startService('microsoft-v3');
    const result = await service.start({ userId, serverSessionId: sid, processingGrantId, providerConsentId });
    assert.equal(result.callbackCookie.name, `awoof_ms_${result.publicResult.attemptId}`);
    assert.equal(result.callbackCookie.maxAgeSeconds, 600);
    assert.equal(result.callbackCookie.path, '/api/verification/microsoft/callback');
    assert.equal(Object.values(result.publicResult).includes(result.callbackCookie.value), false);
    const insert = inserted();
    assert.ok(insert);
    assert.equal(insert!.includes(result.callbackCookie.value), false);
    assert.equal(insert!.includes(result.publicResult.finishSecret), false);
    assert.equal(typeof insert![9], 'string');
    assert.notEqual(insert![9], result.publicResult.attemptId);
    assert.ok(Number.isFinite(Date.parse(result.publicResult.expiresAt)));
    assert.ok(Number.isFinite(Date.parse(result.publicResult.serverNow)));
    assert.ok(Date.parse(result.publicResult.expiresAt) > Date.parse(result.publicResult.serverNow));
});

test('start refuses a new attempt under a legacy Microsoft notice policy', async () => {
    const { service, inserted } = startService('microsoft-v2');
    await assert.rejects(
        service.start({ userId, serverSessionId: sid, processingGrantId, providerConsentId }),
        (error: unknown) => error instanceof ConflictError,
    );
    assert.equal(inserted(), undefined);
});

function linkTx(queries: (text: string) => { rows: Record<string, unknown>[]; rowCount: number } | never, onInsert?: () => void): PoolClient {
    return {
        query: async (text: string) => {
            if (text.includes('INSERT INTO microsoft_identities')) {
                onInsert?.();
                return queries(text);
            }
            return queries(text);
        },
    } as unknown as PoolClient;
}

const linkInput = { userId, universityId, tenantId, objectId: '77777777-7777-4777-8777-777777777777' };

test('linkMicrosoftIdentity reuses the same active owner identity', async () => {
    let inserts = 0;
    const tx = linkTx((text) => {
        if (text.includes('WHERE tenant_id=$1 AND object_id=$2')) {
            return { rows: [{ id: 'identity-1', user_id: userId, university_id: universityId, revoked_at: null }], rowCount: 1 };
        }
        throw new Error(`Unexpected query ${text}`);
    }, () => { inserts += 1; });
    assert.equal(await linkMicrosoftIdentity(tx, linkInput), 'identity-1');
    assert.equal(inserts, 0);
});

test('linkMicrosoftIdentity conflicts when another active identity exists for the university', async () => {
    const tx = linkTx((text) => {
        if (text.includes('WHERE tenant_id=$1 AND object_id=$2')) return { rows: [], rowCount: 0 };
        if (text.includes('WHERE user_id=$1 AND university_id=$2')) return { rows: [{ id: 'identity-existing' }], rowCount: 1 };
        throw new Error(`Unexpected query ${text}`);
    });
    await assert.rejects(linkMicrosoftIdentity(tx, linkInput), (error: unknown) => error instanceof ConflictError);
});

type CallbackScenario = { authorityFailsAt: 'never' | 'claim' | 'post'; expired: boolean; wrongKey?: boolean };

function callbackHarness(scenario: CallbackScenario): { service: MicrosoftFlowService; invoke: () => Promise<{ attemptId: string; outcome?: string; completionUrl: URL }> } {
    const callbackAttemptId = '99999999-9999-4999-8999-999999999999';
    const callbackTenant = '88888888-8888-4888-8888-888888888888';
    const callbackObject = '77777777-7777-4777-8777-777777777777';
    const browserCookie = 'callback-browser-secret';
    const key = randomBytes(32).toString('base64url');
    const attempt = {
        id: callbackAttemptId, user_id: userId, university_id: universityId, institution_policy_version: 1,
        provider_policy_version: 1, identity_version: 1, processing_grant_id: processingGrantId,
        provider_consent_id: providerConsentId, server_session_id: sid,
        encrypted_verifier: encryptMicrosoftAttemptVerifier('verifier-canary', key, callbackAttemptId),
        nonce: 'nonce-canary', expires_at: new Date(Date.now() + (scenario.expired ? -60_000 : 60_000)), status: 'pending', result: null,
    };
    let redeemed = false;
    const txQuery = async (text: string) => {
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rowCount: 0, rows: [] };
        if (text.includes('SELECT browser_secret_hash')) return { rowCount: 1, rows: [{ browser_secret_hash: hashMicrosoftAttemptSecret(browserCookie) }] };
        if (text.includes('JOIN institution_microsoft_policies')) return { rowCount: 1, rows: [{ mode: 'identity_only' }] };
        if (text.includes('FROM microsoft_verification_consents')) {
            if (scenario.authorityFailsAt === 'claim' || (scenario.authorityFailsAt === 'post' && redeemed)) throw new MicrosoftAuthorityInvalidatedError();
            return { rowCount: 1, rows: [{ id: providerConsentId }] };
        }
        if (text.includes('FROM verification_consents')) return { rowCount: 1, rows: [{ id: processingGrantId }] };
        if (text.includes('FROM institution_microsoft_policies WHERE university_id')) {
            return { rowCount: 1, rows: [{ tenant_id: callbackTenant, version: 1, enabled: true, mode: 'identity_only',
                approved_until: new Date(Date.now() + 60_000), term_ends_at: null, max_evidence_hours: 24,
                scopes: ['openid', 'profile'], notice_version: 'microsoft-v3' }] };
        }
        if (text.trimStart().startsWith('SELECT clock_timestamp()')) return { rowCount: 1, rows: [{ now: new Date() }] };
        if (text.includes('FROM users') && text.includes("role = 'student'")) return { rowCount: 1, rows: [{ id: userId, email: 'student@example.invalid' }] };
        if (text.includes('active_session_id')) return { rowCount: 1, rows: [{ id: userId }] };
        if (text.includes('FROM students WHERE user_id')) return { rowCount: 1, rows: [{ status: 'active' }] };
        if (text.includes('SELECT id, email, role, deleted_at')) {
            return { rowCount: 1, rows: [{ id: userId, email: 'Student@Example.Invalid', role: 'student', deleted_at: null }] };
        }
        if (text.includes('SELECT id, university_id, identity_version, status')) {
            return { rowCount: 1, rows: [{ id: 'student-1', university_id: universityId, identity_version: 1, status: 'active' }] };
        }
        if (text.includes('SELECT id, is_active, verification_policy_version')) {
            return { rowCount: 1, rows: [{ id: universityId, is_active: true, verification_policy_version: 1 }] };
        }
        if (text.includes('FROM student_eligibility_state')) return { rowCount: 1, rows: [{ authoritative_denial: false }] };
        if (text.includes('SELECT id FROM microsoft_verification_attempts WHERE id = $1 FOR UPDATE')) return { rowCount: 1, rows: [{ id: callbackAttemptId }] };
        if (text.includes('SELECT * FROM microsoft_verification_attempts WHERE id=$1')) return { rowCount: 1, rows: [attempt] };
        if (text.includes("SET status='processing'")) return { rowCount: 1, rows: [] };
        if (text.includes("SET status='failed'")) return { rowCount: 1, rows: [] };
        throw new Error(`Unexpected query ${text}`);
    };
    const pool = {
        connect: async () => ({ query: async (text: string, values: unknown[] = []) => {
            if (text.includes('WHERE state_hash=$1')) {
                assert.equal(values[0], hashMicrosoftAttemptSecret('callback-state'));
                return { rowCount: 1, rows: [attempt] };
            }
            return txQuery(text);
        }, release: () => undefined }),
        query: async (text: string) => {
            if (text.includes('diagnostic_correlation_id')) return { rowCount: 0, rows: [] };
            throw new Error(`Unexpected direct pool query ${text}`);
        },
    } as unknown as Pool;
    const service = new MicrosoftFlowService({
        pool,
        oidc: { authorize: async () => { throw new Error('not used'); },
            redeem: async () => {
                assert.equal(scenario.authorityFailsAt, 'post', 'token exchange must not dispatch for pre-redemption failures');
                redeemed = true;
                return { identity: { tenantId: callbackTenant, objectId: callbackObject } };
            } },
        verifierEncryptionKey: scenario.wrongKey ? randomBytes(32).toString('base64url') : key,
        callbackUrl: new URL('https://api.example.test/api/verification/microsoft/callback'),
        completionUrl: new URL('https://app.example.test/student/verification/microsoft/complete'),
        isEnabled: () => true,
        diagnostics: { record: async () => undefined },
    });
    const callbackUrl = new URL('https://api.example.test/api/verification/microsoft/callback?state=callback-state&code=canary');
    return { service, invoke: () => service.callback({ callbackUrl, browserCookies: [{ name: `awoof_ms_${callbackAttemptId}`, value: browserCookie }] }) };
}

async function assertBoundedCompletion(scenario: CallbackScenario): Promise<void> {
    const { invoke } = callbackHarness(scenario);
    const result = await invoke();
    assert.equal(result.attemptId, '99999999-9999-4999-8999-999999999999');
    assert.equal(result.outcome, 'connection_not_completed');
    assert.equal(result.completionUrl.searchParams.get('attempt'), '99999999-9999-4999-8999-999999999999');
    assert.equal(result.completionUrl.searchParams.get('outcome'), 'connection_not_completed');
}

test('callback returns a bounded completion page instead of a raw error when authority is lost after token redemption', async () => {
    await assertBoundedCompletion({ authorityFailsAt: 'post', expired: false });
});

test('callback returns a bounded completion page when authority is lost after the cookie check but before redemption', async () => {
    await assertBoundedCompletion({ authorityFailsAt: 'claim', expired: false });
});

test('callback returns a bounded completion page for an authenticated expired attempt', async () => {
    await assertBoundedCompletion({ authorityFailsAt: 'never', expired: true });
});

test('callback terminalizes instead of 500ing when the stored verifier no longer decrypts', async () => {
    // wrongKey makes decryptMicrosoftAttemptVerifier throw inside the claim
    // transaction; the oidc harness asserts redemption never dispatches.
    await assertBoundedCompletion({ authorityFailsAt: 'never', expired: false, wrongKey: true });
});

test('canonicalizeEducationObservation re-stamps student observations with the database clock', () => {
    const appClock = new Date('2026-09-19T10:00:00.000Z');
    const databaseClock = new Date('2026-09-19T12:00:00.000Z');
    assert.deepEqual(
        canonicalizeEducationObservation({ outcome: 'student', objectId: 'oid', observedAt: appClock }, databaseClock),
        { outcome: 'student', objectId: 'oid', observedAt: databaseClock },
    );
    assert.equal(canonicalizeEducationObservation({ outcome: 'unknown', reason: 'unavailable' }, databaseClock)?.outcome, 'unknown');
    assert.equal(canonicalizeEducationObservation(undefined, databaseClock), undefined);
});

test('linkMicrosoftIdentity maps an insert race to a conflict instead of a 500', async () => {
    const tx = linkTx((text) => {
        if (text.includes('WHERE tenant_id=$1 AND object_id=$2')) return { rows: [], rowCount: 0 };
        if (text.includes('WHERE user_id=$1 AND university_id=$2')) return { rows: [], rowCount: 0 };
        if (text.includes('INSERT INTO microsoft_identities')) throw Object.assign(new Error('duplicate key'), { code: '23505' });
        throw new Error(`Unexpected query ${text}`);
    });
    await assert.rejects(linkMicrosoftIdentity(tx, linkInput), (error: unknown) => error instanceof ConflictError);
});
