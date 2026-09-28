import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { assertFixtureDatabase, createTestPool } from './test-database.js';
import {
    StudentSsoFlowService,
    cleanupStudentSsoTransients,
    studentSsoCookieName,
    type ApprovedLoginPolicy,
} from '../../services/auth/student-sso-flow.service.js';
import { issueSessionInTransaction } from '../../services/auth/session.service.js';
import { StudentAccountRecoveryService } from '../../services/auth/student-account-recovery.service.js';
import { jwtService } from '../../services/auth/jwt.service.js';
import { GOOGLE_ISSUER, StudentOidcOperationalError } from '../../services/auth/student-google-oidc.js';
import type { ProviderObservation, StudentOidcAdapter } from '../../services/auth/student-sso.types.js';
import type { StudentAssurance } from '../../services/verification/student-assurance.types.js';
import {
    decryptMicrosoftAttemptVerifier,
    encryptMicrosoftAttemptVerifier,
    hashMicrosoftAttemptSecret,
} from '../../services/verification/microsoft-attempt-crypto.js';

// Task B3: browser-bound atomic SSO login over migration 057 storage. The OIDC
// transport is a per-test fake (mocked discovery semantics, redeem counters);
// no network identity calls run here, ever.

const GOOGLE_CALLBACK = new URL('https://api.example.invalid/api/auth/student/sso/google/callback');
const MICROSOFT_CALLBACK = new URL('https://api.example.invalid/api/auth/student/sso/microsoft/callback');
const COMPLETION_URL = new URL('https://app.example.invalid/auth/student/sso/complete');

function uniqueLabel(): string {
    return randomUUID().replaceAll('-', '').slice(0, 12);
}

function refreshHash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

async function withSsoPool<T>(operation: (pool: Pool) => Promise<T>): Promise<T> {
    const pool = createTestPool();
    const probe = await pool.connect();
    try {
        await assertFixtureDatabase(probe);
    } finally {
        probe.release();
    }
    try {
        return await operation(pool);
    } finally {
        await pool.end();
    }
}

async function createUniversity(client: PoolClient): Promise<string> {
    return (await client.query<{ id: string }>(
        'INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id',
        [`SSO Flow School ${uniqueLabel()}`],
    )).rows[0]!.id;
}

async function createStudent(client: PoolClient, universityId: string, email: string): Promise<string> {
    const userId = (await client.query<{ id: string }>(
        'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
        [email, `hash-${uniqueLabel()}`, 'student'],
    )).rows[0]!.id;
    await client.query('INSERT INTO students (user_id, name, university_id) VALUES ($1, $2, $3)', [userId, `Flow Student ${uniqueLabel()}`, universityId]);
    return userId;
}

async function createLoginPolicy(
    client: PoolClient,
    universityId: string,
    overrides: { provider?: string; issuer?: string; realm?: string; version?: number; enabled?: boolean; approvedUntil?: string | null; approvedBy?: string | null } = {},
): Promise<{ id: string; version: number }> {
    const provider = overrides.provider ?? 'google';
    const enabled = overrides.enabled ?? true;
    // Enabled policies require a recorded approver; seed one unless the
    // caller explicitly opts out with approvedBy: null (negative tests).
    const approvedBy = overrides.approvedBy !== undefined
        ? overrides.approvedBy
        : enabled ? await createAdmin(client) : null;
    const row = (await client.query<{ id: string; version: number }>(
        `INSERT INTO institution_login_policies
             (university_id, provider, issuer, provider_realm, version, enabled, approved_until, approved_by, school_assertion_days)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 90)
         RETURNING id, version`,
        [
            universityId,
            provider,
            overrides.issuer ?? (provider === 'google' ? GOOGLE_ISSUER : `https://login.microsoftonline.com/${overrides.realm ?? randomUUID()}/v2.0`),
            overrides.realm ?? `flow${uniqueLabel()}.school.example`,
            overrides.version ?? 1,
            enabled,
            overrides.approvedUntil !== undefined ? overrides.approvedUntil : new Date(Date.now() + 30 * 86_400_000).toISOString(),
            approvedBy,
        ],
    )).rows[0]!;
    return { id: row.id, version: row.version };
}

async function createAdmin(client: PoolClient): Promise<string> {
    return (await client.query<{ id: string }>(
        'INSERT INTO users (email, role) VALUES ($1, $2) RETURNING id',
        [`sso-admin-${uniqueLabel()}@example.invalid`, 'admin'],
    )).rows[0]!.id;
}

async function createLoginDomain(client: PoolClient, domain: string, universityId: string, provider: string, policyId: string): Promise<void> {
    await client.query('INSERT INTO institution_login_domains (domain, university_id, is_active) VALUES ($1, $2, true)', [domain, universityId]);
    await client.query(
        'INSERT INTO institution_login_domain_providers (domain, university_id, provider, policy_id) VALUES ($1, $2, $3, $4)',
        [domain, universityId, provider, policyId],
    );
}

async function createIdentity(
    client: PoolClient,
    userId: string,
    universityId: string,
    overrides: { provider?: string; issuer?: string; subject?: string; revoked?: boolean } = {},
): Promise<string> {
    const id = (await client.query<{ id: string }>(
        `INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [userId, universityId, overrides.provider ?? 'google', overrides.issuer ?? GOOGLE_ISSUER, overrides.subject ?? `flow-sub-${uniqueLabel()}`],
    )).rows[0]!.id;
    if (overrides.revoked) {
        await client.query('UPDATE student_auth_identities SET revoked_at = clock_timestamp() WHERE id = $1', [id]);
    }
    return id;
}

type FakeOidc = {
    oidc: { forPolicy(policy: ApprovedLoginPolicy): StudentOidcAdapter };
    authorizeInputs: { policy: ApprovedLoginPolicy; state: string; nonce: string; verifier: string; loginHint: string }[];
    redeemCount: number;
    redeemWith: (observation: ProviderObservation) => void;
    redeemWithPromise: (promise: Promise<ProviderObservation>) => void;
    redeemFailsWith: (error: Error) => void;
};

function makeOidc(): FakeOidc {
    const authorizeInputs: FakeOidc['authorizeInputs'] = [];
    let redeemCount = 0;
    let behavior: () => ProviderObservation | Promise<ProviderObservation> = () => { throw new StudentOidcOperationalError('upstream_unavailable'); };
    return {
        authorizeInputs,
        get redeemCount() { return redeemCount; },
        set redeemCount(_value: number) { redeemCount = _value; },
        redeemWith: (observation: ProviderObservation) => { behavior = () => observation; },
        redeemWithPromise: (promise: Promise<ProviderObservation>) => { behavior = () => promise; },
        redeemFailsWith: (error: Error) => { behavior = () => { throw error; }; },
        oidc: {
            forPolicy: (policy: ApprovedLoginPolicy) => ({
                authorize: async (input: { state: string; nonce: string; verifier: string; loginHint: string }) => {
                    authorizeInputs.push({ policy, ...input });
                    return new URL(`https://provider.example.invalid/authorize?state=${input.state}`);
                },
                redeem: async () => {
                    redeemCount += 1;
                    return behavior();
                },
            }),
        },
    };
}

function makeService(
    pool: Pool,
    oidc: FakeOidc['oidc'],
    overrides: {
        attemptKey?: string;
        isEnabled?: () => boolean;
        isProviderEnabled?: (provider: 'google' | 'microsoft') => boolean;
        readAssurance?: (userId: string) => Promise<StudentAssurance | null>;
    } = {},
): { service: StudentSsoFlowService; attemptKey: string } {
    const attemptKey = overrides.attemptKey ?? randomBytes(32).toString('base64url');
    const service = new StudentSsoFlowService({
        pool,
        oidc,
        attemptKey,
        callbackUrls: { google: GOOGLE_CALLBACK, microsoft: MICROSOFT_CALLBACK },
        completionUrl: COMPLETION_URL,
        isEnabled: overrides.isEnabled ?? (() => true),
        isProviderEnabled: overrides.isProviderEnabled ?? (() => true),
        ...(overrides.readAssurance ? { readAssurance: overrides.readAssurance } : {}),
    });
    return { service, attemptKey };
}

async function approvedGoogleFixture(pool: Pool): Promise<{ universityId: string; domain: string; policyId: string; realm: string }> {
    const client = await pool.connect();
    try {
        const universityId = await createUniversity(client);
        const domain = `flow${uniqueLabel()}.school.example`;
        const policy = await createLoginPolicy(client, universityId, { provider: 'google', realm: domain });
        await createLoginDomain(client, domain, universityId, 'google', policy.id);
        return { universityId, domain, policyId: policy.id, realm: domain };
    } finally {
        client.release();
    }
}

function observationFor(realm: string, subject: string): ProviderObservation {
    return {
        provider: 'google',
        issuer: GOOGLE_ISSUER,
        subject,
        email: `student@${realm}`,
        mailboxVerified: true,
        realm,
        schoolMembershipAttested: true,
        objectId: null,
    };
}

async function startGoogle(service: StudentSsoFlowService, oidc: FakeOidc, email: string, rememberMe = false) {
    const started = await service.start({ provider: 'google', email, rememberMe });
    const captured = oidc.authorizeInputs[oidc.authorizeInputs.length - 1]!;
    const callbackUrl = new URL(GOOGLE_CALLBACK.href);
    callbackUrl.searchParams.set('code', 'opaque-code');
    callbackUrl.searchParams.set('state', captured.state);
    const cookies = [{ name: studentSsoCookieName(started.publicResult.attemptId), value: started.callbackCookie.value }];
    return { started, captured, callbackUrl, cookies };
}

test('start rechecks the provider kill switch after authorize resolves', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        let googleLive = true;
        const base = makeOidc();
        const oidc = {
            forPolicy: (policy: ApprovedLoginPolicy) => {
                const adapter = base.oidc.forPolicy(policy);
                return {
                    authorize: async (input: { state: string; nonce: string; verifier: string; loginHint: string }) => {
                        // The provider is disabled while authorize() is in flight.
                        googleLive = false;
                        return adapter.authorize(input);
                    },
                    redeem: adapter.redeem,
                };
            },
        };
        const { service } = makeService(pool, oidc, {
            isEnabled: () => true,
            isProviderEnabled: (provider) => (provider === 'google' ? googleLive : true),
        });
        const email = `late-${uniqueLabel()}@${fixture.domain}`;
        await assert.rejects(service.start({ provider: 'google', email }), /no longer valid/);
        const check = await pool.connect();
        try {
            const rows = await check.query(
                `SELECT count(*)::int AS count FROM student_auth_attempts
                 WHERE requested_email = $1 AND status IN ('pending', 'processing', 'ready')`,
                [email],
            );
            assert.equal(rows.rows[0]!.count, 0);
        } finally {
            check.release();
        }
    });
});

