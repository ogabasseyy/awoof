import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import { db } from '../../config/database.js';
import { grantVerificationProcessing, withdrawConsent } from '../../services/verification/eligibility-consent.service.js';
import { acceptMicrosoftConsent, withdrawMicrosoftConsent } from '../../services/verification/microsoft-consent.service.js';
import { VERIFICATION_NOTICE_VERSION } from '../../services/verification/verification-notices.js';
import { MicrosoftFlowService } from '../../services/verification/microsoft-flow.service.js';
import { inTransaction, withTestClient } from './test-database.js';

after(() => db.close());

type Fixture = { adminId: string; userId: string; universityId: string; processingGrantId: string };

async function assertCallbacksBlockedBy(observer: PoolClient, blockerPid: number, expected: number): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const result = await observer.query<{ count: string }>(
            `WITH RECURSIVE blocking_chain AS (
                 SELECT waiting.pid AS waiting_pid, blocker.pid AS blocker_pid, 1 AS depth
                 FROM pg_stat_activity AS waiting
                 CROSS JOIN LATERAL unnest(pg_blocking_pids(waiting.pid)) AS blocker(pid)
                 WHERE waiting.query LIKE 'SELECT id, email FROM users%'
                 UNION ALL
                 SELECT chain.waiting_pid, blocker.pid, chain.depth + 1
                 FROM blocking_chain AS chain
                 JOIN pg_stat_activity AS waiting ON waiting.pid = chain.blocker_pid
                 CROSS JOIN LATERAL unnest(pg_blocking_pids(waiting.pid)) AS blocker(pid)
                 WHERE chain.depth < 8
             )
             SELECT count(DISTINCT waiting_pid)::text AS count
             FROM blocking_chain
             WHERE blocker_pid = $1`,
            [blockerPid],
        );
        if (Number(result.rows[0]?.count ?? 0) >= expected) return;
        await delay(10);
    }
    throw new Error(`Expected ${expected} Microsoft callback authority transactions to block on the held user lock`);
}

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

