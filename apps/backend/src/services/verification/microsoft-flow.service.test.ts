import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { MicrosoftFlowService } from './microsoft-flow.service.js';

const userId = '11111111-1111-4111-8111-111111111111';
const sid = '22222222-2222-4222-8222-222222222222';
const universityId = '33333333-3333-4333-8333-333333333333';
const processingGrantId = '44444444-4444-4444-8444-444444444444';
const providerConsentId = '55555555-5555-4555-8555-555555555555';
const tenantId = '66666666-6666-4666-8666-666666666666';

test('start keeps the browser secret exclusively in typed cookie instructions and persists only hashes', async () => {
    let insert: unknown[] | undefined;
    const tx = { query: async (text: string, values: unknown[] = []) => {
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rowCount: 0, rows: [] };
        if (text.trimStart().startsWith('SELECT clock_timestamp()')) return { rowCount: 1, rows: [{ now: new Date() }] };
        if (text.includes('FROM users')) return { rowCount: 1, rows: [{ id: userId, email: 'student@example.invalid', role: 'student', deleted_at: null }] };
        if (text.includes('FROM students')) return { rowCount: 1, rows: [{ id: 'student-id', university_id: universityId, identity_version: 1, status: 'active' }] };
        if (text.includes('FROM universities')) return { rowCount: 1, rows: [{ id: universityId, is_active: true, verification_policy_version: 1 }] };
        if (text.includes('student_eligibility_state')) return { rowCount: 1, rows: [{}] };
        if (text.includes('FROM verification_consents')) return { rowCount: 1, rows: [{}] };
        if (text.includes('FROM institution_microsoft_policies')) return { rowCount: 1, rows: [{ tenant_id: tenantId, version: 1, enabled: true, mode: 'identity_only', approved_until: new Date(Date.now() + 60_000), scopes: ['openid', 'profile'], notice_version: 'microsoft-v1' }] };
        if (text.includes('FROM microsoft_verification_consents')) return { rowCount: 1, rows: [{}] };
        if (text.includes('count(*)')) return { rowCount: 1, rows: [{ count: '0' }] };
        if (text.includes('INSERT INTO microsoft_verification_attempts')) { insert = values; return { rowCount: 1, rows: [] }; }
        if (text.includes('FROM microsoft_verification_attempts')) {
            if (text.includes('SELECT id')) return { rowCount: 1, rows: [{ id: insert?.[0] }] };
            return { rowCount: 1, rows: [{ id: insert?.[0], user_id: userId, university_id: universityId, institution_policy_version: 1, provider_policy_version: 1, identity_version: 1, processing_grant_id: processingGrantId, provider_consent_id: providerConsentId, server_session_id: sid, encrypted_verifier: 'x', nonce: 'x', expires_at: new Date(Date.now() + 60_000), status: 'pending', result: null }] };
        }
        throw new Error(`Unexpected query ${text}`);
    }, release: () => undefined };
    const service = new MicrosoftFlowService({
        pool: { connect: async () => tx } as never,
        oidc: { authorize: async () => 'https://login.microsoftonline.com/authorize', redeem: async () => { throw new Error('not used'); } },
        verifierEncryptionKey: randomBytes(32).toString('base64url'), callbackUrl: new URL('https://api.example.test/api/verification/microsoft/callback'), completionUrl: new URL('https://app.example.test/student/verification/microsoft/complete'),
        isEnabled: () => true,
    });
    const result = await service.start({ userId, serverSessionId: sid, processingGrantId, providerConsentId });
    assert.equal(result.callbackCookie.name, `awoof_ms_${result.publicResult.attemptId}`);
    assert.equal(result.callbackCookie.maxAgeSeconds, 600);
    assert.equal(result.callbackCookie.path, '/api/verification/microsoft/callback');
    assert.equal(Object.values(result.publicResult).includes(result.callbackCookie.value), false);
    assert.ok(insert);
    assert.equal(insert!.includes(result.callbackCookie.value), false);
    assert.equal(insert!.includes(result.publicResult.finishSecret), false);
});
