import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import type { PoolClient } from 'pg';
import { db } from '../../config/database.js';
import { config } from '../../config/env.js';
import { createApp } from '../../index.js';
import { rotateReportingKey } from '../../services/auth/reporting-key.service.js';
import { jwtService } from '../../services/auth/jwt.service.js';
import { consumeChallenge, requestChallenge } from '../../services/verification/challenge.service.js';
import { grantMerchantDisclosure, grantVerificationProcessing } from '../../services/verification/eligibility-consent.service.js';
import { lockStudentContext } from '../../services/verification/eligibility-context.service.js';
import { recordEmailAssurance, recordMailboxProof } from '../../services/verification/eligibility-evidence.service.js';
import { updateInstitutionPolicy } from '../../services/verification/eligibility-policy.service.js';
import { getEffectiveEligibility } from '../../services/verification/eligibility-read.service.js';
import { exchangeMerchantAssertion, issueMerchantAssertion } from '../../services/verification/merchant-assertion.service.js';
import { MERCHANT_DISCLOSURE_NOTICE_VERSION, VERIFICATION_NOTICE_VERSION } from '../../services/verification/verification-notices.js';
import { inTransaction, createTestPool, withTestClient } from './test-database.js';

after(() => db.close());

type Fixture = {
    adminId: string;
    userId: string;
    studentId: string;
    universityId: string;
    processingGrantId: string;
    email: string;
};

type MicrosoftEvidence = {
    evidenceId: string;
    emailEvidenceId: string;
    proofId: string;
    consentId: string;
    identityId: string;
    attemptId: string;
};

const DISABLED_FALLBACK_SMOKE = 'testing/postgres/microsoft-fallback-artifact.integration.js';

function label(): string {
    return randomUUID().replaceAll('-', '').slice(0, 12);
}

function assertMicrosoftDisabled(): void {
    assert.equal(config.microsoftOidc.enabled, false, 'this dedicated process must keep Microsoft disabled');
}

async function lockExistingStudentForChallenge(client: PoolClient, fixture: Fixture): Promise<void> {
    const context = await lockStudentContext(client, fixture.userId);
    await client.query(
        `INSERT INTO student_eligibility_state (student_id, university_id)
         VALUES ($1, $2) ON CONFLICT (student_id, university_id) DO NOTHING`,
        [context.studentId, context.universityId],
    );
    const grant = await client.query(
        `SELECT id FROM verification_consents
         WHERE id=$1 AND user_id=$2 AND university_id=$3 AND kind='processing'
           AND accepted AND withdrawn_at IS NULL AND notice_version=$4 FOR UPDATE`,
        [fixture.processingGrantId, fixture.userId, fixture.universityId, VERIFICATION_NOTICE_VERSION],
    );
    assert.equal(grant.rowCount, 1);
}

async function createFixture(client: PoolClient): Promise<Fixture> {
    const suffix = label();
    const adminId = (await client.query<{ id: string }>(
        `INSERT INTO users (email, role) VALUES ($1, 'admin') RETURNING id`, [`admin-${suffix}@example.invalid`],
    )).rows[0]!.id;
    const email = `student-${suffix}@students.school.example`;
    const userId = (await client.query<{ id: string }>(
        `INSERT INTO users (email, role) VALUES ($1, 'student') RETURNING id`, [email],
    )).rows[0]!.id;
    const universityId = (await client.query<{ id: string }>(
        `INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id`, [`Fallback School ${suffix}`],
    )).rows[0]!.id;
    const studentId = (await client.query<{ id: string }>(
        `INSERT INTO students (user_id, name, university_id) VALUES ($1, 'Fallback Student', $2) RETURNING id`,
        [userId, universityId],
    )).rows[0]!.id;
    const fixture = { adminId, userId, studentId, universityId, processingGrantId: '', email };
    await inTransaction(client, () => updateInstitutionPolicy(client, adminId, universityId, {
        domains: ['students.school.example'], emailEvidenceValidityDays: 90, enrollmentValidityDays: 30,
        registrationNormalization: null, isActive: true,
    }));
    fixture.processingGrantId = await inTransaction(client, () => grantVerificationProcessing(client, userId, universityId, {
        accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION,
    }));
    await inTransaction(client, async () => {
        await lockExistingStudentForChallenge(client, fixture);
        const issued = await requestChallenge(client, {
            purpose: 'student_email', subjectKey: userId,
            bindings: { ...(await lockStudentContext(client, userId)), processingGrantId: fixture.processingGrantId, noticeVersion: VERIFICATION_NOTICE_VERSION },
        });
        assert.equal(issued.status, 'issued');
        if (issued.status !== 'issued') throw new Error('Synthetic email challenge was not issued');
        const consumed = await consumeChallenge(client, { purpose: 'student_email', subjectKey: userId, challengeId: issued.challengeId, code: issued.code });
        assert.equal(consumed.status, 'verified');
        await recordEmailAssurance(client, userId, { challengeId: issued.challengeId, processingGrantId: fixture.processingGrantId });
    });
    return fixture;
}