test('provider-only withdrawal leaves its live parent and unrelated provider consent intact', async () => {
    const data = await fixture();
    await withTestClient(async (client) => inTransaction(client, async () => {
        const version = (await client.query<{ version: number }>(`SELECT version FROM institution_microsoft_policies WHERE university_id = $1`, [data.universityId])).rows[0]!.version;
        const input = { accepted: true as const, processingGrantId: data.processingGrantId, snapshot: { universityId: data.universityId, providerPolicyVersion: version, noticeVersion: 'microsoft-v1', mode: 'identity_only' as const, scopes: ['openid', 'profile'] } };
        const target = await acceptMicrosoftConsent(client, data.userId, input);
        const other = await acceptMicrosoftConsent(client, data.userId, input);
        const identity = (await client.query<{ id: string }>(`INSERT INTO microsoft_identities (user_id, university_id, tenant_id, object_id) VALUES ($1,$2,$3,$4) RETURNING id`, [data.userId, data.universityId, randomUUID(), randomUUID()])).rows[0]!.id;
        const attempt = randomUUID();
        await client.query(`INSERT INTO microsoft_verification_attempts (id,user_id,university_id,institution_policy_version,provider_policy_version,identity_version,processing_grant_id,provider_consent_id,server_session_id,state_hash,browser_secret_hash,finish_secret_hash,encrypted_verifier,nonce,expires_at,status) VALUES ($1,$2,$3,1,$4,1,$5,$6,$7,$8,'b','f','secret','nonce',clock_timestamp()+interval '1 hour','pending')`, [attempt, data.userId, data.universityId, version, data.processingGrantId, target, randomUUID(), `state-${randomUUID()}`]);
        const targetProof = (await client.query<{ id: string }>(`INSERT INTO microsoft_provider_proofs (user_id,university_id,provider_consent_id,identity_id,provider_policy_version) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [data.userId, data.universityId, target, identity, version])).rows[0]!.id;
        const otherProof = (await client.query<{ id: string }>(`INSERT INTO microsoft_provider_proofs (user_id,university_id,provider_consent_id,identity_id,provider_policy_version) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [data.userId, data.universityId, other, identity, version])).rows[0]!.id;
        await withdrawMicrosoftConsent(client, data.userId, target);
        assert.equal((await client.query(`SELECT 1 FROM verification_consents WHERE id=$1 AND withdrawn_at IS NULL`, [data.processingGrantId])).rowCount, 1);
        assert.equal((await client.query(`SELECT 1 FROM microsoft_verification_consents WHERE id=$1 AND withdrawn_at IS NULL`, [other])).rowCount, 1);
        assert.notEqual((await client.query<{ withdrawn_at: Date | null }>(`SELECT withdrawn_at FROM microsoft_verification_consents WHERE id = $1`, [target])).rows[0]!.withdrawn_at, null);
        assert.notEqual((await client.query<{ revoked_at: Date | null }>(`SELECT revoked_at FROM microsoft_provider_proofs WHERE id = $1`, [targetProof])).rows[0]!.revoked_at, null);
        assert.equal((await client.query<{ revoked_at: Date | null }>(`SELECT revoked_at FROM microsoft_provider_proofs WHERE id = $1`, [otherProof])).rows[0]!.revoked_at, null);
        assert.deepEqual((await client.query<{ status:string; encrypted_verifier:string|null }>(`SELECT status,encrypted_verifier FROM microsoft_verification_attempts WHERE id=$1`, [attempt])).rows[0], { status: 'failed', encrypted_verifier: null });
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
        await rejectsSql(() => client.query(`UPDATE microsoft_published_notices SET content = 'changed' WHERE version = 'microsoft-v1'`), client);
        await rejectsSql(() => client.query(`DELETE FROM microsoft_published_notices WHERE version = 'microsoft-v1'`), client);
        assert.equal((await client.query<{ matches: boolean }>(`SELECT content_digest = encode(digest(convert_to(content, 'UTF8'), 'sha256'), 'hex') AS matches FROM microsoft_published_notices WHERE version = 'microsoft-v1'`)).rows[0]!.matches, true);
        await rejectsSql(() => client.query(`INSERT INTO microsoft_published_notices (version, content, content_digest) VALUES ('microsoft-invalid', 'copy', repeat('0', 64))`), client);
        await rejectsSql(() => client.query(`UPDATE institution_microsoft_policies SET notice_version = 'unknown-microsoft-copy' WHERE university_id = $1`, [first.universityId]), client);

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

test('durable identity-only flow hashes secrets, links only at finish, and permits bounded same-session retry', async () => {
    const data = await fixture();
    const sid = randomUUID();
    const key = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '').slice(0, 12);
    const consentId = await withTestClient(async (client) => inTransaction(client, async () => {
        await client.query(`UPDATE users SET active_session_id=$2, refresh_token_hash='test-hash', refresh_token_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [data.userId, sid]);
        const policy = (await client.query<{ version: number }>('SELECT version FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
        return acceptMicrosoftConsent(client, data.userId, { accepted: true, processingGrantId: data.processingGrantId,
            snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v1', mode: 'identity_only', scopes: ['openid', 'profile'] } });
    }));
    let authorizeInput: { state: string; nonce: string; verifier: string } | undefined;
    const tenantId = await withTestClient(async (client) => {
        const policy = await client.query<{ tenant_id: string }>('SELECT tenant_id FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId]);
        return policy.rows[0]!.tenant_id;
    });
    const identity = { tenantId, objectId: randomUUID() };
    const service = new MicrosoftFlowService({ pool: db.getPool(), verifierEncryptionKey: Buffer.from(key.slice(0, 32)).toString('base64url'),
        callbackUrl: new URL('https://api.example.invalid/api/verification/microsoft/callback'), completionUrl: new URL('https://app.example.invalid/student/verification/microsoft/complete'),
        isEnabled: () => true,
        oidc: { authorize: async (input) => { authorizeInput = input; return 'https://provider.example.invalid/authorize'; }, redeem: async (input) => { assert.equal(input.verifier, authorizeInput?.verifier); return { identity }; } },
    });
    const started = await service.start({ userId: data.userId, serverSessionId: sid, processingGrantId: data.processingGrantId, providerConsentId: consentId });
    assert.equal((await withTestClient(async (client) => client.query('SELECT 1 FROM microsoft_identities WHERE user_id=$1', [data.userId]))).rowCount, 0);
    const callback = new URL('https://api.example.invalid/api/verification/microsoft/callback'); callback.searchParams.set('state', authorizeInput!.state); callback.searchParams.set('code', 'CANARY-NOT-PERSISTED');
    const complete = await service.callback({ callbackUrl: callback, browserCookie: started.callbackCookie.value });
    assert.equal(complete.completionUrl.searchParams.get('attempt'), started.publicResult.attemptId);
    assert.equal(complete.completionUrl.search.includes('code'), false);
    assert.equal((await withTestClient(async (client) => client.query('SELECT 1 FROM microsoft_identities WHERE user_id=$1', [data.userId]))).rowCount, 0);
    assert.deepEqual(await service.finish({ userId: data.userId, serverSessionId: sid, attemptId: started.publicResult.attemptId, finishSecret: started.publicResult.finishSecret }), { accountLinked: true, enrollment: 'not_checked' });
    assert.deepEqual(await service.finish({ userId: data.userId, serverSessionId: sid, attemptId: started.publicResult.attemptId, finishSecret: started.publicResult.finishSecret }), { accountLinked: true, enrollment: 'not_checked' });
    await withTestClient(async (client) => inTransaction(client, async () => {
        assert.equal((await client.query('SELECT 1 FROM microsoft_identities WHERE user_id=$1', [data.userId])).rowCount, 1);
        assert.equal((await client.query('SELECT 1 FROM eligibility_evidence evidence JOIN students ON students.id=evidence.student_id WHERE students.user_id=$1', [data.userId])).rowCount, 0);
        const stored = (await client.query<{ state_hash:string; browser_secret_hash:string; finish_secret_hash:string; encrypted_verifier:string|null; nonce:string|null; status:string }>('SELECT state_hash,browser_secret_hash,finish_secret_hash,encrypted_verifier,nonce,status FROM microsoft_verification_attempts WHERE id=$1', [started.publicResult.attemptId])).rows[0]!;
        assert.equal(stored.status, 'completed'); assert.notEqual(stored.state_hash, authorizeInput!.state); assert.notEqual(stored.browser_secret_hash, started.callbackCookie.value); assert.notEqual(stored.finish_secret_hash, started.publicResult.finishSecret); assert.equal(stored.encrypted_verifier, null); assert.equal(stored.nonce, null);
    }));
});

test('both consent withdrawals prevent dispatch before claim, prevent ready during held redeem, and reject ready finish', async () => {
    for (const withdrawal of ['processing', 'provider'] as const) {
        for (const phase of ['before', 'during', 'after'] as const) {
            const data = await fixture();
            const sid = randomUUID();
            const consentId = await withTestClient(async (client) => inTransaction(client, async () => {
                await client.query(`UPDATE users SET active_session_id=$2, refresh_token_hash='test-hash', refresh_token_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [data.userId, sid]);
                const policy = (await client.query<{ version: number }>('SELECT version FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
                return acceptMicrosoftConsent(client, data.userId, { accepted: true, processingGrantId: data.processingGrantId,
                    snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v1', mode: 'identity_only', scopes: ['openid', 'profile'] } });
            }));
            const tenantId = (await withTestClient(async (client) => (await client.query<{ tenant_id: string }>('SELECT tenant_id FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!.tenant_id));
            let state = ''; let dispatched = 0; let release: (() => void) | undefined; let entered: (() => void) | undefined;
            const held = new Promise<void>((resolve) => { release = resolve; });
            const enteredRedeem = new Promise<void>((resolve) => { entered = resolve; });
            const service = new MicrosoftFlowService({ pool: db.getPool(), verifierEncryptionKey: randomBytes(32).toString('base64url'), isEnabled: () => true,
                callbackUrl: new URL('https://api.example.invalid/api/verification/microsoft/callback'), completionUrl: new URL('https://app.example.invalid/student/verification/microsoft/complete'),
                oidc: { authorize: async (input) => { state = input.state; return 'https://provider.example.invalid/authorize'; }, redeem: async () => { dispatched += 1; entered!(); await held; return { identity: { tenantId, objectId: randomUUID() } }; } },
            });
            const started = await service.start({ userId: data.userId, serverSessionId: sid, processingGrantId: data.processingGrantId, providerConsentId: consentId });
            const callback = new URL('https://api.example.invalid/api/verification/microsoft/callback'); callback.searchParams.set('state', state); callback.searchParams.set('code', 'CANARY');
            const withdraw = async () => withTestClient((client) => inTransaction(client, () => withdrawal === 'processing'
                ? withdrawConsent(client, data.userId, data.processingGrantId)
                : withdrawMicrosoftConsent(client, data.userId, consentId)));
            if (phase === 'before') {
                await withdraw();
                await assert.rejects(() => service.callback({ callbackUrl: callback, browserCookie: started.callbackCookie.value }));
                assert.equal(dispatched, 0, `${withdrawal} withdrawal must prevent token dispatch before claim`);
            } else if (phase === 'during') {
                const pending = service.callback({ callbackUrl: callback, browserCookie: started.callbackCookie.value });
                await enteredRedeem;
                await withdraw(); release!();
                await assert.rejects(() => pending);
                assert.equal((await withTestClient(async (client) => client.query(`SELECT 1 FROM microsoft_verification_attempts WHERE id=$1 AND status='ready'`, [started.publicResult.attemptId]))).rowCount, 0);
                assert.equal((await withTestClient(async (client) => client.query(`SELECT 1 FROM microsoft_identities WHERE user_id=$1`, [data.userId]))).rowCount, 0);
            } else {
                const pending = service.callback({ callbackUrl: callback, browserCookie: started.callbackCookie.value });
                await enteredRedeem; release!(); await pending;
                await withdraw();
                await assert.rejects(() => service.finish({ userId: data.userId, serverSessionId: sid, attemptId: started.publicResult.attemptId, finishSecret: started.publicResult.finishSecret }));
                assert.equal((await withTestClient(async (client) => client.query(`SELECT 1 FROM microsoft_identities WHERE user_id=$1`, [data.userId]))).rowCount, 0);
            }
        }
    }
});

async function readyDurableAttempt() {
    const data = await fixture(); const sid = randomUUID(); let state = ''; let exchanges = 0;
    const consentId = await withTestClient(async (client) => inTransaction(client, async () => {
        await client.query(`UPDATE users SET active_session_id=$2,refresh_token_hash='h',refresh_token_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [data.userId, sid]);
        const policy = (await client.query<{ version:number }>('SELECT version FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
        return acceptMicrosoftConsent(client, data.userId, { accepted:true, processingGrantId:data.processingGrantId, snapshot:{ universityId:data.universityId, providerPolicyVersion:policy.version, noticeVersion:'microsoft-v1', mode:'identity_only', scopes:['openid','profile'] } });
    }));
    const tenantId = (await withTestClient(async (client) => (await client.query<{tenant_id:string}>('SELECT tenant_id FROM institution_microsoft_policies WHERE university_id=$1',[data.universityId])).rows[0]!.tenant_id));
    const service = new MicrosoftFlowService({ pool:db.getPool(), verifierEncryptionKey:randomBytes(32).toString('base64url'), isEnabled:()=>true, callbackUrl:new URL('https://api.example.invalid/api/verification/microsoft/callback'), completionUrl:new URL('https://app.example.invalid/student/verification/microsoft/complete'), oidc:{ authorize:async(input)=>{state=input.state;return 'https://provider.example.invalid/a';}, redeem:async()=>{exchanges++;return {identity:{tenantId,objectId:randomUUID()}};} } });
    const started = await service.start({userId:data.userId,serverSessionId:sid,processingGrantId:data.processingGrantId,providerConsentId:consentId});
    const callback = new URL('https://api.example.invalid/api/verification/microsoft/callback'); callback.searchParams.set('state',state); callback.searchParams.set('code','CANARY');
    await service.callback({callbackUrl:callback,browserCookie:started.callbackCookie.value});
    return { data,sid,service,started,callback,exchanges:()=>exchanges };
}

async function pendingDurableAttempt(options: { isEnabled?: () => boolean; beforeRedeem?: () => Promise<void> } = {}) {
    const data = await fixture(); const sid = randomUUID(); let state = ''; let exchanges = 0;
    const consentId = await withTestClient(async (client) => inTransaction(client, async () => {
        await client.query(`UPDATE users SET active_session_id=$2,refresh_token_hash='h',refresh_token_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [data.userId, sid]);
        const policy = (await client.query<{ version: number }>('SELECT version FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
        return acceptMicrosoftConsent(client, data.userId, { accepted: true, processingGrantId: data.processingGrantId, snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v1', mode: 'identity_only', scopes: ['openid', 'profile'] } });
    }));
    const tenantId = (await withTestClient(async (client) => (await client.query<{ tenant_id: string }>('SELECT tenant_id FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!.tenant_id));
    const service = new MicrosoftFlowService({ pool: db.getPool(), verifierEncryptionKey: randomBytes(32).toString('base64url'), isEnabled: options.isEnabled ?? (() => true), callbackUrl: new URL('https://api.example.invalid/api/verification/microsoft/callback'), completionUrl: new URL('https://app.example.invalid/student/verification/microsoft/complete'), oidc: { authorize: async (input) => { state = input.state; return 'https://provider.example.invalid/a'; }, redeem: async () => { exchanges += 1; await options.beforeRedeem?.(); return { identity: { tenantId, objectId: randomUUID() } }; } } });
    const started = await service.start({ userId: data.userId, serverSessionId: sid, processingGrantId: data.processingGrantId, providerConsentId: consentId });
    const callback = new URL('https://api.example.invalid/api/verification/microsoft/callback'); callback.searchParams.set('state', state); callback.searchParams.set('code', 'CANARY');
    return { data, sid, service, started, callback, exchanges: () => exchanges };
}

test('callback expiry is rechecked after it blocks on the independent user lock', async () => {
    const flow = await pendingDurableAttempt();
    const lockClient = await db.getPool().connect(); const observer = await db.getPool().connect();
    try {
        await lockClient.query('BEGIN');
        const blockerPid = Number((await lockClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
        await lockClient.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [flow.data.userId]);
        const callback = flow.service.callback({ callbackUrl: flow.callback, browserCookie: flow.started.callbackCookie.value });
        const settled = callback.then(() => ({ ok: true }), () => ({ ok: false }));
        await assertCallbacksBlockedBy(observer, blockerPid, 1);
        await lockClient.query(`UPDATE microsoft_verification_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [flow.started.publicResult.attemptId]);
        await lockClient.query('COMMIT');
        assert.deepEqual(await settled, { ok: false });
        assert.equal(flow.exchanges(), 0);
        assert.equal((await withTestClient(client => client.query(`SELECT 1 FROM microsoft_verification_attempts WHERE id=$1 AND status='ready'`, [flow.started.publicResult.attemptId]))).rowCount, 0);
    } finally {
        await lockClient.query('ROLLBACK').catch(() => undefined); lockClient.release(); observer.release();
    }
});

test('callback rechecks the enabled gate after its authority lock and before claim dispatch', async () => {
    let enabled = true;
    const flow = await pendingDurableAttempt({ isEnabled: () => enabled });
    const lockClient = await db.getPool().connect(); const observer = await db.getPool().connect();
    try {
        await lockClient.query('BEGIN');
        const blockerPid = Number((await lockClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
        await lockClient.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [flow.data.userId]);
        const callback = flow.service.callback({ callbackUrl: flow.callback, browserCookie: flow.started.callbackCookie.value });
        const settled = callback.then(() => ({ ok: true }), () => ({ ok: false }));
        await assertCallbacksBlockedBy(observer, blockerPid, 1);
        enabled = false; await lockClient.query('COMMIT');
        assert.deepEqual(await settled, { ok: false });
        assert.equal(flow.exchanges(), 0);
        assert.equal((await withTestClient(client => client.query(`SELECT 1 FROM microsoft_verification_attempts WHERE id=$1 AND status='processing'`, [flow.started.publicResult.attemptId]))).rowCount, 0);
    } finally {
        await lockClient.query('ROLLBACK').catch(() => undefined); lockClient.release(); observer.release();
    }
});

test('simultaneous callbacks make one durable claim after both block on the user lock', async () => {
    const flow = await pendingDurableAttempt();
    const lockClient = await db.getPool().connect(); const observer = await db.getPool().connect();
    try {
        await lockClient.query('BEGIN');
        const blockerPid = Number((await lockClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
        await lockClient.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [flow.data.userId]);
        const first = flow.service.callback({ callbackUrl: flow.callback, browserCookie: flow.started.callbackCookie.value });
        const second = flow.service.callback({ callbackUrl: flow.callback, browserCookie: flow.started.callbackCookie.value });
        const settled = [first, second].map((promise) => promise.then(() => ({ ok: true }), () => ({ ok: false })));
        await assertCallbacksBlockedBy(observer, blockerPid, 2);
        await lockClient.query('COMMIT');
        const results = await Promise.all(settled);
        assert.equal(results.filter((result) => result.ok).length, 1);
        assert.equal(results.filter((result) => !result.ok).length, 1);
        assert.equal(flow.exchanges(), 1);
        assert.equal((await withTestClient(client => client.query(`SELECT 1 FROM microsoft_verification_attempts WHERE id=$1 AND status='ready'`, [flow.started.publicResult.attemptId]))).rowCount, 1);
        assert.equal((await withTestClient(client => client.query('SELECT 1 FROM microsoft_identities WHERE user_id=$1', [flow.data.userId]))).rowCount, 0);
    } finally {
        await lockClient.query('ROLLBACK').catch(() => undefined); lockClient.release(); observer.release();
    }
});

test('disabling during held redeem scrubs the attempt, and disabling after an awaited lock rejects completed retry', async () => {
    let enabled = true; let releaseRedeem: (() => void) | undefined; let enteredRedeem: (() => void) | undefined;
    const heldRedeem = new Promise<void>((resolve) => { releaseRedeem = resolve; });
    const redeemEntered = new Promise<void>((resolve) => { enteredRedeem = resolve; });
    const flow = await pendingDurableAttempt({ isEnabled: () => enabled, beforeRedeem: async () => { enteredRedeem!(); await heldRedeem; } });
    const callback = flow.service.callback({ callbackUrl: flow.callback, browserCookie: flow.started.callbackCookie.value });
    const settledCallback = callback.then(() => ({ ok: true }), () => ({ ok: false }));
    await redeemEntered; enabled = false; releaseRedeem!();
    assert.deepEqual(await settledCallback, { ok: false });
    const scrubbed = await withTestClient(async (client) => (await client.query<{ status: string; encrypted_verifier: string | null; nonce: string | null }>('SELECT status,encrypted_verifier,nonce FROM microsoft_verification_attempts WHERE id=$1', [flow.started.publicResult.attemptId])).rows[0]!);
    assert.deepEqual(scrubbed, { status: 'failed', encrypted_verifier: null, nonce: null });

    const completed = await readyDurableAttempt();
    await completed.service.finish({ userId: completed.data.userId, serverSessionId: completed.sid, attemptId: completed.started.publicResult.attemptId, finishSecret: completed.started.publicResult.finishSecret });
    let retryEnabled = true;
    const retryService = new MicrosoftFlowService({ pool: db.getPool(), verifierEncryptionKey: randomBytes(32).toString('base64url'), isEnabled: () => retryEnabled, callbackUrl: new URL('https://api.example.invalid/api/verification/microsoft/callback'), completionUrl: new URL('https://app.example.invalid/student/verification/microsoft/complete'), oidc: { authorize: async () => 'unused', redeem: async () => { throw new Error('unused'); } } });
    const lockClient = await db.getPool().connect(); const observer = await db.getPool().connect();
    try {
        await lockClient.query('BEGIN'); const blockerPid = Number((await lockClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
        await lockClient.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [completed.data.userId]);
        const retry = retryService.finish({ userId: completed.data.userId, serverSessionId: completed.sid, attemptId: completed.started.publicResult.attemptId, finishSecret: completed.started.publicResult.finishSecret });
        const settledRetry = retry.then(() => ({ ok: true }), () => ({ ok: false }));
        await assertCallbacksBlockedBy(observer, blockerPid, 1); retryEnabled = false; await lockClient.query('COMMIT');
        assert.deepEqual(await settledRetry, { ok: false });
    } finally { await lockClient.query('ROLLBACK').catch(() => undefined); lockClient.release(); observer.release(); }
});

test('callback accepts only the fixed configured HTTPS origin and path before token exchange', async () => {
    const flow = await pendingDurableAttempt();
    const wrongOrigin = new URL(flow.callback); wrongOrigin.hostname = 'evil.example.invalid';
    const wrongPath = new URL(flow.callback); wrongPath.pathname = '/api/verification/microsoft/other';
    await assert.rejects(() => flow.service.callback({ callbackUrl: wrongOrigin, browserCookie: flow.started.callbackCookie.value }));
    await assert.rejects(() => flow.service.callback({ callbackUrl: wrongPath, browserCookie: flow.started.callbackCookie.value }));
    assert.equal(flow.exchanges(), 0);
    assert.equal((await withTestClient(client => client.query(`SELECT 1 FROM microsoft_verification_attempts WHERE id=$1 AND status='pending'`, [flow.started.publicResult.attemptId]))).rowCount, 1);
});

test('callback replay redeems once and parallel finish creates one identity with bounded retry', async () => {
    const flow = await readyDurableAttempt();
    await assert.rejects(() => flow.service.callback({callbackUrl:flow.callback,browserCookie:flow.started.callbackCookie.value}));
    assert.equal(flow.exchanges(), 1);
    const input={userId:flow.data.userId,serverSessionId:flow.sid,attemptId:flow.started.publicResult.attemptId,finishSecret:flow.started.publicResult.finishSecret};
    assert.deepEqual(await Promise.all([flow.service.finish(input),flow.service.finish(input)]),[{accountLinked:true,enrollment:'not_checked'},{accountLinked:true,enrollment:'not_checked'}]);
    assert.equal((await withTestClient(async c=>c.query('SELECT 1 FROM microsoft_identities WHERE user_id=$1',[flow.data.userId]))).rowCount,1);
});

test('session replacement and policy drift reject a ready attempt', async () => {
    const replaced = await readyDurableAttempt();
    await withTestClient(c=>inTransaction(c,()=>c.query('UPDATE users SET active_session_id=$2 WHERE id=$1',[replaced.data.userId,randomUUID()])));
    await assert.rejects(()=>replaced.service.finish({userId:replaced.data.userId,serverSessionId:replaced.sid,attemptId:replaced.started.publicResult.attemptId,finishSecret:replaced.started.publicResult.finishSecret}));
    const drifted = await readyDurableAttempt();
    await withTestClient(c=>inTransaction(c,()=>c.query('UPDATE institution_microsoft_policies SET max_evidence_hours=23 WHERE university_id=$1',[drifted.data.universityId])));
    await assert.rejects(()=>drifted.service.finish({userId:drifted.data.userId,serverSessionId:drifted.sid,attemptId:drifted.started.publicResult.attemptId,finishSecret:drifted.started.publicResult.finishSecret}));
});

test('completed retry is bound to its original live identity, not another link', async () => {
    const flow = await readyDurableAttempt();
    const input={userId:flow.data.userId,serverSessionId:flow.sid,attemptId:flow.started.publicResult.attemptId,finishSecret:flow.started.publicResult.finishSecret};
    await flow.service.finish(input);
    await withTestClient(c=>inTransaction(c,async()=>{
        await c.query(`UPDATE microsoft_identities SET revoked_at=clock_timestamp() WHERE user_id=$1`,[flow.data.userId]);
        await c.query(`INSERT INTO microsoft_identities(user_id,university_id,tenant_id,object_id) VALUES($1,$2,$3,$4)`,[flow.data.userId,flow.data.universityId,randomUUID(),randomUUID()]);
    }));
    await assert.rejects(()=>flow.service.finish(input));
});

test('wrong finish secret and logout fence ready finalization', async () => {
    const flow=await readyDurableAttempt();
    await assert.rejects(()=>flow.service.finish({userId:flow.data.userId,serverSessionId:flow.sid,attemptId:flow.started.publicResult.attemptId,finishSecret:randomUUID()}));
    await withTestClient(c=>inTransaction(c,()=>c.query(`UPDATE users SET active_session_id=NULL,refresh_token_hash=NULL WHERE id=$1`,[flow.data.userId])));
    await assert.rejects(()=>flow.service.finish({userId:flow.data.userId,serverSessionId:flow.sid,attemptId:flow.started.publicResult.attemptId,finishSecret:flow.started.publicResult.finishSecret}));
});

test('synthetic aged fixture isolates the ten-outstanding-attempt guard from the five-start window', async () => {
    const flow = await pendingDurableAttempt();
    await withTestClient(async (client) => inTransaction(client, async () => {
        for (let index = 0; index < 9; index += 1) {
            await client.query(
                `INSERT INTO microsoft_verification_attempts
                     (id,user_id,university_id,institution_policy_version,provider_policy_version,identity_version,processing_grant_id,provider_consent_id,server_session_id,state_hash,browser_secret_hash,finish_secret_hash,encrypted_verifier,nonce,expires_at,status,created_at)
                 SELECT $2,user_id,university_id,institution_policy_version,provider_policy_version,identity_version,processing_grant_id,provider_consent_id,server_session_id,$3,$4,$5,encrypted_verifier,nonce,expires_at,status,clock_timestamp()-interval '11 minutes'
                 FROM microsoft_verification_attempts WHERE id=$1`,
                [flow.started.publicResult.attemptId, randomUUID(), `synthetic-state-${randomUUID()}`, `synthetic-browser-${randomUUID()}`, `synthetic-finish-${randomUUID()}`],
            );
        }
    }));
    const ids = await withTestClient(async (client) => (await client.query<{ processing_grant_id: string; provider_consent_id: string }>('SELECT processing_grant_id,provider_consent_id FROM microsoft_verification_attempts WHERE id=$1', [flow.started.publicResult.attemptId])).rows[0]!);
    let authorizations = 0;
    const service = new MicrosoftFlowService({ pool: db.getPool(), verifierEncryptionKey: randomBytes(32).toString('base64url'), isEnabled: () => true, callbackUrl: new URL('https://api.example.invalid/api/verification/microsoft/callback'), completionUrl: new URL('https://app.example.invalid/student/verification/microsoft/complete'), oidc: { authorize: async () => { authorizations += 1; return 'https://provider.example.invalid/a'; }, redeem: async () => { throw new Error('unused'); } } });
    await assert.rejects(() => service.start({ userId: flow.data.userId, serverSessionId: flow.sid, processingGrantId: ids.processing_grant_id, providerConsentId: ids.provider_consent_id }), /outstanding Microsoft verification attempts/i);
    assert.equal(authorizations, 0);
    assert.equal((await withTestClient(client => client.query(`SELECT 1 FROM microsoft_verification_attempts WHERE user_id=$1 AND status='pending' AND expires_at > clock_timestamp()`, [flow.data.userId]))).rowCount, 10);
    assert.equal((await withTestClient(client => client.query(`SELECT 1 FROM microsoft_verification_attempts WHERE user_id=$1 AND created_at > clock_timestamp()-interval '10 minutes'`, [flow.data.userId]))).rowCount, 1);
});

test('persistent Microsoft start limit is shared across service instances', async () => {
    const flow = await readyDurableAttempt();
    const ids = await withTestClient(async (c) => (await c.query<{ processing_grant_id:string; provider_consent_id:string }>('SELECT processing_grant_id,provider_consent_id FROM microsoft_verification_attempts WHERE id=$1',[flow.started.publicResult.attemptId])).rows[0]!);
    const input = { userId: flow.data.userId, serverSessionId: flow.sid, processingGrantId: ids.processing_grant_id, providerConsentId: ids.provider_consent_id };
    let authorizations = flow.exchanges();
    const make = () => new MicrosoftFlowService({ pool: db.getPool(), verifierEncryptionKey: randomBytes(32).toString('base64url'), isEnabled: () => true, callbackUrl: new URL('https://api.example.invalid/api/verification/microsoft/callback'), completionUrl: new URL('https://app.example.invalid/student/verification/microsoft/complete'), oidc: { authorize: async () => { authorizations++; return 'https://provider.example.invalid/a'; }, redeem: async () => { throw new Error('unused'); } } });
    for (let index = 0; index < 4; index += 1) await make().start(input);
    const before = authorizations;
    await assert.rejects(() => make().start(input));
    assert.equal(authorizations, before);
    assert.equal((await withTestClient(async c => c.query(`SELECT 1 FROM microsoft_verification_attempts WHERE user_id=$1 AND created_at > clock_timestamp()-interval '10 minutes'`, [flow.data.userId]))).rowCount, 5);
});
