import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { GOOGLE_ISSUER } from '../../services/auth/student-google-oidc.js';
import { StudentSsoLinkService } from '../../services/auth/student-sso-link.service.js';
import { StudentSsoSignupService } from '../../services/auth/student-sso-signup.service.js';
import { passwordService } from '../../services/auth/password.service.js';
import { StudentSsoFlowService, studentSsoCookieName, type ApprovedLoginPolicy } from '../../services/auth/student-sso-flow.service.js';
import type { StudentOidcAdapter } from '../../services/auth/student-sso.types.js';
import { lockStudentContext } from '../../services/verification/eligibility-context.service.js';
import { grantVerificationProcessing } from '../../services/verification/eligibility-consent.service.js';
import { consumeChallenge, requestChallenge } from '../../services/verification/challenge.service.js';
import { recordEmailAssurance } from '../../services/verification/eligibility-evidence.service.js';
import { encryptMicrosoftAttemptVerifier, hashMicrosoftAttemptSecret } from '../../services/verification/microsoft-attempt-crypto.js';
import { assertFixtureDatabase, createTestPool } from './test-database.js';
import { STUDENT_TERMS_VERSION, VERIFICATION_NOTICE_TEXT, VERIFICATION_NOTICE_VERSION } from '../../services/verification/verification-notices.js';
import { challengeSubjectDigest } from '../../services/verification/challenge.service.js';

const label = () => randomUUID().replaceAll('-', '').slice(0, 12);
const secret = () => randomBytes(32).toString('hex');

async function withPool<T>(work: (pool: Pool) => Promise<T>): Promise<T> { const pool = createTestPool(); const c = await pool.connect(); try { await assertFixtureDatabase(c); } finally { c.release(); } try { return await work(pool); } finally { await pool.end(); } }

async function seed(client: PoolClient, key: string, options: { expired?: boolean; handoffLifetimeMs?: number; provider?: 'google' | 'microsoft' } = {}) {
    const suffix = label(), domain = `signup-${suffix}.school.example`, email = `ada-${suffix}@${domain}`;
    const provider = options.provider ?? 'microsoft';
    const admin = (await client.query<{ id: string }>(`INSERT INTO users (email, role) VALUES ($1, 'admin') RETURNING id`, [`admin-${suffix}@example.invalid`])).rows[0]!.id;
    const university = (await client.query<{ id: string }>(`INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id`, [`Signup School ${suffix}`])).rows[0]!.id;
    const tenant = randomUUID(), issuer = provider === 'microsoft' ? `https://login.microsoftonline.com/${tenant}/v2.0` : GOOGLE_ISSUER;
    const realm = provider === 'microsoft' ? tenant : domain;
    const policy = (await client.query<{ id: string; version: number }>(`INSERT INTO institution_login_policies (university_id, provider, issuer, provider_realm, version, enabled, approved_until, approved_by, school_assertion_days) VALUES ($1, $2, $3, $4, 1, true, clock_timestamp() + interval '1 day', $5, 90) RETURNING id, version`, [university, provider, issuer, realm, admin])).rows[0]!;
    await client.query(`INSERT INTO institution_login_domains (domain, university_id, is_active) VALUES ($1, $2, true)`, [domain, university]);
    await client.query(`INSERT INTO institution_login_domain_providers (domain, university_id, provider, policy_id) VALUES ($1, $2, $3, $4)`, [domain, university, provider, policy.id]);
    const expiry = options.expired ? new Date(Date.now() - 1_000) : new Date(Date.now() + (options.handoffLifetimeMs ?? 9 * 60_000));
    const attempt = (await client.query<{ id: string }>(`INSERT INTO student_auth_attempts (policy_id, policy_version, provider, requested_email, state_hash, callback_cookie_hash, finish_secret_hash, encrypted_verifier, nonce, encrypted_observation, status, expires_at, remember_me) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,'pending',$10,false) RETURNING id`, [policy.id, policy.version, provider, email, secret(), secret(), secret(), secret(), secret(), expiry])).rows[0]!.id;
    const handoffId = randomUUID(), handoffSecret = secret(), browser = secret(); const obs = { provider, issuer, subject: `subject-${suffix}`, email, mailboxVerified: true, realm, schoolMembershipAttested: false, objectId: null };
    await client.query(`INSERT INTO student_auth_link_handoffs (id, attempt_id, secret_hash, encrypted_observation, policy_id, policy_version, browser_binding_hash, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [handoffId, attempt, hashMicrosoftAttemptSecret(handoffSecret), encryptMicrosoftAttemptVerifier(JSON.stringify(obs), key, handoffId), policy.id, policy.version, hashMicrosoftAttemptSecret(browser), expiry]);
    return { email, university, attemptId: attempt, handoffId, handoffSecret, browser, subject: obs.subject, expiresAt: expiry, issuer, tenant };
}

async function seedVerifiedLinkOwner(client: PoolClient, input: { email: string; universityId: string }) {
    const domain = input.email.slice(input.email.lastIndexOf('@') + 1);
    const adminId = (await client.query<{ id: string }>(`INSERT INTO users (email, role) VALUES ($1, 'admin') RETURNING id`, [`approval-${label()}@example.invalid`])).rows[0]!.id;
    await client.query(`INSERT INTO approved_student_email_domains (university_id, domain, approved_by) VALUES ($1, $2, $3)`, [input.universityId, domain, adminId]);
    const userId = (await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'student') RETURNING id`,
        [input.email, await passwordService.hashPassword('Correct!horse-9-battery')],
    )).rows[0]!.id;
    await client.query(
        `INSERT INTO students (user_id, name, university_id) VALUES ($1, 'Existing Student', $2)`,
        [userId, input.universityId],
    );
    const grantId = await grantVerificationProcessing(client, userId, input.universityId, {
        accepted: true,
        noticeVersion: VERIFICATION_NOTICE_VERSION,
    });
    const context = await lockStudentContext(client, userId);
    const issued = await requestChallenge(client, {
        purpose: 'student_email',
        subjectKey: userId,
        bindings: { ...context, processingGrantId: grantId, noticeVersion: VERIFICATION_NOTICE_VERSION },
    });
    assert.equal(issued.status, 'issued');
    if (issued.status !== 'issued') throw new Error('Expected an owner email challenge');
    const consumed = await consumeChallenge(client, {
        purpose: 'student_email', subjectKey: userId, challengeId: issued.challengeId, code: issued.code,
    });
    assert.equal(consumed.status, 'verified');
    await recordEmailAssurance(client, userId, { challengeId: issued.challengeId, processingGrantId: grantId });
    const sid = randomUUID();
    await client.query(`UPDATE users SET active_session_id = $2 WHERE id = $1`, [userId, sid]);
    return { userId, sid };
}