async function makeMicrosoftCurrent(client: PoolClient, fixture: Fixture): Promise<MicrosoftEvidence> {
    const email = (await client.query<{ id: string; email_proof_id: string; identity_version: number; policy_version: number }>(
        `SELECT id,email_proof_id,identity_version,policy_version FROM eligibility_evidence
         WHERE student_id=$1 AND method='student_email' AND revoked_at IS NULL ORDER BY verified_at DESC,id DESC LIMIT 1`,
        [fixture.studentId],
    )).rows[0]!;
    const tenantId = randomUUID();
    const consentId = randomUUID();
    const identityId = randomUUID();
    const attemptId = randomUUID();
    const proofId = randomUUID();
    await client.query(
        `INSERT INTO institution_microsoft_policies
             (university_id,tenant_id,enabled,mode,approved_until,approved_by,term_ends_at,max_evidence_hours,scopes,notice_version)
         VALUES ($1,$2,true,'graph_enrollment',clock_timestamp()+interval '30 days',$3,clock_timestamp()+interval '20 days',24,
                 ARRAY['https://graph.microsoft.com/EduRoster.ReadBasic','openid','profile'],'microsoft-v2')`,
        [fixture.universityId, tenantId, fixture.adminId],
    );
    await client.query(
        `INSERT INTO microsoft_verification_consents
             (id,user_id,university_id,processing_grant_id,provider_policy_version,notice_version,mode,scopes)
         VALUES ($1,$2,$3,$4,1,'microsoft-v2','graph_enrollment',ARRAY['https://graph.microsoft.com/EduRoster.ReadBasic','openid','profile'])`,
        [consentId, fixture.userId, fixture.universityId, fixture.processingGrantId],
    );
    await client.query(`INSERT INTO microsoft_identities(id,user_id,university_id,tenant_id,object_id) VALUES($1,$2,$3,$4,$5)`,
        [identityId, fixture.userId, fixture.universityId, tenantId, randomUUID()]);
    await client.query(
        `INSERT INTO microsoft_verification_attempts
             (id,user_id,university_id,institution_policy_version,provider_policy_version,identity_version,processing_grant_id,provider_consent_id,server_session_id,state_hash,browser_secret_hash,finish_secret_hash,expires_at,status,result)
         VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,'browser','finish',clock_timestamp()+interval '1 hour','ready','{}')`,
        [attemptId, fixture.userId, fixture.universityId, email.policy_version, email.identity_version, fixture.processingGrantId, consentId, randomUUID(), `microsoft-${randomUUID()}`],
    );
    await client.query(
        `INSERT INTO microsoft_provider_proofs
             (id,user_id,university_id,provider_consent_id,identity_id,provider_policy_version,attempt_id,observed_at,outcome,source)
         VALUES($1,$2,$3,$4,$5,1,$6,clock_timestamp(),'student','microsoft-education:v1')`,
        [proofId, fixture.userId, fixture.universityId, consentId, identityId, attemptId],
    );
    const evidenceId = (await client.query<{ id: string }>(
        `INSERT INTO eligibility_evidence
             (student_id,university_id,email_proof_id,processing_grant_id,provider_proof_id,method,outcome,identity_version,policy_version,source,expires_at)
         VALUES($1,$2,$3,$4,$5,'enrollment','verified',$6,$7,'microsoft-education:v1',clock_timestamp()+interval '24 hours') RETURNING id`,
        [fixture.studentId, fixture.universityId, email.email_proof_id, fixture.processingGrantId, proofId, email.identity_version, email.policy_version],
    )).rows[0]!.id;
    await client.query(`UPDATE student_eligibility_state SET current_evidence_id=$1 WHERE student_id=$2 AND university_id=$3`,
        [evidenceId, fixture.studentId, fixture.universityId]);
    return { evidenceId, emailEvidenceId: email.id, proofId, consentId, identityId, attemptId };
}