test('linked owner signs in with one atomic session and separated assurance', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const email = `owner-${uniqueLabel()}@${fixture.domain}`;
        const setup = await pool.connect();
        let userId: string;
        let identityId: string;
        const subject = `owner-sub-${uniqueLabel()}`;
        try {
            userId = await createStudent(setup, fixture.universityId, email);
            identityId = await createIdentity(setup, userId, fixture.universityId, { subject });
        } finally {
            setup.release();
        }
        const oidc = makeOidc();
        oidc.redeemWith(observationFor(fixture.realm, subject));
        const { service } = makeService(pool, oidc.oidc);

        const { started, captured, callbackUrl, cookies } = await startGoogle(service, oidc, email);
        assert.equal(started.publicResult.attemptId.length, 36);
        assert.ok(captured.verifier.length >= 43);
        assert.equal(captured.loginHint, email);
        assert.equal(started.callbackCookie.name, studentSsoCookieName(started.publicResult.attemptId));

        const callback = await service.callback({ provider: 'google', callbackUrl, browserCookies: cookies });
        assert.equal(callback.attemptId, started.publicResult.attemptId);
        assert.equal(callback.outcome, undefined);
        assert.equal(callback.completionUrl.href, `${COMPLETION_URL.href}?attempt=${callback.attemptId}`);

        const finished = await service.finish({
            attemptId: started.publicResult.attemptId,
            finishSecret: started.publicResult.finishSecret,
            browserCookie: started.callbackCookie.value,
        });
        assert.equal(finished.outcome, 'authenticated');
        if (finished.outcome !== 'authenticated') throw new Error('unreachable');
        assert.equal(finished.user.id, userId);
        assert.equal(finished.user.email, email);
        assert.equal(finished.user.role, 'student');
        const decoded = jwtService.verifyRefreshToken(finished.tokens.refreshToken);
        assert.equal(decoded.userId, userId);
        // Login succeeds with separated assurance: school and enrollment stay
        // independent, and nothing here claims enrollment verified.
        assert.equal(finished.assuranceStatus, 'available');
        assert.ok(finished.studentAssurance);
        assert.equal(finished.studentAssurance.studentStatus, 'pending');
        assert.equal(finished.studentAssurance.schoolAccountStatus, 'unverified');

        const check = await pool.connect();
        try {
            const users = await check.query<{ refresh_token_hash: string; active_session_id: string; active_session_auth_identity_id: string }>(
                'SELECT refresh_token_hash, active_session_id, active_session_auth_identity_id FROM users WHERE id = $1',
                [userId],
            );
            assert.equal(users.rows[0]!.refresh_token_hash, refreshHash(finished.tokens.refreshToken));
            assert.ok(users.rows[0]!.active_session_id);
            assert.equal(users.rows[0]!.active_session_auth_identity_id, identityId);
            const attempts = await check.query(
                'SELECT status, encrypted_verifier, nonce, encrypted_observation FROM student_auth_attempts WHERE id = $1',
                [started.publicResult.attemptId],
            );
            assert.deepEqual(attempts.rows[0], { status: 'consumed', encrypted_verifier: null, nonce: null, encrypted_observation: null });
        } finally {
            check.release();
        }
    });
});

test('linked sign-in surfaces the recovery re-enrollment marker', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const email = `marker-${uniqueLabel()}@${fixture.domain}`;
        const subject = `marker-sub-${uniqueLabel()}`;
        const setup = await pool.connect();
        try {
            const userId = await createStudent(setup, fixture.universityId, email);
            await createIdentity(setup, userId, fixture.universityId, { subject });
            // lost_access recovery consumed the only active code: the
            // persistent marker stays set until a replacement activates.
            await setup.query('UPDATE users SET recovery_reenrollment_requires_password = true WHERE id = $1', [userId]);
        } finally {
            setup.release();
        }
        const oidc = makeOidc();
        oidc.redeemWith(observationFor(fixture.realm, subject));
        const { service } = makeService(pool, oidc.oidc);
        const { started, callbackUrl, cookies } = await startGoogle(service, oidc, email);
        await service.callback({ provider: 'google', callbackUrl, browserCookies: cookies });
        const finished = await service.finish({
            attemptId: started.publicResult.attemptId,
            finishSecret: started.publicResult.finishSecret,
            browserCookie: started.callbackCookie.value,
        });
        assert.equal(finished.outcome, 'authenticated');
        if (finished.outcome !== 'authenticated') throw new Error('unreachable');
        // Mirroring password login and /auth/me: clients committing the
        // SSO response directly must still show the replacement-code
        // warning instead of offering provider-backed enrollment.
        assert.equal(finished.user.recoveryReenrollmentRequired, true);
    });
});

test('finish yields to a session issued after the attempt started', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const email = `owner-${uniqueLabel()}@${fixture.domain}`;
        const setup = await pool.connect();
        let userId: string;
        const subject = `owner-sub-${uniqueLabel()}`;
        try {
            userId = await createStudent(setup, fixture.universityId, email);
            await createIdentity(setup, userId, fixture.universityId, { subject });
        } finally {
            setup.release();
        }
        const oidc = makeOidc();
        oidc.redeemWith(observationFor(fixture.realm, subject));
        const { service } = makeService(pool, oidc.oidc);

        const { started, callbackUrl, cookies } = await startGoogle(service, oidc, email);
        const callback = await service.callback({ provider: 'google', callbackUrl, browserCookies: cookies });
        assert.equal(callback.outcome, undefined);

        // Another tab signs this account in after the attempt started.
        const issuer = await pool.connect();
        let concurrentSid: string;
        let concurrentHash: string;
        try {
            await issuer.query('BEGIN');
            const concurrent = await issueSessionInTransaction(issuer, { userId, email, role: 'student' });
            await issuer.query('COMMIT');
            concurrentSid = jwtService.verifyRefreshToken(concurrent.refreshToken).sid as string;
            concurrentHash = refreshHash(concurrent.refreshToken);
        } finally {
            issuer.release();
        }

        const finished = await service.finish({
            attemptId: started.publicResult.attemptId,
            finishSecret: started.publicResult.finishSecret,
            browserCookie: started.callbackCookie.value,
        });
        assert.equal(finished.outcome, 'restart_required');

        // The concurrent session survives untouched; the attempt is spent.
        const check = await pool.connect();
        try {
            const users = await check.query<{ refresh_token_hash: string; active_session_id: string }>(
                'SELECT refresh_token_hash, active_session_id FROM users WHERE id = $1',
                [userId],
            );
            assert.equal(users.rows[0]!.active_session_id, concurrentSid);
            assert.equal(users.rows[0]!.refresh_token_hash, concurrentHash);
            const attempts = await check.query(
                'SELECT status, encrypted_observation FROM student_auth_attempts WHERE id = $1',
                [started.publicResult.attemptId],
            );
            assert.deepEqual(attempts.rows[0], { status: 'failed', encrypted_observation: null });
        } finally {
            check.release();
        }
    });
});

test('a provider finish racing compromise recovery cannot leave a surviving SSO session', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const email = `recovery-race-${uniqueLabel()}@${fixture.domain}`;
        const setup = await pool.connect();
        const recoveryCode = `saved-${uniqueLabel()}`;
        let userId: string;
        const subject = `recovery-race-sub-${uniqueLabel()}`;
        try {
            userId = await createStudent(setup, fixture.universityId, email);
            await createIdentity(setup, userId, fixture.universityId, { subject });
            await setup.query('UPDATE users SET password_setup_requires_recovery_code = true WHERE id = $1', [userId]);
            await setup.query(
                `INSERT INTO student_auth_recovery_codes (user_id, generation, code_digest, status, activated_at)
                 VALUES ($1, 1, $2, 'active', clock_timestamp())`,
                [userId, createHmac('sha256', 'test-recovery-code-key').update(recoveryCode, 'utf8').digest('base64url')],
            );
        } finally {
            setup.release();
        }
        const oidc = makeOidc();
        oidc.redeemWith(observationFor(fixture.realm, subject));
        const { service } = makeService(pool, oidc.oidc);
        const { started, callbackUrl, cookies } = await startGoogle(service, oidc, email);
        await service.callback({ provider: 'google', callbackUrl, browserCookies: cookies });
        let otp = '';
        const recovery = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key', deliverOtp: async (_email, delivered) => { otp = delivered; return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'compromise-race-password-hash',
        });
        const startedRecovery = await recovery.start({ email, purpose: 'compromise' });
        await recovery.verify({ attemptId: startedRecovery.attemptId, secret: startedRecovery.secret, code: recoveryCode, otp });
        await Promise.allSettled([
            service.finish({ attemptId: started.publicResult.attemptId, finishSecret: started.publicResult.finishSecret, browserCookie: started.callbackCookie.value }),
            recovery.complete({ attemptId: startedRecovery.attemptId, secret: startedRecovery.secret, password: 'ValidNew1!' }),
        ]);
        const check = await pool.connect();
        try {
            const user = await check.query<{ active_session_id: string | null }>('SELECT active_session_id FROM users WHERE id = $1', [userId]);
            const identity = await check.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM student_auth_identities WHERE user_id = $1', [userId]);
            assert.equal(user.rows[0]!.active_session_id, null);
            assert.notEqual(identity.rows[0]!.revoked_at, null);
        } finally {
            check.release();
        }
    });
});

test('a provider finish racing lost-access recovery cannot issue a post-recovery session', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const email = `lost-race-${uniqueLabel()}@${fixture.domain}`;
        const setup = await pool.connect();
        const recoveryCode = `saved-${uniqueLabel()}`;
        let userId: string;
        const subject = `lost-race-sub-${uniqueLabel()}`;
        try {
            userId = await createStudent(setup, fixture.universityId, email);
            await createIdentity(setup, userId, fixture.universityId, { subject });
            await setup.query('UPDATE users SET password_setup_requires_recovery_code = true WHERE id = $1', [userId]);
            await setup.query(`INSERT INTO student_auth_recovery_codes (user_id, generation, code_digest, status, activated_at) VALUES ($1, 1, $2, 'active', clock_timestamp())`, [userId, createHmac('sha256', 'test-recovery-code-key').update(recoveryCode, 'utf8').digest('base64url')]);
        } finally { setup.release(); }
        const oidc = makeOidc(); oidc.redeemWith(observationFor(fixture.realm, subject));
        const { service } = makeService(pool, oidc.oidc);
        const { started, callbackUrl, cookies } = await startGoogle(service, oidc, email);
        await service.callback({ provider: 'google', callbackUrl, browserCookies: cookies });
        let otp = '';
        const recovery = new StudentAccountRecoveryService({ pool, recoveryCodeKey: 'test-recovery-code-key', deliverOtp: async (_email, delivered) => { otp = delivered; return { success: true }; }, validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'lost-race-password-hash' });
        const startedRecovery = await recovery.start({ email, purpose: 'lost_access' });
        await recovery.verify({ attemptId: startedRecovery.attemptId, secret: startedRecovery.secret, code: recoveryCode, otp });
        await Promise.allSettled([
            service.finish({ attemptId: started.publicResult.attemptId, finishSecret: started.publicResult.finishSecret, browserCookie: started.callbackCookie.value }),
            recovery.complete({ attemptId: startedRecovery.attemptId, secret: startedRecovery.secret, password: 'ValidNew1!' }),
        ]);
        const check = await pool.connect();
        try {
            const user = await check.query<{ active_session_id: string | null }>('SELECT active_session_id FROM users WHERE id = $1', [userId]);
            assert.equal(user.rows[0]!.active_session_id, null);
        } finally { check.release(); }
    });
});

test('lost-access recovery fences a ready SSO attempt even when the login used an alias mailbox', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const canonicalEmail = `canonical-${uniqueLabel()}@${fixture.domain}`;
        const aliasEmail = `alias-${uniqueLabel()}@${fixture.domain}`;
        const setup = await pool.connect();
        let userId: string;
        const subject = `alias-recovery-sub-${uniqueLabel()}`;
        try {
            userId = await createStudent(setup, fixture.universityId, canonicalEmail);
            await createIdentity(setup, userId, fixture.universityId, { subject });
            await setup.query('BEGIN');
            await issueSessionInTransaction(setup, { userId, email: canonicalEmail, role: 'student' });
            await setup.query('COMMIT');
        } finally { setup.release(); }
        const oidc = makeOidc();
        oidc.redeemWith(observationFor(fixture.realm, subject));
        const { service } = makeService(pool, oidc.oidc);
        const { started, callbackUrl, cookies } = await startGoogle(service, oidc, aliasEmail);
        await service.callback({ provider: 'google', callbackUrl, browserCookies: cookies });
        const fence = await pool.connect();
        try {
            await fence.query('UPDATE users SET student_sso_attempts_not_before = clock_timestamp() WHERE id = $1', [userId]);
        } finally { fence.release(); }
        const result = await service.finish({ attemptId: started.publicResult.attemptId, finishSecret: started.publicResult.finishSecret, browserCookie: started.callbackCookie.value });
        assert.equal(result.outcome, 'restart_required');
        const check = await pool.connect();
        try {
            const user = await check.query<{ active_session_id: string | null }>('SELECT active_session_id FROM users WHERE id = $1', [userId]);
            assert.ok(user.rows[0]!.active_session_id, 'the migration/recovery fence must not revoke an already-issued session');
        } finally { check.release(); }
    });
});