test('passwordless signup creates one passwordless account, mailbox proof, identity and session but no enrollment evidence', async () => {
    await withPool(async pool => {
        const key = randomBytes(32).toString('base64url'); let code = '';
        const service = new StudentSsoSignupService({ pool, attemptKey: key, isEnabled: () => true, isProviderEnabled: () => true, deliverOtp: async (_email, sent) => { code = sent; return { success: true }; } });
        const c = await pool.connect(); let state; try { state = await seed(c, key); } finally { c.release(); }
        const ctx = await service.context({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser });
        assert.equal(ctx.noticeText, VERIFICATION_NOTICE_TEXT, 'signup must present the processing notice text before recording consent');
        await assert.rejects(service.complete({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, fullName: 'Ada Student', ageAttested: true, termsAccepted: true, termsVersion: STUDENT_TERMS_VERSION, verificationConsent: true, noticeVersion: VERIFICATION_NOTICE_VERSION }), /not available/i);
        assert.equal((await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM users WHERE email=$1`, [state.email])).rows[0]!.count, '0');
        await assert.rejects(service.complete({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, fullName: 'Ada Student', ageAttested: true, termsAccepted: true, termsVersion: 'stale-terms', verificationConsent: true, noticeVersion: VERIFICATION_NOTICE_VERSION }), /current age, terms, and verification processing assent/i);
        assert.equal((await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM users WHERE email=$1`, [state.email])).rows[0]!.count, '0');
        await assert.rejects(service.complete({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, fullName: 'Ada Student', ageAttested: true, termsAccepted: true, termsVersion: STUDENT_TERMS_VERSION, verificationConsent: false, noticeVersion: VERIFICATION_NOTICE_VERSION }), /current age, terms, and verification processing assent/i);
        assert.equal((await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM users WHERE email=$1`, [state.email])).rows[0]!.count, '0');
        await assert.rejects(service.complete({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, fullName: 'Ada Student', ageAttested: true, termsAccepted: false, termsVersion: STUDENT_TERMS_VERSION, verificationConsent: true, noticeVersion: VERIFICATION_NOTICE_VERSION }), /current age, terms, and verification processing assent/i);
        assert.equal((await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM users WHERE email=$1`, [state.email])).rows[0]!.count, '0');
        const sent = await service.sendCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser });
        const stored = await pool.query<{ bindings: Record<string, unknown> }>(`SELECT bindings FROM verification_challenges WHERE id = $1`, [sent.challengeId]);
        assert.deepEqual(Object.keys(stored.rows[0]!.bindings).sort(), ['email', 'matricNumber', 'name', 'noticeVersion', 'policyVersion', 'universityId']);
        await service.verifyCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, challengeId: sent.challengeId, code });
        const completed = await service.complete({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, fullName: 'Ada Student', ageAttested: true, termsAccepted: true, termsVersion: STUDENT_TERMS_VERSION, verificationConsent: true, noticeVersion: VERIFICATION_NOTICE_VERSION });
        assert.equal(completed.user.email, state.email);
        const transientSecrets = await pool.query<{
            handoff_secret: string | null; handoff_binding: string | null; handoff_observation: string | null;
            signup_secret: string | null; signup_binding: string | null; otp_digest: string;
        }>(
            `SELECT handoff.secret_hash AS handoff_secret, handoff.browser_binding_hash AS handoff_binding,
                    handoff.encrypted_observation AS handoff_observation, signup.secret_hash AS signup_secret,
                    signup.browser_binding_hash AS signup_binding, otp.secret_digest AS otp_digest
             FROM student_auth_link_handoffs handoff
             JOIN student_auth_signup_challenges signup ON signup.handoff_id = handoff.id
             JOIN verification_challenges otp ON otp.id = signup.mailbox_challenge_id
             WHERE handoff.id = $1`,
            [state.handoffId],
        );
        assert.deepEqual(transientSecrets.rows[0], {
            handoff_secret: null, handoff_binding: null, handoff_observation: null,
            signup_secret: null, signup_binding: null, otp_digest: '0'.repeat(64),
        }, 'successful passwordless signup immediately scrubs its handoff, signup, and OTP digests');
        const rows = await pool.query<{ users: string; identities: string; sessions: string; enrollment: string; proofs: string }>(`SELECT (SELECT count(*)::text FROM users WHERE id=$1) users, (SELECT count(*)::text FROM student_auth_identities WHERE user_id=$1) identities, (SELECT count(*)::text FROM users WHERE id=$1 AND active_session_id IS NOT NULL) sessions, (SELECT count(*)::text FROM eligibility_evidence e JOIN students s ON s.id=e.student_id WHERE s.user_id=$1) enrollment, (SELECT count(*)::text FROM user_email_proofs WHERE user_id=$1) proofs`, [completed.user.id]);
        assert.deepEqual(rows.rows[0], { users: '1', identities: '1', sessions: '1', enrollment: '0', proofs: '1' });
        // Models a commit-success/response-loss retry: the consumed handoff
        // cannot issue a second account/session; ordinary SSO can now locate
        // the durable provider identity on a fresh provider attempt.
        await assert.rejects(service.complete({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, fullName: 'Ada Student', ageAttested: true, termsAccepted: true, termsVersion: STUDENT_TERMS_VERSION, verificationConsent: true, noticeVersion: VERIFICATION_NOTICE_VERSION }), /not available/i);
        const linked = await pool.query(`SELECT 1 FROM student_auth_identities WHERE provider='microsoft' AND subject=$1`, [state.subject]); assert.equal(linked.rowCount, 1);
        let oauthState = '';
        const flow = new StudentSsoFlowService({ pool, attemptKey: randomBytes(32).toString('base64url'), callbackUrls: { google: new URL('https://api.example.invalid/api/auth/student/sso/google/callback'), microsoft: new URL('https://api.example.invalid/api/auth/student/sso/microsoft/callback') }, completionUrl: new URL('https://app.example.invalid/auth/student/sso/complete'), isEnabled: () => true, isProviderEnabled: () => true,
            oidc: { forPolicy: (_policy: ApprovedLoginPolicy): StudentOidcAdapter => ({ authorize: async ({ state: value }) => { oauthState = value; return new URL(`https://provider.invalid/?state=${value}`); }, redeem: async () => ({ provider: 'microsoft', issuer: state.issuer, subject: state.subject, email: state.email, mailboxVerified: true, realm: state.tenant, schoolMembershipAttested: false, objectId: null }) }) },
        });
        const login = await flow.start({ provider: 'microsoft', email: state.email }); const callback = new URL('https://api.example.invalid/api/auth/student/sso/microsoft/callback'); callback.searchParams.set('state', oauthState); callback.searchParams.set('code', 'opaque');
        await flow.callback({ provider: 'microsoft', callbackUrl: callback, browserCookies: [{ name: studentSsoCookieName(login.publicResult.attemptId), value: login.callbackCookie.value }] });
        const relogin = await flow.finish({ attemptId: login.publicResult.attemptId, finishSecret: login.publicResult.finishSecret, browserCookie: login.callbackCookie.value });
        assert.equal(relogin.outcome, 'authenticated');
    });
});