async function seedExpiredIndependentEmail(client: PoolClient, fixture: Fixture, evidenceId: string): Promise<void> {
    // Keep expiry immutable: revoke the original disposable proof, then create
    // a distinct consumed challenge and mailbox proof for the historical row.
    await client.query(`UPDATE eligibility_evidence SET revoked_at=clock_timestamp() WHERE id=$1`, [evidenceId]);
    await client.query(
        `UPDATE verification_challenge_budgets SET resend_available_at=clock_timestamp()-interval '1 second'
         WHERE current_challenge_id=(SELECT challenge_id FROM eligibility_evidence WHERE id=$1)`, [evidenceId],
    );
    await inTransaction(client, async () => {
        const context = await lockStudentContext(client, fixture.userId);
        const issued = await requestChallenge(client, {
            purpose: 'student_email', subjectKey: fixture.userId,
            bindings: { ...context, processingGrantId: fixture.processingGrantId, noticeVersion: VERIFICATION_NOTICE_VERSION },
        });
        assert.equal(issued.status, 'issued');
        if (issued.status !== 'issued') throw new Error('Historical email challenge was not issued');
        const consumed = await consumeChallenge(client, {
            purpose: 'student_email', subjectKey: fixture.userId, challengeId: issued.challengeId, code: issued.code,
        });
        assert.equal(consumed.status, 'verified');
        const proofId = await recordMailboxProof(client, fixture.userId, issued.challengeId);
        await client.query(
            `INSERT INTO eligibility_evidence
                 (student_id,university_id,email_proof_id,processing_grant_id,challenge_id,method,outcome,identity_version,policy_version,verified_at,expires_at)
             VALUES($1,$2,$3,$4,$5,'student_email','verified',$6,$7,clock_timestamp()-interval '2 seconds',clock_timestamp()-interval '1 second')`,
            [context.studentId, context.universityId, proofId, fixture.processingGrantId, issued.challengeId, context.identityVersion, context.policyVersion],
        );
    });
}

async function seedRetentionAttempt(
    client: PoolClient,
    fixture: Fixture,
    microsoft: MicrosoftEvidence,
    status: 'pending' | 'failed',
): Promise<string> {
    const id = randomUUID();
    await client.query(
        `INSERT INTO microsoft_verification_attempts
             (id,user_id,university_id,institution_policy_version,provider_policy_version,identity_version,processing_grant_id,provider_consent_id,server_session_id,state_hash,browser_secret_hash,finish_secret_hash,encrypted_verifier,nonce,expires_at,status,result)
         VALUES($1,$2,$3,1,1,1,$4,$5,$6,$7,'browser','finish','synthetic','synthetic',
                CASE WHEN $8='pending' THEN clock_timestamp()-interval '1 second' ELSE clock_timestamp()+interval '1 hour' END,$8,'{}')`,
        [id, fixture.userId, fixture.universityId, fixture.processingGrantId, microsoft.consentId, randomUUID(), `retention-${randomUUID()}`, status],
    );
    return id;
}

function isDedicatedDisabledFallbackSmoke(): boolean {
    const selector = process.env.AWOOF_POSTGRES_TEST_FILES;
    if (selector === undefined) return false;
    assert.equal(process.env.AWOOF_POSTGRES_ARTIFACT_RUNTIME, '1', 'disabled fallback selector requires the source-absent artifact runtime');
    assert.equal(selector, DISABLED_FALLBACK_SMOKE, 'only the fixed disabled fallback smoke selector is allowed');
    return true;
}

const dedicatedDisabledFallbackSmoke = isDedicatedDisabledFallbackSmoke();

function runCompiledCleanupCli(): ReturnType<typeof spawnSync> {
    assert.equal(import.meta.url.includes('/dist/'), true, 'dedicated cleanup must execute the compiled artifact entry');
    return spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/cleanup-microsoft-attempts.js', import.meta.url))], {
        cwd: fileURLToPath(new URL('../../..', import.meta.url)), encoding: 'utf8', timeout: 30_000,
        env: {
            PATH: process.env.PATH ?? '', NODE_ENV: 'test', MICROSOFT_OIDC_ENABLED: 'false',
            DATABASE_URL: process.env.DATABASE_URL ?? '', AWOOF_TEST_DATABASE_URL: process.env.AWOOF_TEST_DATABASE_URL ?? '',
            AWOOF_TEST_GUARD: process.env.AWOOF_TEST_GUARD ?? '',
        },
    });
}