test('account recovery fences an SSO callback that becomes ready after recovery commits', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const canonicalEmail = `callback-after-recovery-${uniqueLabel()}@${fixture.domain}`;
        const aliasEmail = `callback-after-recovery-alias-${uniqueLabel()}@${fixture.domain}`;
        const setup = await pool.connect();
        let userId: string;
        const subject = `callback-after-recovery-sub-${uniqueLabel()}`;
        try {
            userId = await createStudent(setup, fixture.universityId, canonicalEmail);
            await createIdentity(setup, userId, fixture.universityId, { subject });
        } finally { setup.release(); }
        let providerEntered!: () => void;
        let releaseProvider!: (observation: ProviderObservation) => void;
        const providerStarted = new Promise<void>((resolve) => { providerEntered = resolve; });
        const providerResult = new Promise<ProviderObservation>((resolve) => { releaseProvider = resolve; });
        const oidc = makeOidc();
        oidc.redeemWithPromise((async () => { providerEntered(); return providerResult; })());
        const { service } = makeService(pool, oidc.oidc);
        const { started, callbackUrl, cookies } = await startGoogle(service, oidc, aliasEmail);
        const callback = service.callback({ provider: 'google', callbackUrl, browserCookies: cookies });
        await providerStarted;
        const fence = await pool.connect();
        try {
            await fence.query('UPDATE users SET student_sso_attempts_not_before = clock_timestamp() WHERE id = $1', [userId]);
        } finally { fence.release(); }
        releaseProvider(observationFor(fixture.realm, subject));
        await callback;
        const result = await service.finish({ attemptId: started.publicResult.attemptId, finishSecret: started.publicResult.finishSecret, browserCookie: started.callbackCookie.value });
        assert.equal(result.outcome, 'restart_required');
        const check = await pool.connect();
        try {
            const user = await check.query<{ active_session_id: string | null }>('SELECT active_session_id FROM users WHERE id = $1', [userId]);
            assert.equal(user.rows[0]!.active_session_id, null);
        } finally { check.release(); }
    });
});

test('finish still replaces a session that predates the attempt', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const email = `owner-${uniqueLabel()}@${fixture.domain}`;
        const setup = await pool.connect();
        let userId: string;
        const subject = `owner-sub-${uniqueLabel()}`;
        try {
            userId = await createStudent(setup, fixture.universityId, email);
            await createIdentity(setup, userId, fixture.universityId, { subject });
        } finally {
            setup.release();
        }
        // A stale pre-existing session is replaced, not preserved.
        const stale = await pool.connect();
        try {
            await stale.query('BEGIN');
            await issueSessionInTransaction(stale, { userId, email, role: 'student' });
            await stale.query('COMMIT');
        } finally {
            stale.release();
        }
        const oidc = makeOidc();
        oidc.redeemWith(observationFor(fixture.realm, subject));
        const { service } = makeService(pool, oidc.oidc);

        const { started, callbackUrl, cookies } = await startGoogle(service, oidc, email);
        await service.callback({ provider: 'google', callbackUrl, browserCookies: cookies });
        const finished = await service.finish({
            attemptId: started.publicResult.attemptId,
            finishSecret: started.publicResult.finishSecret,
            browserCookie: started.callbackCookie.value,
        });
        assert.equal(finished.outcome, 'authenticated');
    });
});

test('linked finish rejects an identity bound to another university', async () => {
    await withSsoPool(async (pool) => {
        // Google shares one issuer across universities, so the account
        // chooser can return an identity linked under university A while
        // the attempt runs under university B's live policy. The finish
        // must not let B's policy authenticate A's identity.
        const fixtureA = await approvedGoogleFixture(pool);
        const fixtureB = await approvedGoogleFixture(pool);
        const email = `mover-${uniqueLabel()}@${fixtureB.domain}`;
        const subject = `moved-sub-${uniqueLabel()}`;
        const setup = await pool.connect();
        let userId: string;
        try {
            userId = await createStudent(setup, fixtureB.universityId, email);
            await createIdentity(setup, userId, fixtureA.universityId, { subject });
        } finally {
            setup.release();
        }
        const oidc = makeOidc();
        oidc.redeemWith(observationFor(fixtureB.realm, subject));
        const { service } = makeService(pool, oidc.oidc);
        const { started, callbackUrl, cookies } = await startGoogle(service, oidc, email);
        await service.callback({ provider: 'google', callbackUrl, browserCookies: cookies });
        await assert.rejects(service.finish({
            attemptId: started.publicResult.attemptId,
            finishSecret: started.publicResult.finishSecret,
            browserCookie: started.callbackCookie.value,
        }), /no longer valid/);
        const check = await pool.connect();
        try {
            const users = await check.query<{ active_session_id: string | null }>(
                'SELECT active_session_id FROM users WHERE id = $1', [userId],
            );
            assert.equal(users.rows[0]!.active_session_id, null);
        } finally {
            check.release();
        }
    });
});

test('callback from a different browser cannot redeem or replace the attempt', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const email = `browser-${uniqueLabel()}@${fixture.domain}`;
        const oidc = makeOidc();
        oidc.redeemWith(observationFor(fixture.realm, `browser-sub-${uniqueLabel()}`));
        const { service } = makeService(pool, oidc.oidc);
        const { started, callbackUrl, cookies } = await startGoogle(service, oidc, email);

        const wrongCookie = [{ name: cookies[0]!.name, value: 'attacker-secret' }];
        await assert.rejects(service.callback({ provider: 'google', callbackUrl, browserCookies: wrongCookie }), /no longer valid/);
        await assert.rejects(service.callback({ provider: 'google', callbackUrl, browserCookies: [] }), /no longer valid/);
        assert.equal(oidc.redeemCount, 0);

        const check = await pool.connect();
        try {
            const row = await check.query<{ status: string; encrypted_verifier: string | null }>(
                'SELECT status, encrypted_verifier FROM student_auth_attempts WHERE id = $1',
                [started.publicResult.attemptId],
            );
            assert.equal(row.rows[0]!.status, 'pending');
            assert.ok(row.rows[0]!.encrypted_verifier);
        } finally {
            check.release();
        }

        // The legitimate browser still completes after the failed attempts.
        const callback = await service.callback({ provider: 'google', callbackUrl, browserCookies: cookies });
        assert.equal(callback.outcome, undefined);
        assert.equal(oidc.redeemCount, 1);
    });
});

test('two concurrent callbacks redeem exactly once', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const email = `race-${uniqueLabel()}@${fixture.domain}`;
        const oidc = makeOidc();
        oidc.redeemWith(observationFor(fixture.realm, `race-sub-${uniqueLabel()}`));
        const { service } = makeService(pool, oidc.oidc);
        const { callbackUrl, cookies } = await startGoogle(service, oidc, email);

        const outcomes = await Promise.allSettled([
            service.callback({ provider: 'google', callbackUrl, browserCookies: cookies }),
            service.callback({ provider: 'google', callbackUrl, browserCookies: cookies }),
        ]);
        const fulfilled = outcomes.filter((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof service.callback>>> => outcome.status === 'fulfilled');
        const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
        assert.equal(fulfilled.length, 1);
        assert.equal(rejected.length, 1);
        assert.match(String((rejected[0] as PromiseRejectedResult).reason), /no longer valid/);
        assert.equal(oidc.redeemCount, 1);
        assert.equal(fulfilled[0]!.value.outcome, undefined);
    });
});

test('duplicate callbacks report in-flight state while the winner finishes', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const email = `duplicate-${uniqueLabel()}@${fixture.domain}`;
        const subject = `duplicate-sub-${uniqueLabel()}`;
        const setup = await pool.connect();
        try {
            const userId = await createStudent(setup, fixture.universityId, email);
            await createIdentity(setup, userId, fixture.universityId, { subject });
        } finally {
            setup.release();
        }
        const oidc = makeOidc();
        oidc.redeemWith(observationFor(fixture.realm, subject));
        const { service } = makeService(pool, oidc.oidc);
        const { started, callbackUrl, cookies } = await startGoogle(service, oidc, email);

        const outcomes = await Promise.allSettled([
            service.callback({ provider: 'google', callbackUrl, browserCookies: cookies }),
            service.callback({ provider: 'google', callbackUrl, browserCookies: cookies }),
        ]);
        assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
        assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
        assert.equal(oidc.redeemCount, 1);

        // The loser does not consume or fail the attempt: the same state
        // still resolves, still reports in flight, and the winner's
        // browser binding still proves at finish.
        const duplicate = await service.callbackDuplicateState(callbackUrl, 'google');
        assert.deepEqual(duplicate, { attemptId: started.publicResult.attemptId, inFlight: true });
        assert.equal(
            await service.callbackCookieNameForState(callbackUrl, 'google'),
            studentSsoCookieName(started.publicResult.attemptId),
        );
        const finished = await service.finish({
            attemptId: started.publicResult.attemptId,
            finishSecret: started.publicResult.finishSecret,
            browserCookie: started.callbackCookie.value,
        });
        assert.equal(finished.outcome, 'authenticated');
    });
});

test('login finish stays retryable while redemption is processing', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const email = `redeeming-${uniqueLabel()}@${fixture.domain}`;
        const oidc = makeOidc();
        const { service } = makeService(pool, oidc.oidc);
        const { started, captured, callbackUrl } = await startGoogle(service, oidc, email);
        const client = await pool.connect();
        try {
            await client.query(`UPDATE student_auth_attempts SET status = 'processing' WHERE id = $1`, [started.publicResult.attemptId]);
        } finally {
            client.release();
        }

        const duplicate = await service.callbackDuplicateState(callbackUrl, 'google');
        assert.deepEqual(duplicate, { attemptId: started.publicResult.attemptId, inFlight: true });
        const microsoftUrl = new URL(MICROSOFT_CALLBACK.href);
        microsoftUrl.searchParams.set('code', 'opaque-code');
        microsoftUrl.searchParams.set('state', captured.state);
        assert.equal(await service.callbackDuplicateState(microsoftUrl, 'microsoft'), null);
        const unknownUrl = new URL(callbackUrl.href);
        unknownUrl.searchParams.set('state', randomUUID());
        assert.equal(await service.callbackDuplicateState(unknownUrl, 'google'), null);

        // The bound owner learns the attempt is still redeeming and waits
        // instead of failing; anyone without the browser binding gets the
        // uniform terminal shape with no state signal.
        await assert.rejects(
            () => service.finish({
                attemptId: started.publicResult.attemptId,
                finishSecret: started.publicResult.finishSecret,
                browserCookie: started.callbackCookie.value,
            }),
            (error: unknown) => {
                assert.ok(error instanceof Error && /still completing/.test(error.message));
                assert.deepEqual((error as { details?: unknown }).details, { retryable: true });
                return true;
            },
        );
        await assert.rejects(
            () => service.finish({
                attemptId: started.publicResult.attemptId,
                finishSecret: started.publicResult.finishSecret,
                browserCookie: 'wrong-cookie',
            }),
            (error: unknown) => {
                assert.ok(error instanceof Error && /no longer valid/.test(error.message));
                assert.equal((error as { details?: unknown }).details, undefined);
                return true;
            },
        );
    });
});

