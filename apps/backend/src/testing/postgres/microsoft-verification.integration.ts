import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { db } from '../../config/database.js';
import { grantVerificationProcessing, withdrawConsent } from '../../services/verification/eligibility-consent.service.js';
import { acceptMicrosoftConsent, withdrawMicrosoftConsent } from '../../services/verification/microsoft-consent.service.js';
import { VERIFICATION_NOTICE_VERSION } from '../../services/verification/verification-notices.js';
import { inTransaction, withTestClient } from './test-database.js';

after(() => db.close());

type Fixture = { adminId: string; userId: string; universityId: string; processingGrantId: string };

async function fixture(): Promise<Fixture> {
    return withTestClient(async (client) => inTransaction(client, async () => {
        const suffix = randomUUID().slice(0, 8);
        const adminId = (await client.query<{ id: string }>(`INSERT INTO users (email, role) VALUES ($1, 'admin') RETURNING id`, [`admin-${suffix}@example.invalid`])).rows[0]!.id;
        const userId = (await client.query<{ id: string }>(`INSERT INTO users (email, role) VALUES ($1, 'student') RETURNING id`, [`student-${suffix}@example.invalid`])).rows[0]!.id;
        const universityId = (await client.query<{ id: string }>(`INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id`, [`Microsoft ${suffix}`])).rows[0]!.id;
        await client.query(`INSERT INTO students (user_id, name, university_id) VALUES ($1, 'Student', $2)`, [userId, universityId]);
        await client.query(
            `INSERT INTO institution_microsoft_policies
                 (university_id, tenant_id, enabled, mode, approved_until, approved_by, term_ends_at, max_evidence_hours, scopes, notice_version)
             VALUES ($1, $2, true, 'identity_only', clock_timestamp() + interval '30 days', $3, NULL, 24, ARRAY['openid', 'profile'], 'microsoft-v1')`,
            [universityId, randomUUID(), adminId],
        );
        const processingGrantId = await grantVerificationProcessing(client, userId, universityId, { accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION });
        return { adminId, userId, universityId, processingGrantId };
    }));
}

test('Microsoft authority rejects duplicate identities and disabled-policy consent starts', async () => {
    const data = await fixture();
    await withTestClient(async (client) => inTransaction(client, async () => {
        const policy = (await client.query<{ version: number }>(`SELECT version FROM institution_microsoft_policies WHERE university_id = $1`, [data.universityId])).rows[0]!;
        await assert.rejects(() => acceptMicrosoftConsent(client, data.userId, {
            accepted: true, processingGrantId: data.processingGrantId,
            snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version + 1, noticeVersion: 'microsoft-v1', mode: 'identity_only', scopes: ['openid', 'profile'] },
        }), { statusCode: 409, code: 'consent_notice_changed' });
    }));
    await withTestClient(async (client) => inTransaction(client, async () => {
        await client.query(`UPDATE institution_microsoft_policies SET enabled = false WHERE university_id = $1`, [data.universityId]);
        const policy = (await client.query<{ version: number }>(`SELECT version FROM institution_microsoft_policies WHERE university_id = $1`, [data.universityId])).rows[0]!;
        await assert.rejects(() => acceptMicrosoftConsent(client, data.userId, {
            accepted: true, processingGrantId: data.processingGrantId,
            snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v1', mode: 'identity_only', scopes: ['openid', 'profile'] },
        }), { statusCode: 409, code: 'consent_notice_changed' });
    }));
    await withTestClient(async (client) => inTransaction(client, async () => {
        const tenantId = randomUUID(); const objectId = randomUUID();
        await client.query(`INSERT INTO microsoft_identities (user_id, university_id, tenant_id, object_id) VALUES ($1, $2, $3, $4)`, [data.userId, data.universityId, tenantId, objectId]);
        await assert.rejects(() => client.query(`INSERT INTO microsoft_identities (user_id, university_id, tenant_id, object_id) VALUES ($1, $2, $3, $4)`, [data.userId, data.universityId, tenantId, objectId]));
    }));
});

