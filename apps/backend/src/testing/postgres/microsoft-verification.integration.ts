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

async function rejectsSql(operation: () => Promise<unknown>, client: Parameters<typeof inTransaction>[0]): Promise<void> {
    const savepoint = `microsoft_expected_failure_${randomUUID().replaceAll('-', '')}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    await assert.rejects(operation);
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
}

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
        const identityId = (await client.query<{ id: string }>(
            `INSERT INTO microsoft_identities (user_id, university_id, tenant_id, object_id)
             VALUES ($1, $2, $3, $4) RETURNING id`, [data.userId, data.universityId, randomUUID(), randomUUID()],
        )).rows[0]!.id;
        const proofId = (await client.query<{ id: string }>(
            `INSERT INTO microsoft_provider_proofs (user_id, university_id, provider_consent_id, identity_id, provider_policy_version)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`, [data.userId, data.universityId, consentId, identityId, policy.version],
        )).rows[0]!.id;
        const otherUser = (await client.query<{ id: string }>(`INSERT INTO users (email, role) VALUES ($1, 'student') RETURNING id`, [`other-${randomUUID()}@example.invalid`])).rows[0]!.id;
        await assert.rejects(() => withdrawMicrosoftConsent(client, otherUser, consentId), { statusCode: 403 });
        await client.query(`UPDATE students SET status = 'suspended' WHERE user_id = $1`, [data.userId]);
        await client.query(`UPDATE universities SET is_active = false WHERE id = $1`, [data.universityId]);
        await client.query(`UPDATE institution_microsoft_policies SET enabled = false, notice_version = 'microsoft-v2' WHERE university_id = $1`, [data.universityId]);
        await withdrawConsent(client, data.userId, data.processingGrantId);
        await withdrawMicrosoftConsent(client, data.userId, consentId);
        await withdrawMicrosoftConsent(client, data.userId, consentId);
        const cancelled = (await client.query<{ status: string; encrypted_verifier: string | null; nonce: string | null }>(`SELECT status, encrypted_verifier, nonce FROM microsoft_verification_attempts WHERE id = $1`, [providerAttemptId])).rows[0]!;
        assert.deepEqual(cancelled, { status: 'failed', encrypted_verifier: null, nonce: null });
        assert.notEqual((await client.query<{ revoked_at: Date | null }>(`SELECT revoked_at FROM microsoft_provider_proofs WHERE id = $1`, [proofId])).rows[0]!.revoked_at, null);
        await rejectsSql(() => client.query(`UPDATE microsoft_provider_proofs SET provider_policy_version = 99 WHERE id = $1`, [proofId]), client);
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

test('Microsoft tables reject cross-subject authority bindings and malformed canonical scopes', async () => {
    const first = await fixture();
    const second = await fixture();
    await withTestClient(async (client) => inTransaction(client, async () => {
        await rejectsSql(() => client.query(
            `INSERT INTO microsoft_verification_consents
             (user_id, university_id, processing_grant_id, provider_policy_version, notice_version, mode, scopes)
             VALUES ($1, $2, $3, 1, 'microsoft-v1', 'identity_only', ARRAY['openid'])`,
            [first.userId, first.universityId, second.processingGrantId],
        ), client);
        await rejectsSql(() => client.query(
            `UPDATE institution_microsoft_policies SET scopes = ARRAY[' openid', 'profile'] WHERE university_id = $1`,
            [first.universityId],
        ), client);
        await rejectsSql(() => client.query(
            `UPDATE institution_microsoft_policies SET scopes = ARRAY['', 'profile'] WHERE university_id = $1`,
            [first.universityId],
        ), client);
        await rejectsSql(() => client.query(
            `UPDATE institution_microsoft_policies SET scopes = ARRAY['openid', NULL] WHERE university_id = $1`,
            [first.universityId],
        ), client);
        await rejectsSql(() => client.query(
            `UPDATE institution_microsoft_policies SET scopes = ARRAY[E'open\\tid', 'profile'] WHERE university_id = $1`,
            [first.universityId],
        ), client);
        await rejectsSql(() => client.query(
            `UPDATE institution_microsoft_policies SET scopes = ARRAY[E'openid\\n', 'profile'] WHERE university_id = $1`,
            [first.universityId],
        ), client);

        const firstPolicy = (await client.query<{ version: number }>(`SELECT version FROM institution_microsoft_policies WHERE university_id = $1`, [first.universityId])).rows[0]!;
        const firstConsent = await acceptMicrosoftConsent(client, first.userId, { accepted: true, processingGrantId: first.processingGrantId,
            snapshot: { universityId: first.universityId, providerPolicyVersion: firstPolicy.version, noticeVersion: 'microsoft-v1', mode: 'identity_only', scopes: ['openid', 'profile'] } });
        await rejectsSql(() => client.query(
            `INSERT INTO microsoft_verification_attempts
             (user_id, university_id, institution_policy_version, provider_policy_version, identity_version, processing_grant_id, provider_consent_id, server_session_id, state_hash, browser_secret_hash, finish_secret_hash, encrypted_verifier, nonce, expires_at, status)
             VALUES ($1, $2, 1, 1, 1, $3, $4, $5, $6, 'browser', 'finish', 'encrypted', 'nonce', clock_timestamp() + interval '1 hour', 'pending')`,
            [first.userId, first.universityId, second.processingGrantId, firstConsent, randomUUID(), `state-${randomUUID()}`],
        ), client);
        const firstIdentity = (await client.query<{ id: string }>(`INSERT INTO microsoft_identities (user_id, university_id, tenant_id, object_id) VALUES ($1, $2, $3, $4) RETURNING id`, [first.userId, first.universityId, randomUUID(), randomUUID()])).rows[0]!.id;
        const secondIdentity = (await client.query<{ id: string }>(`INSERT INTO microsoft_identities (user_id, university_id, tenant_id, object_id) VALUES ($1, $2, $3, $4) RETURNING id`, [second.userId, second.universityId, randomUUID(), randomUUID()])).rows[0]!.id;
        await rejectsSql(() => client.query(
            `INSERT INTO microsoft_provider_proofs (user_id, university_id, provider_consent_id, identity_id, provider_policy_version)
             VALUES ($1, $2, $3, $4, 1)`, [first.userId, first.universityId, firstConsent, secondIdentity],
        ), client);
        const tenant = randomUUID(); const object = randomUUID();
        await client.query(`INSERT INTO microsoft_identities (user_id, university_id, tenant_id, object_id, revoked_at) VALUES ($1, $2, $3, $4, clock_timestamp())`, [first.userId, first.universityId, tenant, object]);
        await rejectsSql(() => client.query(`INSERT INTO microsoft_identities (user_id, university_id, tenant_id, object_id) VALUES ($1, $2, $3, $4)`, [second.userId, second.universityId, tenant, object]), client);
        await client.query(`INSERT INTO microsoft_provider_proofs (user_id, university_id, provider_consent_id, identity_id, provider_policy_version) VALUES ($1, $2, $3, $4, 1)`, [first.userId, first.universityId, firstConsent, firstIdentity]);
    }));
});

test('displayed consent cannot be accepted after policy copy or mode/scope change, including change-away-and-back', async () => {
    const data = await fixture();
    await withTestClient(async (client) => inTransaction(client, async () => {
        const displayed = (await client.query<{ version: number }>(`SELECT version FROM institution_microsoft_policies WHERE university_id = $1`, [data.universityId])).rows[0]!;
        const snapshot = { universityId: data.universityId, providerPolicyVersion: displayed.version, noticeVersion: 'microsoft-v1', mode: 'identity_only' as const, scopes: ['openid', 'profile'] };
        await client.query(`UPDATE institution_microsoft_policies SET mode = 'graph_enrollment', scopes = ARRAY['https://graph.microsoft.com/EduRoster.ReadBasic', 'openid', 'profile'], notice_version = 'microsoft-v2', term_ends_at = clock_timestamp() + interval '60 days' WHERE university_id = $1`, [data.universityId]);
        await assert.rejects(() => acceptMicrosoftConsent(client, data.userId, { accepted: true, processingGrantId: data.processingGrantId, snapshot }), { statusCode: 409, code: 'consent_notice_changed' });
        assert.equal((await client.query(`SELECT id FROM microsoft_verification_consents WHERE user_id = $1`, [data.userId])).rowCount, 0);
        await client.query(`UPDATE institution_microsoft_policies SET mode = 'identity_only', scopes = ARRAY['openid', 'profile'], notice_version = 'microsoft-v1', term_ends_at = NULL WHERE university_id = $1`, [data.universityId]);
        await assert.rejects(() => acceptMicrosoftConsent(client, data.userId, { accepted: true, processingGrantId: data.processingGrantId, snapshot }), { statusCode: 409, code: 'consent_notice_changed' });
        assert.equal((await client.query(`SELECT id FROM microsoft_verification_consents WHERE user_id = $1`, [data.userId])).rowCount, 0);
    }));
});