function installNonLoopbackFetchTrap(): () => void {
    const originalFetch = globalThis.fetch;
    let nonLoopbackCalls = 0;
    globalThis.fetch = async (...args: Parameters<typeof fetch>): ReturnType<typeof fetch> => {
        const input = args[0];
        const address = input instanceof Request ? input.url : input instanceof URL ? input.href : input.toString();
        const destination = new URL(address);
        if (!['127.0.0.1', '::1', '[::1]'].includes(destination.hostname)) {
            nonLoopbackCalls += 1;
            throw new Error(`Disabled fallback attempted non-loopback transport: ${destination.origin}`);
        }
        return originalFetch(...args);
    };
    return () => {
        globalThis.fetch = originalFetch;
        assert.equal(nonLoopbackCalls, 0, 'disabled fallback must not invoke an external transport');
    };
}

async function createMerchant(client: PoolClient): Promise<{ ownerId: string; vendorId: string; origin: string }> {
    const ownerId = (await client.query<{ id: string }>(`INSERT INTO users (email,role) VALUES($1,'vendor') RETURNING id`, [`vendor-${label()}@example.invalid`])).rows[0]!.id;
    const vendorId = (await client.query<{ id: string }>(`INSERT INTO vendors (user_id,name,status) VALUES($1,$2,'active') RETURNING id`, [ownerId, `Fallback merchant ${label()}`])).rows[0]!.id;
    const origin = `https://${label()}.merchant.example`;
    const hostname = new URL(origin).hostname;
    await client.query(`INSERT INTO widget_configs(vendor_id,allowed_domains,allowed_origins,api_key,status) VALUES($1,ARRAY[$2],ARRAY[$3],$4,'active')`, [vendorId, hostname, origin, `public-${label()}`]);
    return { ownerId, vendorId, origin };
}

test('dedicated compiled fallback smoke runs the bounded compiled retention cleanup', {
    concurrency: false,
    skip: dedicatedDisabledFallbackSmoke ? false : 'requires the fixed source-absent disabled fallback selector; broad and source suites do not own global cleanup candidates',
}, async () => {
    assertMicrosoftDisabled();
    await withTestClient(async (client) => {
        const fixture = await createFixture(client);
        const microsoft = await makeMicrosoftCurrent(client, fixture);
        const expiredPendingId = await seedRetentionAttempt(client, fixture, microsoft, 'pending');
        const cancelledId = await seedRetentionAttempt(client, fixture, microsoft, 'failed');
        const cleanup = runCompiledCleanupCli();
        assert.equal(cleanup.status, 0, cleanup.stderr?.toString());
        assert.equal(cleanup.stderr?.toString(), '');
        assert.match(cleanup.stdout?.toString() ?? '', /microsoft retention cleanup complete: attempts=2 diagnostics=0/);
        const scrubbed = await client.query<{ id: string; status: string; encrypted_verifier: string | null; nonce: string | null }>(
            `SELECT id,status,encrypted_verifier,nonce FROM microsoft_verification_attempts WHERE id = ANY($1::uuid[]) ORDER BY id`,
            [[expiredPendingId, cancelledId]],
        );
        assert.deepEqual(scrubbed.rows.map((row) => ({ status: row.status, encrypted_verifier: row.encrypted_verifier, nonce: row.nonce })), [
            { status: 'failed', encrypted_verifier: null, nonce: null },
            { status: 'failed', encrypted_verifier: null, nonce: null },
        ]);
    });
});