test('two concurrent finishes issue one session', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const email = `finish-${uniqueLabel()}@${fixture.domain}`;
        const subject = `finish-sub-${uniqueLabel()}`;
        const setup = await pool.connect();
        let userId: string;
        try {
            userId = await createStudent(setup, fixture.universityId, email);
            await createIdentity(setup, userId, fixture.universityId, { subject });
        } finally {
            setup.release();
        }
        const oidc = makeOidc();
        oidc.redeemWith(observationFor(fixture.realm, subject));
        const { service } = makeService(pool, oidc.oidc);
        const { started, callbackUrl, cookies } = await startGoogle(service, oidc, email);
        await service.callback({ provider: 'google', callbackUrl, browserCookies: cookies });

        const input = {
            attemptId: started.publicResult.attemptId,
            finishSecret: started.publicResult.finishSecret,
            browserCookie: started.callbackCookie.value,
        };
        const outcomes = await Promise.allSettled([service.finish(input), service.finish(input)]);
        const results = outcomes
            .filter((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof service.finish>>> => outcome.status === 'fulfilled')
            .map((outcome) => outcome.value);
        const authenticated = results.filter((result) => result.outcome === 'authenticated');
        assert.equal(authenticated.length, 1);
        // The loser either restarts (its pre-read won the race and the
        // locked re-read found the consumed row) or is rejected outright
        // (its pre-read landed after the winner scrubbed the binding
        // digests). Either way exactly one session is issued.
        for (const outcome of outcomes) {
            if (outcome.status === 'rejected') {
                assert.match(String((outcome as PromiseRejectedResult).reason), /no longer valid/);
            } else {
                const result = (outcome as PromiseFulfilledResult<Awaited<ReturnType<typeof service.finish>>>).value;
                assert.ok(result.outcome === 'authenticated' || result.outcome === 'restart_required');
            }
        }

        const winner = authenticated[0]!;
        if (winner.outcome !== 'authenticated') throw new Error('unreachable');
        const check = await pool.connect();
        try {
            const users = await check.query<{ refresh_token_hash: string }>('SELECT refresh_token_hash FROM users WHERE id = $1', [userId]);
            assert.equal(users.rows[0]!.refresh_token_hash, refreshHash(winner.tokens.refreshToken));
        } finally {
            check.release();
        }
    });
});

test('provider denial cannot skip state and browser checks', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const email = `denial-${uniqueLabel()}@${fixture.domain}`;
        const oidc = makeOidc();
        oidc.redeemFailsWith(new StudentOidcOperationalError('cancelled_or_permission'));
        const { service } = makeService(pool, oidc.oidc);
        const { started, callbackUrl, cookies } = await startGoogle(service, oidc, email);

        await assert.rejects(
            service.callback({ provider: 'google', callbackUrl, browserCookies: [{ name: cookies[0]!.name, value: 'wrong' }] }),
            /no longer valid/,
        );
        assert.equal(oidc.redeemCount, 0);

        const denied = await service.callback({ provider: 'google', callbackUrl, browserCookies: cookies });
        assert.equal(denied.outcome, 'connection_not_completed');
        assert.ok(denied.completionUrl.href.includes('outcome=connection_not_completed'));
        assert.equal(oidc.redeemCount, 1);

        const check = await pool.connect();
        try {
            const row = await check.query(
                'SELECT status, state_hash, callback_cookie_hash, finish_secret_hash, encrypted_verifier, nonce, encrypted_observation FROM student_auth_attempts WHERE id = $1',
                [started.publicResult.attemptId],
            );
            // Tombstone: single-use secrets are nulled but the finish
            // bindings survive so an authenticated retry can restart.
            assert.equal(row.rows[0]!.status, 'failed');
            assert.equal(row.rows[0]!.state_hash, null);
            assert.ok(row.rows[0]!.callback_cookie_hash);
            assert.ok(row.rows[0]!.finish_secret_hash);
            assert.equal(row.rows[0]!.encrypted_verifier, null);
            assert.equal(row.rows[0]!.nonce, null);
            assert.equal(row.rows[0]!.encrypted_observation, null);
        } finally {
            check.release();
        }

        // The failed attempt kept its finish tombstone: a finish replay
        // proves the secrets and restarts instead of failing generic.
        const replay = await service.finish({
            attemptId: started.publicResult.attemptId,
            finishSecret: started.publicResult.finishSecret,
            browserCookie: started.callbackCookie.value,
        });
        assert.equal(replay.outcome, 'restart_required');
    });
});

test('unlinked identity receives a handoff and retains the browser binding', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const email = `unlinked-${uniqueLabel()}@${fixture.domain}`;
        const oidc = makeOidc();
        const subject = `unlinked-sub-${uniqueLabel()}`;
        oidc.redeemWith(observationFor(fixture.realm, subject));
        const { service, attemptKey } = makeService(pool, oidc.oidc);
        const { started, callbackUrl, cookies } = await startGoogle(service, oidc, email);
        await service.callback({ provider: 'google', callbackUrl, browserCookies: cookies });

        const finished = await service.finish({
            attemptId: started.publicResult.attemptId,
            finishSecret: started.publicResult.finishSecret,
            browserCookie: started.callbackCookie.value,
        });
        assert.equal(finished.outcome, 'link_required');
        if (finished.outcome !== 'link_required') throw new Error('unreachable');
        assert.equal(finished.provider, 'google');
        assert.equal(finished.handoffId.length, 36);
        assert.ok(finished.handoffSecret.length > 0);

        const check = await pool.connect();
        try {
            const handoffs = await check.query<{
                encrypted_observation: string; policy_id: string; policy_version: number; browser_binding_hash: string; expires_at: Date;
            }>(
                'SELECT encrypted_observation, policy_id, policy_version, browser_binding_hash, expires_at FROM student_auth_link_handoffs WHERE id = $1',
                [finished.handoffId],
            );
            const handoff = handoffs.rows[0]!;
            assert.equal(handoff.policy_id, fixture.policyId);
            assert.equal(handoff.policy_version, 1);
            assert.ok(handoff.expires_at.getTime() > Date.now());
            const attempts = await check.query<{ state_hash: string | null; callback_cookie_hash: string | null; finish_secret_hash: string | null; status: string; encrypted_observation: string | null }>(
                'SELECT state_hash, callback_cookie_hash, finish_secret_hash, status, encrypted_observation FROM student_auth_attempts WHERE id = $1',
                [started.publicResult.attemptId],
            );
            assert.equal(attempts.rows[0]!.status, 'consumed');
            assert.equal(attempts.rows[0]!.encrypted_observation, null);
            // The handoff inherits a copy of the browser binding; the
            // consumed attempt keeps its finish tombstone so an
            // authenticated retry restarts instead of failing generic.
            assert.equal(handoff.browser_binding_hash, hashMicrosoftAttemptSecret(started.callbackCookie.value));
            assert.equal(attempts.rows[0]!.state_hash, null);
            assert.ok(attempts.rows[0]!.callback_cookie_hash);
            assert.ok(attempts.rows[0]!.finish_secret_hash);
            const decrypted = JSON.parse(decryptMicrosoftAttemptVerifier(handoff.encrypted_observation, attemptKey, finished.handoffId));
            assert.equal(decrypted.subject, subject);
            assert.equal(decrypted.provider, 'google');
        } finally {
            check.release();
        }

        // A retry after a lost link_required response proves the
        // tombstone bindings and restarts instead of failing generic.
        const retry = await service.finish({
            attemptId: started.publicResult.attemptId,
            finishSecret: started.publicResult.finishSecret,
            browserCookie: started.callbackCookie.value,
        });
        assert.equal(retry.outcome, 'restart_required');
    });
});

test('finish refuses a provider disabled after the attempt went ready', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const email = `killed-${uniqueLabel()}@${fixture.domain}`;
        const oidc = makeOidc();
        oidc.redeemWith(observationFor(fixture.realm, `killed-sub-${uniqueLabel()}`));
        // One service drives start/callback while enabled; a second shares
        // the pool and attempt key but sees the provider as disabled, as
        // after a mid-flight kill-switch flip and restart.
        const attemptKey = randomBytes(32).toString('base64url');
        const live = makeService(pool, oidc.oidc, { attemptKey }).service;
        const killed = makeService(pool, oidc.oidc, { attemptKey, isProviderEnabled: () => false }).service;
        const { started, callbackUrl, cookies } = await startGoogle(live, oidc, email);
        await live.callback({ provider: 'google', callbackUrl, browserCookies: cookies });
        await assert.rejects(
            killed.finish({
                attemptId: started.publicResult.attemptId,
                finishSecret: started.publicResult.finishSecret,
                browserCookie: started.callbackCookie.value,
            }),
            /no longer valid/,
        );
    });
});

test('duplicate finish after commit restarts without a new session', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const email = `replay-${uniqueLabel()}@${fixture.domain}`;
        const subject = `replay-sub-${uniqueLabel()}`;
        const setup = await pool.connect();
        let userId: string;
        try {
            userId = await createStudent(setup, fixture.universityId, email);
            await createIdentity(setup, userId, fixture.universityId, { subject });
        } finally {
            setup.release();
        }
        const oidc = makeOidc();
        oidc.redeemWith(observationFor(fixture.realm, subject));
        const { service } = makeService(pool, oidc.oidc);
        const { started, callbackUrl, cookies } = await startGoogle(service, oidc, email);
        await service.callback({ provider: 'google', callbackUrl, browserCookies: cookies });
        const input = {
            attemptId: started.publicResult.attemptId,
            finishSecret: started.publicResult.finishSecret,
            browserCookie: started.callbackCookie.value,
        };
        const first = await service.finish(input);
        assert.equal(first.outcome, 'authenticated');

        const before = await pool.connect();
        let committedHash: string;
        try {
            committedHash = (await before.query<{ refresh_token_hash: string }>('SELECT refresh_token_hash FROM users WHERE id = $1', [userId])).rows[0]!.refresh_token_hash;
        } finally {
            before.release();
        }

        // A lost response replays the same proofs: the commit kept the
        // finish tombstone, so the replay proves the secrets, restarts,
        // and persists no second session.
        const replay = await service.finish(input);
        assert.equal(replay.outcome, 'restart_required');

        const after = await pool.connect();
        try {
            const users = await after.query<{ refresh_token_hash: string }>('SELECT refresh_token_hash FROM users WHERE id = $1', [userId]);
            assert.equal(users.rows[0]!.refresh_token_hash, committedHash);
        } finally {
            after.release();
        }
    });
});

test('logout then stale finish cannot commit a new session', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const email = `stale-${uniqueLabel()}@${fixture.domain}`;
        const subject = `stale-sub-${uniqueLabel()}`;
        const setup = await pool.connect();
        let userId: string;
        try {
            userId = await createStudent(setup, fixture.universityId, email);
            await createIdentity(setup, userId, fixture.universityId, { subject });
        } finally {
            setup.release();
        }
        const oidc = makeOidc();
        oidc.redeemWith(observationFor(fixture.realm, subject));
        const { service } = makeService(pool, oidc.oidc);
        const { started, callbackUrl, cookies } = await startGoogle(service, oidc, email);
        await service.callback({ provider: 'google', callbackUrl, browserCookies: cookies });
        const input = {
            attemptId: started.publicResult.attemptId,
            finishSecret: started.publicResult.finishSecret,
            browserCookie: started.callbackCookie.value,
        };
        const first = await service.finish(input);
        assert.equal(first.outcome, 'authenticated');
        if (first.outcome !== 'authenticated') throw new Error('unreachable');

        // The captured refresh credential revokes only itself, exactly like logout.
        const logout = await pool.connect();
        try {
            await logout.query(
                `UPDATE users SET refresh_token_hash = NULL, refresh_token_expires_at = NULL,
                    active_session_id = NULL, active_session_auth_identity_id = NULL
                 WHERE id = $1 AND refresh_token_hash = $2`,
                [userId, refreshHash(first.tokens.refreshToken)],
            );
        } finally {
            logout.release();
        }

        const stale = await service.finish(input);
        assert.equal(stale.outcome, 'restart_required');
        const check = await pool.connect();
        try {
            const users = await check.query<{ refresh_token_hash: string | null; active_session_id: string | null }>(
                'SELECT refresh_token_hash, active_session_id FROM users WHERE id = $1',
                [userId],
            );
            assert.equal(users.rows[0]!.refresh_token_hash, null);
            assert.equal(users.rows[0]!.active_session_id, null);
        } finally {
            check.release();
        }
    });
});

