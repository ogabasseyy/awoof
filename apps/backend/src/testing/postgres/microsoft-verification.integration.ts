import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import type { PoolClient } from 'pg';
import { db } from '../../config/database.js';
import { config } from '../../config/env.js';
import { grantMerchantDisclosure, grantVerificationProcessing, withdrawConsent } from '../../services/verification/eligibility-consent.service.js';
import { applyMicrosoftEnrollment, recordMailboxProof } from '../../services/verification/eligibility-evidence.service.js';
import { consumeChallenge, requestChallenge } from '../../services/verification/challenge.service.js';
import { acceptMicrosoftConsent, withdrawMicrosoftConsent } from '../../services/verification/microsoft-consent.service.js';
import { VERIFICATION_NOTICE_VERSION } from '../../services/verification/verification-notices.js';
import { MicrosoftFlowService } from '../../services/verification/microsoft-flow.service.js';
import { hashMicrosoftAttemptSecret } from '../../services/verification/microsoft-attempt-crypto.js';
import { createApp } from '../../index.js';
import { jwtService } from '../../services/auth/jwt.service.js';
import { rotateReportingKey } from '../../services/auth/reporting-key.service.js';
import { issueMerchantAssertion, exchangeMerchantAssertion } from '../../services/verification/merchant-assertion.service.js';
import { MERCHANT_DISCLOSURE_NOTICE_VERSION } from '../../services/verification/verification-notices.js';
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