test('signup OTP verification is idempotent for a lost success response', async () => {
    await withPool(async pool => {
        const key = randomBytes(32).toString('base64url'); let code = ''; let deliveries = 0;
        const service = new StudentSsoSignupService({ pool, attemptKey: key, isEnabled: () => true, isProviderEnabled: () => true, deliverOtp: async (_email, sent) => { code = sent; deliveries += 1; return { success: true }; } });
        const c = await pool.connect(); let state; try { state = await seed(c, key); } finally { c.release(); }
        const sent = await service.sendCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser });
        const first = await service.verifyCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, challengeId: sent.challengeId, code });
        assert.deepEqual(first, { verified: true, expiresAt: first.expiresAt });
        // The success response was lost after commit: retrying the same
        // bound challenge replays the verified result instead of consuming
        // the spent challenge twice and forcing a sign-in restart.
        const replay = await service.verifyCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, challengeId: sent.challengeId, code });
        assert.deepEqual(replay, first);
        await assert.rejects(
            service.verifyCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, challengeId: randomUUID(), code }),
            /not available/i,
        );
        // A reload after verification lost the browser challenge: sending
        // again resumes with the bound challenge instead of tripping the
        // trigger-immutable binding, and delivers nothing new.
        const resumed = await service.sendCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser });
        assert.equal(resumed.challengeId, sent.challengeId);
        assert.equal(deliveries, 1);
        const resumedVerify = await service.verifyCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, challengeId: resumed.challengeId, code });
        assert.deepEqual(resumedVerify, first);
    });
});