test('restart invalidates abandoned pending flows but spares ready siblings', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const email = `siblings-${uniqueLabel()}@${fixture.domain}`;
        const oidc = makeOidc();
        oidc.redeemWith(observationFor(fixture.realm, `sibling-sub-${uniqueLabel()}`));
        const { service } = makeService(pool, oidc.oidc);

        const consumed = await startGoogle(service, oidc, email);
        await service.callback({ provider: 'google', callbackUrl: consumed.callbackUrl, browserCookies: consumed.cookies });
        const consumedFinish = await service.finish({
            attemptId: consumed.started.publicResult.attemptId,
            finishSecret: consumed.started.publicResult.finishSecret,
            browserCookie: consumed.started.callbackCookie.value,
        });
        assert.equal(consumedFinish.outcome, 'link_required');

        const pending = await startGoogle(service, oidc, email);
        const abandoned = await startGoogle(service, oidc, email);
        const ready = await startGoogle(service, oidc, email);
        await service.callback({ provider: 'google', callbackUrl: ready.callbackUrl, browserCookies: ready.cookies });

        // One pending flow expires: its finish restarts and invalidates the
        // abandoned sibling while the ready sibling survives. (A replay on
        // the consumed attempt cannot drive this: terminalized digests no
        // longer prove, so replays are rejected outright.)
        const ager = await pool.connect();
        try {
            await ager.query(`UPDATE student_auth_attempts SET expires_at = clock_timestamp() - interval '1 minute' WHERE id = $1`, [
                pending.started.publicResult.attemptId,
            ]);
        } finally {
            ager.release();
        }
        const restart = await service.finish({
            attemptId: pending.started.publicResult.attemptId,
            finishSecret: pending.started.publicResult.finishSecret,
            browserCookie: pending.started.callbackCookie.value,
        });
        assert.equal(restart.outcome, 'restart_required');

        const check = await pool.connect();
        try {
            const rows = await check.query<{ id: string; status: string; encrypted_verifier: string | null }>(
                'SELECT id, status, encrypted_verifier FROM student_auth_attempts WHERE requested_email = $1',
                [email],
            );
            const byId = new Map(rows.rows.map((row) => [row.id, row]));
            assert.equal(byId.get(pending.started.publicResult.attemptId)!.status, 'failed');
            assert.equal(byId.get(pending.started.publicResult.attemptId)!.encrypted_verifier, null);
            assert.equal(byId.get(abandoned.started.publicResult.attemptId)!.status, 'failed');
            assert.equal(byId.get(abandoned.started.publicResult.attemptId)!.encrypted_verifier, null);
            assert.equal(byId.get(ready.started.publicResult.attemptId)!.status, 'ready');
        } finally {
            check.release();
        }

        const sibling = await service.finish({
            attemptId: ready.started.publicResult.attemptId,
            finishSecret: ready.started.publicResult.finishSecret,
            browserCookie: ready.started.callbackCookie.value,
        });
        assert.equal(sibling.outcome, 'link_required');
    });
});

test('policy disable or version change between start and callback fails the return', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const email = `policy-${uniqueLabel()}@${fixture.domain}`;
        const oidc = makeOidc();
        oidc.redeemWith(observationFor(fixture.realm, `policy-sub-${uniqueLabel()}`));
        const { service } = makeService(pool, oidc.oidc);
        const { callbackUrl, cookies } = await startGoogle(service, oidc, email);

        const admin = await pool.connect();
        try {
            await admin.query('UPDATE institution_login_policies SET enabled = false WHERE id = $1', [fixture.policyId]);
        } finally {
            admin.release();
        }
        const disabled = await service.callback({ provider: 'google', callbackUrl, browserCookies: cookies });
        assert.equal(disabled.outcome, 'connection_not_completed');

        const admin2 = await pool.connect();
        try {
            await admin2.query('UPDATE institution_login_policies SET enabled = true, version = version + 1 WHERE id = $1', [fixture.policyId]);
        } finally {
            admin2.release();
        }
        const { callbackUrl: staleUrl, cookies: staleCookies } = await startGoogle(service, oidc, email);
        const admin3 = await pool.connect();
        try {
            await admin3.query('UPDATE institution_login_policies SET version = version + 1 WHERE id = $1', [fixture.policyId]);
        } finally {
            admin3.release();
        }
        const stale = await service.callback({ provider: 'google', callbackUrl: staleUrl, browserCookies: staleCookies });
        assert.equal(stale.outcome, 'connection_not_completed');
    });
});

test('expired attempts restart on a tombstone the retention scrub clears', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const email = `expired-${uniqueLabel()}@${fixture.domain}`;
        const oidc = makeOidc();
        oidc.redeemWith(observationFor(fixture.realm, `expired-sub-${uniqueLabel()}`));
        const { service } = makeService(pool, oidc.oidc);
        const { started, callbackUrl, cookies } = await startGoogle(service, oidc, email);
        await service.callback({ provider: 'google', callbackUrl, browserCookies: cookies });

        const admin = await pool.connect();
        try {
            await admin.query('UPDATE student_auth_attempts SET expires_at = clock_timestamp() - interval \'1 minute\' WHERE id = $1', [
                started.publicResult.attemptId,
            ]);
        } finally {
            admin.release();
        }

        const finished = await service.finish({
            attemptId: started.publicResult.attemptId,
            finishSecret: started.publicResult.finishSecret,
            browserCookie: started.callbackCookie.value,
        });
        assert.equal(finished.outcome, 'restart_required');

        const check = await pool.connect();
        try {
            const row = await check.query(
                'SELECT status, callback_cookie_hash, finish_secret_hash, encrypted_verifier, nonce, encrypted_observation FROM student_auth_attempts WHERE id = $1',
                [started.publicResult.attemptId],
            );
            // Terminalization keeps the finish tombstone: a retry proves
            // the bindings and restarts instead of failing generic.
            assert.equal(row.rows[0]!.status, 'failed');
            assert.ok(row.rows[0]!.callback_cookie_hash);
            assert.ok(row.rows[0]!.finish_secret_hash);
            assert.equal(row.rows[0]!.encrypted_verifier, null);
            assert.equal(row.rows[0]!.nonce, null);
            assert.equal(row.rows[0]!.encrypted_observation, null);
        } finally {
            check.release();
        }

        const retry = await service.finish({
            attemptId: started.publicResult.attemptId,
            finishSecret: started.publicResult.finishSecret,
            browserCookie: started.callbackCookie.value,
        });
        assert.equal(retry.outcome, 'restart_required');

        // The retention scrub clears the tombstone once the attempt has
        // expired; a post-scrub retry can no longer prove the bindings.
        const worker = await pool.connect();
        try {
            await cleanupStudentSsoTransients(worker);
            const scrubbed = await worker.query(
                'SELECT callback_cookie_hash, finish_secret_hash FROM student_auth_attempts WHERE id = $1',
                [started.publicResult.attemptId],
            );
            assert.equal(scrubbed.rows[0]!.callback_cookie_hash, null);
            assert.equal(scrubbed.rows[0]!.finish_secret_hash, null);
        } finally {
            worker.release();
        }
        await assert.rejects(service.finish({
            attemptId: started.publicResult.attemptId,
            finishSecret: started.publicResult.finishSecret,
            browserCookie: started.callbackCookie.value,
        }), /no longer valid/);
    });
});

test('SSO cleanup scrubs terminal bindings in bounded repeatable batches', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const setup = await pool.connect();
        try {
            await setup.query(
                `INSERT INTO student_auth_attempts
                     (policy_id, policy_version, provider, requested_email, state_hash,
                      callback_cookie_hash, finish_secret_hash, status, expires_at)
                 SELECT $1, 1, 'google', 'cleanup-' || n || '@students.example.invalid',
                        'cleanup-state-' || n, 'cleanup-browser-' || n, 'cleanup-finish-' || n,
                        'consumed', clock_timestamp() - interval '2 hours'
                 FROM generate_series(1, 501) AS n`,
                [fixture.policyId],
            );
        } finally {
            setup.release();
        }

        const worker = await pool.connect();
        try {
            const first = await cleanupStudentSsoTransients(worker);
            assert.equal(first.terminalSecretsScrubbed, 500);
            const remaining = await worker.query<{ count: string }>(
                `SELECT count(*)::text AS count FROM student_auth_attempts
                 WHERE expires_at <= clock_timestamp() - interval '1 hour'
                   AND callback_cookie_hash IS NOT NULL`,
            );
            assert.equal(Number(remaining.rows[0]!.count), 1);

            const second = await cleanupStudentSsoTransients(worker);
            assert.equal(second.terminalSecretsScrubbed, 1);
            const cleared = await worker.query<{ count: string }>(
                `SELECT count(*)::text AS count FROM student_auth_attempts
                 WHERE expires_at <= clock_timestamp() - interval '1 hour'
                   AND callback_cookie_hash IS NOT NULL`,
            );
            assert.equal(Number(cleared.rows[0]!.count), 0);
        } finally {
            worker.release();
        }
    });
});

test('finish before callback is invalid and changes nothing', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const email = `early-${uniqueLabel()}@${fixture.domain}`;
        const oidc = makeOidc();
        oidc.redeemWith(observationFor(fixture.realm, `early-sub-${uniqueLabel()}`));
        const { service } = makeService(pool, oidc.oidc);
        const { started, callbackUrl, cookies } = await startGoogle(service, oidc, email);

        await assert.rejects(service.finish({
            attemptId: started.publicResult.attemptId,
            finishSecret: started.publicResult.finishSecret,
            browserCookie: started.callbackCookie.value,
        }), /no longer valid/);

        const check = await pool.connect();
        try {
            const row = await check.query<{ status: string; encrypted_verifier: string | null }>(
                'SELECT status, encrypted_verifier FROM student_auth_attempts WHERE id = $1',
                [started.publicResult.attemptId],
            );
            assert.equal(row.rows[0]!.status, 'pending');
            assert.ok(row.rows[0]!.encrypted_verifier);
        } finally {
            check.release();
        }

        const callback = await service.callback({ provider: 'google', callbackUrl, browserCookies: cookies });
        assert.equal(callback.outcome, undefined);
    });
});

test('inactive and deleted actors fail login without a session', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const oidc = makeOidc();
        const { service } = makeService(pool, oidc.oidc);

        for (const state of ['suspended', 'deleted'] as const) {
            const email = `${state}-${uniqueLabel()}@${fixture.domain}`;
            const subject = `${state}-sub-${uniqueLabel()}`;
            const setup = await pool.connect();
            let userId: string;
            try {
                userId = await createStudent(setup, fixture.universityId, email);
                await createIdentity(setup, userId, fixture.universityId, { subject });
                if (state === 'suspended') {
                    await setup.query('UPDATE students SET status = \'suspended\' WHERE user_id = $1', [userId]);
                } else {
                    await setup.query('UPDATE users SET deleted_at = clock_timestamp() WHERE id = $1', [userId]);
                }
            } finally {
                setup.release();
            }
            oidc.redeemWith(observationFor(fixture.realm, subject));
            const { started, callbackUrl, cookies } = await startGoogle(service, oidc, email);
            await service.callback({ provider: 'google', callbackUrl, browserCookies: cookies });
            await assert.rejects(service.finish({
                attemptId: started.publicResult.attemptId,
                finishSecret: started.publicResult.finishSecret,
                browserCookie: started.callbackCookie.value,
            }), /not available for this account/);

            const check = await pool.connect();
            try {
                const users = await check.query<{ refresh_token_hash: string | null }>('SELECT refresh_token_hash FROM users WHERE id = $1', [userId]);
                assert.equal(users.rows[0]!.refresh_token_hash, null);
            } finally {
                check.release();
            }
        }
    });
});

test('login succeeds with unavailable assurance when the status read fails', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const email = `assurance-${uniqueLabel()}@${fixture.domain}`;
        const subject = `assurance-sub-${uniqueLabel()}`;
        const setup = await pool.connect();
        let userId: string;
        try {
            userId = await createStudent(setup, fixture.universityId, email);
            await createIdentity(setup, userId, fixture.universityId, { subject });
        } finally {
            setup.release();
        }
        const oidc = makeOidc();
        oidc.redeemWith(observationFor(fixture.realm, subject));
        const { service } = makeService(pool, oidc.oidc, {
            readAssurance: async () => { throw new Error('status store unavailable'); },
        });
        const { started, callbackUrl, cookies } = await startGoogle(service, oidc, email);
        await service.callback({ provider: 'google', callbackUrl, browserCookies: cookies });

        const finished = await service.finish({
            attemptId: started.publicResult.attemptId,
            finishSecret: started.publicResult.finishSecret,
            browserCookie: started.callbackCookie.value,
        });
        assert.equal(finished.outcome, 'authenticated');
        if (finished.outcome !== 'authenticated') throw new Error('unreachable');
        assert.equal(finished.studentAssurance, null);
        assert.equal(finished.assuranceStatus, 'unavailable');
        assert.ok(finished.tokens.refreshToken);

        const check = await pool.connect();
        try {
            const users = await check.query<{ refresh_token_hash: string }>('SELECT refresh_token_hash FROM users WHERE id = $1', [userId]);
            assert.equal(users.rows[0]!.refresh_token_hash, refreshHash(finished.tokens.refreshToken));
        } finally {
            check.release();
        }
    });
});