async function assertWriterBlockedBy(observer: PoolClient, blockerPid: number, writerPid: number): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const result = await observer.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM pg_stat_activity
             WHERE pid = $2 AND $1 = ANY(pg_blocking_pids(pid))`, [blockerPid, writerPid],
        );
        if (Number(result.rows[0]?.count ?? 0) >= 1) return;
        await delay(10);
    }
    throw new Error('Expected canonical Microsoft writer transaction to block on the held authority lock');
}

async function assertPidBlockedBy(observer: PoolClient, waitingPid: number, blockerPid: number, label: string): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const result = await observer.query<{ blocked: boolean }>(
            `SELECT $2 = ANY(pg_blocking_pids($1)) AS blocked`, [waitingPid, blockerPid],
        );
        if (result.rows[0]?.blocked === true) return;
        await delay(10);
    }
    throw new Error(`Expected ${label} (pid ${waitingPid}) to block behind finish authority (pid ${blockerPid})`);
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

async function graphReadyWriterAttempt(client: PoolClient, data: Fixture, input: { mailbox?: boolean; observation?: unknown; observedAt?: string } = {}): Promise<string> {
    const sid = randomUUID();
    await client.query(`UPDATE users SET active_session_id=$2, refresh_token_hash='writer-test', refresh_token_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [data.userId, sid]);
    await client.query(`INSERT INTO student_eligibility_state (student_id, university_id)
        SELECT id, university_id FROM students WHERE user_id=$1 ON CONFLICT DO NOTHING`, [data.userId]);
    await client.query(`UPDATE institution_microsoft_policies SET mode='graph_enrollment', scopes=ARRAY['https://graph.microsoft.com/EduRoster.ReadBasic','openid','profile'], notice_version='microsoft-v2', term_ends_at=clock_timestamp()+interval '4 days', approved_until=clock_timestamp()+interval '3 days', max_evidence_hours=2 WHERE university_id=$1`, [data.universityId]);
    const policy = (await client.query<{ version: number }>('SELECT version FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
    const consent = await acceptMicrosoftConsent(client, data.userId, { accepted: true, processingGrantId: data.processingGrantId,
        snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v2', mode: 'graph_enrollment', scopes: ['https://graph.microsoft.com/EduRoster.ReadBasic', 'openid', 'profile'] } });
    const tenant = (await client.query<{ tenant_id: string }>('SELECT tenant_id FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!.tenant_id;
    const objectId = randomUUID();
    await client.query(`INSERT INTO microsoft_identities(user_id,university_id,tenant_id,object_id) VALUES($1,$2,$3,$4)`, [data.userId, data.universityId, tenant, objectId]);
    if (input.mailbox !== false) {
        const email = (await client.query<{ email: string }>('SELECT email FROM users WHERE id=$1', [data.userId])).rows[0]!.email;
        const issued = await requestChallenge(client, { purpose: 'account_email', subjectKey: data.userId, bindings: { userId: data.userId, email } });
        assert.equal(issued.status, 'issued');
        const consumed = await consumeChallenge(client, { purpose: 'account_email', subjectKey: data.userId, challengeId: issued.challengeId, code: issued.code });
        assert.equal(consumed.status, 'verified');
        await recordMailboxProof(client, data.userId, issued.challengeId);
    }
    const attemptId = randomUUID(); const observedAt = input.observedAt ?? new Date().toISOString();
    const observation = input.observation ?? { identity: { tenantId: tenant, objectId }, educationObservation: { outcome: 'student', objectId, observedAt } };
    await client.query(`INSERT INTO microsoft_verification_attempts
      (id,user_id,university_id,institution_policy_version,provider_policy_version,identity_version,processing_grant_id,provider_consent_id,server_session_id,state_hash,browser_secret_hash,finish_secret_hash,expires_at,status,result)
      SELECT $1,$2,$3,u.verification_policy_version,$4,s.identity_version,$5,$6,$7,$8,'browser','finish',clock_timestamp()+interval '10 minutes','ready',$9::jsonb
      FROM universities u JOIN students s ON s.university_id=u.id WHERE u.id=$3`,
    [attemptId, data.userId, data.universityId, policy.version, data.processingGrantId, consent, sid, `writer-${randomUUID()}`, JSON.stringify(observation)]);
    return attemptId;
}

type FinishTestHooks = {
    onFinishTransactionStarted?: (tx: PoolClient) => Promise<void>;
    beforeFinishCommit?: (tx: PoolClient) => Promise<void>;
};

async function readyGraphAttempt(options: { prelinkedIdentity?: boolean; testHooks?: FinishTestHooks } = {}) {
    const data = await fixture();
    const sid = randomUUID(); let state = '';
    const { consentId, tenantId, objectId, identityId } = await withTestClient((client) => inTransaction(client, async () => {
        await client.query(`UPDATE users SET active_session_id=$2, refresh_token_hash='ready-graph', refresh_token_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [data.userId, sid]);
        await client.query(`UPDATE institution_microsoft_policies
            SET mode='graph_enrollment', scopes=ARRAY['https://graph.microsoft.com/EduRoster.ReadBasic','openid','profile'],
                notice_version='microsoft-v2', term_ends_at=clock_timestamp()+interval '1 day'
            WHERE university_id=$1`, [data.universityId]);
        const policy = (await client.query<{ version: number; tenant_id: string }>('SELECT version,tenant_id FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
        const consentId = await acceptMicrosoftConsent(client, data.userId, {
            accepted: true, processingGrantId: data.processingGrantId,
            snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v2', mode: 'graph_enrollment', scopes: ['https://graph.microsoft.com/EduRoster.ReadBasic', 'openid', 'profile'] },
        });
        const objectId = randomUUID();
        const identityId = options.prelinkedIdentity
            ? (await client.query<{ id: string }>(`INSERT INTO microsoft_identities(user_id,university_id,tenant_id,object_id)
                VALUES($1,$2,$3,$4) RETURNING id`, [data.userId, data.universityId, policy.tenant_id, objectId])).rows[0]!.id
            : undefined;
        const email = (await client.query<{ email: string }>('SELECT email FROM users WHERE id=$1', [data.userId])).rows[0]!.email;
        const issued = await requestChallenge(client, { purpose: 'account_email', subjectKey: data.userId, bindings: { userId: data.userId, email } });
        if (issued.status !== 'issued') throw new Error('Expected Graph fixture mailbox challenge');
        const consumed = await consumeChallenge(client, { purpose: 'account_email', subjectKey: data.userId, challengeId: issued.challengeId, code: issued.code });
        if (consumed.status !== 'verified') throw new Error('Expected Graph fixture mailbox proof');
        await recordMailboxProof(client, data.userId, issued.challengeId);
        return { consentId, tenantId: policy.tenant_id, objectId, identityId };
    }));
    const service = new MicrosoftFlowService({
        pool: db.getPool(), verifierEncryptionKey: randomBytes(32).toString('base64url'), isEnabled: () => true,
        callbackUrl: new URL('https://api.example.invalid/api/verification/microsoft/callback'), completionUrl: new URL('https://app.example.invalid/student/verification/microsoft/complete'),
        oidc: { authorize: async (input) => { state = input.state; return 'https://provider.example.invalid/authorize'; }, redeem: async () => ({ identity: { tenantId, objectId }, graphAccessToken: 'TOKEN_CANARY' }) },
        education: { observe: async ({ expectedOid }) => ({ outcome: 'student', objectId: expectedOid, observedAt: new Date() }) },
        ...(options.testHooks ? { testHooks: options.testHooks } : {}),
    });
    const started = await service.start({ userId: data.userId, serverSessionId: sid, processingGrantId: data.processingGrantId, providerConsentId: consentId });
    const callback = new URL('https://api.example.invalid/api/verification/microsoft/callback'); callback.searchParams.set('state', state); callback.searchParams.set('code', 'CANARY');
    await service.callback({ callbackUrl: callback, browserCookie: started.callbackCookie.value });
    const ready = await withTestClient(async (client) => (await client.query<{ status: string; result: unknown }>(
        'SELECT status,result FROM microsoft_verification_attempts WHERE id=$1', [started.publicResult.attemptId],
    )).rows[0]!);
    assert.equal(ready.status, 'ready');
    assert.equal(JSON.stringify(ready.result).includes('TOKEN_CANARY'), false);
    return { data, sid, consentId, tenantId, objectId, identityId, service, started };
}

type FinishInvalidation = 'provider_policy_change' | 'identity_unlink' | 'account_identity_change' | 'authoritative_denial';

async function mutateFinishAuthority(client: PoolClient, kind: FinishInvalidation, data: Fixture): Promise<void> {
    if (kind === 'provider_policy_change') {
        await client.query(`UPDATE institution_microsoft_policies SET max_evidence_hours=max_evidence_hours-1 WHERE university_id=$1`, [data.universityId]);
        return;
    }
    if (kind === 'identity_unlink') {
        await client.query(`UPDATE microsoft_identities SET revoked_at=clock_timestamp() WHERE user_id=$1 AND university_id=$2 AND revoked_at IS NULL`, [data.userId, data.universityId]);
        return;
    }
    if (kind === 'account_identity_change') {
        await client.query(`UPDATE students SET name=name || ' changed' WHERE user_id=$1`, [data.userId]);
        return;
    }
    await client.query(`UPDATE student_eligibility_state SET authoritative_denial=true WHERE student_id=(SELECT id FROM students WHERE user_id=$1) AND university_id=$2`, [data.userId, data.universityId]);
}

async function graphEvidenceCount(attemptId: string): Promise<number> {
    return withTestClient(async (client) => Number((await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM eligibility_evidence evidence
         JOIN microsoft_provider_proofs proof ON proof.id=evidence.provider_proof_id WHERE proof.attempt_id=$1`, [attemptId],
    )).rows[0]?.count ?? 0));
}

async function callbackRequest(base: string, path: string, headers: http.OutgoingHttpHeaders): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
    const url = new URL(path, base);
    return new Promise((resolve, reject) => {
        const request = http.request(url, { method: 'GET', headers }, (response) => {
            response.resume();
            response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers }));
        });
        request.on('error', reject); request.end();
    });
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

test('canonical Graph writer uses exact configured expiry and is idempotent', async () => {
    const data = await fixture();
    await withTestClient(client => inTransaction(client, async () => {
        const attempt = await graphReadyWriterAttempt(client, data);
        const first = await applyMicrosoftEnrollment(client, attempt, { isEnabled: () => true });
        const second = await applyMicrosoftEnrollment(client, attempt, { isEnabled: () => true });
        assert.equal(first.eligible, true); assert.deepEqual(second, first);
        const row = (await client.query<{ count: string; hours: string }>(
            `SELECT count(*)::text AS count, extract(epoch FROM (e.expires_at-p.observed_at))/3600 AS hours
             FROM eligibility_evidence e JOIN microsoft_provider_proofs p ON p.id=e.provider_proof_id
             WHERE p.attempt_id=$1 GROUP BY e.expires_at,p.observed_at`, [attempt],
        )).rows[0]!;
        assert.equal(row.count, '1'); assert.equal(Number(row.hours), 2);
    }));
});

test('canonical Graph writer creates no positive evidence for unknown observation, missing proof, denial, or stale policy', async () => {
    const unknown = await fixture();
    await withTestClient(client => inTransaction(client, async () => {
        const attempt = await graphReadyWriterAttempt(client, unknown, { observation: { identity: { tenantId: 'x', objectId: 'y' }, educationObservation: { outcome: 'unknown', reason: 'unavailable' } } });
        assert.deepEqual(await applyMicrosoftEnrollment(client, attempt, { isEnabled: () => true }), { eligible: false, reason: 'unverified' });
        assert.equal((await client.query(`SELECT 1 FROM eligibility_evidence WHERE student_id=(SELECT id FROM students WHERE user_id=$1) AND provider_proof_id IS NOT NULL`, [unknown.userId])).rowCount, 0);
    }));
    const missing = await fixture();
    await withTestClient(client => inTransaction(client, async () => {
        const attempt = await graphReadyWriterAttempt(client, missing, { mailbox: false });
        assert.deepEqual(await applyMicrosoftEnrollment(client, attempt, { isEnabled: () => true }), { eligible: false, reason: 'unverified' });
    }));
    const denied = await fixture();
    await withTestClient(client => inTransaction(client, async () => {
        const attempt = await graphReadyWriterAttempt(client, denied);
        await client.query(`UPDATE student_eligibility_state SET authoritative_denial=true WHERE student_id=(SELECT id FROM students WHERE user_id=$1)`, [denied.userId]);
        assert.deepEqual(await applyMicrosoftEnrollment(client, attempt, { isEnabled: () => true }), { eligible: false, reason: 'enrollment_denied' });
        assert.equal((await client.query(`SELECT 1 FROM eligibility_evidence WHERE student_id=(SELECT id FROM students WHERE user_id=$1) AND provider_proof_id IS NOT NULL`, [denied.userId])).rowCount, 0);
    }));
    const stale = await fixture();
    await withTestClient(client => inTransaction(client, async () => {
        const attempt = await graphReadyWriterAttempt(client, stale);
        await client.query(`UPDATE institution_microsoft_policies SET max_evidence_hours=3 WHERE university_id=$1`, [stale.universityId]);
        await assert.rejects(() => applyMicrosoftEnrollment(client, attempt, { isEnabled: () => true }));
    }));
});

test('canonical Graph writer rejects withdrawn grant, session/identity mismatch and disabled global flag without writes', async () => {
    const withdrawn = await fixture();
    await withTestClient(client => inTransaction(client, async () => {
        const attempt = await graphReadyWriterAttempt(client, withdrawn);
        await withdrawConsent(client, withdrawn.userId, withdrawn.processingGrantId);
        await assert.rejects(() => applyMicrosoftEnrollment(client, attempt, { isEnabled: () => true }));
    }));
    const session = await fixture();
    await withTestClient(client => inTransaction(client, async () => {
        const attempt = await graphReadyWriterAttempt(client, session);
        await client.query(`UPDATE users SET active_session_id=$2 WHERE id=$1`, [session.userId, randomUUID()]);
        await assert.rejects(() => applyMicrosoftEnrollment(client, attempt, { isEnabled: () => true }));
    }));
    const identity = await fixture();
    await withTestClient(client => inTransaction(client, async () => {
        const attempt = await graphReadyWriterAttempt(client, identity);
        await client.query(`UPDATE microsoft_identities SET revoked_at=clock_timestamp() WHERE user_id=$1`, [identity.userId]);
        assert.deepEqual(await applyMicrosoftEnrollment(client, attempt, { isEnabled: () => true }), { eligible: false, reason: 'unverified' });
    }));
    const flag = await fixture();
    await withTestClient(client => inTransaction(client, async () => {
        const attempt = await graphReadyWriterAttempt(client, flag);
        assert.deepEqual(await applyMicrosoftEnrollment(client, attempt, { isEnabled: () => false }), { eligible: false, reason: 'unverified' });
        assert.equal((await client.query(`SELECT 1 FROM eligibility_evidence WHERE student_id=(SELECT id FROM students WHERE user_id=$1)`, [flag.userId])).rowCount, 0);
    }));
});

test('Microsoft provenance schema rejects partial metadata and preserves evidence revocation after proof withdrawal', async () => {
    const data = await fixture();
    await withTestClient(client => inTransaction(client, async () => {
        const attempt = await graphReadyWriterAttempt(client, data);
        const row = (await client.query<{ provider_consent_id: string; user_id: string; university_id: string; provider_policy_version: number }>(
            `SELECT provider_consent_id,user_id,university_id,provider_policy_version FROM microsoft_verification_attempts WHERE id=$1`, [attempt],
        )).rows[0]!;
        const identity = (await client.query<{ id: string }>('SELECT id FROM microsoft_identities WHERE user_id=$1', [data.userId])).rows[0]!.id;
        await rejectsSql(() => client.query(
            `INSERT INTO microsoft_provider_proofs(user_id,university_id,provider_consent_id,identity_id,provider_policy_version,observed_at)
             VALUES($1,$2,$3,$4,$5,clock_timestamp())`, [row.user_id, row.university_id, row.provider_consent_id, identity, row.provider_policy_version],
        ), client);
        const otherConsent = await acceptMicrosoftConsent(client, data.userId, { accepted: true, processingGrantId: data.processingGrantId,
            snapshot: { universityId: data.universityId, providerPolicyVersion: row.provider_policy_version, noticeVersion: 'microsoft-v2', mode: 'graph_enrollment', scopes: ['https://graph.microsoft.com/EduRoster.ReadBasic', 'openid', 'profile'] } });
        await rejectsSql(() => client.query(
            `INSERT INTO microsoft_provider_proofs(user_id,university_id,provider_consent_id,identity_id,provider_policy_version,attempt_id,observed_at,outcome,source)
             VALUES($1,$2,$3,$4,$5,$6,clock_timestamp(),'student','microsoft-education:v1')`,
            [row.user_id, row.university_id, otherConsent, identity, row.provider_policy_version, attempt],
        ), client);
        const positive = await applyMicrosoftEnrollment(client, attempt, { isEnabled: () => true });
        assert.equal(positive.eligible, true);
        await withdrawConsent(client, data.userId, data.processingGrantId);
        assert.equal((await client.query(`SELECT 1 FROM eligibility_evidence WHERE id=$1 AND revoked_at IS NOT NULL`, [positive.evidenceId])).rowCount, 1);
    }));
});

test('canonical Graph writer blocks on canonical mutation authority then rejects policy drift', async () => {
    const data = await fixture();
    const attempt = await withTestClient(client => inTransaction(client, () => graphReadyWriterAttempt(client, data)));
    const holder = await db.getPool().connect();
    let writer: PoolClient | undefined;
    try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [data.userId]);
        writer = await db.getPool().connect();
        await writer.query('BEGIN');
        const writerPid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        const applying = applyMicrosoftEnrollment(writer, attempt, { isEnabled: () => true });
        const blockerPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        await assertWriterBlockedBy(holder, blockerPid, writerPid);
        await withTestClient(client => inTransaction(client, () => client.query(
            `UPDATE institution_microsoft_policies SET max_evidence_hours=3 WHERE university_id=$1`, [data.universityId],
        )));
        await holder.query('ROLLBACK');
        await assert.rejects(() => applying);
    } finally {
        await writer?.query('ROLLBACK').catch(() => undefined);
        writer?.release();
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
    }
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
    const identity = { tenantId, objectId: randomUUID() }; let graphCalls = 0;
    const service = new MicrosoftFlowService({ pool: db.getPool(), verifierEncryptionKey: Buffer.from(key.slice(0, 32)).toString('base64url'),
        callbackUrl: new URL('https://api.example.invalid/api/verification/microsoft/callback'), completionUrl: new URL('https://app.example.invalid/student/verification/microsoft/complete'),
        isEnabled: () => true,
        oidc: { authorize: async (input) => { authorizeInput = input; return 'https://provider.example.invalid/authorize'; }, redeem: async (input) => { assert.equal(input.verifier, authorizeInput?.verifier); return { identity }; } },
        education: { observe: async () => { graphCalls += 1; return { outcome: 'unknown', reason: 'unavailable' }; } },
    });
    const started = await service.start({ userId: data.userId, serverSessionId: sid, processingGrantId: data.processingGrantId, providerConsentId: consentId });
    assert.equal((await withTestClient(async (client) => client.query('SELECT 1 FROM microsoft_identities WHERE user_id=$1', [data.userId]))).rowCount, 0);
    const callback = new URL('https://api.example.invalid/api/verification/microsoft/callback'); callback.searchParams.set('state', authorizeInput!.state); callback.searchParams.set('code', 'CANARY-NOT-PERSISTED');
    const complete = await service.callback({ callbackUrl: callback, browserCookie: started.callbackCookie.value });
    assert.equal(graphCalls, 0, 'identity-only policy must not dispatch Graph');
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

test('a durable claimed callback redemption failure returns only a generic terminal outcome and scrubs without evidence', async () => {
    const data = await fixture();
    const sid = randomUUID(); let state = '';
    const consentId = await withTestClient((client) => inTransaction(client, async () => {
        await client.query(`UPDATE users SET active_session_id=$2, refresh_token_hash='redeem-failure', refresh_token_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [data.userId, sid]);
        const policy = (await client.query<{ version: number }>('SELECT version FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
        return acceptMicrosoftConsent(client, data.userId, {
            accepted: true, processingGrantId: data.processingGrantId,
            snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v1', mode: 'identity_only', scopes: ['openid', 'profile'] },
        });
    }));
    const service = new MicrosoftFlowService({
        pool: db.getPool(), verifierEncryptionKey: randomBytes(32).toString('base64url'), isEnabled: () => true,
        callbackUrl: new URL('https://api.example.invalid/api/verification/microsoft/callback'),
        completionUrl: new URL('https://app.example.invalid/student/verification/microsoft/complete'),
        oidc: {
            authorize: async (input) => { state = input.state; return 'https://provider.example.invalid/authorize'; },
            redeem: async () => { throw new Error('SYNTHETIC_REDEMPTION_DETAIL_MUST_NOT_ESCAPE'); },
        },
    });
    const started = await service.start({ userId: data.userId, serverSessionId: sid, processingGrantId: data.processingGrantId, providerConsentId: consentId });
    const callback = new URL('https://api.example.invalid/api/verification/microsoft/callback');
    callback.searchParams.set('state', state); callback.searchParams.set('error', 'access_denied'); callback.searchParams.set('error_description', 'SYNTHETIC_REDEMPTION_DETAIL_MUST_NOT_ESCAPE');
    const terminal = await service.callback({ callbackUrl: callback, browserCookie: started.callbackCookie.value });
    assert.equal(terminal.outcome, 'connection_not_completed');
    assert.equal(terminal.completionUrl.searchParams.get('attempt'), started.publicResult.attemptId);
    assert.equal(terminal.completionUrl.searchParams.get('outcome'), 'connection_not_completed');
    assert.equal(terminal.completionUrl.href.includes('SYNTHETIC_REDEMPTION_DETAIL_MUST_NOT_ESCAPE'), false);
    assert.equal(terminal.completionUrl.href.includes('access_denied'), false);
    await withTestClient(async (client) => inTransaction(client, async () => {
        const stored = (await client.query<{ status: string; encrypted_verifier: string | null; nonce: string | null; result: unknown }>(
            'SELECT status,encrypted_verifier,nonce,result FROM microsoft_verification_attempts WHERE id=$1', [started.publicResult.attemptId],
        )).rows[0]!;
        assert.deepEqual(stored, { status: 'failed', encrypted_verifier: null, nonce: null, result: null });
        assert.equal((await client.query('SELECT 1 FROM microsoft_identities WHERE user_id=$1', [data.userId])).rowCount, 0);
        assert.equal((await client.query('SELECT 1 FROM microsoft_provider_proofs WHERE user_id=$1', [data.userId])).rowCount, 0);
        assert.equal((await client.query(`SELECT 1 FROM eligibility_evidence evidence JOIN students ON students.id=evidence.student_id WHERE students.user_id=$1`, [data.userId])).rowCount, 0);
    }));
    await assert.rejects(() => service.finish({ userId: data.userId, serverSessionId: sid, attemptId: started.publicResult.attemptId, finishSecret: started.publicResult.finishSecret }));
    await assert.rejects(() => service.callback({ callbackUrl: callback, browserCookie: started.callbackCookie.value }));
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

test('both consent withdrawals during held Graph discard the token result and never persist a graph-ready payload', async () => {
    for (const withdrawal of ['processing', 'provider'] as const) {
        const data = await fixture();
        const sid = randomUUID(); let state = ''; let graphCalls = 0;
        const consentId = await withTestClient((client) => inTransaction(client, async () => {
            await client.query(`UPDATE users SET active_session_id=$2, refresh_token_hash='graph-test', refresh_token_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [data.userId, sid]);
            await client.query(`UPDATE institution_microsoft_policies
                SET mode='graph_enrollment', scopes=ARRAY['https://graph.microsoft.com/EduRoster.ReadBasic','openid','profile'],
                    notice_version='microsoft-v2', term_ends_at=clock_timestamp()+interval '1 day'
                WHERE university_id=$1`, [data.universityId]);
            const policy = (await client.query<{ version: number }>('SELECT version FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
            return acceptMicrosoftConsent(client, data.userId, { accepted: true, processingGrantId: data.processingGrantId,
                snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v2', mode: 'graph_enrollment', scopes: ['https://graph.microsoft.com/EduRoster.ReadBasic', 'openid', 'profile'] } });
        }));
        const tenantId = (await withTestClient(async (client) => (await client.query<{ tenant_id: string }>('SELECT tenant_id FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!.tenant_id));
        let releaseGraph: (() => void) | undefined; let enteredGraph: (() => void) | undefined;
        const heldGraph = new Promise<void>((resolve) => { releaseGraph = resolve; });
        const graphEntered = new Promise<void>((resolve) => { enteredGraph = resolve; });
        const service = new MicrosoftFlowService({
            pool: db.getPool(), verifierEncryptionKey: randomBytes(32).toString('base64url'), isEnabled: () => true,
            callbackUrl: new URL('https://api.example.invalid/api/verification/microsoft/callback'), completionUrl: new URL('https://app.example.invalid/student/verification/microsoft/complete'),
            oidc: { authorize: async (input) => { state = input.state; return 'https://provider.example.invalid/authorize'; }, redeem: async () => ({ identity: { tenantId, objectId: randomUUID() }, graphAccessToken: 'TOKEN_CANARY' }) },
            education: { observe: async () => { graphCalls += 1; enteredGraph!(); await heldGraph; return { outcome: 'student', objectId: 'not-used', observedAt: new Date() }; } },
        });
        const started = await service.start({ userId: data.userId, serverSessionId: sid, processingGrantId: data.processingGrantId, providerConsentId: consentId });
        const callback = new URL('https://api.example.invalid/api/verification/microsoft/callback'); callback.searchParams.set('state', state); callback.searchParams.set('code', 'CANARY');
        const pending = service.callback({ callbackUrl: callback, browserCookie: started.callbackCookie.value });
        await graphEntered;
        await withTestClient((client) => inTransaction(client, () => withdrawal === 'processing'
            ? withdrawConsent(client, data.userId, data.processingGrantId)
            : withdrawMicrosoftConsent(client, data.userId, consentId)));
        releaseGraph!();
        await assert.rejects(() => pending);
        assert.equal(graphCalls, 1, `${withdrawal} can only stop Graph persistence after its already-dispatched request`);
        const stored = await withTestClient(async (client) => (await client.query<{ status: string; result: unknown }>(
            'SELECT status,result FROM microsoft_verification_attempts WHERE id=$1', [started.publicResult.attemptId],
        )).rows[0]!);
        assert.equal(stored.status, 'failed'); assert.equal(stored.result, null);
        assert.equal(JSON.stringify(stored).includes('TOKEN_CANARY'), false);
    }
});

test('Graph callback writes only the canonical observation and finish writes an eligible receipt bound to that evidence', async () => {
    const data = await fixture(); const sid = randomUUID(); let state = '';
    const { consentId, tenantId } = await withTestClient((client) => inTransaction(client, async () => {
        await client.query(`UPDATE users SET active_session_id=$2, refresh_token_hash='graph-positive', refresh_token_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [data.userId, sid]);
        await client.query(`UPDATE institution_microsoft_policies SET mode='graph_enrollment', scopes=ARRAY['https://graph.microsoft.com/EduRoster.ReadBasic','openid','profile'], notice_version='microsoft-v2', term_ends_at=clock_timestamp()+interval '1 day' WHERE university_id=$1`, [data.universityId]);
        const policy = (await client.query<{ version: number; tenant_id: string }>('SELECT version,tenant_id FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
        const consentId = await acceptMicrosoftConsent(client, data.userId, { accepted: true, processingGrantId: data.processingGrantId,
            snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v2', mode: 'graph_enrollment', scopes: ['https://graph.microsoft.com/EduRoster.ReadBasic', 'openid', 'profile'] } });
        const email = (await client.query<{ email: string }>('SELECT email FROM users WHERE id=$1', [data.userId])).rows[0]!.email;
        const issued = await requestChallenge(client, { purpose: 'account_email', subjectKey: data.userId, bindings: { userId: data.userId, email } });
        if (issued.status !== 'issued') throw new Error('Expected mailbox challenge');
        const consumed = await consumeChallenge(client, { purpose: 'account_email', subjectKey: data.userId, challengeId: issued.challengeId, code: issued.code });
        if (consumed.status !== 'verified') throw new Error('Expected mailbox proof');
        await recordMailboxProof(client, data.userId, issued.challengeId);
        return { consentId, tenantId: policy.tenant_id };
    }));
    const objectId = randomUUID();
    const service = new MicrosoftFlowService({
        pool: db.getPool(), verifierEncryptionKey: randomBytes(32).toString('base64url'), isEnabled: () => true,
        callbackUrl: new URL('https://api.example.invalid/api/verification/microsoft/callback'), completionUrl: new URL('https://app.example.invalid/student/verification/microsoft/complete'),
        oidc: { authorize: async (input) => { state = input.state; return 'https://provider.example.invalid/authorize'; }, redeem: async () => ({ identity: { tenantId, objectId }, graphAccessToken: 'TOKEN_CANARY' }) },
        education: { observe: async ({ expectedOid }) => ({ outcome: 'student', objectId: expectedOid, observedAt: new Date() }) },
    });
    const started = await service.start({ userId: data.userId, serverSessionId: sid, processingGrantId: data.processingGrantId, providerConsentId: consentId });
    const callback = new URL('https://api.example.invalid/api/verification/microsoft/callback'); callback.searchParams.set('state', state); callback.searchParams.set('code', 'CANARY');
    await service.callback({ callbackUrl: callback, browserCookie: started.callbackCookie.value });
    const ready = await withTestClient(async (client) => (await client.query<{ result: unknown }>('SELECT result FROM microsoft_verification_attempts WHERE id=$1', [started.publicResult.attemptId])).rows[0]!.result);
    assert.equal(JSON.stringify(ready).includes('TOKEN_CANARY'), false);
    const first = await service.finish({ userId: data.userId, serverSessionId: sid, attemptId: started.publicResult.attemptId, finishSecret: started.publicResult.finishSecret });
    assert.deepEqual(first, { accountLinked: true, enrollment: 'eligible' });
    const receipt = await withTestClient(async (client) => (await client.query<{ result: { evidenceId: string; providerProofId: string } }>('SELECT result FROM microsoft_verification_attempts WHERE id=$1', [started.publicResult.attemptId])).rows[0]!.result);
    assert.equal(typeof receipt.evidenceId, 'string'); assert.equal(typeof receipt.providerProofId, 'string');
    await withTestClient((client) => inTransaction(client, () => client.query(`UPDATE student_eligibility_state SET authoritative_denial=true WHERE student_id=(SELECT id FROM students WHERE user_id=$1) AND university_id=$2`, [data.userId, data.universityId])));
    assert.deepEqual(await service.finish({ userId: data.userId, serverSessionId: sid, attemptId: started.publicResult.attemptId, finishSecret: started.publicResult.finishSecret }), { accountLinked: true, enrollment: 'denied' });
    await withTestClient((client) => inTransaction(client, () => client.query(`UPDATE student_eligibility_state SET authoritative_denial=false WHERE student_id=(SELECT id FROM students WHERE user_id=$1) AND university_id=$2`, [data.userId, data.universityId])));
    await withTestClient((client) => inTransaction(client, () => client.query(`UPDATE microsoft_provider_proofs SET revoked_at=clock_timestamp() WHERE id=$1`, [receipt.providerProofId])));
    await assert.rejects(() => service.finish({ userId: data.userId, serverSessionId: sid, attemptId: started.publicResult.attemptId, finishSecret: started.publicResult.finishSecret }));
});

test('actual finished Graph evidence issues and exchanges a merchant assertion, then rejects after allowed provenance revocation', async () => {
    const originalEnabled = config.microsoftOidc.enabled;
    config.microsoftOidc.enabled = true;
    try {
        const flow = await readyGraphAttempt();
        assert.deepEqual(await flow.service.finish({ userId: flow.data.userId, serverSessionId: flow.sid, attemptId: flow.started.publicResult.attemptId, finishSecret: flow.started.publicResult.finishSecret }), { accountLinked: true, enrollment: 'eligible' });
        const merchant = await withTestClient((client) => inTransaction(client, async () => {
        const ownerId = (await client.query<{ id: string }>(`INSERT INTO users(email,role) VALUES($1,'vendor') RETURNING id`, [`graph-merchant-${randomUUID()}@example.invalid`])).rows[0]!.id;
        const vendorId = (await client.query<{ id: string }>(`INSERT INTO vendors(user_id,name,status) VALUES($1,'Graph merchant','active') RETURNING id`, [ownerId])).rows[0]!.id;
        const origin = 'https://graph-merchant.example';
        await client.query(`INSERT INTO widget_configs(vendor_id,allowed_domains,allowed_origins,api_key,status)
            VALUES($1,ARRAY['graph-merchant.example'],ARRAY[$2],$3,'active')`, [vendorId, origin, randomUUID()]);
        const disclosureGrantId = await grantMerchantDisclosure(client, flow.data.userId, {
            vendorId, origin, purpose: 'student-discount', accepted: true, noticeVersion: MERCHANT_DISCLOSURE_NOTICE_VERSION,
        });
        return { ownerId, vendorId, origin, disclosureGrantId };
        }));
        const key = await rotateReportingKey(db.getPool(), merchant.ownerId);
        const input = { vendorId: merchant.vendorId, origin: merchant.origin, purpose: 'student-discount', campaignId: 'actual-graph', disclosureGrantId: merchant.disclosureGrantId };
        const assertion = await issueMerchantAssertion(db.getPool(), flow.data.userId, input);
        const exchange = await exchangeMerchantAssertion(db.getPool(), key, { code: assertion.code, campaignId: input.campaignId, idempotencyKey: randomUUID() });
        assert.equal(exchange.assuranceMethod, 'enrollment');
        const proof = await withTestClient(async (client) => (await client.query<{ provider_proof_id: string }>(
        `SELECT evidence.provider_proof_id FROM eligibility_evidence evidence
         JOIN microsoft_provider_proofs proof ON proof.id=evidence.provider_proof_id
         WHERE proof.attempt_id=$1 AND evidence.student_id=(SELECT id FROM students WHERE user_id=$2)`,
        [flow.started.publicResult.attemptId, flow.data.userId],
        )).rows[0]);
        if (!proof) throw new Error('Expected actual Graph evidence provenance');
        const invalidated = await issueMerchantAssertion(db.getPool(), flow.data.userId, input);
        await withTestClient((client) => inTransaction(client, () => client.query(`UPDATE microsoft_provider_proofs SET revoked_at=clock_timestamp() WHERE id=$1`, [proof.provider_proof_id])));
        await assert.rejects(() => exchangeMerchantAssertion(db.getPool(), key, { code: invalidated.code, campaignId: input.campaignId, idempotencyKey: randomUUID() }), /no longer eligible/i);
    } finally {
        config.microsoftOidc.enabled = originalEnabled;
    }
});

test('completed Graph receipt rejects an initially expired controlled evidence fixture without mutating immutable evidence', async () => {
    const data = await fixture(); const finishSecret = randomUUID();
    const seeded = await withTestClient((client) => inTransaction(client, async () => {
        const attemptId = await graphReadyWriterAttempt(client, data);
        const attempt = (await client.query<{
            provider_consent_id: string; provider_policy_version: number; server_session_id: string; identity_version: number; institution_policy_version: number;
        }>(`SELECT provider_consent_id,provider_policy_version,server_session_id,identity_version,institution_policy_version
             FROM microsoft_verification_attempts WHERE id=$1`, [attemptId])).rows[0]!;
        const identityId = (await client.query<{ id: string }>('SELECT id FROM microsoft_identities WHERE user_id=$1 AND university_id=$2', [data.userId, data.universityId])).rows[0]!.id;
        const proofId = (await client.query<{ id: string }>(`INSERT INTO microsoft_provider_proofs
            (user_id,university_id,provider_consent_id,identity_id,provider_policy_version,attempt_id,observed_at,outcome,source)
            VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()-interval '3 hours','student','microsoft-education:v1') RETURNING id`,
        [data.userId, data.universityId, attempt.provider_consent_id, identityId, attempt.provider_policy_version, attemptId])).rows[0]!.id;
        const evidenceId = (await client.query<{ id: string }>(`INSERT INTO eligibility_evidence
            (student_id,university_id,email_proof_id,processing_grant_id,provider_proof_id,method,outcome,identity_version,policy_version,source,expires_at)
            SELECT students.id,$2,proof.id,attempt.processing_grant_id,$3,'enrollment','verified',$4,$5,'microsoft-education:v1',clock_timestamp()-interval '1 second'
            FROM students
            JOIN microsoft_verification_attempts attempt ON attempt.id=$1
            JOIN user_email_proofs proof ON proof.user_id=attempt.user_id
            WHERE students.user_id=attempt.user_id
            ORDER BY proof.proven_at DESC,proof.id DESC LIMIT 1 RETURNING id`,
        [attemptId, data.universityId, proofId, attempt.identity_version, attempt.institution_policy_version])).rows[0]!.id;
        await client.query(`UPDATE microsoft_verification_attempts SET status='completed', finish_secret_hash=$2, result=$3::jsonb WHERE id=$1`, [
            attemptId, hashMicrosoftAttemptSecret(finishSecret), JSON.stringify({ accountLinked: true, enrollment: 'eligible', identityId, evidenceId, providerProofId: proofId }),
        ]);
        return { attemptId, sid: attempt.server_session_id, evidenceId };
    }));
    const service = new MicrosoftFlowService({ pool: db.getPool(), verifierEncryptionKey: randomBytes(32).toString('base64url'), isEnabled: () => true,
        callbackUrl: new URL('https://api.example.invalid/api/verification/microsoft/callback'), completionUrl: new URL('https://app.example.invalid/student/verification/microsoft/complete'),
        oidc: { authorize: async () => 'unused', redeem: async () => { throw new Error('unused'); } },
    });
    await assert.rejects(() => service.finish({ userId: data.userId, serverSessionId: seeded.sid, attemptId: seeded.attemptId, finishSecret }));
    await withTestClient((client) => inTransaction(client, (async () => {
        await rejectsSql(() => client.query(`UPDATE eligibility_evidence SET expires_at=clock_timestamp() WHERE id=$1`, [seeded.evidenceId]), client);
    })));
});

test('actual Graph finish serializes provider, identity, account, and denial invalidations in both commit orders', async () => {
    const invalidations: readonly FinishInvalidation[] = ['provider_policy_change', 'identity_unlink', 'account_identity_change', 'authoritative_denial'];
    for (const kind of invalidations) {
        let finishPid = 0; let finishStarted!: () => void;
        const started = new Promise<void>((resolve) => { finishStarted = resolve; });
        const flow = await readyGraphAttempt({
            prelinkedIdentity: kind === 'identity_unlink',
            testHooks: { onFinishTransactionStarted: async (tx) => { finishPid = Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid); finishStarted(); } },
        });
        const mutation = await db.getPool().connect(); const observer = await db.getPool().connect();
        try {
            const mutationPid = Number((await mutation.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
            await mutation.query('BEGIN');
            await mutateFinishAuthority(mutation, kind, flow.data);
            const pending = flow.service.finish({ userId: flow.data.userId, serverSessionId: flow.sid, attemptId: flow.started.publicResult.attemptId, finishSecret: flow.started.publicResult.finishSecret });
            await started;
            await assertPidBlockedBy(observer, finishPid, mutationPid, `${kind} mutation-first finish`);
            await mutation.query('COMMIT');
            if (kind === 'authoritative_denial') {
                assert.deepEqual(await pending, { accountLinked: true, enrollment: 'denied' });
            } else {
                await assert.rejects(() => pending);
            }
            assert.equal(await graphEvidenceCount(flow.started.publicResult.attemptId), 0, `${kind} committed first cannot write obsolete Graph evidence`);
        } finally {
            await mutation.query('ROLLBACK').catch(() => undefined); mutation.release(); observer.release();
        }
    }

    for (const kind of invalidations) {
        let finishPid = 0; let finishStarted!: () => void; let release!: () => void; let entered!: () => void;
        const started = new Promise<void>((resolve) => { finishStarted = resolve; });
        const released = new Promise<void>((resolve) => { release = resolve; });
        const atPrecommit = new Promise<void>((resolve) => { entered = resolve; });
        const flow = await readyGraphAttempt({
            prelinkedIdentity: kind === 'identity_unlink',
            testHooks: {
                onFinishTransactionStarted: async (tx) => { finishPid = Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid); finishStarted(); },
                beforeFinishCommit: async () => {
                    entered();
                    await Promise.race([released, delay(5_000).then(() => { throw new Error('finish test precommit barrier timed out'); })]);
                },
            },
        });
        const pending = flow.service.finish({ userId: flow.data.userId, serverSessionId: flow.sid, attemptId: flow.started.publicResult.attemptId, finishSecret: flow.started.publicResult.finishSecret });
        await started; await atPrecommit;
        const mutation = await db.getPool().connect(); const observer = await db.getPool().connect();
        try {
            const mutationPid = Number((await mutation.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
            await mutation.query('BEGIN');
            const changed = mutateFinishAuthority(mutation, kind, flow.data);
            await assertPidBlockedBy(observer, mutationPid, finishPid, `${kind} finish-first mutation`);
            release();
            assert.deepEqual(await pending, { accountLinked: true, enrollment: 'eligible' });
            await changed; await mutation.query('COMMIT');
            const retry = flow.service.finish({ userId: flow.data.userId, serverSessionId: flow.sid, attemptId: flow.started.publicResult.attemptId, finishSecret: flow.started.publicResult.finishSecret });
            if (kind === 'authoritative_denial') {
                assert.deepEqual(await retry, { accountLinked: true, enrollment: 'denied' }, 'a later authoritative denial must never be returned as positive retry success');
            } else {
                await assert.rejects(() => retry);
            }
        } finally {
            release?.();
            await mutation.query('ROLLBACK').catch(() => undefined); mutation.release(); observer.release();
        }
    }
});

test('unknown Graph observation links the validated identity but never fabricates Microsoft or fallback enrollment evidence', async () => {
    const data = await fixture(); const sid = randomUUID(); let state = '';
    const { consentId, tenantId } = await withTestClient((client) => inTransaction(client, async () => {
        await client.query(`UPDATE users SET active_session_id=$2, refresh_token_hash='graph-unknown', refresh_token_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [data.userId, sid]);
        await client.query(`UPDATE institution_microsoft_policies SET mode='graph_enrollment', scopes=ARRAY['https://graph.microsoft.com/EduRoster.ReadBasic','openid','profile'], notice_version='microsoft-v2', term_ends_at=clock_timestamp()+interval '1 day' WHERE university_id=$1`, [data.universityId]);
        const policy = (await client.query<{ version: number; tenant_id: string }>('SELECT version,tenant_id FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
        return { consentId: await acceptMicrosoftConsent(client, data.userId, { accepted: true, processingGrantId: data.processingGrantId,
            snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v2', mode: 'graph_enrollment', scopes: ['https://graph.microsoft.com/EduRoster.ReadBasic', 'openid', 'profile'] } }), tenantId: policy.tenant_id };
    }));
    const service = new MicrosoftFlowService({ pool: db.getPool(), verifierEncryptionKey: randomBytes(32).toString('base64url'), isEnabled: () => true,
        callbackUrl: new URL('https://api.example.invalid/api/verification/microsoft/callback'), completionUrl: new URL('https://app.example.invalid/student/verification/microsoft/complete'),
        oidc: { authorize: async (input) => { state = input.state; return 'https://provider.example.invalid/authorize'; }, redeem: async () => ({ identity: { tenantId, objectId: randomUUID() }, graphAccessToken: 'TOKEN_CANARY' }) },
        education: { observe: async () => ({ outcome: 'unknown', reason: 'role_not_confirmed' }) },
    });
    const started = await service.start({ userId: data.userId, serverSessionId: sid, processingGrantId: data.processingGrantId, providerConsentId: consentId });
    const callback = new URL('https://api.example.invalid/api/verification/microsoft/callback'); callback.searchParams.set('state', state); callback.searchParams.set('code', 'CANARY');
    await service.callback({ callbackUrl: callback, browserCookie: started.callbackCookie.value });
    assert.deepEqual(await service.finish({ userId: data.userId, serverSessionId: sid, attemptId: started.publicResult.attemptId, finishSecret: started.publicResult.finishSecret }), { accountLinked: true, enrollment: 'unconfirmed' });
    const evidence = await withTestClient(async (client) => (await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM eligibility_evidence evidence JOIN students student ON student.id=evidence.student_id WHERE student.user_id=$1`, [data.userId])).rows[0]!.count);
    assert.equal(evidence, 0);
});

test('Graph mode cancellation prevents claim dispatch, prevents Graph after held token, and prevents ready finish', async () => {
    for (const withdrawal of ['processing', 'provider'] as const) for (const phase of ['before_claim', 'held_token', 'after_ready'] as const) {
        const data = await fixture(); const sid = randomUUID(); let state = ''; let tokenCalls = 0; let graphCalls = 0;
        const { consentId, tenantId } = await withTestClient((client) => inTransaction(client, async () => {
            await client.query(`UPDATE users SET active_session_id=$2, refresh_token_hash='graph-cancel', refresh_token_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [data.userId, sid]);
            await client.query(`UPDATE institution_microsoft_policies SET mode='graph_enrollment', scopes=ARRAY['https://graph.microsoft.com/EduRoster.ReadBasic','openid','profile'], notice_version='microsoft-v2', term_ends_at=clock_timestamp()+interval '1 day' WHERE university_id=$1`, [data.universityId]);
            const policy = (await client.query<{ version: number; tenant_id: string }>('SELECT version,tenant_id FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
            return { consentId: await acceptMicrosoftConsent(client, data.userId, { accepted: true, processingGrantId: data.processingGrantId,
                snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v2', mode: 'graph_enrollment', scopes: ['https://graph.microsoft.com/EduRoster.ReadBasic', 'openid', 'profile'] } }), tenantId: policy.tenant_id };
        }));
        let releaseToken: (() => void) | undefined; let enteredToken: (() => void) | undefined;
        const heldToken = new Promise<void>((resolve) => { releaseToken = resolve; });
        const tokenEntered = new Promise<void>((resolve) => { enteredToken = resolve; });
        const service = new MicrosoftFlowService({ pool: db.getPool(), verifierEncryptionKey: randomBytes(32).toString('base64url'), isEnabled: () => true,
            callbackUrl: new URL('https://api.example.invalid/api/verification/microsoft/callback'), completionUrl: new URL('https://app.example.invalid/student/verification/microsoft/complete'),
            oidc: { authorize: async (input) => { state = input.state; return 'https://provider.example.invalid/authorize'; }, redeem: async () => { tokenCalls += 1; if (phase === 'held_token') { enteredToken!(); await heldToken; } return { identity: { tenantId, objectId: randomUUID() }, graphAccessToken: 'TOKEN_CANARY' }; } },
            education: { observe: async () => { graphCalls += 1; return { outcome: 'unknown', reason: 'unavailable' }; } },
        });
        const started = await service.start({ userId: data.userId, serverSessionId: sid, processingGrantId: data.processingGrantId, providerConsentId: consentId });
        const callback = new URL('https://api.example.invalid/api/verification/microsoft/callback'); callback.searchParams.set('state', state); callback.searchParams.set('code', 'CANARY');
        const withdraw = () => withTestClient((client) => inTransaction(client, () => withdrawal === 'processing' ? withdrawConsent(client, data.userId, data.processingGrantId) : withdrawMicrosoftConsent(client, data.userId, consentId)));
        if (phase === 'before_claim') {
            await withdraw(); await assert.rejects(() => service.callback({ callbackUrl: callback, browserCookie: started.callbackCookie.value }));
            assert.equal(tokenCalls, 0); assert.equal(graphCalls, 0);
        } else if (phase === 'held_token') {
            const pending = service.callback({ callbackUrl: callback, browserCookie: started.callbackCookie.value }); await tokenEntered;
            await withdraw(); releaseToken!(); await assert.rejects(() => pending);
            assert.equal(tokenCalls, 1); assert.equal(graphCalls, 0, 'post-token authority check must fence Graph');
        } else {
            await service.callback({ callbackUrl: callback, browserCookie: started.callbackCookie.value }); assert.equal(graphCalls, 1);
            await withdraw(); await assert.rejects(() => service.finish({ userId: data.userId, serverSessionId: sid, attemptId: started.publicResult.attemptId, finishSecret: started.publicResult.finishSecret }));
            assert.equal((await withTestClient((client) => client.query('SELECT 1 FROM microsoft_identities WHERE user_id=$1', [data.userId]))).rowCount, 0);
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

test('mounted Microsoft callback and finish use the durable service with fixed redirect and redacted failure headers', async () => {
    const flow = await pendingDurableAttempt();
    const widget = await withTestClient(async (client) => inTransaction(client, async () => {
        const owner = (await client.query<{ id:string }>(`INSERT INTO users(email,role) VALUES($1,'vendor') RETURNING id`, [`widget-${randomUUID()}@example.invalid`])).rows[0]!.id;
        const vendor = (await client.query<{ id:string }>(`INSERT INTO vendors(user_id,name,status) VALUES($1,'Mounted Widget','active') RETURNING id`, [owner])).rows[0]!.id;
        const apiKey = randomUUID();
        await client.query(`INSERT INTO widget_configs(vendor_id,allowed_domains,allowed_origins,api_key,status) VALUES($1,ARRAY['merchant.example'],ARRAY['https://merchant.example'],$2,'active')`, [vendor, apiKey]);
        return { vendor, apiKey };
    }));
    const app = await createApp({ microsoftFlowFactory: () => flow.service });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a loopback test port');
    const base = `http://127.0.0.1:${address.port}`;
    const callbackState = flow.callback.searchParams.get('state')!;
    const callbackHeaders = { host: 'api.example.invalid', 'x-forwarded-proto': 'https', cookie: `${flow.started.callbackCookie.name}=${flow.started.callbackCookie.value}` };
    try {
        const noCookie = await callbackRequest(base, `/api/verification/microsoft/callback?state=${callbackState}&code=CANARY_CODE`, { host: 'api.example.invalid', 'x-forwarded-proto': 'https' });
        assert.equal(noCookie.status, 409);
        assert.equal((await withTestClient((client) => client.query(`SELECT count(*)::int AS count FROM microsoft_identities WHERE user_id=$1`, [flow.data.userId]))).rows[0]!.count, 0);
        const callback = await callbackRequest(base, `/api/verification/microsoft/callback?state=${callbackState}&code=CANARY_CODE`, callbackHeaders);
        assert.equal(callback.status, 303);
        const location = callback.headers.location! as string;
        assert.equal(location, `https://app.example.invalid/student/verification/microsoft/complete?attempt=${flow.started.publicResult.attemptId}`);
        assert.equal(location.includes('CANARY_CODE'), false);
        assert.match(String(callback.headers['set-cookie'] ?? ''), new RegExp(`${flow.started.callbackCookie.name}=;`));
        assert.equal(callback.headers['cache-control'], 'no-store');
        assert.equal(callback.headers['referrer-policy'], 'no-referrer');

        const token = jwtService.generateAccessToken({ userId: flow.data.userId, email: 'student@example.invalid', role: 'student', sid: flow.sid });
        const finish = await fetch(`${base}/api/verification/microsoft/finish`, { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ attemptId: flow.started.publicResult.attemptId, finishSecret: flow.started.publicResult.finishSecret }) });
        assert.equal(finish.status, 200);
        const result = await finish.json() as { data: { accountLinked: boolean; enrollment: string } };
        assert.deepEqual(result.data, { accountLinked: true, enrollment: 'not_checked' });

        const replay = await callbackRequest(base, `/api/verification/microsoft/callback?state=${callbackState}&code=CANARY_CODE`, callbackHeaders);
        assert.equal(replay.status, 409);
        assert.match(String(replay.headers['set-cookie'] ?? ''), new RegExp(`${flow.started.callbackCookie.name}=;`));

        const widgetOrigin = 'https://merchant.example';
        const widgetOk = await fetch(`${base}/api/widget/domain-check?domain=merchant.example&apiKey=${widget.apiKey}`, { headers: { origin: widgetOrigin } });
        assert.equal(widgetOk.status, 200); assert.equal(widgetOk.headers.get('access-control-allow-origin'), widgetOrigin);
        const widgetUnknown = await fetch(`${base}/api/widget/domain-check?domain=unknown.example&apiKey=${widget.apiKey}`, { headers: { origin: 'https://unknown.example' } });
        assert.equal(widgetUnknown.status, 403); assert.equal(widgetUnknown.headers.get('access-control-allow-origin'), null);
        await withTestClient((client) => client.query(`UPDATE widget_configs SET status='suspended' WHERE vendor_id=$1`, [widget.vendor]));
        const widgetDisabled = await fetch(`${base}/api/widget/domain-check?domain=merchant.example&apiKey=${widget.apiKey}`, { headers: { origin: widgetOrigin } });
        assert.equal(widgetDisabled.status, 403); assert.equal(widgetDisabled.headers.get('access-control-allow-origin'), null);
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('mounted Microsoft start returns only the finish secret and sets the state-resolved HttpOnly callback cookie', async () => {
    const data = await fixture(); const sid = randomUUID(); let authorized = 0;
    const consentId = await withTestClient((client) => inTransaction(client, async () => {
        await client.query(`UPDATE users SET active_session_id=$2,refresh_token_hash='h',refresh_token_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [data.userId, sid]);
        const policy = (await client.query<{ version:number }>('SELECT version FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
        return acceptMicrosoftConsent(client, data.userId, { accepted:true, processingGrantId:data.processingGrantId, snapshot:{ universityId:data.universityId, providerPolicyVersion:policy.version, noticeVersion:'microsoft-v1', mode:'identity_only', scopes:['openid','profile'] } });
    }));
    const service = new MicrosoftFlowService({ pool: db.getPool(), verifierEncryptionKey: randomBytes(32).toString('base64url'), isEnabled: () => true,
        callbackUrl: new URL('https://api.example.invalid/api/verification/microsoft/callback'), completionUrl: new URL('https://app.example.invalid/student/verification/microsoft/complete'),
        oidc: { authorize: async () => { authorized += 1; return 'https://provider.example.invalid/authorize'; }, redeem: async () => { throw new Error('not used'); } },
    });
    const app = await createApp({ microsoftFlowFactory: () => service }); const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a loopback test port');
    try {
        const token = jwtService.generateAccessToken({ userId:data.userId, email:'student@example.invalid', role:'student', sid });
        const response = await fetch(`http://127.0.0.1:${address.port}/api/verification/microsoft/start`, { method:'POST', headers:{ origin:'http://localhost:3000', 'content-type':'application/json', authorization:`Bearer ${token}` }, body:JSON.stringify({ processingGrantId:data.processingGrantId, providerConsentId:consentId }) });
        const text = await response.text();
        assert.equal(response.status, 201); assert.equal(authorized, 1);
        assert.match(response.headers.get('set-cookie') ?? '', /HttpOnly; Secure; SameSite=Lax/i);
        assert.match(response.headers.get('set-cookie') ?? '', /Path=\/api\/verification\/microsoft\/callback/i);
        assert.equal(text.includes('awoof_ms_'), false);
        assert.equal(text.includes('browserSecret'), false);
        assert.equal(text.includes('finishSecret'), true);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test('mounted Microsoft consent routes bind the rendered snapshot, preserve owner withdrawal, and keep history available with issuance off', async () => {
    const data = await fixture();
    const sid = randomUUID();
    const other = await withTestClient((client) => inTransaction(client, async () => {
        await client.query(`UPDATE institution_microsoft_policies SET notice_version='microsoft-v3' WHERE university_id=$1`, [data.universityId]);
        await client.query(`UPDATE users SET active_session_id=$2,refresh_token_hash='consent-route',refresh_token_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [data.userId, sid]);
        const other = (await client.query<{ id: string }>(`INSERT INTO users (email,role,active_session_id,refresh_token_hash,refresh_token_expires_at)
            VALUES ($1,'student',$2,'other-consent-route',clock_timestamp()+interval '1 hour') RETURNING id`, [`other-${randomUUID()}@example.invalid`, randomUUID()])).rows[0]!.id;
        await client.query(`INSERT INTO students (user_id,name,university_id) VALUES($1,'Other',$2)`, [other, data.universityId]);
        const processingGrantId = await grantVerificationProcessing(client, other, data.universityId, { accepted:true, noticeVersion:VERIFICATION_NOTICE_VERSION });
        return { userId: other, processingGrantId };
    }));
    let issuanceEnabled = true;
    const app = await createApp({ microsoftIssuanceEnabled: () => issuanceEnabled });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a loopback test port');
    const base = `http://127.0.0.1:${address.port}/api/verification/microsoft`;
    const token = jwtService.generateAccessToken({ userId:data.userId, email:'student@example.invalid', role:'student', sid });
    const headers = { authorization:`Bearer ${token}`, origin:'http://localhost:3000', 'content-type':'application/json' };
    const mutableConfig = config as unknown as { microsoftOidc: { enabled: boolean }; microsoftVerification: { attemptEncryptionKey?: string } };
    const originalOidc = mutableConfig.microsoftOidc;
    const originalKey = mutableConfig.microsoftVerification.attemptEncryptionKey;
    try {
        const disabledMethods = await fetch(`${base.replace('/microsoft', '')}/methods/${data.universityId}`);
        const disabledMethodBody = await disabledMethods.json() as { data: { methods: Array<{ methodType: string; isAvailable: boolean }> } };
        const disabledEmail = disabledMethodBody.data.methods.find((method) => method.methodType === 'email');
        assert.equal(disabledMethodBody.data.methods.find((method) => method.methodType === 'microsoft')?.isAvailable, false);
        mutableConfig.microsoftOidc = { enabled: true };
        mutableConfig.microsoftVerification.attemptEncryptionKey = randomBytes(32).toString('base64url');
        const enabledMethods = await fetch(`${base.replace('/microsoft', '')}/methods/${data.universityId}`);
        const enabledMethodBody = await enabledMethods.json() as { data: { methods: Array<{ methodType: string; isAvailable: boolean }> } };
        assert.equal(enabledMethodBody.data.methods.find((method) => method.methodType === 'microsoft')?.isAvailable, true);
        assert.equal(enabledMethodBody.data.methods.find((method) => method.methodType === 'email')?.isAvailable, disabledEmail?.isAvailable);

        const noticeResponse = await fetch(`${base}/notice`, { headers:{ authorization: headers.authorization } });
        const noticeBody = await noticeResponse.json() as { data: { snapshot: { universityId: string; providerPolicyVersion: number; noticeVersion: string; mode: string; scopes: string[] }; copy: { text: string } } };
        assert.equal(noticeResponse.status, 200);
        assert.equal(noticeBody.data.snapshot.universityId, data.universityId);
        assert.equal(noticeBody.data.snapshot.noticeVersion, 'microsoft-v3');
        assert.match(noticeBody.data.copy.text, /10 minutes/i);
        assert.match(noticeBody.data.copy.text, /30 days/i);

        const accepted = await fetch(`${base}/consents`, { method:'POST', headers, body:JSON.stringify({ accepted:true, processingGrantId:data.processingGrantId, snapshot:noticeBody.data.snapshot }) });
        const acceptedBody = await accepted.json() as { data: { providerConsentId: string } };
        assert.equal(accepted.status, 201);
        assert.match(acceptedBody.data.providerConsentId, /^[0-9a-f-]{36}$/i);

        const displayedSnapshot = { ...noticeBody.data.snapshot, mode: noticeBody.data.snapshot.mode as 'identity_only' | 'graph_enrollment' };
        const extra = await fetch(`${base}/consents`, { method:'POST', headers, body:JSON.stringify({ accepted:true, processingGrantId:data.processingGrantId, snapshot:displayedSnapshot, userId:other.userId }) });
        assert.equal(extra.status, 400);
        const hostile = await fetch(`${base}/consents/${acceptedBody.data.providerConsentId}/withdraw`, { method:'POST', headers:{ ...headers, origin:'https://merchant.example.invalid' }, body:'{}' });
        assert.equal(hostile.status, 400);

        // Populate one full keyset page plus one additional row while the
        // original snapshot is still current, then verify owner-only cursors.
        const additional = await withTestClient((client) => inTransaction(client, async () => {
            const ids: string[] = [];
            for (let index = 0; index < 20; index += 1) {
                ids.push(await acceptMicrosoftConsent(client, data.userId, { accepted:true, processingGrantId:data.processingGrantId, snapshot:displayedSnapshot }));
            }
            const foreign = await acceptMicrosoftConsent(client, other.userId, { accepted:true, processingGrantId:other.processingGrantId, snapshot:displayedSnapshot });
            return { ids, foreign };
        }));
        const firstHistory = await fetch(`${base}/consents`, { headers:{ authorization:headers.authorization } });
        const firstHistoryBody = await firstHistory.json() as { data: { items: Array<{ id: string }>; nextCursor: string | null } };
        assert.equal(firstHistory.status, 200); assert.equal(firstHistoryBody.data.items.length, 20);
        assert.notEqual(firstHistoryBody.data.nextCursor, null);
        const secondHistory = await fetch(`${base}/consents?cursor=${firstHistoryBody.data.nextCursor}`, { headers:{ authorization:headers.authorization } });
        const secondHistoryBody = await secondHistory.json() as { data: { items: Array<{ id: string }>; nextCursor: string | null } };
        assert.equal(secondHistory.status, 200); assert.equal(secondHistoryBody.data.nextCursor, null);
        assert.deepEqual(new Set([...firstHistoryBody.data.items, ...secondHistoryBody.data.items].map((item) => item.id)), new Set([acceptedBody.data.providerConsentId, ...additional.ids]));
        assert.equal((await fetch(`${base}/consents?cursor=${randomUUID()}`, { headers:{ authorization:headers.authorization } })).status, 400);
        assert.equal((await fetch(`${base}/consents?cursor=${additional.foreign}`, { headers:{ authorization:headers.authorization } })).status, 400);

        await withTestClient((client) => client.query(`UPDATE institution_microsoft_policies SET max_evidence_hours=max_evidence_hours-1 WHERE university_id=$1`, [data.universityId]));
        const stale = await fetch(`${base}/consents`, { method:'POST', headers, body:JSON.stringify({ accepted:true, processingGrantId:data.processingGrantId, snapshot:displayedSnapshot }) });
        const staleBody = await stale.json() as { error: { code: string } };
        assert.equal(stale.status, 409); assert.equal(staleBody.error.code, 'consent_notice_changed');

        issuanceEnabled = false;
        assert.equal(issuanceEnabled, false);
        // Student status has no "inactive" enum value; suspended is the
        // supported non-active owner state that must still reach history and
        // withdrawal through the owner-session guard.
        await withTestClient((client) => client.query(`UPDATE students SET status='suspended' WHERE user_id=$1`, [data.userId]));
        const history = await fetch(`${base}/consents`, { headers:{ authorization:headers.authorization } });
        const historyBody = await history.json() as { data: { items: Array<{ id: string }>; nextCursor: string | null } };
        assert.equal(history.status, 200); assert.equal(historyBody.data.items.length, 20);
        assert.notEqual(historyBody.data.nextCursor, null);

        const withdraw = await fetch(`${base}/consents/${acceptedBody.data.providerConsentId}/withdraw`, { method:'POST', headers, body:'{}' });
        assert.equal(withdraw.status, 200);
        const repeatedWithdraw = await fetch(`${base}/consents/${acceptedBody.data.providerConsentId}/withdraw`, { method:'POST', headers, body:'{}' });
        assert.equal(repeatedWithdraw.status, 200);
        const otherSid = (await withTestClient(async (client) => (await client.query<{ active_session_id: string }>('SELECT active_session_id FROM users WHERE id=$1', [other.userId])).rows[0]!)).active_session_id;
        const otherToken = jwtService.generateAccessToken({ userId:other.userId, email:'other@example.invalid', role:'student', sid:otherSid });
        const wrongOwner = await fetch(`${base}/consents/${acceptedBody.data.providerConsentId}/withdraw`, { method:'POST', headers:{ authorization:`Bearer ${otherToken}`, origin:'http://localhost:3000', 'content-type':'application/json' }, body:'{}' });
        assert.equal(wrongOwner.status, 403);
    } finally {
        mutableConfig.microsoftOidc = originalOidc;
        if (originalKey === undefined) delete mutableConfig.microsoftVerification.attemptEncryptionKey;
        else mutableConfig.microsoftVerification.attemptEncryptionKey = originalKey;
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('mounted Microsoft rejects expired callbacks and stale live sessions without writes', async () => {
    const expired = await pendingDurableAttempt();
    const app = await createApp({ microsoftFlowFactory: () => expired.service }); const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a loopback test port'); const base = `http://127.0.0.1:${address.port}`;
    try {
        await withTestClient((client) => client.query(`UPDATE microsoft_verification_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [expired.started.publicResult.attemptId]));
        const state = expired.callback.searchParams.get('state')!;
        const expiredResponse = await callbackRequest(base, `/api/verification/microsoft/callback?state=${state}&code=CANARY`, { host:'api.example.invalid', 'x-forwarded-proto':'https', cookie:`${expired.started.callbackCookie.name}=${expired.started.callbackCookie.value}` });
        assert.equal(expiredResponse.status, 409);
        assert.equal((await withTestClient((client) => client.query(`SELECT count(*)::int AS count FROM microsoft_identities WHERE user_id=$1`, [expired.data.userId]))).rows[0]!.count, 0);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }

    const stale = await readyDurableAttempt();
    const staleApp = await createApp({ microsoftFlowFactory: () => stale.service }); const staleServer = http.createServer(staleApp);
    await new Promise<void>((resolve) => staleServer.listen(0, '127.0.0.1', resolve)); const staleAddress = staleServer.address();
    if (!staleAddress || typeof staleAddress === 'string') throw new Error('Expected a loopback test port');
    try {
        await withTestClient((client) => client.query(`UPDATE users SET active_session_id=$2 WHERE id=$1`, [stale.data.userId, randomUUID()]));
        const token = jwtService.generateAccessToken({ userId:stale.data.userId, email:'student@example.invalid', role:'student', sid:stale.sid });
        const response = await fetch(`http://127.0.0.1:${staleAddress.port}/api/verification/microsoft/finish`, { method:'POST', headers:{ origin:'http://localhost:3000', 'content-type':'application/json', authorization:`Bearer ${token}` }, body:JSON.stringify({ attemptId:stale.started.publicResult.attemptId, finishSecret:stale.started.publicResult.finishSecret }) });
        const body = await response.json() as { error: { code: string } };
        assert.equal(response.status, 401); assert.equal(body.error.code, 'reauthentication_required');
        assert.equal((await withTestClient((client) => client.query(`SELECT count(*)::int AS count FROM microsoft_identities WHERE user_id=$1`, [stale.data.userId]))).rows[0]!.count, 0);
    } finally { await new Promise<void>((resolve, reject) => staleServer.close((error) => error ? reject(error) : resolve())); }
});

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