test('signup completion succeeds when the consumed OTP expired after verification but the handoff is live', async () => {
    await withPool(async pool => {
        const key = randomBytes(32).toString('base64url'); let code = '';
        const service = new StudentSsoSignupService({ pool, attemptKey: key, isEnabled: () => true, isProviderEnabled: () => true, deliverOtp: async (_email, sent) => { code = sent; return { success: true }; } });
        const c = await pool.connect(); let state; try { state = await seed(c, key); } finally { c.release(); }
        const sent = await service.sendCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser });
        await service.verifyCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, challengeId: sent.challengeId, code });
        await pool.query(`UPDATE verification_challenges SET expires_at = clock_timestamp() WHERE id = $1`, [sent.challengeId]);
        const completed = await service.complete({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, fullName: 'Ada Student', ageAttested: true, termsAccepted: true, termsVersion: STUDENT_TERMS_VERSION, verificationConsent: true, noticeVersion: VERIFICATION_NOTICE_VERSION });
        assert.equal(completed.user.email, state.email);
        const proofs = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM user_email_proofs WHERE user_id = $1`, [completed.user.id]);
        assert.equal(proofs.rows[0]!.count, '1');
    });
});

test('link and signup completion racing for one verified handoff leave only the existing owner', async () => {
    await withPool(async pool => {
        const key = randomBytes(32).toString('base64url'); let code = '';
        const signup = new StudentSsoSignupService({ pool, attemptKey: key, isEnabled: () => true, isProviderEnabled: () => true, deliverOtp: async (_email, sent) => { code = sent; return { success: true }; } });
        const link = new StudentSsoLinkService({ pool, attemptKey: key, isEnabled: () => true, isProviderEnabled: () => true });
        const client = await pool.connect(); let state; let owner;
        try {
            state = await seed(client, key);
            owner = await seedVerifiedLinkOwner(client, { email: state.email, universityId: state.university });
        } finally { client.release(); }
        const sent = await signup.sendCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser });
        await signup.verifyCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, challengeId: sent.challengeId, code });
        const grant = await link.reauth({ userId: owner.userId, sid: owner.sid, password: 'Correct!horse-9-battery', purpose: 'link' });
        const results = await Promise.allSettled([
            signup.complete({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, fullName: 'Racing Student', ageAttested: true, termsAccepted: true, termsVersion: STUDENT_TERMS_VERSION, verificationConsent: true, noticeVersion: VERIFICATION_NOTICE_VERSION }),
            link.link({ userId: owner.userId, sid: owner.sid, handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserCookies: [{ name: studentSsoCookieName(state.attemptId), value: state.browser }], grantId: grant.grantId, grantSecret: grant.grantSecret }),
        ]);
        assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
        if (results[1].status !== 'fulfilled') throw new Error('Expected the existing owner link to win the handoff race');
        assert.equal(results[1].value.outcome, 'linked');
        assert.equal(results[0].status, 'rejected');
        const persisted = await pool.query<{ users: string; identities: string; owner_id: string; sessions: string }>(
            `SELECT
                (SELECT count(*)::text FROM users WHERE email = $1) AS users,
                (SELECT count(*)::text FROM student_auth_identities WHERE provider = 'microsoft' AND subject = $2) AS identities,
                (SELECT user_id FROM student_auth_identities WHERE provider = 'microsoft' AND subject = $2) AS owner_id,
                (SELECT count(*)::text FROM users WHERE email = $1 AND active_session_id IS NOT NULL) AS sessions`,
            [state.email, state.subject],
        );
        assert.deepEqual(persisted.rows[0], { users: '1', identities: '1', owner_id: owner.userId, sessions: '1' });
    });
});

test('passwordless signup fails closed for a wrong browser and expired handoff', async () => {
    await withPool(async pool => {
        const key = randomBytes(32).toString('base64url'); const service = new StudentSsoSignupService({ pool, attemptKey: key, isEnabled: () => true, isProviderEnabled: () => true, deliverOtp: async () => ({ success: true }) });
        const c = await pool.connect(); let live, expired; try { live = await seed(c, key); expired = await seed(c, key, { expired: true }); } finally { c.release(); }
        await assert.rejects(service.context({ handoffId: live.handoffId, handoffSecret: live.handoffSecret, browserBinding: secret() }), /not available/i);
        await assert.rejects(service.context({ handoffId: expired.handoffId, handoffSecret: expired.handoffSecret, browserBinding: expired.browser }), /not available/i);
        // This test deliberately seeds an expired row; terminalize it so the
        // later shared cleanup regression owns only its own fixture.
        await pool.query(`UPDATE student_auth_link_handoffs SET consumed_at=clock_timestamp(), encrypted_observation='scrubbed' WHERE id=$1`, [expired.handoffId]);
        await pool.query(`UPDATE student_auth_attempts SET status='failed', state_hash=NULL, callback_cookie_hash=NULL, finish_secret_hash=NULL, encrypted_verifier=NULL, nonce=NULL WHERE id=$1`, [expired.attemptId]);
    });
});

test('signup send budgets survive rejected transactions and cap delivery at three sends', async () => {
    await withPool(async pool => {
        const key = randomBytes(32).toString('base64url'); let sends = 0;
        const service = new StudentSsoSignupService({ pool, attemptKey: key, isEnabled: () => true, isProviderEnabled: () => true, deliverOtp: async () => { sends++; return { success: true }; } });
        const c = await pool.connect(); let state; try { state = await seed(c, key); } finally { c.release(); }
        const seen = new Set<string>();
        for (let count = 0; count < 3; count++) {
            const sent = await service.sendCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser });
            seen.add(sent.challengeId);
            await pool.query(`UPDATE verification_challenge_budgets SET resend_available_at = clock_timestamp() - interval '1 second'`);
        }
        assert.equal(seen.size, 3);
        // Locked with a live bound challenge: the pending retry resumes it
        // instead of a 409, and delivers nothing new.
        const resumed = await service.sendCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser });
        assert.ok(seen.has(resumed.challengeId));
        assert.equal(sends, 3);
        // Locked with no live bound challenge: still a bounded refusal.
        // created_at moves with expires_at to satisfy the table's
        // expires_at > created_at check; the subject scope spares other
        // tests' challenges in the shared database.
        await pool.query(`UPDATE verification_challenges SET created_at = clock_timestamp() - interval '1 hour', expires_at = clock_timestamp() - interval '1 second' WHERE purpose = 'student_sso_signup' AND subject_digest = $1`, [challengeSubjectDigest('student_sso_signup', state.email)]);
        await assert.rejects(service.sendCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser }), /wait before/i);
        assert.equal(sends, 3);
        const budget = await pool.query<{ send_count: number }>(`SELECT send_count FROM verification_challenge_budgets WHERE purpose='student_sso_signup' AND subject_digest=$1`, [challengeSubjectDigest('student_sso_signup', state.email)]);
        assert.equal(budget.rows[0]!.send_count, 3);
    });
});

test('failed signup delivery supersedes the bound challenge instead of resuming it', async () => {
    await withPool(async pool => {
        const key = randomBytes(32).toString('base64url'); let code = ''; let sends = 0;
        const service = new StudentSsoSignupService({
            pool, attemptKey: key, isEnabled: () => true, isProviderEnabled: () => true,
            deliverOtp: async (_email, value) => { sends++; if (sends === 1) return { success: false }; code = value; return { success: true }; },
        });
        const c = await pool.connect(); let state; try { state = await seed(c, key); } finally { c.release(); }
        await assert.rejects(service.sendCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser }), /could not deliver/);
        // The bound challenge was never emailed: the cooldown retry must
        // refuse instead of resuming it as success with an unusable OTP.
        await assert.rejects(service.sendCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser }), /wait before/i);
        await pool.query(`UPDATE verification_challenge_budgets SET resend_available_at = clock_timestamp() - interval '1 second'`);
        const retry = await service.sendCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser });
        assert.equal(sends, 2);
        const bound = await pool.query<{ id: string; superseded_at: Date | null }>(
            `SELECT c.id, c.superseded_at FROM verification_challenges c
             JOIN student_auth_signup_challenges s ON s.mailbox_challenge_id = c.id
             WHERE s.handoff_id = $1`, [state.handoffId],
        );
        assert.equal(bound.rows[0]!.id, retry.challengeId);
        assert.equal(bound.rows[0]!.superseded_at, null);
        const dead = await pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM verification_challenges
             WHERE purpose = 'student_sso_signup' AND subject_digest = $1 AND superseded_at IS NOT NULL`,
            [challengeSubjectDigest('student_sso_signup', state.email)],
        );
        assert.equal(dead.rows[0]!.count, '1', 'the undelivered challenge is superseded exactly once');
        await service.verifyCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, challengeId: retry.challengeId, code });
    });
});