test('login maps a null assurance read to unavailable, never available', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const email = `nullread-${uniqueLabel()}@${fixture.domain}`;
        const subject = `nullread-sub-${uniqueLabel()}`;
        const setup = await pool.connect();
        try {
            const userId = await createStudent(setup, fixture.universityId, email);
            await createIdentity(setup, userId, fixture.universityId, { subject });
        } finally {
            setup.release();
        }
        const oidc = makeOidc();
        oidc.redeemWith(observationFor(fixture.realm, subject));
        // The default reader resolves null on transient failures instead
        // of throwing; the web parser rejects a null pairing with
        // available, so the finish must say unavailable.
        const { service } = makeService(pool, oidc.oidc, { readAssurance: async () => null });
        const { started, callbackUrl, cookies } = await startGoogle(service, oidc, email);
        await service.callback({ provider: 'google', callbackUrl, browserCookies: cookies });

        const finished = await service.finish({
            attemptId: started.publicResult.attemptId,
            finishSecret: started.publicResult.finishSecret,
            browserCookie: started.callbackCookie.value,
        });
        assert.equal(finished.outcome, 'authenticated');
        if (finished.outcome !== 'authenticated') throw new Error('unreachable');
        assert.equal(finished.studentAssurance, null);
        assert.equal(finished.assuranceStatus, 'unavailable');
        assert.ok(finished.tokens.refreshToken);
    });
});

test('misconfigured policy trust data fails start closed', async () => {
    await withSsoPool(async (pool) => {
        const setup = await pool.connect();
        let universityId: string;
        let badDomain: string;
        let microsoftDomain: string;
        try {
            universityId = await createUniversity(setup);
            badDomain = `bad${uniqueLabel()}.school.example`;
            const badPolicy = await createLoginPolicy(setup, universityId, { provider: 'google', issuer: 'https://evil.example.invalid', realm: badDomain });
            await createLoginDomain(setup, badDomain, universityId, 'google', badPolicy.id);
            microsoftDomain = `ms${uniqueLabel()}.school.example`;
            const msPolicy = await createLoginPolicy(setup, universityId, {
                provider: 'microsoft',
                issuer: 'https://login.microsoftonline.com/tenant-a/v2.0',
                realm: 'tenant-a',
            });
            await createLoginDomain(setup, microsoftDomain, universityId, 'microsoft', msPolicy.id);
        } finally {
            setup.release();
        }
        const oidc = makeOidc();
        const { service } = makeService(pool, oidc.oidc);
        await assert.rejects(service.start({ provider: 'google', email: `user@${badDomain}` }), /no longer valid/);
        await assert.rejects(service.start({ provider: 'microsoft', email: `user@${microsoftDomain}` }), /no longer valid/);
        assert.equal(oidc.authorizeInputs.length, 0);

        const check = await pool.connect();
        try {
            const rows = await check.query('SELECT id FROM student_auth_attempts WHERE requested_email LIKE $1', [`%@${badDomain}`]);
            assert.equal(rows.rowCount, 0);
        } finally {
            check.release();
        }
    });
});

test('open attempts are capped per policy mailbox', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const email = `capped-${uniqueLabel()}@${fixture.domain}`;
        const oidc = makeOidc();
        const { service } = makeService(pool, oidc.oidc);
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const started = await service.start({ provider: 'google', email });
            assert.ok(started.publicResult.attemptId);
        }
        await assert.rejects(service.start({ provider: 'google', email }), /Too many outstanding/);
        const other = await service.start({ provider: 'google', email: `other-${uniqueLabel()}@${fixture.domain}` });
        assert.ok(other.publicResult.attemptId);
    });
});

test('concurrent starts cannot exceed the open-attempt cap', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const email = `racing-start-${uniqueLabel()}@${fixture.domain}`;
        const oidc = makeOidc();
        const { service } = makeService(pool, oidc.oidc);

        const outcomes = await Promise.allSettled(
            Array.from({ length: 5 }, () => service.start({ provider: 'google', email })),
        );
        const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
        const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
        assert.equal(fulfilled.length, 3);
        assert.equal(rejected.length, 2);
        for (const outcome of rejected) {
            assert.match(String((outcome as PromiseRejectedResult).reason), /Too many outstanding/);
        }

        const check = await pool.connect();
        try {
            const rows = await check.query<{ count: string }>(
                `SELECT count(*) AS count FROM student_auth_attempts
                 WHERE requested_email = $1 AND status IN ('pending', 'processing', 'ready')
                 AND expires_at > clock_timestamp()`,
                [email],
            );
            assert.equal(Number(rows.rows[0]!.count), 3);
        } finally {
            check.release();
        }
    });
});

test('unknown domains and disabled services fail start without an attempt row', async () => {
    await withSsoPool(async (pool) => {
        const oidc = makeOidc();
        const { service } = makeService(pool, oidc.oidc);
        await assert.rejects(service.start({ provider: 'google', email: `user@unknown-${uniqueLabel()}.example` }), /not available for this email domain/);
        const { service: disabled } = makeService(pool, oidc.oidc, { isEnabled: () => false });
        await assert.rejects(disabled.start({ provider: 'google', email: 'user@students.school.example' }), /no longer valid/);
        assert.equal(oidc.authorizeInputs.length, 0);
    });
});

test('held user lock does not block the transaction session writer', async () => {
    await withSsoPool(async (pool) => {
        const setup = await pool.connect();
        let userId: string;
        let email: string;
        try {
            const universityId = await createUniversity(setup);
            email = `heldlock-${uniqueLabel()}@example.invalid`;
            userId = await createStudent(setup, universityId, email);
        } finally {
            setup.release();
        }
        const client = await pool.connect();
        try {
            await assertFixtureDatabase(client);
            await client.query('BEGIN');
            await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
            // The writer uses only this client while the lock is held: no
            // second pool connection, so no global-pool self-block.
            const tokens = await issueSessionInTransaction(client, { userId, email, role: 'student' }, false);
            const decoded = jwtService.verifyRefreshToken(tokens.refreshToken);
            assert.equal(decoded.userId, userId);
            const row = await client.query<{ refresh_token_hash: string; active_session_id: string; active_session_auth_identity_id: string | null }>(
                'SELECT refresh_token_hash, active_session_id, active_session_auth_identity_id FROM users WHERE id = $1',
                [userId],
            );
            assert.equal(row.rows[0]!.refresh_token_hash, refreshHash(tokens.refreshToken));
            assert.ok(row.rows[0]!.active_session_id);
            assert.equal(row.rows[0]!.active_session_auth_identity_id, null);
            await client.query('ROLLBACK');
        } finally {
            client.release();
        }
    });
});

test('remember-me extends the refresh window on SSO sessions', async () => {
    await withSsoPool(async (pool) => {
        const fixture = await approvedGoogleFixture(pool);
        const email = `remember-${uniqueLabel()}@${fixture.domain}`;
        const subject = `remember-sub-${uniqueLabel()}`;
        const setup = await pool.connect();
        try {
            const userId = await createStudent(setup, fixture.universityId, email);
            await createIdentity(setup, userId, fixture.universityId, { subject });
        } finally {
            setup.release();
        }
        const oidc = makeOidc();
        oidc.redeemWith(observationFor(fixture.realm, subject));
        const { service } = makeService(pool, oidc.oidc);
        const before = Date.now();
        const { started, callbackUrl, cookies } = await startGoogle(service, oidc, email, true);
        await service.callback({ provider: 'google', callbackUrl, browserCookies: cookies });
        const finished = await service.finish({
            attemptId: started.publicResult.attemptId,
            finishSecret: started.publicResult.finishSecret,
            browserCookie: started.callbackCookie.value,
        });
        assert.equal(finished.outcome, 'authenticated');
        if (finished.outcome !== 'authenticated') throw new Error('unreachable');
        const decoded = jwtService.verifyRefreshToken(finished.tokens.refreshToken);
        assert.ok(decoded.exp);
        assert.ok(decoded.exp * 1000 >= before + 29 * 86_400_000);
        assert.ok(decoded.exp * 1000 <= before + 31 * 86_400_000);
    });
});

