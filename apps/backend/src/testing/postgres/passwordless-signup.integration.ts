import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { GOOGLE_ISSUER } from '../../services/auth/student-google-oidc.js';
import { StudentSsoSignupService } from '../../services/auth/student-sso-signup.service.js';
import { encryptMicrosoftAttemptVerifier, hashMicrosoftAttemptSecret } from '../../services/verification/microsoft-attempt-crypto.js';
import { assertFixtureDatabase, createTestPool } from './test-database.js';
import { STUDENT_TERMS_VERSION, VERIFICATION_NOTICE_VERSION } from '../../services/verification/verification-notices.js';

const label = () => randomUUID().replaceAll('-', '').slice(0, 12);
const secret = () => randomBytes(32).toString('hex');

async function withPool<T>(work: (pool: Pool) => Promise<T>): Promise<T> { const pool = createTestPool(); const c = await pool.connect(); try { await assertFixtureDatabase(c); } finally { c.release(); } try { return await work(pool); } finally { await pool.end(); } }

async function seed(client: PoolClient, key: string, options: { expired?: boolean } = {}) {
    const suffix = label(), domain = `signup-${suffix}.school.example`, email = `ada-${suffix}@${domain}`;
    const admin = (await client.query<{ id: string }>(`INSERT INTO users (email, role) VALUES ($1, 'admin') RETURNING id`, [`admin-${suffix}@example.invalid`])).rows[0]!.id;
    const university = (await client.query<{ id: string }>(`INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id`, [`Signup School ${suffix}`])).rows[0]!.id;
    const policy = (await client.query<{ id: string; version: number }>(`INSERT INTO institution_login_policies (university_id, provider, issuer, provider_realm, version, enabled, approved_until, approved_by, school_assertion_days) VALUES ($1, 'google', $2, $3, 1, true, clock_timestamp() + interval '1 day', $4, 90) RETURNING id, version`, [university, GOOGLE_ISSUER, domain, admin])).rows[0]!;
    await client.query(`INSERT INTO institution_login_domains (domain, university_id, is_active) VALUES ($1, $2, true)`, [domain, university]);
    await client.query(`INSERT INTO institution_login_domain_providers (domain, university_id, provider, policy_id) VALUES ($1, $2, 'google', $3)`, [domain, university, policy.id]);
    const attempt = (await client.query<{ id: string }>(`INSERT INTO student_auth_attempts (policy_id, policy_version, provider, requested_email, state_hash, callback_cookie_hash, finish_secret_hash, encrypted_verifier, nonce, encrypted_observation, status, expires_at, remember_me) VALUES ($1,$2,'google',$3,$4,$5,$6,$7,$8,NULL,'pending',$9,false) RETURNING id`, [policy.id, policy.version, email, secret(), secret(), secret(), secret(), secret(), options.expired ? new Date(Date.now() - 1_000) : new Date(Date.now() + 9 * 60_000)])).rows[0]!.id;
    const handoffId = randomUUID(), handoffSecret = secret(), browser = secret(); const obs = { provider: 'google' as const, issuer: GOOGLE_ISSUER, subject: `subject-${suffix}`, email, mailboxVerified: true, realm: domain, schoolMembershipAttested: false, objectId: null };
    await client.query(`INSERT INTO student_auth_link_handoffs (id, attempt_id, secret_hash, encrypted_observation, policy_id, policy_version, browser_binding_hash, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [handoffId, attempt, hashMicrosoftAttemptSecret(handoffSecret), encryptMicrosoftAttemptVerifier(JSON.stringify(obs), key, handoffId), policy.id, policy.version, hashMicrosoftAttemptSecret(browser), options.expired ? new Date(Date.now() - 1_000) : new Date(Date.now() + 9 * 60_000)]);
    return { email, university, handoffId, handoffSecret, browser, subject: obs.subject };
}

test('passwordless signup creates one passwordless account, mailbox proof, identity and session but no enrollment evidence', async () => {
    await withPool(async pool => {
        const key = randomBytes(32).toString('base64url'); let code = '';
        const service = new StudentSsoSignupService({ pool, attemptKey: key, isEnabled: () => true, isProviderEnabled: () => true, deliverOtp: async (_email, sent) => { code = sent; return { success: true }; } });
        const c = await pool.connect(); let state; try { state = await seed(c, key); } finally { c.release(); }
        await service.context({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser });
        const sent = await service.sendCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser });
        await service.verifyCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, challengeId: sent.challengeId, code });
        const completed = await service.complete({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, fullName: 'Ada Student', ageAttested: true, termsVersion: STUDENT_TERMS_VERSION, verificationConsent: true, noticeVersion: VERIFICATION_NOTICE_VERSION });
        assert.equal(completed.user.email, state.email);
        const rows = await pool.query<{ users: string; identities: string; sessions: string; enrollment: string; proofs: string }>(`SELECT (SELECT count(*)::text FROM users WHERE id=$1) users, (SELECT count(*)::text FROM student_auth_identities WHERE user_id=$1) identities, (SELECT count(*)::text FROM users WHERE id=$1 AND active_session_id IS NOT NULL) sessions, (SELECT count(*)::text FROM eligibility_evidence e JOIN students s ON s.id=e.student_id WHERE s.user_id=$1) enrollment, (SELECT count(*)::text FROM user_email_proofs WHERE user_id=$1) proofs`, [completed.user.id]);
        assert.deepEqual(rows.rows[0], { users: '1', identities: '1', sessions: '1', enrollment: '0', proofs: '1' });
        // Models a commit-success/response-loss retry: the consumed handoff
        // cannot issue a second account/session; ordinary SSO can now locate
        // the durable provider identity on a fresh provider attempt.
        await assert.rejects(service.complete({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, fullName: 'Ada Student', ageAttested: true, termsVersion: STUDENT_TERMS_VERSION, verificationConsent: true, noticeVersion: VERIFICATION_NOTICE_VERSION }), /not available/i);
        const linked = await pool.query(`SELECT 1 FROM student_auth_identities WHERE provider='google' AND subject=$1`, [state.subject]); assert.equal(linked.rowCount, 1);
    });
});

test('passwordless signup fails closed for a wrong browser and expired handoff', async () => {
    await withPool(async pool => {
        const key = randomBytes(32).toString('base64url'); const service = new StudentSsoSignupService({ pool, attemptKey: key, isEnabled: () => true, isProviderEnabled: () => true, deliverOtp: async () => ({ success: true }) });
        const c = await pool.connect(); let live, expired; try { live = await seed(c, key); expired = await seed(c, key, { expired: true }); } finally { c.release(); }
        await assert.rejects(service.context({ handoffId: live.handoffId, handoffSecret: live.handoffSecret, browserBinding: secret() }), /not available/i);
        await assert.rejects(service.context({ handoffId: expired.handoffId, handoffSecret: expired.handoffSecret, browserBinding: expired.browser }), /not available/i);
    });
});

test('signup send budgets survive rejected transactions and refuse a fourth send', async () => {
    await withPool(async pool => {
        const key = randomBytes(32).toString('base64url'); let sends = 0;
        const service = new StudentSsoSignupService({ pool, attemptKey: key, isEnabled: () => true, isProviderEnabled: () => true, deliverOtp: async () => { sends++; return { success: true }; } });
        const c = await pool.connect(); let state; try { state = await seed(c, key); } finally { c.release(); }
        for (let count = 0; count < 3; count++) {
            await service.sendCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser });
            await pool.query(`UPDATE verification_challenge_budgets SET resend_available_at = clock_timestamp() - interval '1 second'`);
        }
        await assert.rejects(service.sendCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser }), /wait before/i);
        assert.equal(sends, 3);
        const budget = await pool.query<{ send_count: number }>(`SELECT send_count FROM verification_challenge_budgets`);
        assert.equal(budget.rows[0]!.send_count, 3);
    });
});

test('signup rejects an existing email or provider identity without creating a second account', async () => {
    await withPool(async pool => {
        const key = randomBytes(32).toString('base64url'); let code = ''; const service = new StudentSsoSignupService({ pool, attemptKey: key, isEnabled: () => true, isProviderEnabled: () => true, deliverOtp: async (_email, value) => { code = value; return { success: true }; } });
        const c = await pool.connect(); let state; try { state = await seed(c, key); await c.query(`INSERT INTO users (email, role) VALUES ($1, 'student')`, [state.email]); } finally { c.release(); }
        const sent = await service.sendCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser });
        await service.verifyCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, challengeId: sent.challengeId, code });
        await assert.rejects(service.complete({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, fullName: 'Ada Student', ageAttested: true, termsVersion: STUDENT_TERMS_VERSION, verificationConsent: true, noticeVersion: VERIFICATION_NOTICE_VERSION }), /duplicate|unique/i);
        const users = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM users WHERE email=$1`, [state.email]); assert.equal(users.rows[0]!.count, '1');
    });
});

test('signup rechecks a policy disabled after its handoff was created', async () => {
    await withPool(async pool => {
        const key = randomBytes(32).toString('base64url'); const service = new StudentSsoSignupService({ pool, attemptKey: key, isEnabled: () => true, isProviderEnabled: () => true, deliverOtp: async () => ({ success: true }) });
        const c = await pool.connect(); let state; try { state = await seed(c, key); await c.query(`UPDATE institution_login_policies SET enabled=false WHERE university_id=$1`, [state.university]); } finally { c.release(); }
        await assert.rejects(service.context({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser }), /not available/i);
    });
});