test('signup resumes a pending send after response loss and expiry after verified OTP creates no account', async () => {
    await withPool(async pool => {
        const key = randomBytes(32).toString('base64url'); let code = ''; let sends = 0;
        const service = new StudentSsoSignupService({ pool, attemptKey: key, isEnabled: () => true, isProviderEnabled: () => true, deliverOtp: async (_email, value) => { code = value; sends++; return { success: true }; } });
        const c = await pool.connect(); let state; try { state = await seed(c, key, { handoffLifetimeMs: 2_000 }); } finally { c.release(); }
        const sent = await service.sendCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser });
        // The 201 was lost: the immediate retry hits the cooldown but the
        // bound challenge and its OTP are still live, so the send resumes
        // with the same id instead of stranding the emailed code.
        const resumed = await service.sendCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser });
        assert.equal(resumed.challengeId, sent.challengeId);
        assert.equal(sends, 1);
        await service.verifyCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, challengeId: resumed.challengeId, code });
        await new Promise(resolve => setTimeout(resolve, Math.max(0, state.expiresAt.getTime() - Date.now()) + 50));
        await assert.rejects(service.complete({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, fullName: 'Ada Student', ageAttested: true, termsAccepted: true, termsVersion: STUDENT_TERMS_VERSION, verificationConsent: true, noticeVersion: VERIFICATION_NOTICE_VERSION }), /not available/i);
        assert.equal((await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM users WHERE email=$1`, [state.email])).rows[0]!.count, '0');
        await pool.query(`UPDATE student_auth_link_handoffs SET consumed_at=clock_timestamp(), encrypted_observation='scrubbed' WHERE id=$1`, [state.handoffId]);
        await pool.query(`UPDATE student_auth_attempts SET status='failed', state_hash=NULL, callback_cookie_hash=NULL, finish_secret_hash=NULL, encrypted_verifier=NULL, nonce=NULL WHERE id=$1`, [state.attemptId]);
    });
});

test('active and revoked provider identities cannot be claimed by passwordless signup', async () => {
    await withPool(async pool => {
        const key = randomBytes(32).toString('base64url'); const service = new StudentSsoSignupService({ pool, attemptKey: key, isEnabled: () => true, isProviderEnabled: () => true, deliverOtp: async () => ({ success: true }) });
        const c = await pool.connect(); let state; try { state = await seed(c, key); const owner = (await c.query<{ id: string }>(`INSERT INTO users (email, role) VALUES ($1,'student') RETURNING id`, [`owner-${label()}@example.invalid`])).rows[0]!.id; await c.query(`INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject, observed_email, revoked_at) VALUES ($1,$2,'microsoft',$3,$4,$5,clock_timestamp())`, [owner, state.university, state.issuer, state.subject, state.email]); } finally { c.release(); }
        await assert.rejects(service.context({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser }), (error: unknown) => (error as { code?: string }).code === 'SSO_SIGNUP_EXISTING_ACCOUNT');
    });
});

test('five rejected OTP checks are committed and lock the correct code too', async () => {
    await withPool(async pool => {
        const key = randomBytes(32).toString('base64url'); let code = '';
        const service = new StudentSsoSignupService({ pool, attemptKey: key, isEnabled: () => true, isProviderEnabled: () => true, deliverOtp: async (_email, value) => { code = value; return { success: true }; } });
        const c = await pool.connect(); let state; try { state = await seed(c, key); } finally { c.release(); }
        const sent = await service.sendCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser });
        for (let attempt = 0; attempt < 5; attempt++) {
            await assert.rejects(service.verifyCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, challengeId: sent.challengeId, code: '000000' }), /invalid or expired/i);
        }
        await assert.rejects(service.verifyCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, challengeId: sent.challengeId, code }), /invalid or expired/i);
        const budget = await pool.query<{ failed_attempts: number }>(`SELECT failed_attempts FROM verification_challenge_budgets WHERE purpose='student_sso_signup' AND subject_digest=$1`, [challengeSubjectDigest('student_sso_signup', state.email)]);
        assert.equal(budget.rows[0]!.failed_attempts, 5);
    });
});

test('signup rejects an existing email or provider identity without creating a second account', async () => {
    await withPool(async pool => {
        const key = randomBytes(32).toString('base64url'); let code = ''; const service = new StudentSsoSignupService({ pool, attemptKey: key, isEnabled: () => true, isProviderEnabled: () => true, deliverOtp: async (_email, value) => { code = value; return { success: true }; } });
        const c = await pool.connect(); let state; try { state = await seed(c, key); await c.query(`INSERT INTO users (email, role) VALUES ($1, 'student')`, [state.email]); } finally { c.release(); }
        const sent = await service.sendCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser });
        await service.verifyCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, challengeId: sent.challengeId, code });
        await assert.rejects(service.complete({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, fullName: 'Ada Student', ageAttested: true, termsAccepted: true, termsVersion: STUDENT_TERMS_VERSION, verificationConsent: true, noticeVersion: VERIFICATION_NOTICE_VERSION }), (error: unknown) => (error as { code?: string }).code === 'SSO_SIGNUP_EXISTING_ACCOUNT');
        const users = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM users WHERE email=$1`, [state.email]); assert.equal(users.rows[0]!.count, '1');
    });
});