test('disabled compiled fallback selects only independent email authority and fails closed for Microsoft-only states', { concurrency: false }, async () => {
    assertMicrosoftDisabled();
    await withTestClient(async (client) => {
        const mixed = await createFixture(client);
        const mixedMicrosoft = await makeMicrosoftCurrent(client, mixed);
        const mixedResult = await inTransaction(client, () => getEffectiveEligibility(client, mixed.userId));
        assert.equal(mixedResult.eligible, true);
        if (mixedResult.eligible) assert.deepEqual({ evidenceId: mixedResult.evidenceId, method: mixedResult.method }, { evidenceId: mixedMicrosoft.emailEvidenceId, method: 'student_email' });

        for (const invalidation of ['microsoft_only', 'provider_consent_microsoft_only', 'provider_proof_microsoft_only', 'provider_policy_disabled', 'base_institution_disabled', 'email_expired', 'authoritative_denial'] as const) {
            const fixture = await createFixture(client);
            const microsoft = await makeMicrosoftCurrent(client, fixture);
            if (invalidation === 'microsoft_only') await client.query(`UPDATE eligibility_evidence SET revoked_at=clock_timestamp() WHERE id=$1`, [microsoft.emailEvidenceId]);
            if (invalidation === 'provider_consent_microsoft_only') {
                await client.query(`UPDATE eligibility_evidence SET revoked_at=clock_timestamp() WHERE id=$1`, [microsoft.emailEvidenceId]);
                await client.query(`UPDATE microsoft_verification_consents SET withdrawn_at=clock_timestamp() WHERE id=$1`, [microsoft.consentId]);
            }
            if (invalidation === 'provider_proof_microsoft_only') {
                await client.query(`UPDATE eligibility_evidence SET revoked_at=clock_timestamp() WHERE id=$1`, [microsoft.emailEvidenceId]);
                await client.query(`UPDATE microsoft_provider_proofs SET revoked_at=clock_timestamp() WHERE id=$1`, [microsoft.proofId]);
            }
            if (invalidation === 'provider_policy_disabled') await client.query(`UPDATE institution_microsoft_policies SET enabled=false WHERE university_id=$1`, [fixture.universityId]);
            if (invalidation === 'base_institution_disabled') await client.query(`UPDATE universities SET is_active=false WHERE id=$1`, [fixture.universityId]);
            if (invalidation === 'email_expired') await seedExpiredIndependentEmail(client, fixture, microsoft.emailEvidenceId);
            if (invalidation === 'authoritative_denial') await client.query(`UPDATE student_eligibility_state SET authoritative_denial=true WHERE student_id=$1 AND university_id=$2`, [fixture.studentId, fixture.universityId]);
            const result = await inTransaction(client, () => getEffectiveEligibility(client, fixture.userId));
            if (invalidation === 'provider_policy_disabled') {
                assert.equal(result.eligible, true, `${invalidation} must preserve independent email`);
                if (result.eligible) assert.equal(result.evidenceId, microsoft.emailEvidenceId);
            } else {
                assert.equal(result.eligible, false, invalidation);
            }
        }
    });
});

test('disabled compiled fallback keeps assertion binding and historical receipt replay without fresh authorization', { concurrency: false }, async () => {
    assertMicrosoftDisabled();
    const pool = createTestPool();
    try {
        await withTestClient(async (client) => {
            const fixture = await createFixture(client);
            const microsoft = await makeMicrosoftCurrent(client, fixture);
            const merchant = await createMerchant(client);
            const disclosureGrantId = await inTransaction(client, () => grantMerchantDisclosure(client, fixture.userId, {
                vendorId: merchant.vendorId, origin: merchant.origin, purpose: 'student-discount', accepted: true, noticeVersion: MERCHANT_DISCLOSURE_NOTICE_VERSION,
            }));
            const input = { vendorId: merchant.vendorId, origin: merchant.origin, purpose: 'student-discount', campaignId: 'disabled-fallback', disclosureGrantId };
            const key = await rotateReportingKey(pool, merchant.ownerId);
            const oldCode = `old-${randomUUID()}`;
            await client.query(
                `INSERT INTO merchant_assertions(code_hash,user_id,vendor_id,origin,purpose,campaign_id,disclosure_grant_id,evidence_id,processing_grant_id,expires_at)
                 VALUES(encode(sha256($1::bytea),'hex'),$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+interval '2 minutes')`,
                [Buffer.from(oldCode), fixture.userId, merchant.vendorId, merchant.origin, input.purpose, input.campaignId, disclosureGrantId, microsoft.evidenceId, fixture.processingGrantId],
            );
            await assert.rejects(exchangeMerchantAssertion(pool, key, { code: oldCode, campaignId: input.campaignId, idempotencyKey: randomUUID() }), /no longer eligible/i);
            const fresh = await issueMerchantAssertion(pool, fixture.userId, input);
            const receiptIdempotencyKey = randomUUID();
            const receipt = await exchangeMerchantAssertion(pool, key, { code: fresh.code, campaignId: input.campaignId, idempotencyKey: receiptIdempotencyKey });
            assert.equal(receipt.assuranceMethod, 'student_email');
            const persistedFresh = (await client.query<{ evidence_id: string; processing_grant_id: string }>(
                `SELECT evidence_id,processing_grant_id FROM merchant_assertions WHERE code_hash=encode(sha256($1::bytea),'hex')`, [Buffer.from(fresh.code)],
            )).rows[0]!;
            assert.deepEqual(persistedFresh, { evidence_id: microsoft.emailEvidenceId, processing_grant_id: fixture.processingGrantId });
            await client.query(`UPDATE student_eligibility_state SET authoritative_denial=true WHERE student_id=$1 AND university_id=$2`, [fixture.studentId, fixture.universityId]);
            const replay = await exchangeMerchantAssertion(pool, key, { code: fresh.code, campaignId: input.campaignId, idempotencyKey: receiptIdempotencyKey });
            assert.deepEqual(replay, receipt, 'stored receipt replay must not become a fresh authorization');
        });
    } finally {
        await pool.end();
    }
});