test('policy changes and provider withdrawal cancel pending attempts and scrub sensitive payloads', async () => {
    const data = await fixture();
    await withTestClient(async (client) => inTransaction(client, async () => {
        const policy = (await client.query<{ version: number }>(`SELECT version FROM institution_microsoft_policies WHERE university_id = $1`, [data.universityId])).rows[0]!;
        const consentId = await acceptMicrosoftConsent(client, data.userId, {
            accepted: true, processingGrantId: data.processingGrantId,
            snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v1', mode: 'identity_only', scopes: ['openid', 'profile'] },
        });
        const attemptId = randomUUID();
        await client.query(
            `INSERT INTO microsoft_verification_attempts
                 (id, user_id, university_id, institution_policy_version, provider_policy_version, identity_version, processing_grant_id, provider_consent_id, server_session_id, state_hash, browser_secret_hash, finish_secret_hash, encrypted_verifier, nonce, expires_at, status)
             VALUES ($1, $2, $3, 1, $4, 1, $5, $6, $7, $8, 'browser', 'finish', 'encrypted', 'nonce', clock_timestamp() + interval '10 minutes', 'pending')`,
            [attemptId, data.userId, data.universityId, policy.version, data.processingGrantId, consentId, randomUUID(), `state-${randomUUID()}`],
        );
        await client.query(`UPDATE institution_microsoft_policies SET max_evidence_hours = 23 WHERE university_id = $1`, [data.universityId]);
        const changed = (await client.query<{ status: string; encrypted_verifier: string | null; nonce: string | null }>(`SELECT status, encrypted_verifier, nonce FROM microsoft_verification_attempts WHERE id = $1`, [attemptId])).rows[0]!;
        assert.deepEqual(changed, { status: 'failed', encrypted_verifier: null, nonce: null });

        const providerAttemptId = randomUUID();
        await client.query(
            `INSERT INTO microsoft_verification_attempts
                 (id, user_id, university_id, institution_policy_version, provider_policy_version, identity_version, processing_grant_id, provider_consent_id, server_session_id, state_hash, browser_secret_hash, finish_secret_hash, encrypted_verifier, nonce, expires_at, status)
             VALUES ($1, $2, $3, 1, $4, 1, $5, $6, $7, $8, 'browser', 'finish', 'encrypted', 'nonce', clock_timestamp() + interval '10 minutes', 'pending')`,
            [providerAttemptId, data.userId, data.universityId, policy.version, data.processingGrantId, consentId, randomUUID(), `state-${randomUUID()}`],
        );
        await withdrawMicrosoftConsent(client, data.userId, consentId);
        const cancelled = (await client.query<{ status: string; encrypted_verifier: string | null; nonce: string | null }>(`SELECT status, encrypted_verifier, nonce FROM microsoft_verification_attempts WHERE id = $1`, [providerAttemptId])).rows[0]!;
        assert.deepEqual(cancelled, { status: 'failed', encrypted_verifier: null, nonce: null });
    }));
});

test('parent processing withdrawal cancels its dependent Microsoft attempt', async () => {
    const data = await fixture();
    await withTestClient(async (client) => inTransaction(client, async () => {
        const policy = (await client.query<{ version: number }>(`SELECT version FROM institution_microsoft_policies WHERE university_id = $1`, [data.universityId])).rows[0]!;
        const consentId = await acceptMicrosoftConsent(client, data.userId, { accepted: true, processingGrantId: data.processingGrantId,
            snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v1', mode: 'identity_only', scopes: ['openid', 'profile'] } });
        const attemptId = randomUUID();
        await client.query(`INSERT INTO microsoft_verification_attempts
            (id, user_id, university_id, institution_policy_version, provider_policy_version, identity_version, processing_grant_id, provider_consent_id, server_session_id, state_hash, browser_secret_hash, finish_secret_hash, encrypted_verifier, nonce, expires_at, status)
            VALUES ($1, $2, $3, 1, $4, 1, $5, $6, $7, $8, 'browser', 'finish', 'encrypted', 'nonce', clock_timestamp() + interval '10 minutes', 'pending')`,
        [attemptId, data.userId, data.universityId, policy.version, data.processingGrantId, consentId, randomUUID(), `state-${randomUUID()}`]);
        await withdrawConsent(client, data.userId, data.processingGrantId);
        const cancelled = (await client.query<{ status: string; encrypted_verifier: string | null }>(`SELECT status, encrypted_verifier FROM microsoft_verification_attempts WHERE id = $1`, [attemptId])).rows[0]!;
        assert.deepEqual(cancelled, { status: 'failed', encrypted_verifier: null });
    }));
});