test('cleanup scrubs expired ciphertext and deletes only aged transients', async () => {
    await withSsoPool(async (pool) => {
        const setup = await pool.connect();
        let policyId: string;
        let identityId: string;
        let freshAttempt: string;
        let handoffAttempt: string;
        let laggedHandoffAttempt: string;
        let legacyHandoffId: string;
        let expiredReauthAttempt: string;
        let expiredRecoveryAttempt: string;
        let terminalReauthAttempt: string;
        let terminalRecoveryAttempt: string;
        let blockedTerminalReauthAttempt: string;
        let expiredActionGrant: string;
        let activeRecoveryCode: string;
        let expiredRecoveryCode: string;
        let referencedCodeTombstone: string;
        let unreferencedCodeTombstone: string;
        let deletedActionGrant: string;
        try {
            const universityId = await createUniversity(setup);
            const domain = `cleanup${uniqueLabel()}.school.example`;
            const policy = await createLoginPolicy(setup, universityId, { provider: 'google', realm: domain });
            policyId = policy.id;
            await createLoginDomain(setup, domain, universityId, 'google', policy.id);
            const userId = await createStudent(setup, universityId, `cleanup-${uniqueLabel()}@${domain}`);
            identityId = await createIdentity(setup, userId, universityId, {});
            await setup.query(
                `INSERT INTO student_school_assertions
                     (user_id, university_id, source, auth_identity_id, login_policy_id, policy_version, identity_version, expires_at)
                 VALUES ($1, $2, 'google_workspace', $3, $4, 1, 1, clock_timestamp() + interval '30 days')`,
                [userId, universityId, identityId, policyId],
            );
            const attemptKey = randomBytes(32).toString('base64url');
            const insertAttempt = async (createdAgo: string, status: string, withSecrets: boolean): Promise<string> => {
                const id = randomUUID();
                const created = `clock_timestamp() - interval '${createdAgo}'`;
                // Expiry stays within the created+10min CHECK window: rows
                // created over 9 minutes ago are expired, fresher rows live.
                const expires = `clock_timestamp() - interval '${createdAgo}' + interval '9 minutes'`;
                return (await setup.query<{ id: string }>(
                    `INSERT INTO student_auth_attempts
                         (id, policy_id, policy_version, provider, requested_email, state_hash, callback_cookie_hash,
                          finish_secret_hash, encrypted_verifier, nonce, encrypted_observation, status, expires_at, created_at)
                     VALUES ($1, $2, 1, 'google', $3, $4, $5, $6, $7, $8, $9, $10, ${expires}, ${created})
                     RETURNING id`,
                    [
                        id, policyId, `cleanup-${uniqueLabel()}@${domain}`,
                        hashMicrosoftAttemptSecret(`state-${id}`), hashMicrosoftAttemptSecret(`cookie-${id}`),
                        hashMicrosoftAttemptSecret(`finish-${id}`),
                        withSecrets ? encryptMicrosoftAttemptVerifier(`verifier-${id}`, attemptKey, id) : null,
                        withSecrets ? `nonce-${id}` : null,
                        status === 'ready' && withSecrets ? encryptMicrosoftAttemptVerifier('observation', attemptKey, id) : null,
                        status,
                    ],
                )).rows[0]!.id;
            };
            const recentlyExpired = await insertAttempt('1 hour', 'pending', true);
            await insertAttempt('8 days', 'consumed', false);
            freshAttempt = await insertAttempt('1 minute', 'pending', true);
            handoffAttempt = await insertAttempt('8 days', 'consumed', false);
            await setup.query(
                `INSERT INTO student_auth_link_handoffs
                     (attempt_id, secret_hash, encrypted_observation, policy_id, policy_version, browser_binding_hash, expires_at, created_at)
                 VALUES ($1, $2, $3, $4, 1, $5, clock_timestamp() - interval '51 minutes', clock_timestamp() - interval '1 hour')`,
                [recentlyExpired, hashMicrosoftAttemptSecret(`handoff-${uniqueLabel()}`), 'enc:observation', policyId, hashMicrosoftAttemptSecret('binding')],
            );
            await setup.query(
                `INSERT INTO student_auth_link_handoffs
                     (attempt_id, secret_hash, encrypted_observation, policy_id, policy_version, browser_binding_hash, expires_at, created_at)
                 VALUES ($1, $2, $3, $4, 1, $5, clock_timestamp() - interval '8 days', clock_timestamp() - interval '8 days')`,
                [handoffAttempt, hashMicrosoftAttemptSecret(`handoff-${uniqueLabel()}`), 'enc:observation', policyId, hashMicrosoftAttemptSecret('binding')],
            );
            // A completed signup owns a non-cascading FK to this aged handoff.
            // Cleanup must remove the child tombstone before the parent, while
            // still continuing on to later grant and credential cleanup.
            await setup.query(
                `INSERT INTO student_auth_signup_challenges
                     (handoff_id, secret_hash, browser_binding_hash, status, expires_at, mailbox_verified_at, consumed_at, terminal_at, created_at)
                 VALUES ((SELECT id FROM student_auth_link_handoffs WHERE attempt_id = $1), $2, $3, 'consumed',
                         clock_timestamp() - interval '8 days', clock_timestamp() - interval '8 days',
                         clock_timestamp() - interval '8 days', clock_timestamp() - interval '8 days', clock_timestamp() - interval '8 days')`,
                [handoffAttempt, hashMicrosoftAttemptSecret(`signup-${uniqueLabel()}`), hashMicrosoftAttemptSecret(`signup-binding-${uniqueLabel()}`)],
            );
            // A scheduler-lagged signup tombstone: the handoff expired eight
            // days ago but the child terminalized six days ago, so both rows
            // must survive this pass instead of aborting cleanup on the FK.
            laggedHandoffAttempt = await insertAttempt('8 days', 'consumed', false);
            await setup.query(
                `INSERT INTO student_auth_link_handoffs
                     (attempt_id, secret_hash, encrypted_observation, policy_id, policy_version, browser_binding_hash, expires_at, created_at)
                 VALUES ($1, $2, $3, $4, 1, $5, clock_timestamp() - interval '8 days', clock_timestamp() - interval '8 days')`,
                [laggedHandoffAttempt, hashMicrosoftAttemptSecret(`handoff-${uniqueLabel()}`), 'enc:observation', policyId, hashMicrosoftAttemptSecret('binding')],
            );
            await setup.query(
                `INSERT INTO student_auth_signup_challenges
                     (handoff_id, secret_hash, browser_binding_hash, status, expires_at, terminal_at, created_at)
                 VALUES ((SELECT id FROM student_auth_link_handoffs WHERE attempt_id = $1), $2, $3, 'expired',
                         clock_timestamp() - interval '8 days', clock_timestamp() - interval '6 days', clock_timestamp() - interval '8 days')`,
                [laggedHandoffAttempt, hashMicrosoftAttemptSecret(`signup-${uniqueLabel()}`), hashMicrosoftAttemptSecret(`signup-binding-${uniqueLabel()}`)],
            );
            // A pre-deployment consumed handoff: the old consume path kept
            // the binding digests, so cleanup must catch the residue up
            // instead of retaining it until the tombstone is deleted.
            const legacyHandoffAttempt = await insertAttempt('8 days', 'consumed', false);
            legacyHandoffId = (await setup.query<{ id: string }>(
                `INSERT INTO student_auth_link_handoffs
                     (attempt_id, secret_hash, encrypted_observation, policy_id, policy_version, browser_binding_hash,
                      expires_at, created_at, consumed_at, target_user_id, target_sid)
                 VALUES ($1, $2, 'scrubbed', $3, 1, $4, clock_timestamp() - interval '8 days',
                         clock_timestamp() - interval '8 days', clock_timestamp() - interval '8 days', $5, $6::uuid)
                 RETURNING id`,
                [legacyHandoffAttempt, hashMicrosoftAttemptSecret(`legacy-handoff-${uniqueLabel()}`), policyId,
                    hashMicrosoftAttemptSecret('legacy-binding'), userId, randomUUID()],
            )).rows[0]!.id;
            await setup.query(
                `INSERT INTO student_auth_reauth_grants (user_id, sid, purpose, secret_hash, expires_at, created_at)
                 VALUES ($1, $2, 'link', $3, clock_timestamp() - interval '8 days', clock_timestamp() - interval '8 days')`,
                [userId, randomUUID(), hashMicrosoftAttemptSecret(`grant-${uniqueLabel()}`)],
            );
            expiredActionGrant = (await setup.query<{ id: string }>(
                `INSERT INTO student_auth_action_grants
                 (user_id, sid, credential_generation, purpose, secret_hash, expires_at, created_at)
                 VALUES ($1, $2, 0, 'recovery_code_generate', $3, clock_timestamp() - interval '61 minutes', clock_timestamp() - interval '66 minutes')
                 RETURNING id`,
                [userId, randomUUID(), hashMicrosoftAttemptSecret(`action-grant-${uniqueLabel()}`)],
            )).rows[0]!.id;
            activeRecoveryCode = (await setup.query<{ id: string }>(
                `INSERT INTO student_auth_recovery_codes
                 (user_id, generation, code_digest, status, activated_at, created_at)
                 VALUES ($1, 71, $2, 'active', clock_timestamp() - interval '2 minutes', clock_timestamp() - interval '2 minutes')
                 RETURNING id`,
                [userId, hashMicrosoftAttemptSecret(`active-recovery-${uniqueLabel()}`)],
            )).rows[0]!.id;
            expiredReauthAttempt = (await setup.query<{ id: string }>(
                `INSERT INTO student_auth_reauth_attempts
                     (user_id, sid, credential_generation, purpose, state_hash, callback_cookie_hash, encrypted_verifier, nonce,
                      status, expires_at, consumed_at, created_at)
                 VALUES ($1, $2, 0, 'link', $3, $4, $5, $6, 'consumed',
                         clock_timestamp() - interval '8 days', clock_timestamp() - interval '8 days', clock_timestamp() - interval '8 days')
                 RETURNING id`,
                [userId, randomUUID(), hashMicrosoftAttemptSecret(`reauth-state-${uniqueLabel()}`), hashMicrosoftAttemptSecret(`reauth-cookie-${uniqueLabel()}`), 'encrypted-verifier', 'reauth-nonce'],
            )).rows[0]!.id;
            expiredRecoveryAttempt = (await setup.query<{ id: string }>(
                `INSERT INTO student_auth_recovery_attempts
                     (user_id, credential_generation, purpose, secret_hash, recovery_code_generation, status, expires_at, verified_at, consumed_at, created_at)
                 VALUES ($1, 0, 'lost_access', $2, 71, 'consumed',
                         clock_timestamp() - interval '8 days', clock_timestamp() - interval '8 days',
                         clock_timestamp() - interval '8 days', clock_timestamp() - interval '8 days')
                 RETURNING id`,
                [userId, hashMicrosoftAttemptSecret(`recovery-attempt-${uniqueLabel()}`)],
            )).rows[0]!.id;
            terminalReauthAttempt = (await setup.query<{ id: string }>(
                `INSERT INTO student_auth_reauth_attempts
                     (user_id, sid, credential_generation, purpose, state_hash, callback_cookie_hash, encrypted_verifier, nonce,
                      status, expires_at, consumed_at, created_at)
                 VALUES ($1, $2, 0, 'link', $3, $4, $5, $6, 'failed',
                         clock_timestamp() + interval '4 minutes', clock_timestamp(), clock_timestamp())
                 RETURNING id`,
                [userId, randomUUID(), hashMicrosoftAttemptSecret(`terminal-reauth-state-${uniqueLabel()}`), hashMicrosoftAttemptSecret(`terminal-reauth-cookie-${uniqueLabel()}`), 'terminal-encrypted-verifier', 'terminal-reauth-nonce'],
            )).rows[0]!.id;
            terminalRecoveryAttempt = (await setup.query<{ id: string }>(
                `INSERT INTO student_auth_recovery_attempts
                     (user_id, credential_generation, purpose, secret_hash, recovery_code_generation, status, expires_at, created_at)
                 VALUES ($1, 0, 'lost_access', $2, 71, 'failed', clock_timestamp() + interval '4 minutes', clock_timestamp())
                 RETURNING id`,
                [userId, hashMicrosoftAttemptSecret(`terminal-recovery-${uniqueLabel()}`)],
            )).rows[0]!.id;
            blockedTerminalReauthAttempt = (await setup.query<{ id: string }>(
                `INSERT INTO student_auth_reauth_attempts
                     (user_id, sid, credential_generation, purpose, state_hash, callback_cookie_hash, encrypted_verifier, nonce,
                      status, expires_at, consumed_at, created_at)
                 VALUES ($1, $2, 0, 'link', $3, $4, $5, $6, 'failed',
                         clock_timestamp() - interval '56 minutes', clock_timestamp() - interval '61 minutes', clock_timestamp() - interval '61 minutes')
                 RETURNING id`,
                [userId, randomUUID(), hashMicrosoftAttemptSecret(`blocked-reauth-state-${uniqueLabel()}`), hashMicrosoftAttemptSecret(`blocked-reauth-cookie-${uniqueLabel()}`), 'blocked-encrypted-verifier', 'blocked-reauth-nonce'],
            )).rows[0]!.id;
            await setup.query(`CREATE FUNCTION test_block_terminal_reauth_scrub() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    IF OLD.id = TG_ARGV[0]::uuid THEN RETURN NULL; END IF;
                    RETURN NEW;
                END $$`);
            const triggerStatement = await setup.query<{ statement: string }>(
                `SELECT format(
                    'CREATE TRIGGER test_block_terminal_reauth_scrub BEFORE UPDATE ON student_auth_reauth_attempts FOR EACH ROW EXECUTE FUNCTION test_block_terminal_reauth_scrub(%L)',
                    $1::text
                ) AS statement`,
                [blockedTerminalReauthAttempt],
            );
            await setup.query(triggerStatement.rows[0]!.statement);
            expiredRecoveryCode = (await setup.query<{ id: string }>(
                `INSERT INTO student_auth_recovery_codes
                 (user_id, generation, code_digest, status, expires_at, created_at, pending_sid, pending_credential_generation)
                 VALUES ($1, 72, $2, 'pending', clock_timestamp() - interval '1 second', clock_timestamp() - interval '5 minutes', $3, 0)
                 RETURNING id`,
                [userId, hashMicrosoftAttemptSecret(`expired-recovery-${uniqueLabel()}`), randomUUID()],
            )).rows[0]!.id;
            referencedCodeTombstone = (await setup.query<{ id: string }>(
                `INSERT INTO student_auth_recovery_codes
                 (user_id, generation, code_digest, status, revoked_at, created_at)
                 VALUES ($1, 73, NULL, 'revoked', clock_timestamp() - interval '8 days', clock_timestamp() - interval '8 days')
                 RETURNING id`,
                [userId],
            )).rows[0]!.id;
            unreferencedCodeTombstone = (await setup.query<{ id: string }>(
                `INSERT INTO student_auth_recovery_codes
                 (user_id, generation, code_digest, status, revoked_at, created_at)
                 VALUES ($1, 74, NULL, 'revoked', clock_timestamp() - interval '8 days', clock_timestamp() - interval '8 days')
                 RETURNING id`,
                [userId],
            )).rows[0]!.id;
            await setup.query(
                `INSERT INTO student_auth_recovery_attempts
                     (user_id, credential_generation, purpose, secret_hash, recovery_code_generation, status, expires_at, created_at)
                 VALUES ($1, 0, 'lost_access', $2, 73, 'pending', clock_timestamp() + interval '4 minutes', clock_timestamp())`,
                [userId, hashMicrosoftAttemptSecret(`referencing-recovery-${uniqueLabel()}`)],
            );
            deletedActionGrant = (await setup.query<{ id: string }>(
                `INSERT INTO student_auth_action_grants
                 (user_id, sid, credential_generation, purpose, secret_hash, expires_at, revoked_at, created_at)
                 VALUES ($1, $2, 0, 'recovery_code_generate', 'scrubbed', clock_timestamp() - interval '8 days', clock_timestamp() - interval '8 days', clock_timestamp() - interval '8 days')
                 RETURNING id`,
                [userId, randomUUID()],
            )).rows[0]!.id;
            await setup.query(
                `INSERT INTO student_auth_reauth_grants (user_id, sid, purpose, secret_hash, expires_at, created_at)
                 VALUES ($1, $2, 'link', $3, clock_timestamp() + interval '4 minutes', clock_timestamp())`,
                [userId, randomUUID(), hashMicrosoftAttemptSecret(`grant-${uniqueLabel()}`)],
            );
        } finally {
            setup.release();
        }

        const worker = await pool.connect();
        let result: Awaited<ReturnType<typeof cleanupStudentSsoTransients>>;
        try {
            result = await cleanupStudentSsoTransients(worker);
        } finally {
            worker.release();
        }
        // The aged handoff is scrubbed before it is deleted, so it counts in
        // both steps; the lagged handoff is scrubbed in place and retained
        // for its referencing signup child. The legacy consumed handoff is
        // scrubbed and deleted with its attempt. No other suite backdates SSO transients.
        assert.equal(result.attemptsFailed, 1);
        assert.equal(result.handoffsScrubbed, 4);
        assert.equal(result.attemptsDeleted, 3);
        assert.equal(result.handoffsDeleted, 2);
        assert.equal(result.grantsDeleted, 1);
        assert.equal((result as unknown as { actionGrantsScrubbed?: number }).actionGrantsScrubbed, 1,
            'expired action grants must lose their digest on the next cleanup pass');
        assert.equal((result as unknown as { recoveryCodesScrubbed?: number }).recoveryCodesScrubbed, 1,
            'expired pending recovery-code digests must be terminalized on the next cleanup pass');
        assert.equal((result as unknown as { terminalSecretsScrubbed?: number }).terminalSecretsScrubbed, 8,
            'catch-up scrubs already-terminal login, reauthentication, and recovery rows before their expiry, including the legacy handoff attempt');
        assert.equal((result as unknown as { overdueExpired?: number }).overdueExpired, 4,
            'monitoring reports every class that sat expired past the one-hour retention bound: the action grant, the two aged handoffs, and the legacy consumed handoff');
        assert.equal((result as unknown as { overdueTerminalSecrets?: number }).overdueTerminalSecrets, 7,
            'monitoring reports terminal rows that kept secrets past the one-hour retention bound, including ones this pass repairs and the legacy handoff attempt');

        const unblock = await pool.connect();
        try {
            await unblock.query('DROP TRIGGER test_block_terminal_reauth_scrub ON student_auth_reauth_attempts');
            await unblock.query('DROP FUNCTION test_block_terminal_reauth_scrub()');
            const recovered = await cleanupStudentSsoTransients(unblock);
            assert.equal((recovered as unknown as { terminalSecretsScrubbed?: number }).terminalSecretsScrubbed, 1,
                'a later cleanup pass repairs the previously blocked terminal reauthentication row');
            assert.equal((recovered as unknown as { overdueTerminalSecrets?: number }).overdueTerminalSecrets, 1,
                'the delayed repair still reports the overdue row it found as scheduler-lag evidence');
            assert.equal((recovered as unknown as { overdueExpired?: number }).overdueExpired, 0);
            const converged = await cleanupStudentSsoTransients(unblock);
            assert.equal((converged as unknown as { terminalSecretsScrubbed?: number }).terminalSecretsScrubbed, 0);
            assert.equal((converged as unknown as { overdueTerminalSecrets?: number }).overdueTerminalSecrets, 0);
            assert.equal((converged as unknown as { overdueExpired?: number }).overdueExpired, 0);
        } finally {
            unblock.release();
        }

        const check = await pool.connect();
        try {
            const fresh = await check.query<{ status: string; encrypted_verifier: string | null }>(
                'SELECT status, encrypted_verifier FROM student_auth_attempts WHERE id = $1',
                [freshAttempt],
            );
            assert.equal(fresh.rows[0]!.status, 'pending');
            assert.ok(fresh.rows[0]!.encrypted_verifier);
            const laggedAttempt = await check.query<{ state_hash: string | null; callback_cookie_hash: string | null; finish_secret_hash: string | null }>(
                'SELECT state_hash, callback_cookie_hash, finish_secret_hash FROM student_auth_attempts WHERE id = $1',
                [laggedHandoffAttempt],
            );
            assert.deepEqual(laggedAttempt.rows[0], { state_hash: null, callback_cookie_hash: null, finish_secret_hash: null },
                'retained terminal login tombstones lose their binding digests to catch-up scrubbing');
            const scrubbed = await check.query<{ encrypted_observation: string | null }>(
                'SELECT encrypted_observation FROM student_auth_link_handoffs WHERE policy_id = $1',
                [policyId],
            );
            assert.equal(scrubbed.rows.length, 2);
            for (const row of scrubbed.rows) assert.equal(row.encrypted_observation, null);
            const freshGrants = await check.query('SELECT id FROM student_auth_reauth_grants WHERE expires_at > clock_timestamp()');
            assert.ok(freshGrants.rows.length >= 1);
            const scrubbedActionGrant = await check.query<{ secret_hash: string; revoked_at: Date | null }>(
                'SELECT secret_hash, revoked_at FROM student_auth_action_grants WHERE id = $1', [expiredActionGrant],
            );
            assert.deepEqual(scrubbedActionGrant.rows[0], { secret_hash: 'scrubbed', revoked_at: scrubbedActionGrant.rows[0]!.revoked_at });
            assert.ok(scrubbedActionGrant.rows[0]!.revoked_at);
            const recoveryCodes = await check.query<{ id: string; status: string; code_digest: string | null; expires_at: Date | null; pending_sid: string | null; pending_credential_generation: string | null; pending_proof_identity_id: string | null }>(
                'SELECT id, status, code_digest, expires_at, pending_sid, pending_credential_generation, pending_proof_identity_id FROM student_auth_recovery_codes WHERE id = ANY($1::uuid[]) ORDER BY id',
                [[activeRecoveryCode, expiredRecoveryCode]],
            );
            const active = recoveryCodes.rows.find(row => row.id === activeRecoveryCode);
            const expired = recoveryCodes.rows.find(row => row.id === expiredRecoveryCode);
            assert.equal(active?.status, 'active', 'active recovery credentials are never transient cleanup data');
            assert.ok(active?.code_digest, 'active recovery-code digest survives transient cleanup');
            assert.equal(active?.expires_at, null);
            assert.deepEqual(expired && { status: expired.status, digest: expired.code_digest, expiresAt: expired.expires_at }, {
                status: 'revoked', digest: null, expiresAt: null,
            });
            assert.deepEqual(expired && { sid: expired.pending_sid, generation: expired.pending_credential_generation, proof: expired.pending_proof_identity_id }, {
                sid: null, generation: null, proof: null,
            }, 'expired pending codes lose their activation bindings on terminalization');
            const tombstones = await check.query<{ id: string }>(
                'SELECT id FROM student_auth_recovery_codes WHERE id = ANY($1::uuid[])',
                [[referencedCodeTombstone, unreferencedCodeTombstone]],
            );
            assert.deepEqual(tombstones.rows.map(row => row.id).sort(), [referencedCodeTombstone].sort(),
                'aged code tombstones survive cleanup while retained attempts reference them, without aborting the pass');
            const deleted = await check.query('SELECT id FROM student_auth_action_grants WHERE id = $1', [deletedActionGrant]);
            assert.equal(deleted.rowCount, 0, 'seven-day terminal grant tombstones are deleted');
            const completedSignup = await check.query(
                `SELECT signup.id
                 FROM student_auth_signup_challenges signup
                 JOIN student_auth_link_handoffs handoff ON handoff.id = signup.handoff_id
                 WHERE handoff.attempt_id = $1`,
                [handoffAttempt],
            );
            assert.equal(completedSignup.rowCount, 0,
                'aged completed signup tombstones are deleted before their non-cascading handoff parent');
            const deletedHandoff = await check.query('SELECT id FROM student_auth_link_handoffs WHERE attempt_id = $1', [handoffAttempt]);
            assert.equal(deletedHandoff.rowCount, 0, 'the completed signup handoff is deleted without aborting later cleanup');
            const legacyHandoff = await check.query('SELECT id FROM student_auth_link_handoffs WHERE id = $1', [legacyHandoffId]);
            assert.equal(legacyHandoff.rowCount, 0, 'the legacy consumed handoff is scrubbed then deleted with no residue retained');
            const lagged = await check.query(
                `SELECT signup.id AS signup_id
                 FROM student_auth_signup_challenges signup
                 JOIN student_auth_link_handoffs handoff ON handoff.id = signup.handoff_id
                 WHERE handoff.attempt_id = $1`,
                [laggedHandoffAttempt],
            );
            assert.equal(lagged.rowCount, 1, 'aged handoffs survive cleanup while a retained signup child references them');
            const deletedAttempts = await check.query(
                'SELECT id FROM student_auth_reauth_attempts WHERE id = $1 UNION ALL SELECT id FROM student_auth_recovery_attempts WHERE id = $2',
                [expiredReauthAttempt, expiredRecoveryAttempt],
            );
            assert.equal(deletedAttempts.rowCount, 0,
                'seven-day reauthentication and recovery tombstones are deleted after their secrets are terminalized');
            const terminalSecrets = await check.query<{
                id: string; status: string; consumed_at: Date | null; state_hash: string | null; callback_cookie_hash: string | null;
                encrypted_verifier: string | null; nonce: string | null; secret_hash: string | null;
            }>(
                `SELECT id, status, consumed_at, state_hash, callback_cookie_hash, encrypted_verifier, nonce, NULL::text AS secret_hash
                 FROM student_auth_reauth_attempts WHERE id = ANY($1::uuid[])
                 UNION ALL
                 SELECT id, status, consumed_at, NULL::text, NULL::text, NULL::text, NULL::text, secret_hash
                 FROM student_auth_recovery_attempts WHERE id = $2`,
                [[terminalReauthAttempt, blockedTerminalReauthAttempt], terminalRecoveryAttempt],
            );
            assert.equal(terminalSecrets.rows.length, 3);
            for (const row of terminalSecrets.rows) {
                assert.equal(row.status, 'failed');
                assert.equal(row.state_hash, null);
                assert.equal(row.callback_cookie_hash, null);
                assert.equal(row.encrypted_verifier, null);
                assert.equal(row.nonce, null);
                assert.equal(row.secret_hash, null);
            }
            const replaySignup = await check.query(
                `UPDATE student_auth_signup_challenges
                 SET status = 'consumed', consumed_at = clock_timestamp(), terminal_at = clock_timestamp()
                 WHERE handoff_id = (SELECT id FROM student_auth_link_handoffs WHERE attempt_id = $1)`,
                [handoffAttempt],
            );
            assert.equal(replaySignup.rowCount, 0, 'deleting a terminal signup tombstone cannot revive its consumed handoff');
            const replay = await check.query(
                "UPDATE student_auth_action_grants SET consumed_at = clock_timestamp(), secret_hash = 'scrubbed' WHERE id = $1 AND consumed_at IS NULL AND revoked_at IS NULL",
                [deletedActionGrant],
            );
            assert.equal(replay.rowCount, 0, 'a deleted terminal tombstone cannot be replayed into a usable grant');
            // Owner linkage and school assertions are retained audit records.
            const identities = await check.query('SELECT id FROM student_auth_identities WHERE id = $1', [identityId]);
            assert.equal(identities.rows.length, 1);
            const assertions = await check.query('SELECT id FROM student_school_assertions WHERE login_policy_id = $1', [policyId]);
            assert.equal(assertions.rows.length, 1);
        } finally {
            check.release();
        }
    });
});