test('disabled compiled default routes reject issuance while owner recovery remain available without external transport', { concurrency: false }, async () => {
    assertMicrosoftDisabled();
    await withTestClient(async (client) => {
        const fixture = await createFixture(client);
        const microsoft = await makeMicrosoftCurrent(client, fixture);
        const sid = randomUUID();
        await client.query(`UPDATE users SET active_session_id=$2,refresh_token_hash='disabled-smoke',refresh_token_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [fixture.userId, sid]);
        const app = await createApp();
        const server = http.createServer(app);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Expected a loopback route fixture');
        const base = `http://127.0.0.1:${address.port}/api/verification/microsoft`;
        const token = jwtService.generateAccessToken({ userId: fixture.userId, email: fixture.email, role: 'student', sid });
        const headers = { authorization: `Bearer ${token}`, origin: 'http://localhost:3000', 'content-type': 'application/json' };
        const beforeAttempts = (await client.query(`SELECT count(*)::int AS count FROM microsoft_verification_attempts WHERE user_id=$1`, [fixture.userId])).rows[0]!.count;
        const restoreFetch = installNonLoopbackFetchTrap();
        try {
            assert.equal((await fetch(`${base}/notice`, { headers })).status, 503);
            assert.equal((await fetch(`${base}/consents`, { method: 'POST', headers, body: JSON.stringify({ accepted: true, processingGrantId: fixture.processingGrantId, snapshot: { universityId: fixture.universityId, providerPolicyVersion: 1, noticeVersion: 'microsoft-v2', mode: 'graph_enrollment', scopes: ['https://graph.microsoft.com/EduRoster.ReadBasic', 'openid', 'profile'] } }) })).status, 503);
            assert.equal((await fetch(`${base}/start`, { method: 'POST', headers, body: JSON.stringify({ processingGrantId: fixture.processingGrantId, providerConsentId: microsoft.consentId }) })).status, 503);
            assert.equal((await fetch(`${base}/finish`, { method: 'POST', headers, body: JSON.stringify({ attemptId: microsoft.attemptId, finishSecret: 'finish' }) })).status, 503);
            assert.equal((await fetch(`${base}/callback?state=synthetic`)).status, 503);
            assert.equal((await client.query(`SELECT count(*)::int AS count FROM microsoft_verification_attempts WHERE user_id=$1`, [fixture.userId])).rows[0]!.count, beforeAttempts);
            const history = await fetch(`${base}/consents`, { headers });
            assert.equal(history.status, 200);
            const historyData = (await history.json() as { data: { items: Array<{ id: string; withdrawnAt: string | null }>; nextCursor: string | null } }).data;
            assert.deepEqual(historyData.items.map((item) => item.id), [microsoft.consentId]);
            assert.equal(historyData.items[0]?.withdrawnAt, null);
            assert.equal(historyData.nextCursor, null);
            const identities = await fetch(`${base}/identities`, { headers });
            assert.equal(identities.status, 200);
            const identityData = (await identities.json() as { data: { items: Array<{ id: string; revokedAt: string | null }>; nextCursor: string | null } }).data;
            assert.equal(identityData.items[0]?.id, microsoft.identityId);
            assert.equal(identityData.items[0]?.revokedAt, null);
            assert.equal(identityData.nextCursor, null);
            const withdrawn = await fetch(`${base}/consents/${microsoft.consentId}/withdraw`, { method: 'POST', headers, body: '{}' });
            assert.equal(withdrawn.status, 200);
            assert.deepEqual((await withdrawn.json() as { data: unknown }).data, { providerConsentId: microsoft.consentId, withdrawn: true });
            const unlinked = await fetch(`${base}/identities/${microsoft.identityId}/unlink`, { method: 'POST', headers, body: '{}' });
            assert.equal(unlinked.status, 200);
            assert.deepEqual((await unlinked.json() as { data: unknown }).data, { identityId: microsoft.identityId, unlinked: true, recovery: 'support_required' });
        } finally {
            restoreFetch();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });
});