test('signup completion refuses an institution deactivated after verification', async () => {
    await withPool(async pool => {
        const key = randomBytes(32).toString('base64url'); let code = '';
        const service = new StudentSsoSignupService({ pool, attemptKey: key, isEnabled: () => true, isProviderEnabled: () => true, deliverOtp: async (_email, sent) => { code = sent; return { success: true }; } });
        const c = await pool.connect(); let state; try { state = await seed(c, key); } finally { c.release(); }
        const sent = await service.sendCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser });
        await service.verifyCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, challengeId: sent.challengeId, code });
        // Deactivate after the mailbox proof: completion rechecks activity
        // while holding the university lock instead of inserting an active
        // student and issuing a session for a dead institution.
        await pool.query('UPDATE universities SET is_active = false WHERE id = $1', [state.university]);
        await assert.rejects(service.complete({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, fullName: 'Ada Student', ageAttested: true, termsAccepted: true, termsVersion: STUDENT_TERMS_VERSION, verificationConsent: true, noticeVersion: VERIFICATION_NOTICE_VERSION }), /not available/i);
        assert.equal((await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM users WHERE email=$1`, [state.email])).rows[0]!.count, '0');
    });
});

test('concurrent signup completions cannot deadlock a login-ordered locker', async () => {
    await withPool(async pool => {
        const key = randomBytes(32).toString('base64url'); const codes = new Map<string, string>();
        const service = new StudentSsoSignupService({ pool, attemptKey: key, isEnabled: () => true, isProviderEnabled: () => true, deliverOtp: async (email, sent) => { codes.set(email, sent); return { success: true }; } });
        const c = await pool.connect();
        let first; let second;
        try {
            first = await seed(c, key);
            // A second verified signup sharing the first's university and
            // policy: same domain mapping, distinct mailbox and subject.
            const domain = first.email.split('@')[1]!;
            const emailB = `bob-${label()}@${domain}`;
            const policy = (await c.query<{ policy_id: string }>('SELECT policy_id FROM student_auth_link_handoffs WHERE id = $1', [first.handoffId])).rows[0]!.policy_id;
            const attemptB = (await c.query<{ id: string }>(`INSERT INTO student_auth_attempts (policy_id, policy_version, provider, requested_email, state_hash, callback_cookie_hash, finish_secret_hash, encrypted_verifier, nonce, encrypted_observation, status, expires_at, remember_me) VALUES ($1,1,'microsoft',$2,$3,$4,$5,$6,$7,NULL,'pending',$8,false) RETURNING id`, [policy, emailB, secret(), secret(), secret(), secret(), secret(), first.expiresAt])).rows[0]!.id;
            const handoffId = randomUUID(), handoffSecret = secret(), browser = secret();
            const obs = { provider: 'microsoft', issuer: first.issuer, subject: `subject-${label()}`, email: emailB, mailboxVerified: true, realm: first.tenant, schoolMembershipAttested: false, objectId: null };
            await c.query(`INSERT INTO student_auth_link_handoffs (id, attempt_id, secret_hash, encrypted_observation, policy_id, policy_version, browser_binding_hash, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [handoffId, attemptB, hashMicrosoftAttemptSecret(handoffSecret), encryptMicrosoftAttemptVerifier(JSON.stringify(obs), key, handoffId), policy, 1, hashMicrosoftAttemptSecret(browser), first.expiresAt]);
            second = { email: emailB, handoffId, handoffSecret, browser };
        } finally { c.release(); }
        for (const state of [first, second]) {
            const sent = await service.sendCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser });
            await service.verifyCode({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, challengeId: sent.challengeId, code: codes.get(state.email)! });
        }
        // A concurrent login-ordered locker (university, then policy, with
        // a hold between): completion locks in the same canonical order,
        // so all three serialize instead of deadlocking (no 40P01).
        const policyId = (await pool.query<{ policy_id: string }>('SELECT policy_id FROM student_auth_link_handoffs WHERE id = $1', [first.handoffId])).rows[0]!.policy_id;
        const locker = (async () => {
            const held = await pool.connect();
            try {
                await held.query('BEGIN');
                await held.query('SELECT id FROM universities WHERE id = $1 FOR UPDATE', [first.university]);
                await new Promise(resolve => setTimeout(resolve, 150));
                await held.query('SELECT id FROM institution_login_policies WHERE id = $1 FOR UPDATE', [policyId]);
                await held.query('COMMIT');
            } catch (error) { await held.query('ROLLBACK').catch(() => undefined); throw error; } finally { held.release(); }
        })();
        const finishing = [first, second].map(state => service.complete({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser, fullName: 'Ada Student', ageAttested: true, termsAccepted: true, termsVersion: STUDENT_TERMS_VERSION, verificationConsent: true, noticeVersion: VERIFICATION_NOTICE_VERSION }));
        const [userA, userB] = await Promise.all([...finishing, locker]);
        assert.ok(userA && userB);
        assert.equal((await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM users WHERE email = ANY($1)', [[first.email, second.email]])).rows[0]!.count, '2');
    });
});

