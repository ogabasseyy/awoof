import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import test, { after } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import type { PoolClient } from 'pg';
import { db } from '../../config/database.js';
import { config } from '../../config/env.js';
import { grantMerchantDisclosure, grantVerificationProcessing, withdrawConsent } from '../../services/verification/eligibility-consent.service.js';
import { applyMicrosoftEnrollment, recordEmailAssurance, recordMailboxProof } from '../../services/verification/eligibility-evidence.service.js';
import { consumeChallenge, requestChallenge } from '../../services/verification/challenge.service.js';
import { acceptMicrosoftConsent, withdrawMicrosoftConsent } from '../../services/verification/microsoft-consent.service.js';
import { VERIFICATION_NOTICE_VERSION } from '../../services/verification/verification-notices.js';
import { MicrosoftFlowService } from '../../services/verification/microsoft-flow.service.js';
import { MicrosoftEducationService } from '../../services/verification/microsoft-education.service.js';
import { MicrosoftOidcOperationalError, MicrosoftOidcService } from '../../services/verification/microsoft-oidc.service.js';
import { readMicrosoftOidcConfiguration } from '../../services/verification/microsoft-oidc.config.js';
import type { VerificationDiagnostics } from '../../services/verification/verification-diagnostics.service.js';
import { hashMicrosoftAttemptSecret } from '../../services/verification/microsoft-attempt-crypto.js';
import { MicrosoftRetentionService } from '../../services/verification/microsoft-retention.service.js';
import { unlinkMicrosoftIdentity } from '../../services/verification/microsoft-identity-unlink.service.js';
import { assertMicrosoftSession } from '../../services/verification/microsoft-session.service.js';
import { lockStudentContext } from '../../services/verification/eligibility-context.service.js';
import { updateInstitutionPolicy } from '../../services/verification/eligibility-policy.service.js';
import { getEffectiveEligibility } from '../../services/verification/eligibility-read.service.js';
import { createApp } from '../../index.js';
import { jwtService } from '../../services/auth/jwt.service.js';
import { rotateReportingKey } from '../../services/auth/reporting-key.service.js';
import { issueMerchantAssertion, exchangeMerchantAssertion } from '../../services/verification/merchant-assertion.service.js';
import { MERCHANT_DISCLOSURE_NOTICE_VERSION } from '../../services/verification/verification-notices.js';
import { inTransaction, withTestClient } from './test-database.js';

after(() => db.close());

type Fixture = { adminId: string; userId: string; universityId: string; processingGrantId: string };

async function assertCallbacksBlockedBy(observer: PoolClient, blockerPid: number, expected: number): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
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

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
    return Promise.race([promise, delay(5_000).then(() => { throw new Error(`${label} timed out`); })]);
}

async function assertDiagnosticWriterBlockedBy(observer: PoolClient, blockerPid: number): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const result = await observer.query<{ blocked: boolean }>(
            `SELECT EXISTS (
                 SELECT 1 FROM pg_stat_activity
                 WHERE $1 = ANY(pg_blocking_pids(pid))
                   AND query LIKE 'SELECT id FROM universities WHERE id=$1 FOR KEY SHARE%'
             ) AS blocked`,
            [blockerPid],
        );
        if (result.rows[0]?.blocked === true) return;
        await delay(10);
    }
    throw new Error('Expected post-commit diagnostic writer to block on the unlink institution lock');
}