test('signup rechecks a policy disabled after its handoff was created', async () => {
    await withPool(async pool => {
        const key = randomBytes(32).toString('base64url'); const service = new StudentSsoSignupService({ pool, attemptKey: key, isEnabled: () => true, isProviderEnabled: () => true, deliverOtp: async () => ({ success: true }) });
        const c = await pool.connect(); let state; try { state = await seed(c, key); await c.query(`UPDATE institution_login_policies SET enabled=false WHERE university_id=$1`, [state.university]); } finally { c.release(); }
        await assert.rejects(service.context({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser }), /not available/i);
    });
});

test('passwordless signup rejects non-Microsoft handoffs before creating signup state', async () => {
    await withPool(async pool => {
        const key = randomBytes(32).toString('base64url'); const service = new StudentSsoSignupService({ pool, attemptKey: key, isEnabled: () => true, isProviderEnabled: () => true, deliverOtp: async () => ({ success: true }) });
        const c = await pool.connect(); let state; try { state = await seed(c, key, { provider: 'google' }); } finally { c.release(); }
        await assert.rejects(service.context({ handoffId: state.handoffId, handoffSecret: state.handoffSecret, browserBinding: state.browser }), /not available/i);
        const signup = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM student_auth_signup_challenges WHERE handoff_id = $1`, [state.handoffId]);
        assert.equal(signup.rows[0]!.count, '0');
    });
});