async function rejectsSql(operation: () => Promise<unknown>, client: Parameters<typeof inTransaction>[0]): Promise<void> {
    const savepoint = `microsoft_expected_failure_${randomUUID().replaceAll('-', '')}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    await assert.rejects(operation);
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
}

async function fixture(options: { approvedStudentDomain?: string } = {}): Promise<Fixture> {
    return withTestClient(async (client) => inTransaction(client, async () => {
        const suffix = randomUUID().slice(0, 8);
        const adminId = (await client.query<{ id: string }>(`INSERT INTO users (email, role) VALUES ($1, 'admin') RETURNING id`, [`admin-${suffix}@example.invalid`])).rows[0]!.id;
        const userId = (await client.query<{ id: string }>(`INSERT INTO users (email, role) VALUES ($1, 'student') RETURNING id`, [`student-${suffix}@example.invalid`])).rows[0]!.id;
        const universityId = (await client.query<{ id: string }>(`INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id`, [`Microsoft ${suffix}`])).rows[0]!.id;
        await client.query(`INSERT INTO students (user_id, name, university_id) VALUES ($1, 'Student', $2)`, [userId, universityId]);
        if (options.approvedStudentDomain) {
            await updateInstitutionPolicy(client, adminId, universityId, {
                domains: [options.approvedStudentDomain], emailEvidenceValidityDays: 90, enrollmentValidityDays: 30,
                registrationNormalization: null, isActive: true,
            });
        }
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

async function readyGraphAttempt(options: { approvedStudentDomain?: string; prelinkedIdentity?: boolean; testHooks?: FinishTestHooks; education?: { observe(input: { accessToken: string; expectedOid: string }): Promise<import('../../services/verification/microsoft-education.service.js').EducationObservation> } } = {}) {
    const data = options.approvedStudentDomain
        ? await fixture({ approvedStudentDomain: options.approvedStudentDomain })
        : await fixture();
    const sid = randomUUID(); let state = '';
    const { consentId, tenantId, objectId, identityId } = await withTestClient((client) => inTransaction(client, async () => {
        await client.query(`UPDATE users SET active_session_id=$2, refresh_token_hash='ready-graph', refresh_token_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [data.userId, sid]);
        await client.query(`UPDATE institution_microsoft_policies
            SET mode='graph_enrollment', scopes=ARRAY['https://graph.microsoft.com/EduRoster.ReadBasic','openid','profile'],
                notice_version='microsoft-v3', term_ends_at=clock_timestamp()+interval '1 day'
            WHERE university_id=$1`, [data.universityId]);
        const policy = (await client.query<{ version: number; tenant_id: string }>('SELECT version,tenant_id FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
        const consentId = await acceptMicrosoftConsent(client, data.userId, {
            accepted: true, processingGrantId: data.processingGrantId,
            snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v3', mode: 'graph_enrollment', scopes: ['https://graph.microsoft.com/EduRoster.ReadBasic', 'openid', 'profile'] },
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
        education: options.education ?? { observe: async ({ expectedOid }) => ({ outcome: 'student', objectId: expectedOid, observedAt: new Date() }) },
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

function signedOidcToken(input: { issuer: URL; audience: string; tenantId: string; nonce: string; key: KeyObject; kid: string }): string {
    const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encoded({ alg: 'RS256', kid: input.kid, typ: 'JWT' });
    const payload = encoded({ iss: input.issuer.href, aud: input.audience, sub: 'synthetic-subject', tid: input.tenantId,
        oid: randomUUID(), nonce: input.nonce, iat: 1_700_000_000, exp: 4_000_000_000 });
    const signer = createSign('RSA-SHA256'); signer.update(`${header}.${payload}`); signer.end();
    return `${header}.${payload}.${signer.sign(input.key).toString('base64url')}`;
}

/** Uses the real OIDC adapter with an invalidly signed token in Graph mode. */
async function invalidSignedGraphAttempt() {
    const data = await fixture(); const sid = randomUUID(); const clientId = '22222222-2222-4222-8222-222222222222';
    const { consentId, tenantId } = await withTestClient((client) => inTransaction(client, async () => {
        await client.query(`UPDATE users SET active_session_id=$2, refresh_token_hash='invalid-signed-graph', refresh_token_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [data.userId, sid]);
        await client.query(`UPDATE institution_microsoft_policies
            SET mode='graph_enrollment', scopes=ARRAY['https://graph.microsoft.com/EduRoster.ReadBasic','openid','profile'],
                notice_version='microsoft-v3', term_ends_at=clock_timestamp()+interval '1 day'
            WHERE university_id=$1`, [data.universityId]);
        const policy = (await client.query<{ version: number; tenant_id: string }>('SELECT version,tenant_id FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
        const consentId = await acceptMicrosoftConsent(client, data.userId, { accepted: true, processingGrantId: data.processingGrantId,
            snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v3', mode: 'graph_enrollment', scopes: ['https://graph.microsoft.com/EduRoster.ReadBasic', 'openid', 'profile'] } });
        const email = (await client.query<{ email: string }>('SELECT email FROM users WHERE id=$1', [data.userId])).rows[0]!.email;
        const challenge = await requestChallenge(client, { purpose: 'account_email', subjectKey: data.userId, bindings: { userId: data.userId, email } });
        if (challenge.status !== 'issued') throw new Error('Expected Graph invalid-token mailbox challenge');
        const consumed = await consumeChallenge(client, { purpose: 'account_email', subjectKey: data.userId, challengeId: challenge.challengeId, code: challenge.code });
        if (consumed.status !== 'verified') throw new Error('Expected Graph invalid-token mailbox proof');
        await recordMailboxProof(client, data.userId, challenge.challengeId);
        return { consentId, tenantId: policy.tenant_id };
    }));
    const issuer = new URL(`https://login.microsoftonline.com/${tenantId}/v2.0`);
    const trusted = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const untrusted = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const trustedJwk = trusted.publicKey.export({ format: 'jwk' });
    let nonce = ''; let graphCalls = 0; let tokenCalls = 0;
    const oidc = MicrosoftOidcService.forConfiguration(readMicrosoftOidcConfiguration({ enabled: true, tenantId, clientId, clientSecret: 'test-secret',
        callbackUrl: 'https://api.example.invalid/api/verification/microsoft/callback', frontendCompletionUrl: 'https://app.example.invalid/student/verification/microsoft/complete' }), {
        issuer,
        fetch: async (input) => {
            const url = new URL(input.toString());
            if (url.pathname.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer: issuer.href,
                authorization_endpoint: new URL('/authorize', issuer).href, token_endpoint: new URL('/token', issuer).href,
                jwks_uri: new URL('/keys', issuer).href, response_types_supported: ['code'], subject_types_supported: ['pairwise'],
                id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'] });
            if (url.pathname === '/keys') return Response.json({ keys: [{ ...trustedJwk, kid: 'trusted', use: 'sig', alg: 'RS256' }] });
            if (url.pathname === '/token') {
                tokenCalls += 1;
                return Response.json({ token_type: 'Bearer', access_token: 'GRAPH_TOKEN_MUST_NOT_DISPATCH',
                    id_token: signedOidcToken({ issuer, audience: clientId, tenantId, nonce, key: untrusted.privateKey, kid: 'trusted' }) });
            }
            throw new Error('Unexpected synthetic OIDC request');
        },
    });
    const service = new MicrosoftFlowService({ pool: db.getPool(), verifierEncryptionKey: randomBytes(32).toString('base64url'), isEnabled: () => true,
        callbackUrl: new URL('https://api.example.invalid/api/verification/microsoft/callback'), completionUrl: new URL('https://app.example.invalid/student/verification/microsoft/complete'),
        oidc, education: { observe: async () => { graphCalls += 1; return { outcome: 'unknown', reason: 'unavailable' }; } } });
    const started = await service.start({ userId: data.userId, serverSessionId: sid, processingGrantId: data.processingGrantId, providerConsentId: consentId });
    nonce = (await withTestClient(async (client) => (await client.query<{ nonce: string }>('SELECT nonce FROM microsoft_verification_attempts WHERE id=$1', [started.publicResult.attemptId])).rows[0]!.nonce));
    const callback = new URL('https://api.example.invalid/api/verification/microsoft/callback');
    callback.searchParams.set('state', new URL(started.publicResult.authorizationUrl).searchParams.get('state')!); callback.searchParams.set('code', 'SYNTHETIC_CODE');
    return { data, service, started, callback, graphCalls: () => graphCalls, tokenCalls: () => tokenCalls };
}

type FinishInvalidation = 'provider_policy_change' | 'identity_unlink' | 'account_identity_change' | 'authoritative_denial';

async function mutateFinishAuthority(client: PoolClient, kind: FinishInvalidation, data: Fixture, sid?: string): Promise<void> {
    if (kind === 'provider_policy_change') {
        await client.query(`UPDATE institution_microsoft_policies SET max_evidence_hours=max_evidence_hours-1 WHERE university_id=$1`, [data.universityId]);
        return;
    }
    if (kind === 'identity_unlink') {
        if (!sid) throw new Error('Identity unlink race requires the owner session');
        const identity = (await client.query<{ id: string }>(`SELECT id FROM microsoft_identities
            WHERE user_id=$1 AND university_id=$2 AND revoked_at IS NULL`, [data.userId, data.universityId])).rows[0];
        if (!identity) throw new Error('Expected prelinked identity for unlink race');
        await assertMicrosoftSession(client, data.userId, sid, 'owner');
        await unlinkMicrosoftIdentity(client, data.userId, identity.id);
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

async function blockedPidForQuery(observer: PoolClient, blockerPid: number, queryPrefix: string, label: string): Promise<number> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const result = await observer.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity
             WHERE $1 = ANY(pg_blocking_pids(pid))
               AND regexp_replace(query, '[[:space:]]+', ' ', 'g') LIKE $2
             LIMIT 1`, [blockerPid, `${queryPrefix.replace(/\s+/g, ' ')}%`],
        );
        if (result.rows[0]) return Number(result.rows[0].pid);
        await delay(10);
    }
    throw new Error(`Expected ${label} to block behind pid ${blockerPid}`);
}

async function microsoftMerchantAssertion(flow: Awaited<ReturnType<typeof readyGraphAttempt>>, campaignId: string) {
    const merchant = await withTestClient((client) => inTransaction(client, async () => {
        const ownerId = (await client.query<{ id: string }>(`INSERT INTO users(email,role) VALUES($1,'vendor') RETURNING id`, [`withdrawal-merchant-${randomUUID()}@example.invalid`])).rows[0]!.id;
        const vendorId = (await client.query<{ id: string }>(`INSERT INTO vendors(user_id,name,status) VALUES($1,$2,'active') RETURNING id`, [ownerId, 'Withdrawal merchant'])).rows[0]!.id;
        const origin = 'https://withdrawal-merchant.example';
        await client.query(`INSERT INTO widget_configs(vendor_id,allowed_domains,allowed_origins,api_key,status)
            VALUES($1,ARRAY['withdrawal-merchant.example'],ARRAY[$2],$3,'active')`, [vendorId, origin, randomUUID()]);
        const disclosureGrantId = await grantMerchantDisclosure(client, flow.data.userId, { vendorId, origin, purpose: 'student-discount', accepted: true, noticeVersion: MERCHANT_DISCLOSURE_NOTICE_VERSION });
        return { ownerId, vendorId, origin, disclosureGrantId };
    }));
    const key = await rotateReportingKey(db.getPool(), merchant.ownerId);
    const input = { vendorId: merchant.vendorId, origin: merchant.origin, purpose: 'student-discount', campaignId, disclosureGrantId: merchant.disclosureGrantId };
    const assertion = await issueMerchantAssertion(db.getPool(), flow.data.userId, input);
    return { ...merchant, key, input, assertion };
}

async function recordIndependentStudentEmail(flow: Awaited<ReturnType<typeof readyGraphAttempt>>): Promise<void> {
    await withTestClient((client) => inTransaction(client, async () => {
        const context = await lockStudentContext(client, flow.data.userId);
        const issued = await requestChallenge(client, {
            purpose: 'student_email', subjectKey: flow.data.userId,
            bindings: { ...context, processingGrantId: flow.data.processingGrantId, noticeVersion: VERIFICATION_NOTICE_VERSION },
        });
        assert.equal(issued.status, 'issued');
        if (issued.status !== 'issued') throw new Error('Expected independent email challenge');
        const consumed = await consumeChallenge(client, { purpose: 'student_email', subjectKey: flow.data.userId, challengeId: issued.challengeId, code: issued.code });
        assert.equal(consumed.status, 'verified');
        await recordEmailAssurance(client, flow.data.userId, { challengeId: issued.challengeId, processingGrantId: flow.data.processingGrantId });
    }));
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

test('canonical Graph writer rejects a valid future observation without advancing the current evidence pointer', async () => {
    const future = await fixture();
    await withTestClient(client => inTransaction(client, async () => {
        const attempt = await graphReadyWriterAttempt(client, future, { observedAt: new Date(Date.now() + 60_000).toISOString() });
        assert.deepEqual(await applyMicrosoftEnrollment(client, attempt, { isEnabled: () => true }), { eligible: false, reason: 'unverified' });
        assert.equal((await client.query(`SELECT 1 FROM microsoft_provider_proofs WHERE attempt_id=$1`, [attempt])).rowCount, 0);
        assert.equal((await client.query(`SELECT 1 FROM eligibility_evidence WHERE student_id=(SELECT id FROM students WHERE user_id=$1)`, [future.userId])).rowCount, 0);
        assert.equal((await client.query(`SELECT current_evidence_id FROM student_eligibility_state WHERE student_id=(SELECT id FROM students WHERE user_id=$1)`, [future.userId])).rows[0]?.current_evidence_id, null);
    }));

    const current = await fixture();
    await withTestClient(client => inTransaction(client, async () => {
        const attempt = await graphReadyWriterAttempt(client, current);
        assert.equal((await applyMicrosoftEnrollment(client, attempt, { isEnabled: () => true })).eligible, true);
        assert.equal((await client.query(`SELECT 1 FROM microsoft_provider_proofs WHERE attempt_id=$1`, [attempt])).rowCount, 1);
        const pointer = (await client.query<{ current_evidence_id: string | null }>(`SELECT current_evidence_id FROM student_eligibility_state WHERE student_id=(SELECT id FROM students WHERE user_id=$1)`, [current.userId])).rows[0];
        assert.ok(pointer?.current_evidence_id, 'a current-time positive control must create and select evidence');
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
        await client.query(`UPDATE institution_microsoft_policies SET notice_version='microsoft-v3' WHERE university_id=$1`, [data.universityId]);
        const policy = (await client.query<{ version: number }>('SELECT version FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
        return acceptMicrosoftConsent(client, data.userId, { accepted: true, processingGrantId: data.processingGrantId,
            snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v3', mode: 'identity_only', scopes: ['openid', 'profile'] } });
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
        await client.query(`UPDATE institution_microsoft_policies SET notice_version='microsoft-v3' WHERE university_id=$1`, [data.universityId]);
        const policy = (await client.query<{ version: number }>('SELECT version FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
        return acceptMicrosoftConsent(client, data.userId, {
            accepted: true, processingGrantId: data.processingGrantId,
            snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v3', mode: 'identity_only', scopes: ['openid', 'profile'] },
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

test('persists redacted Graph and finalization diagnostics without changing enrollment authority', async () => {
    const valid = await readyGraphAttempt();
    assert.deepEqual(await valid.service.finish({ userId: valid.data.userId, serverSessionId: valid.sid, attemptId: valid.started.publicResult.attemptId, finishSecret: valid.started.publicResult.finishSecret }), { accountLinked: true, enrollment: 'eligible' });
    const validEvents = await withTestClient(async (client) => (await client.query<{ stage: string; outcome: string; reason: string; http_status: number | null; row: unknown }>(
        `SELECT stage,outcome,reason,http_status,to_jsonb(verification_diagnostic_events) AS row
         FROM verification_diagnostic_events WHERE correlation_id=(SELECT diagnostic_correlation_id FROM microsoft_verification_attempts WHERE id=$1)
         ORDER BY recorded_at,id`, [valid.started.publicResult.attemptId],
    )).rows);
    assert.deepEqual(validEvents.map(({ stage, outcome, reason }) => ({ stage, outcome, reason })), [
        { stage: 'started', outcome: 'success', reason: 'none' },
        { stage: 'callback_received', outcome: 'success', reason: 'none' },
        { stage: 'token_validated', outcome: 'success', reason: 'none' },
        { stage: 'education_response', outcome: 'success', reason: 'none' },
        { stage: 'policy_decision', outcome: 'success', reason: 'none' },
        { stage: 'finished', outcome: 'success', reason: 'none' },
    ]);
    assert.equal(JSON.stringify(validEvents).includes(valid.objectId), false);

    const graph403 = await readyGraphAttempt({ education: new MicrosoftEducationService({ fetch: async () => new Response('provider-detail-not-stored', { status: 403 }) }) });
    assert.deepEqual(await graph403.service.finish({ userId: graph403.data.userId, serverSessionId: graph403.sid, attemptId: graph403.started.publicResult.attemptId, finishSecret: graph403.started.publicResult.finishSecret }), { accountLinked: true, enrollment: 'unconfirmed' });
    assert.equal(await graphEvidenceCount(graph403.started.publicResult.attemptId), 0);
    const permissionEvent = await withTestClient(async (client) => (await client.query<{ outcome: string; reason: string; http_status: number | null }>(
        `SELECT outcome,reason,http_status FROM verification_diagnostic_events
         WHERE correlation_id=(SELECT diagnostic_correlation_id FROM microsoft_verification_attempts WHERE id=$1)
           AND stage='education_response'`, [graph403.started.publicResult.attemptId],
    )).rows[0]!);
    assert.deepEqual(permissionEvent, { outcome: 'failure', reason: 'permission_required', http_status: 403 });

    const missingRole = await readyGraphAttempt({ education: { observe: async ({ accessToken, expectedOid }) => new MicrosoftEducationService({
        fetch: async () => Response.json({ id: expectedOid, primaryRole: 'teacher', userType: 'Member', accountEnabled: true }),
    }).observe({ accessToken, expectedOid }) } });
    assert.deepEqual(await missingRole.service.finish({ userId: missingRole.data.userId, serverSessionId: missingRole.sid, attemptId: missingRole.started.publicResult.attemptId, finishSecret: missingRole.started.publicResult.finishSecret }), { accountLinked: true, enrollment: 'unconfirmed' });
    assert.equal(await graphEvidenceCount(missingRole.started.publicResult.attemptId), 0);
    const missingDataEvent = await withTestClient(async (client) => (await client.query<{ outcome: string; reason: string; http_status: number | null }>(
        `SELECT outcome,reason,http_status FROM verification_diagnostic_events
         WHERE correlation_id=(SELECT diagnostic_correlation_id FROM microsoft_verification_attempts WHERE id=$1)
           AND stage='education_response'`, [missingRole.started.publicResult.attemptId],
    )).rows[0]!);
    assert.deepEqual(missingDataEvent, { outcome: 'failure', reason: 'missing_data', http_status: null });
});

test('diagnostic expiry and terminal events require trusted ownership and one committed finish', async () => {
    const invalidIdentity = await invalidSignedGraphAttempt();
    const invalidResult = await invalidIdentity.service.callback({ callbackUrl: invalidIdentity.callback, browserCookie: invalidIdentity.started.callbackCookie.value });
    assert.equal(invalidResult.outcome, 'connection_not_completed');
    assert.equal(invalidIdentity.tokenCalls(), 1);
    assert.equal(invalidIdentity.graphCalls(), 0);
    assert.equal((await withTestClient((client) => client.query('SELECT 1 FROM microsoft_identities WHERE user_id=$1', [invalidIdentity.data.userId]))).rowCount, 0);
    assert.equal((await withTestClient((client) => client.query('SELECT 1 FROM microsoft_provider_proofs WHERE user_id=$1', [invalidIdentity.data.userId]))).rowCount, 0);
    assert.equal((await withTestClient((client) => client.query(`SELECT 1 FROM eligibility_evidence evidence JOIN students ON students.id=evidence.student_id WHERE students.user_id=$1`, [invalidIdentity.data.userId]))).rowCount, 0);
    const invalidEvents = await withTestClient(async (client) => (await client.query<{ stage: string; reason: string }>(
        `SELECT stage,reason FROM verification_diagnostic_events WHERE correlation_id=(SELECT diagnostic_correlation_id FROM microsoft_verification_attempts WHERE id=$1) ORDER BY recorded_at,id`,
        [invalidIdentity.started.publicResult.attemptId],
    )).rows);
    assert.deepEqual(invalidEvents.at(-2), { stage: 'token_validated', reason: 'invalid_identity' });
    assert.deepEqual(invalidEvents.at(-1), { stage: 'finished', reason: 'invalid_identity' });

    const cancelled = await pendingDurableAttempt({ redeem: async () => { throw new MicrosoftOidcOperationalError('cancelled_or_permission'); } });
    await cancelled.service.callback({ callbackUrl: cancelled.callback, browserCookie: cancelled.started.callbackCookie.value });
    const cancelledReason = await withTestClient(async (client) => (await client.query<{ reason: string }>(
        `SELECT reason FROM verification_diagnostic_events WHERE correlation_id=(SELECT diagnostic_correlation_id FROM microsoft_verification_attempts WHERE id=$1) AND stage='token_validated'`,
        [cancelled.started.publicResult.attemptId],
    )).rows[0]!.reason);
    assert.equal(cancelledReason, 'cancelled');

    const expired = await pendingDurableAttempt();
    await withTestClient((client) => client.query(`UPDATE microsoft_verification_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [expired.started.publicResult.attemptId]));
    await assert.rejects(() => expired.service.callback({ callbackUrl: expired.callback, browserCookie: expired.started.callbackCookie.value }));
    await assert.rejects(() => expired.service.callback({ callbackUrl: expired.callback, browserCookie: expired.started.callbackCookie.value }));
    const expiryEvents = await withTestClient(async (client) => (await client.query<{ reason: string }>(
        `SELECT reason FROM verification_diagnostic_events WHERE correlation_id=(SELECT diagnostic_correlation_id FROM microsoft_verification_attempts WHERE id=$1) AND stage='finished'`,
        [expired.started.publicResult.attemptId],
    )).rows);
    assert.deepEqual(expiryEvents, [{ reason: 'expired' }]);

    const unauthorizedExpired = await readyDurableAttempt();
    await withTestClient((client) => client.query(`UPDATE microsoft_verification_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [unauthorizedExpired.started.publicResult.attemptId]));
    await assert.rejects(() => unauthorizedExpired.service.finish({ userId: unauthorizedExpired.data.userId, serverSessionId: unauthorizedExpired.sid, attemptId: unauthorizedExpired.started.publicResult.attemptId, finishSecret: randomUUID() }));
    assert.equal((await withTestClient((client) => client.query(
        `SELECT 1 FROM verification_diagnostic_events WHERE correlation_id=(SELECT diagnostic_correlation_id FROM microsoft_verification_attempts WHERE id=$1) AND stage='finished' AND reason='expired'`,
        [unauthorizedExpired.started.publicResult.attemptId],
    ))).rowCount, 0);

    const alerts: unknown[][] = [];
    const persistenceFailure = await readyDurableAttempt({ diagnostics: { record: async () => { throw new Error('TOKEN_CANARY'); } }, diagnosticAlert: (...args: unknown[]) => { alerts.push(args); } });
    const input = { userId: persistenceFailure.data.userId, serverSessionId: persistenceFailure.sid, attemptId: persistenceFailure.started.publicResult.attemptId, finishSecret: persistenceFailure.started.publicResult.finishSecret };
    assert.deepEqual(await persistenceFailure.service.finish(input), { accountLinked: true, enrollment: 'not_checked' });
    assert.deepEqual(await persistenceFailure.service.finish(input), { accountLinked: true, enrollment: 'not_checked' });
    assert.ok(alerts.length >= 1);
    assert.equal(JSON.stringify(alerts).includes('TOKEN_CANARY'), false);
    assert.equal((await withTestClient((client) => client.query('SELECT status FROM microsoft_verification_attempts WHERE id=$1 AND status=\'completed\'', [input.attemptId]))).rowCount, 1);

    const idempotent = await readyDurableAttempt();
    const idempotentInput = { userId: idempotent.data.userId, serverSessionId: idempotent.sid, attemptId: idempotent.started.publicResult.attemptId, finishSecret: idempotent.started.publicResult.finishSecret };
    await idempotent.service.finish(idempotentInput);
    await idempotent.service.finish(idempotentInput);
    const finalEvents = await withTestClient(async (client) => (await client.query<{ stage: string; outcome: string; reason: string }>(
        `SELECT stage,outcome,reason FROM verification_diagnostic_events WHERE correlation_id=(SELECT diagnostic_correlation_id FROM microsoft_verification_attempts WHERE id=$1) AND stage IN ('policy_decision','finished') ORDER BY recorded_at,id`,
        [idempotentInput.attemptId],
    )).rows);
    assert.deepEqual(finalEvents, [
        { stage: 'policy_decision', outcome: 'unknown', reason: 'none' },
        { stage: 'finished', outcome: 'success', reason: 'none' },
    ]);

    const completedThenExpired = await readyDurableAttempt();
    const completedInput = { userId: completedThenExpired.data.userId, serverSessionId: completedThenExpired.sid, attemptId: completedThenExpired.started.publicResult.attemptId, finishSecret: completedThenExpired.started.publicResult.finishSecret };
    await completedThenExpired.service.finish(completedInput);
    await withTestClient((client) => client.query(`UPDATE microsoft_verification_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [completedInput.attemptId]));
    await assert.rejects(() => completedThenExpired.service.finish(completedInput));
    const lateFinished = await withTestClient(async (client) => (await client.query<{ reason: string }>(
        `SELECT reason FROM verification_diagnostic_events WHERE correlation_id=(SELECT diagnostic_correlation_id FROM microsoft_verification_attempts WHERE id=$1) AND stage='finished'`, [completedInput.attemptId],
    )).rows);
    assert.deepEqual(lateFinished, [{ reason: 'none' }], 'the original 409 retry must not append an expiry terminal event after success');

});

test('both consent withdrawals prevent dispatch before claim, prevent ready during held redeem, and reject ready finish', async () => {
    for (const withdrawal of ['processing', 'provider'] as const) {
        for (const phase of ['before', 'during', 'after'] as const) {
            const data = await fixture();
            const sid = randomUUID();
            const consentId = await withTestClient(async (client) => inTransaction(client, async () => {
                await client.query(`UPDATE users SET active_session_id=$2, refresh_token_hash='test-hash', refresh_token_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [data.userId, sid]);
                await client.query(`UPDATE institution_microsoft_policies SET notice_version='microsoft-v3' WHERE university_id=$1`, [data.universityId]);
                const policy = (await client.query<{ version: number }>('SELECT version FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
                return acceptMicrosoftConsent(client, data.userId, { accepted: true, processingGrantId: data.processingGrantId,
                    snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v3', mode: 'identity_only', scopes: ['openid', 'profile'] } });
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
                const terminal = await pending;
                assert.equal(terminal.outcome, 'connection_not_completed');
                assert.equal(terminal.completionUrl.searchParams.get('attempt'), started.publicResult.attemptId);
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
                    notice_version='microsoft-v3', term_ends_at=clock_timestamp()+interval '1 day'
                WHERE university_id=$1`, [data.universityId]);
            const policy = (await client.query<{ version: number }>('SELECT version FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
            return acceptMicrosoftConsent(client, data.userId, { accepted: true, processingGrantId: data.processingGrantId,
                snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v3', mode: 'graph_enrollment', scopes: ['https://graph.microsoft.com/EduRoster.ReadBasic', 'openid', 'profile'] } });
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
        const terminal = await pending;
        assert.equal(terminal.outcome, 'connection_not_completed');
        assert.equal(terminal.completionUrl.searchParams.get('attempt'), started.publicResult.attemptId);
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
        await client.query(`UPDATE institution_microsoft_policies SET mode='graph_enrollment', scopes=ARRAY['https://graph.microsoft.com/EduRoster.ReadBasic','openid','profile'], notice_version='microsoft-v3', term_ends_at=clock_timestamp()+interval '1 day' WHERE university_id=$1`, [data.universityId]);
        const policy = (await client.query<{ version: number; tenant_id: string }>('SELECT version,tenant_id FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
        const consentId = await acceptMicrosoftConsent(client, data.userId, { accepted: true, processingGrantId: data.processingGrantId,
            snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v3', mode: 'graph_enrollment', scopes: ['https://graph.microsoft.com/EduRoster.ReadBasic', 'openid', 'profile'] } });
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
            await mutateFinishAuthority(mutation, kind, flow.data, flow.sid);
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
        let pending: Promise<unknown> | undefined;
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
        pending = flow.service.finish({ userId: flow.data.userId, serverSessionId: flow.sid, attemptId: flow.started.publicResult.attemptId, finishSecret: flow.started.publicResult.finishSecret });
        await started; await atPrecommit;
        const mutation = await db.getPool().connect(); const observer = await db.getPool().connect();
        try {
            const mutationPid = Number((await mutation.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
            await mutation.query('BEGIN');
            const changed = mutateFinishAuthority(mutation, kind, flow.data, flow.sid);
            await assertPidBlockedBy(observer, mutationPid, finishPid, `${kind} finish-first mutation`);
            release();
            // The observed block proves this mutation is behind the held finish
            // transaction. Once it acquires the lock, finish has committed, but
            // finish still writes best-effort diagnostics after its transaction.
            // Commit this mutation before awaiting that post-commit work.
            await changed;
            if (kind === 'identity_unlink') await assertDiagnosticWriterBlockedBy(observer, mutationPid);
            await mutation.query('COMMIT');
            assert.deepEqual(await pending, { accountLinked: true, enrollment: 'eligible' });
            const retry = flow.service.finish({ userId: flow.data.userId, serverSessionId: flow.sid, attemptId: flow.started.publicResult.attemptId, finishSecret: flow.started.publicResult.finishSecret });
            if (kind === 'authoritative_denial') {
                assert.deepEqual(await retry, { accountLinked: true, enrollment: 'denied' }, 'a later authoritative denial must never be returned as positive retry success');
            } else {
                await assert.rejects(() => retry);
            }
        } finally {
            release?.();
            await mutation.query('ROLLBACK').catch(() => undefined); mutation.release(); observer.release();
            if (pending) await Promise.race([
                pending.then(() => undefined, () => undefined),
                delay(5_000).then(() => { throw new Error(`${kind} finish promise did not settle during cleanup`); }),
            ]);
        }
    }
});

test('actual parent and provider withdrawals serialize Graph finish in both commit orders', async () => {
    for (const kind of ['processing', 'provider'] as const) {
        let finishPid = 0; let started!: () => void;
        const finishStarted = new Promise<void>((resolve) => { started = resolve; });
        const flow = await readyGraphAttempt({
            testHooks: { onFinishTransactionStarted: async (tx) => { finishPid = Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid); started(); } },
        });
        const withdrawal = await db.getPool().connect(); const observer = await db.getPool().connect();
        let pending: Promise<unknown> | undefined;
        try {
            const withdrawalPid = Number((await withdrawal.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
            await withdrawal.query('BEGIN');
            await (kind === 'processing'
                ? withdrawConsent(withdrawal, flow.data.userId, flow.data.processingGrantId)
                : withdrawMicrosoftConsent(withdrawal, flow.data.userId, flow.consentId));
            pending = flow.service.finish({ userId: flow.data.userId, serverSessionId: flow.sid, attemptId: flow.started.publicResult.attemptId, finishSecret: flow.started.publicResult.finishSecret });
            void pending.catch(() => undefined);
            await bounded(finishStarted, `${kind} withdrawal-first finish start`);
            await assertPidBlockedBy(observer, finishPid, withdrawalPid, `${kind} withdrawal-first finish`);
            await withdrawal.query('COMMIT');
            const finish = pending;
            if (!finish) throw new Error('Expected a pending withdrawal-first finish');
            await bounded(assert.rejects(() => finish), `${kind} withdrawal-first finish settlement`);
            assert.equal(await graphEvidenceCount(flow.started.publicResult.attemptId), 0, `${kind} withdrawal-first finish cannot write obsolete evidence`);
        } finally {
            await withdrawal.query('ROLLBACK').catch(() => undefined); withdrawal.release(); observer.release();
            if (pending) await bounded(pending.then(() => undefined, () => undefined), `${kind} withdrawal-first finish cleanup`);
        }
    }

    for (const kind of ['processing', 'provider'] as const) {
        let finishPid = 0; let started!: () => void; let entered!: () => void; let release!: () => void;
        const finishStarted = new Promise<void>((resolve) => { started = resolve; });
        const beforeCommit = new Promise<void>((resolve) => { entered = resolve; });
        const released = new Promise<void>((resolve) => { release = resolve; });
        const flow = await readyGraphAttempt({
            testHooks: {
                onFinishTransactionStarted: async (tx) => { finishPid = Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid); started(); },
                beforeFinishCommit: async () => { entered(); await released; },
            },
        });
        const pending = flow.service.finish({ userId: flow.data.userId, serverSessionId: flow.sid, attemptId: flow.started.publicResult.attemptId, finishSecret: flow.started.publicResult.finishSecret });
        await bounded(finishStarted, `${kind} finish-first finish start`); await bounded(beforeCommit, `${kind} finish-first precommit barrier`);
        const withdrawal = await db.getPool().connect(); const observer = await db.getPool().connect();
        try {
            const withdrawalPid = Number((await withdrawal.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
            await withdrawal.query('BEGIN');
            const waitingWithdrawal = kind === 'processing'
                ? withdrawConsent(withdrawal, flow.data.userId, flow.data.processingGrantId)
                : withdrawMicrosoftConsent(withdrawal, flow.data.userId, flow.consentId);
            await assertPidBlockedBy(observer, withdrawalPid, finishPid, `${kind} finish-first withdrawal`);
            release();
            // finish commits its authority/evidence transaction before its
            // best-effort diagnostics. Let the blocked withdrawal commit
            // before awaiting that post-commit diagnostic work.
            await bounded(waitingWithdrawal, `${kind} finish-first withdrawal settlement`);
            await withdrawal.query('COMMIT');
            assert.deepEqual(await bounded(pending, `${kind} finish-first finish settlement`), { accountLinked: true, enrollment: 'eligible' });
            const receiptBeforeWithdrawal = await withTestClient(async (client) => (await client.query<{ result: unknown }>(`SELECT result FROM microsoft_verification_attempts WHERE id=$1`, [flow.started.publicResult.attemptId])).rows[0]!.result);
            await assert.rejects(() => flow.service.finish({ userId: flow.data.userId, serverSessionId: flow.sid, attemptId: flow.started.publicResult.attemptId, finishSecret: flow.started.publicResult.finishSecret }));
            assert.equal(await graphEvidenceCount(flow.started.publicResult.attemptId), 1, `${kind} keeps the immutable finished receipt while revoking live evidence`);
            const receiptAfterWithdrawal = await withTestClient(async (client) => (await client.query<{ result: unknown }>(`SELECT result FROM microsoft_verification_attempts WHERE id=$1`, [flow.started.publicResult.attemptId])).rows[0]!.result);
            assert.deepEqual(receiptAfterWithdrawal, receiptBeforeWithdrawal, `${kind} withdrawal must not rewrite the finished receipt`);
            const proofSnapshot = await withTestClient(async (client) => (await client.query<{ observed_at: Date; revoked_at: Date | null }>(`SELECT observed_at,revoked_at FROM microsoft_provider_proofs WHERE attempt_id=$1`, [flow.started.publicResult.attemptId])).rows[0]);
            assert.ok(proofSnapshot?.observed_at);
            assert.ok(proofSnapshot?.revoked_at, `${kind} withdrawal must retain and revoke the original proof`);
            const liveEvidence = await withTestClient(async (client) => (await client.query(`SELECT 1 FROM eligibility_evidence evidence JOIN microsoft_provider_proofs proof ON proof.id=evidence.provider_proof_id WHERE proof.attempt_id=$1 AND evidence.revoked_at IS NULL AND proof.revoked_at IS NULL`, [flow.started.publicResult.attemptId])).rowCount);
            assert.equal(liveEvidence, 0, `${kind} withdrawal invalidates later live use`);
        } finally {
            release?.();
            await withdrawal.query('ROLLBACK').catch(() => undefined); withdrawal.release(); observer.release();
            await bounded(pending.then(() => undefined, () => undefined), `${kind} finish-first finish cleanup`);
        }
    }
});

test('actual parent and provider withdrawals serialize Microsoft-bound merchant exchange in both commit orders', async () => {
    const originalEnabled = config.microsoftOidc.enabled;
    config.microsoftOidc.enabled = true;
    try {
    for (const kind of ['processing', 'provider'] as const) {
        const flow = await readyGraphAttempt();
        assert.deepEqual(await flow.service.finish({ userId: flow.data.userId, serverSessionId: flow.sid, attemptId: flow.started.publicResult.attemptId, finishSecret: flow.started.publicResult.finishSecret }), { accountLinked: true, enrollment: 'eligible' });
        const merchant = await microsoftMerchantAssertion(flow, `withdrawal-first-${kind}`);
        const holder = await db.getPool().connect(); const withdrawal = await db.getPool().connect(); const observer = await db.getPool().connect();
        try {
            const withdrawalPid = Number((await withdrawal.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
            await holder.query('BEGIN'); await holder.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [flow.data.userId]);
            await withdrawal.query('BEGIN');
            const waitingWithdrawal = kind === 'processing'
                ? withdrawConsent(withdrawal, flow.data.userId, flow.data.processingGrantId)
                : withdrawMicrosoftConsent(withdrawal, flow.data.userId, flow.consentId);
            const exchange = exchangeMerchantAssertion(db.getPool(), merchant.key, { code: merchant.assertion.code, campaignId: merchant.input.campaignId, idempotencyKey: randomUUID() });
            void exchange.catch(() => undefined);
            const holderPid = Number((await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
            await assertPidBlockedBy(observer, withdrawalPid, holderPid, `${kind} withdrawal-first withdrawal`);
            const exchangePid = await blockedPidForQuery(observer, withdrawalPid, 'SELECT id, role, deleted_at', `${kind} withdrawal-first exchange`);
            await holder.query('COMMIT');
            await assertPidBlockedBy(observer, exchangePid, withdrawalPid, `${kind} withdrawal-first exchange`);
            await waitingWithdrawal; await withdrawal.query('COMMIT');
            await assert.rejects(() => exchange, /no longer eligible/i);
            const consumed = await withTestClient(async (client) => (await client.query<{ consumed_at: Date | null }>(`SELECT consumed_at FROM merchant_assertions WHERE code_hash=encode(sha256($1::bytea),'hex')`, [Buffer.from(merchant.assertion.code)])).rows[0]!.consumed_at);
            assert.equal(consumed, null, `${kind} withdrawal-first leaves the obsolete assertion unconsumed`);
        } finally {
            await holder.query('ROLLBACK').catch(() => undefined); await withdrawal.query('ROLLBACK').catch(() => undefined);
            holder.release(); withdrawal.release(); observer.release();
        }
    }

    for (const kind of ['processing', 'provider'] as const) {
        const flow = kind === 'provider'
            ? await readyGraphAttempt({ approvedStudentDomain: 'example.invalid' })
            : await readyGraphAttempt();
        const preservedEmail = kind === 'provider' ? (await recordIndependentStudentEmail(flow), await withTestClient(async (client) => (await client.query<{ id: string; expires_at: Date }>(`SELECT id,expires_at FROM eligibility_evidence WHERE student_id=(SELECT id FROM students WHERE user_id=$1) AND method='student_email' AND revoked_at IS NULL ORDER BY verified_at DESC,id DESC LIMIT 1`, [flow.data.userId])).rows[0]!)) : null;
        assert.deepEqual(await flow.service.finish({ userId: flow.data.userId, serverSessionId: flow.sid, attemptId: flow.started.publicResult.attemptId, finishSecret: flow.started.publicResult.finishSecret }), { accountLinked: true, enrollment: 'eligible' });
        const merchant = await microsoftMerchantAssertion(flow, `exchange-first-${kind}`);
        const staleMicrosoftAssertion = kind === 'provider'
            ? await issueMerchantAssertion(db.getPool(), flow.data.userId, { ...merchant.input, campaignId: `${merchant.input.campaignId}-stale` })
            : null;
        const keyHolder = await db.getPool().connect(); const withdrawal = await db.getPool().connect(); const observer = await db.getPool().connect();
        try {
            const withdrawalPid = Number((await withdrawal.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
            await keyHolder.query('BEGIN'); await keyHolder.query(`SELECT id FROM widget_configs WHERE vendor_id=$1 FOR UPDATE`, [merchant.vendorId]);
            const exchangeInput = { code: merchant.assertion.code, campaignId: merchant.input.campaignId, idempotencyKey: randomUUID() };
            const exchange = exchangeMerchantAssertion(db.getPool(), merchant.key, exchangeInput);
            const exchangePid = await blockedPidForQuery(observer, Number((await keyHolder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid), 'SELECT id FROM widget_configs', `${kind} exchange-first exchange`);
            await withdrawal.query('BEGIN');
            const waitingWithdrawal = kind === 'processing'
                ? withdrawConsent(withdrawal, flow.data.userId, flow.data.processingGrantId)
                : withdrawMicrosoftConsent(withdrawal, flow.data.userId, flow.consentId);
            await assertPidBlockedBy(observer, withdrawalPid, exchangePid, `${kind} exchange-first withdrawal`);
            await keyHolder.query('COMMIT');
            const receipt = await exchange;
            await waitingWithdrawal; await withdrawal.query('COMMIT');
            const replay = await exchangeMerchantAssertion(db.getPool(), merchant.key, exchangeInput);
            assert.deepEqual(replay, receipt, `${kind} preserves the immutable merchant receipt after withdrawal`);
            if (kind === 'provider' && staleMicrosoftAssertion) {
                assert.ok(preservedEmail);
                const preservedAfterWithdrawal = await withTestClient(async (client) => (await client.query<{ id: string; expires_at: Date; revoked_at: Date | null }>(`SELECT id,expires_at,revoked_at FROM eligibility_evidence WHERE id=$1`, [preservedEmail.id])).rows[0]);
                assert.deepEqual(preservedAfterWithdrawal, { ...preservedEmail, revoked_at: null }, 'provider withdrawal preserves independent email evidence and expiry');
                await assert.rejects(() => exchangeMerchantAssertion(db.getPool(), merchant.key, { code: staleMicrosoftAssertion.code, campaignId: `${merchant.input.campaignId}-stale`, idempotencyKey: randomUUID() }), /no longer eligible/i);
                const emailAssertion = await issueMerchantAssertion(db.getPool(), flow.data.userId, { ...merchant.input, campaignId: `${merchant.input.campaignId}-email` });
                const emailReceipt = await exchangeMerchantAssertion(db.getPool(), merchant.key, { code: emailAssertion.code, campaignId: `${merchant.input.campaignId}-email`, idempotencyKey: randomUUID() });
                assert.equal(emailReceipt.assuranceMethod, 'student_email');
            }
        } finally {
            await keyHolder.query('ROLLBACK').catch(() => undefined); await withdrawal.query('ROLLBACK').catch(() => undefined);
            keyHolder.release(); withdrawal.release(); observer.release();
        }
    }
    } finally {
        config.microsoftOidc.enabled = originalEnabled;
    }
});

test('unknown Graph observation links the validated identity but never fabricates Microsoft or fallback enrollment evidence', async () => {
    const data = await fixture(); const sid = randomUUID(); let state = '';
    const { consentId, tenantId } = await withTestClient((client) => inTransaction(client, async () => {
        await client.query(`UPDATE users SET active_session_id=$2, refresh_token_hash='graph-unknown', refresh_token_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [data.userId, sid]);
        await client.query(`UPDATE institution_microsoft_policies SET mode='graph_enrollment', scopes=ARRAY['https://graph.microsoft.com/EduRoster.ReadBasic','openid','profile'], notice_version='microsoft-v3', term_ends_at=clock_timestamp()+interval '1 day' WHERE university_id=$1`, [data.universityId]);
        const policy = (await client.query<{ version: number; tenant_id: string }>('SELECT version,tenant_id FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
        return { consentId: await acceptMicrosoftConsent(client, data.userId, { accepted: true, processingGrantId: data.processingGrantId,
            snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v3', mode: 'graph_enrollment', scopes: ['https://graph.microsoft.com/EduRoster.ReadBasic', 'openid', 'profile'] } }), tenantId: policy.tenant_id };
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
            await client.query(`UPDATE institution_microsoft_policies SET mode='graph_enrollment', scopes=ARRAY['https://graph.microsoft.com/EduRoster.ReadBasic','openid','profile'], notice_version='microsoft-v3', term_ends_at=clock_timestamp()+interval '1 day' WHERE university_id=$1`, [data.universityId]);
            const policy = (await client.query<{ version: number; tenant_id: string }>('SELECT version,tenant_id FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
            return { consentId: await acceptMicrosoftConsent(client, data.userId, { accepted: true, processingGrantId: data.processingGrantId,
                snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v3', mode: 'graph_enrollment', scopes: ['https://graph.microsoft.com/EduRoster.ReadBasic', 'openid', 'profile'] } }), tenantId: policy.tenant_id };
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
            await withdraw(); releaseToken!(); const terminal = await pending;
            assert.equal(terminal.outcome, 'connection_not_completed');
            assert.equal(terminal.completionUrl.searchParams.get('attempt'), started.publicResult.attemptId);
            assert.equal(tokenCalls, 1); assert.equal(graphCalls, 0, 'post-token authority check must fence Graph');
            const terminalEvents = await withTestClient(async (client) => (await client.query<{ reason: string }>(
                `SELECT reason FROM verification_diagnostic_events
                 WHERE correlation_id=(SELECT diagnostic_correlation_id FROM microsoft_verification_attempts WHERE id=$1)
                   AND stage='finished'`, [started.publicResult.attemptId],
            )).rows);
            assert.deepEqual(terminalEvents, [{ reason: 'cancelled' }], `${withdrawal} withdrawal records one durable cancellation terminal`);
            assert.equal((await withTestClient((client) => client.query('SELECT 1 FROM microsoft_identities WHERE user_id=$1', [data.userId]))).rowCount, 0);
            assert.equal(await graphEvidenceCount(started.publicResult.attemptId), 0);
        } else {
            await service.callback({ callbackUrl: callback, browserCookie: started.callbackCookie.value }); assert.equal(graphCalls, 1);
            await withdraw(); await assert.rejects(() => service.finish({ userId: data.userId, serverSessionId: sid, attemptId: started.publicResult.attemptId, finishSecret: started.publicResult.finishSecret }));
            assert.equal((await withTestClient((client) => client.query('SELECT 1 FROM microsoft_identities WHERE user_id=$1', [data.userId]))).rowCount, 0);
        }
    }
});

async function readyDurableAttempt(options: { diagnostics?: VerificationDiagnostics; diagnosticAlert?: (...args: unknown[]) => void } = {}) {
    const data = await fixture(); const sid = randomUUID(); let state = ''; let exchanges = 0;
    const consentId = await withTestClient(async (client) => inTransaction(client, async () => {
        await client.query(`UPDATE users SET active_session_id=$2,refresh_token_hash='h',refresh_token_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [data.userId, sid]);
        await client.query(`UPDATE institution_microsoft_policies SET notice_version='microsoft-v3' WHERE university_id=$1`, [data.universityId]);
        const policy = (await client.query<{ version:number }>('SELECT version FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
        return acceptMicrosoftConsent(client, data.userId, { accepted:true, processingGrantId:data.processingGrantId, snapshot:{ universityId:data.universityId, providerPolicyVersion:policy.version, noticeVersion:'microsoft-v3', mode:'identity_only', scopes:['openid','profile'] } });
    }));
    const tenantId = (await withTestClient(async (client) => (await client.query<{tenant_id:string}>('SELECT tenant_id FROM institution_microsoft_policies WHERE university_id=$1',[data.universityId])).rows[0]!.tenant_id));
    const service = new MicrosoftFlowService({ pool:db.getPool(), verifierEncryptionKey:randomBytes(32).toString('base64url'), isEnabled:()=>true, callbackUrl:new URL('https://api.example.invalid/api/verification/microsoft/callback'), completionUrl:new URL('https://app.example.invalid/student/verification/microsoft/complete'), oidc:{ authorize:async(input)=>{state=input.state;return 'https://provider.example.invalid/a';}, redeem:async()=>{exchanges++;return {identity:{tenantId,objectId:randomUUID()}};} }, ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}), ...(options.diagnosticAlert ? { diagnosticAlert: options.diagnosticAlert } : {}) });
    const started = await service.start({userId:data.userId,serverSessionId:sid,processingGrantId:data.processingGrantId,providerConsentId:consentId});
    const callback = new URL('https://api.example.invalid/api/verification/microsoft/callback'); callback.searchParams.set('state',state); callback.searchParams.set('code','CANARY');
    await service.callback({callbackUrl:callback,browserCookie:started.callbackCookie.value});
    return { data,sid,service,started,callback,exchanges:()=>exchanges };
}

async function pendingDurableAttempt(options: { isEnabled?: () => boolean; beforeRedeem?: (providerConsentId: string) => Promise<void>; redeem?: (tenantId: string) => Promise<{ identity: { tenantId: string; objectId: string }; graphAccessToken?: string }> } = {}) {
    const data = await fixture(); const sid = randomUUID(); let state = ''; let exchanges = 0;
    const consentId = await withTestClient(async (client) => inTransaction(client, async () => {
        await client.query(`UPDATE users SET active_session_id=$2,refresh_token_hash='h',refresh_token_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [data.userId, sid]);
        await client.query(`UPDATE institution_microsoft_policies SET notice_version='microsoft-v3' WHERE university_id=$1`, [data.universityId]);
        const policy = (await client.query<{ version: number }>('SELECT version FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
        return acceptMicrosoftConsent(client, data.userId, { accepted: true, processingGrantId: data.processingGrantId, snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v3', mode: 'identity_only', scopes: ['openid', 'profile'] } });
    }));
    const tenantId = (await withTestClient(async (client) => (await client.query<{ tenant_id: string }>('SELECT tenant_id FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!.tenant_id));
    const service = new MicrosoftFlowService({ pool: db.getPool(), verifierEncryptionKey: randomBytes(32).toString('base64url'), isEnabled: options.isEnabled ?? (() => true), callbackUrl: new URL('https://api.example.invalid/api/verification/microsoft/callback'), completionUrl: new URL('https://app.example.invalid/student/verification/microsoft/complete'), oidc: { authorize: async (input) => { state = input.state; return 'https://provider.example.invalid/a'; }, redeem: async () => { exchanges += 1; await options.beforeRedeem?.(consentId); return options.redeem ? options.redeem(tenantId) : { identity: { tenantId, objectId: randomUUID() } }; } } });
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

        const identityId = (await withTestClient(async (client) => (await client.query<{ id: string }>('SELECT id FROM microsoft_identities WHERE user_id=$1 AND revoked_at IS NULL', [flow.data.userId])).rows[0]!.id));
        const unlink = await fetch(`${base}/api/verification/microsoft/identities/${identityId}/unlink`, {
            method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}',
        });
        assert.equal(unlink.status, 200, 'owner unlink remains available even though the fixture does not enable global Microsoft issuance');
        assert.deepEqual((await unlink.json() as { data: unknown }).data, { identityId, unlinked: true, recovery: 'support_required' });
        const malformedUnlink = await fetch(`${base}/api/verification/microsoft/identities/${identityId}/unlink`, {
            method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{"unexpected":true}',
        });
        assert.equal(malformedUnlink.status, 400);

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
        await client.query(`UPDATE institution_microsoft_policies SET notice_version='microsoft-v3' WHERE university_id=$1`, [data.universityId]);
        const policy = (await client.query<{ version:number }>('SELECT version FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
        return acceptMicrosoftConsent(client, data.userId, { accepted:true, processingGrantId:data.processingGrantId, snapshot:{ universityId:data.universityId, providerPolicyVersion:policy.version, noticeVersion:'microsoft-v3', mode:'identity_only', scopes:['openid','profile'] } });
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

        // Owner recovery reads remain available after issuance is switched off.
        // Use tombstones so the active user/institution uniqueness invariant is
        // preserved while exercising a full bounded historical page.
        const identityHistory = await withTestClient((client) => inTransaction(client, async () => {
            const ids: string[] = [];
            for (let index = 0; index < 21; index += 1) {
                ids.push((await client.query<{ id: string }>(`INSERT INTO microsoft_identities
                    (user_id, university_id, tenant_id, object_id, revoked_at)
                    VALUES ($1,$2,$3,$4,clock_timestamp()) RETURNING id`, [data.userId, data.universityId, randomUUID(), randomUUID()])).rows[0]!.id);
            }
            const foreign = (await client.query<{ id: string }>(`INSERT INTO microsoft_identities
                (user_id, university_id, tenant_id, object_id, revoked_at)
                VALUES ($1,$2,$3,$4,clock_timestamp()) RETURNING id`, [other.userId, data.universityId, randomUUID(), randomUUID()])).rows[0]!.id;
            return { ids, foreign };
        }));
        const identities = await fetch(`${base}/identities`, { headers:{ authorization:headers.authorization } });
        const identityBody = await identities.json() as { data: { items: Array<Record<string, unknown>>; nextCursor: string | null } };
        assert.equal(identities.status, 200); assert.equal(identityBody.data.items.length, 20);
        assert.notEqual(identityBody.data.nextCursor, null);
        assert.deepEqual(Object.keys(identityBody.data.items[0]!).sort(), ['id', 'linkedAt', 'revokedAt', 'status', 'universityId', 'universityName']);
        assert.equal('tenantId' in identityBody.data.items[0]!, false); assert.equal('objectId' in identityBody.data.items[0]!, false);
        const identitySecond = await fetch(`${base}/identities?cursor=${identityBody.data.nextCursor}`, { headers:{ authorization:headers.authorization } });
        const identitySecondBody = await identitySecond.json() as { data: { items: Array<{ id: string }>; nextCursor: string | null } };
        assert.equal(identitySecond.status, 200); assert.equal(identitySecondBody.data.nextCursor, null);
        assert.deepEqual(new Set([...identityBody.data.items, ...identitySecondBody.data.items].map((item) => item.id)), new Set(identityHistory.ids));
        assert.equal((await fetch(`${base}/identities?cursor=${identityHistory.foreign}`, { headers:{ authorization:headers.authorization } })).status, 400);
        const offFlagUnlink = await fetch(`${base}/identities/${identityHistory.ids[0]}/unlink`, { method:'POST', headers, body:'{}' });
        assert.equal(offFlagUnlink.status, 200);

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

test('mounted Microsoft redirects expired callbacks to completion and rejects stale live sessions without writes', async () => {
    const expired = await pendingDurableAttempt();
    const app = await createApp({ microsoftFlowFactory: () => expired.service }); const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a loopback test port'); const base = `http://127.0.0.1:${address.port}`;
    try {
        await withTestClient((client) => client.query(`UPDATE microsoft_verification_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [expired.started.publicResult.attemptId]));
        const state = expired.callback.searchParams.get('state')!;
        const expiredResponse = await callbackRequest(base, `/api/verification/microsoft/callback?state=${state}&code=CANARY`, { host:'api.example.invalid', 'x-forwarded-proto':'https', cookie:`${expired.started.callbackCookie.name}=${expired.started.callbackCookie.value}` });
        assert.equal(expiredResponse.status, 303);
        assert.equal(expiredResponse.headers.location, `https://app.example.invalid/student/verification/microsoft/complete?attempt=${expired.started.publicResult.attemptId}&outcome=connection_not_completed`);
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
        assert.deepEqual(await settled, { ok: true });
        const terminal = await callback;
        assert.equal(terminal.outcome, 'connection_not_completed');
        assert.equal(terminal.completionUrl.searchParams.get('attempt'), flow.started.publicResult.attemptId);
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
    assert.deepEqual(await settledCallback, { ok: true });
    const terminal = await callback;
    assert.equal(terminal.outcome, 'connection_not_completed');
    assert.equal(terminal.completionUrl.searchParams.get('attempt'), flow.started.publicResult.attemptId);
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

async function seedRetentionAttempt(
    client: PoolClient,
    data: Fixture,
    providerConsentId: string,
    input: { status: 'pending' | 'ready' | 'completed' | 'failed'; expiresAt: Date; result?: unknown },
): Promise<{ id: string; correlationId: string }> {
    const policy = (await client.query<{ version: number }>('SELECT version FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
    const id = randomUUID(); const correlationId = randomUUID();
    await client.query(
        `INSERT INTO microsoft_verification_attempts
             (id,user_id,university_id,institution_policy_version,provider_policy_version,identity_version,
              processing_grant_id,provider_consent_id,server_session_id,diagnostic_correlation_id,state_hash,
              browser_secret_hash,finish_secret_hash,encrypted_verifier,nonce,expires_at,status,result)
         SELECT $1,$2,$3,verification_policy_version,$4,identity_version,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb
         FROM universities JOIN students ON students.university_id=universities.id WHERE universities.id=$3`,
        [id, data.userId, data.universityId, policy.version, data.processingGrantId, providerConsentId, randomUUID(), correlationId,
            `retention-state-${randomUUID()}`, `retention-browser-${randomUUID()}`, `retention-finish-${randomUUID()}`,
            input.status === 'pending' ? 'retention-verifier' : null, input.status === 'pending' ? 'retention-nonce' : null,
            input.expiresAt, input.status, JSON.stringify(input.result ?? (input.status === 'completed' ? { accountLinked: true, enrollment: 'not_checked', identityId: randomUUID() } : null))],
    );
    return { id, correlationId };
}

test('Microsoft retention is bounded at 500, preserves a current receipt through its original deadline, and removes only expired diagnostics', async () => {
    // The disposable integration database is shared by this file. Establish a
    // real bounded-cleanup baseline instead of assuming other test attempts do
    // not match the global retention worker's selection predicate.
    // Backdate every leftover row instead of time-travelling the worker clock:
    // the worker must read its cutoff from the database clock, so the drain
    // ages the data itself to establish the same baseline.
    await withTestClient(async (client) => {
        await client.query(`UPDATE microsoft_verification_attempts SET expires_at = clock_timestamp() - interval '1 second'`);
        await client.query(`UPDATE verification_diagnostic_events SET recorded_at = clock_timestamp() - interval '31 days'`);
    });
    const drain = new MicrosoftRetentionService({ pool: db.getPool() });
    let drained = false;
    for (let batch = 0; batch < 100; batch += 1) {
        const result = await drain.cleanup();
        if (result.attempts < 500 && result.diagnostics < 500) { drained = true; break; }
    }
    assert.equal(drained, true, 'bounded cleanup baseline must converge without manual row deletion');
    const data = await fixture();
    const cutoff = new Date();
    const providerConsentId = await withTestClient((client) => inTransaction(client, async () => {
        const policy = (await client.query<{ version: number }>('SELECT version FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
        const consent = await acceptMicrosoftConsent(client, data.userId, { accepted: true, processingGrantId: data.processingGrantId,
            snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v1', mode: 'identity_only', scopes: ['openid', 'profile'] } });
        for (let index = 0; index < 501; index += 1) await seedRetentionAttempt(client, data, consent, { status: 'failed', expiresAt: new Date(cutoff.getTime() - 60_000) });
        return consent;
    }));
    const cleanup = new MicrosoftRetentionService({ pool: db.getPool() });
    assert.deepEqual(await cleanup.cleanup(), { attempts: 500, diagnostics: 0 });
    assert.equal((await withTestClient(async (client) => (await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM microsoft_verification_attempts WHERE user_id=$1 AND finish_secret_hash IS NOT NULL`, [data.userId])).rows[0]!.count)), 1);
    assert.deepEqual(await cleanup.cleanup(), { attempts: 1, diagnostics: 0 });

    const liveReceipt = await readyDurableAttempt();
    const liveInput = { userId: liveReceipt.data.userId, serverSessionId: liveReceipt.sid, attemptId: liveReceipt.started.publicResult.attemptId, finishSecret: liveReceipt.started.publicResult.finishSecret };
    assert.deepEqual(await liveReceipt.service.finish(liveInput), { accountLinked: true, enrollment: 'not_checked' });
    const live = await withTestClient(async (client) => (await client.query<{ diagnostic_correlation_id: string; expires_at: Date }>(
        'SELECT diagnostic_correlation_id,expires_at FROM microsoft_verification_attempts WHERE id=$1', [liveInput.attemptId],
    )).rows[0]!);
    const seeded = await withTestClient((client) => inTransaction(client, async () => {
        const expiredPending = await seedRetentionAttempt(client, data, providerConsentId, { status: 'pending', expiresAt: new Date(cutoff.getTime() - 60_000) });
        const expiredReady = await seedRetentionAttempt(client, data, providerConsentId, { status: 'ready', expiresAt: new Date(cutoff.getTime() - 60_000), result: { accountLinked: true } });
        const expiredCompleted = await seedRetentionAttempt(client, data, providerConsentId, { status: 'completed', expiresAt: new Date(cutoff.getTime() - 60_000) });
        await client.query(`INSERT INTO verification_diagnostic_events (correlation_id,stage,outcome,reason,duration_ms,recorded_at,institution_id,policy_version)
            VALUES ($1,'started','success','none',0,$2,$3,1), ($4,'started','success','none',0,$5,$3,1)`,
        [expiredCompleted.correlationId, new Date(cutoff.getTime() - 31 * 24 * 60 * 60_000), data.universityId, live.diagnostic_correlation_id, new Date(cutoff.getTime() - 24 * 60 * 60_000)]);
        return { expiredPending, expiredReady, expiredCompleted };
    }));
    const result = await cleanup.cleanup();
    assert.equal(result.attempts, 4); assert.equal(result.diagnostics, 1);
    await withTestClient(async (client) => {
        const terminal = await client.query<{ id: string; status: string; state_hash: string | null; browser_secret_hash: string | null; finish_secret_hash: string | null; encrypted_verifier: string | null; nonce: string | null; result: unknown }>(
            `SELECT id,status,state_hash,browser_secret_hash,finish_secret_hash,encrypted_verifier,nonce,result
             FROM microsoft_verification_attempts WHERE id = ANY($1::uuid[])`, [[seeded.expiredPending.id, seeded.expiredReady.id, seeded.expiredCompleted.id]],
        );
        const byId = new Map(terminal.rows.map((row) => [row.id, row]));
        for (const id of [seeded.expiredPending.id, seeded.expiredReady.id, seeded.expiredCompleted.id]) {
            const row = byId.get(id)!;
            assert.equal(row.status, id === seeded.expiredCompleted.id ? 'completed' : 'failed'); assert.equal(row.state_hash, null); assert.equal(row.browser_secret_hash, null);
            assert.equal(row.finish_secret_hash, null); assert.equal(row.encrypted_verifier, null); assert.equal(row.nonce, null); assert.equal(row.result, null);
        }
        assert.equal((await client.query(`SELECT 1 FROM verification_diagnostic_events WHERE correlation_id=$1`, [seeded.expiredCompleted.correlationId])).rowCount, 0);
        assert.ok(((await client.query(`SELECT 1 FROM verification_diagnostic_events WHERE correlation_id=$1`, [live.diagnostic_correlation_id])).rowCount ?? 0) >= 1);
    });
    await withTestClient(async (client) => {
        const row = (await client.query<{ state_hash: string | null; browser_secret_hash: string | null; finish_secret_hash: string | null; result: unknown }>(
            'SELECT state_hash,browser_secret_hash,finish_secret_hash,result FROM microsoft_verification_attempts WHERE id=$1', [liveInput.attemptId],
        )).rows[0]!;
        assert.equal(row.state_hash, null); assert.equal(row.browser_secret_hash, null);
        assert.notEqual(row.finish_secret_hash, null); assert.notEqual(row.result, null, 'the actual receipt remains retryable through its original deadline');
    });
    assert.deepEqual(await liveReceipt.service.finish(liveInput), { accountLinked: true, enrollment: 'not_checked' }, 'actual completed finish retry remains usable before its original deadline');
    await withTestClient(async (client) => {
        await client.query(`UPDATE microsoft_verification_attempts SET expires_at = clock_timestamp() - interval '1 second' WHERE id=$1`, [liveInput.attemptId]);
    });
    const afterDeadline = new MicrosoftRetentionService({ pool: db.getPool() });
    assert.deepEqual(await afterDeadline.cleanup(), { attempts: 1, diagnostics: 0 });
    await withTestClient(async (client) => {
        const row = (await client.query<{ finish_secret_hash: string | null; result: unknown }>('SELECT finish_secret_hash,result FROM microsoft_verification_attempts WHERE id=$1', [liveInput.attemptId])).rows[0]!;
        assert.deepEqual(row, { finish_secret_hash: null, result: null });
    });
    await assert.rejects(() => liveReceipt.service.finish(liveInput));
    assert.deepEqual(await afterDeadline.cleanup(), { attempts: 0, diagnostics: 0 }, 'cleanup is idempotent');
});

test('owner unlink remains available off-policy, uses the captured identity institution, preserves email proof, and tombstones Microsoft data', async () => {
    const data = await fixture();
    const sid = randomUUID();
    const seeded = await withTestClient((client) => inTransaction(client, async () => {
        await client.query(`UPDATE users SET active_session_id=$2,refresh_token_hash='unlink-session',refresh_token_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [data.userId, sid]);
        const policy = (await client.query<{ version: number; tenant_id: string }>('SELECT version,tenant_id FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
        const consent = await acceptMicrosoftConsent(client, data.userId, { accepted: true, processingGrantId: data.processingGrantId,
            snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v1', mode: 'identity_only', scopes: ['openid', 'profile'] } });
        const identity = (await client.query<{ id: string }>('INSERT INTO microsoft_identities(user_id,university_id,tenant_id,object_id) VALUES($1,$2,$3,$4) RETURNING id', [data.userId, data.universityId, policy.tenant_id, randomUUID()])).rows[0]!.id;
        const proof = (await client.query<{ id: string }>('INSERT INTO microsoft_provider_proofs(user_id,university_id,provider_consent_id,identity_id,provider_policy_version) VALUES($1,$2,$3,$4,$5) RETURNING id', [data.userId, data.universityId, consent, identity, policy.version])).rows[0]!.id;
        const pending = await seedRetentionAttempt(client, data, consent, { status: 'pending', expiresAt: new Date(Date.now() + 60_000) });
        const currentUniversity = (await client.query<{ id: string }>(`INSERT INTO universities(name,is_active) VALUES($1,true) RETURNING id`, [`Current school ${randomUUID()}`])).rows[0]!.id;
        await client.query(`UPDATE students SET university_id=$2,university='Current school' WHERE user_id=$1`, [data.userId, currentUniversity]);
        await client.query(`UPDATE universities SET email_evidence_validity_days=90 WHERE id=$1`, [currentUniversity]);
        await client.query(`INSERT INTO approved_student_email_domains(university_id,domain,is_active,approved_by) VALUES($1,'example.invalid',true,$2)`, [currentUniversity, data.adminId]);
        const emailGrant = await grantVerificationProcessing(client, data.userId, currentUniversity, { accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION });
        const emailContext = await lockStudentContext(client, data.userId);
        const challenge = await requestChallenge(client, { purpose: 'student_email', subjectKey: data.userId, bindings: { ...emailContext, processingGrantId: emailGrant, noticeVersion: VERIFICATION_NOTICE_VERSION } });
        if (challenge.status !== 'issued') throw new Error('Expected current-school email challenge');
        const consumed = await consumeChallenge(client, { purpose: 'student_email', subjectKey: data.userId, challengeId: challenge.challengeId, code: challenge.code });
        if (consumed.status !== 'verified') throw new Error('Expected current-school email verification');
        assert.equal((await recordEmailAssurance(client, data.userId, { challengeId: challenge.challengeId, processingGrantId: emailGrant })).eligible, true);
        await client.query('UPDATE institution_microsoft_policies SET enabled=false WHERE university_id=$1', [data.universityId]);
        return { consent, identity, proof, pending: pending.id };
    }));
    const unlink = () => withTestClient((client) => inTransaction(client, async () => {
        await assertMicrosoftSession(client, data.userId, sid, 'owner');
        return unlinkMicrosoftIdentity(client, data.userId, seeded.identity);
    }));
    const beforeUnlink = await withTestClient(async (client) => (await client.query<{ status: string; finish_secret_hash: string | null; expires_at: Date }>(
        'SELECT status,finish_secret_hash,expires_at FROM microsoft_verification_attempts WHERE id=$1', [seeded.pending],
    )).rows[0]!);
    // Disabling the captured policy has already terminalized this row through
    // migration 040's policy trigger. Unlink must not reinterpret failed rows.
    assert.equal(beforeUnlink.status, 'failed');
    assert.notEqual(beforeUnlink.finish_secret_hash, null);
    assert.deepEqual(await unlink(), { identityId: seeded.identity, unlinked: true, recovery: 'support_required' });
    assert.deepEqual(await unlink(), { identityId: seeded.identity, unlinked: true, recovery: 'support_required' });
    await withTestClient(async (client) => {
        assert.notEqual((await client.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM microsoft_identities WHERE id=$1', [seeded.identity])).rows[0]!.revoked_at, null);
        assert.notEqual((await client.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM microsoft_provider_proofs WHERE id=$1', [seeded.proof])).rows[0]!.revoked_at, null);
        assert.deepEqual((await client.query<{ status: string; finish_secret_hash: string | null }>('SELECT status,finish_secret_hash FROM microsoft_verification_attempts WHERE id=$1', [seeded.pending])).rows[0], { status: 'failed', finish_secret_hash: beforeUnlink.finish_secret_hash });
        const effective = await getEffectiveEligibility(client, data.userId);
        assert.equal(effective.eligible, true);
        assert.equal(effective.method, 'student_email', 'unlinking Microsoft data must not revoke independent current-school email eligibility');
        assert.equal((await client.query(`SELECT count(*)::int AS count FROM verification_audit_events WHERE user_id=$1 AND event_type='microsoft_identity_unlinked'`, [data.userId])).rows[0]!.count, 1);
    });
    await new MicrosoftRetentionService({ pool: db.getPool() }).cleanup();
    assert.equal((await withTestClient(async (client) => (await client.query<{ finish_secret_hash: string | null }>('SELECT finish_secret_hash FROM microsoft_verification_attempts WHERE id=$1', [seeded.pending])).rows[0]!.finish_secret_hash)), null);
    const foreign = await fixture();
    await withTestClient((client) => inTransaction(client, () => assert.rejects(() => unlinkMicrosoftIdentity(client, foreign.userId, seeded.identity), { statusCode: 403 })));
});

test('replaying an old Microsoft tombstone does not cancel a later actual start', async () => {
    const data = await fixture(); const sid = randomUUID();
    const seeded = await withTestClient((client) => inTransaction(client, async () => {
        await client.query(`UPDATE users SET active_session_id=$2,refresh_token_hash='unlink-replay-session',refresh_token_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [data.userId, sid]);
        await client.query(`UPDATE institution_microsoft_policies SET notice_version='microsoft-v3' WHERE university_id=$1`, [data.universityId]);
        const policy = (await client.query<{ version: number; tenant_id: string }>('SELECT version,tenant_id FROM institution_microsoft_policies WHERE university_id=$1', [data.universityId])).rows[0]!;
        const consent = await acceptMicrosoftConsent(client, data.userId, { accepted: true, processingGrantId: data.processingGrantId,
            snapshot: { universityId: data.universityId, providerPolicyVersion: policy.version, noticeVersion: 'microsoft-v3', mode: 'identity_only', scopes: ['openid', 'profile'] } });
        const identity = (await client.query<{ id: string }>('INSERT INTO microsoft_identities(user_id,university_id,tenant_id,object_id) VALUES($1,$2,$3,$4) RETURNING id', [data.userId, data.universityId, policy.tenant_id, randomUUID()])).rows[0]!.id;
        return { consent, identity };
    }));
    const unlink = () => withTestClient((client) => inTransaction(client, async () => {
        await assertMicrosoftSession(client, data.userId, sid, 'owner');
        return unlinkMicrosoftIdentity(client, data.userId, seeded.identity);
    }));
    await unlink();
    const service = new MicrosoftFlowService({ pool: db.getPool(), verifierEncryptionKey: randomBytes(32).toString('base64url'), isEnabled: () => true,
        callbackUrl: new URL('https://api.example.invalid/api/verification/microsoft/callback'), completionUrl: new URL('https://app.example.invalid/student/verification/microsoft/complete'),
        oidc: { authorize: async () => 'https://provider.example.invalid/authorize', redeem: async () => { throw new Error('not used'); } },
    });
    const fresh = await service.start({ userId: data.userId, serverSessionId: sid, processingGrantId: data.processingGrantId, providerConsentId: seeded.consent });
    await unlink();
    const status = await withTestClient(async (client) => (await client.query<{ status: string }>('SELECT status FROM microsoft_verification_attempts WHERE id=$1', [fresh.publicResult.attemptId])).rows[0]?.status);
    assert.equal(status, 'pending', 'replaying an already-revoked identity must not cancel a later distinct connection attempt');
});

test('actual callback cannot restore an unlinked identity in either callback/unlink order', async () => {
    for (const order of ['unlink_first', 'callback_first'] as const) {
        const objectId = randomUUID();
        const flow = await pendingDurableAttempt({ redeem: async (tenantId) => ({ identity: { tenantId, objectId } }) });
        const identityId = await withTestClient((client) => inTransaction(client, async () => {
            const tenantId = (await client.query<{ tenant_id: string }>('SELECT tenant_id FROM institution_microsoft_policies WHERE university_id=$1', [flow.data.universityId])).rows[0]!.tenant_id;
            return (await client.query<{ id: string }>('INSERT INTO microsoft_identities(user_id,university_id,tenant_id,object_id) VALUES($1,$2,$3,$4) RETURNING id', [flow.data.userId, flow.data.universityId, tenantId, objectId])).rows[0]!.id;
        }));
        const unlink = () => withTestClient((client) => inTransaction(client, async () => {
            await assertMicrosoftSession(client, flow.data.userId, flow.sid, 'owner');
            return unlinkMicrosoftIdentity(client, flow.data.userId, identityId);
        }));
        if (order === 'unlink_first') {
            await unlink();
            await assert.rejects(() => flow.service.callback({ callbackUrl: flow.callback, browserCookie: flow.started.callbackCookie.value }));
        } else {
            await flow.service.callback({ callbackUrl: flow.callback, browserCookie: flow.started.callbackCookie.value });
            await unlink();
            await assert.rejects(() => flow.service.finish({ userId: flow.data.userId, serverSessionId: flow.sid, attemptId: flow.started.publicResult.attemptId, finishSecret: flow.started.publicResult.finishSecret }));
        }
        await withTestClient(async (client) => {
            const attempt = (await client.query<{ status: string; state_hash: string | null; browser_secret_hash: string | null; finish_secret_hash: string | null; encrypted_verifier: string | null; nonce: string | null; result: unknown }>(
                'SELECT status,state_hash,browser_secret_hash,finish_secret_hash,encrypted_verifier,nonce,result FROM microsoft_verification_attempts WHERE id=$1', [flow.started.publicResult.attemptId],
            )).rows[0]!;
            assert.equal(attempt.status, 'failed');
            assert.equal(attempt.state_hash, null); assert.equal(attempt.browser_secret_hash, null); assert.equal(attempt.finish_secret_hash, null);
            assert.equal(attempt.encrypted_verifier, null); assert.equal(attempt.nonce, null); assert.equal(attempt.result, null);
            assert.notEqual((await client.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM microsoft_identities WHERE id=$1', [identityId])).rows[0]!.revoked_at, null);
            assert.equal((await client.query(`SELECT 1 FROM microsoft_identities WHERE tenant_id=(SELECT tenant_id FROM institution_microsoft_policies WHERE university_id=$1) AND object_id=$2 AND revoked_at IS NULL`, [flow.data.universityId, objectId])).rowCount, 0);
        });
    }
});
