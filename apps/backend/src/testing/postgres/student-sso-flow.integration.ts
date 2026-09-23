import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
    redeemFailsWith: (error: Error) => void;
};

function makeOidc(): FakeOidc {
    const authorizeInputs: FakeOidc['authorizeInputs'] = [];
    let redeemCount = 0;
    let behavior: () => ProviderObservation = () => { throw new StudentOidcOperationalError('upstream_unavailable'); };
    return {
        authorizeInputs,
        get redeemCount() { return redeemCount; },
        set redeemCount(_value: number) { redeemCount = _value; },
        redeemWith: (observation: ProviderObservation) => { behavior = () => observation; },
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
        assert.ok(outcomes.every((outcome) => outcome.status === 'fulfilled'));
        const results = outcomes.map((outcome) => (outcome as PromiseFulfilledResult<Awaited<ReturnType<typeof service.finish>>>).value);
        const authenticated = results.filter((result) => result.outcome === 'authenticated');
        const restarts = results.filter((result) => result.outcome === 'restart_required');
        assert.equal(authenticated.length, 1);
        assert.equal(restarts.length, 1);

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
                'SELECT status, encrypted_verifier, nonce, encrypted_observation FROM student_auth_attempts WHERE id = $1',
                [started.publicResult.attemptId],
            );
            assert.deepEqual(row.rows[0], { status: 'failed', encrypted_verifier: null, nonce: null, encrypted_observation: null });
        } finally {
            check.release();
        }

        const finished = await service.finish({
            attemptId: started.publicResult.attemptId,
            finishSecret: started.publicResult.finishSecret,
            browserCookie: started.callbackCookie.value,
        });
        assert.equal(finished.outcome, 'restart_required');
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
            const attempts = await check.query<{ callback_cookie_hash: string; status: string; encrypted_observation: string | null }>(
                'SELECT callback_cookie_hash, status, encrypted_observation FROM student_auth_attempts WHERE id = $1',
                [started.publicResult.attemptId],
            );
            assert.equal(attempts.rows[0]!.status, 'consumed');
            assert.equal(attempts.rows[0]!.encrypted_observation, null);
            assert.equal(handoff.browser_binding_hash, attempts.rows[0]!.callback_cookie_hash);
            const decrypted = JSON.parse(decryptMicrosoftAttemptVerifier(handoff.encrypted_observation, attemptKey, finished.handoffId));
            assert.equal(decrypted.subject, subject);
            assert.equal(decrypted.provider, 'google');
        } finally {
            check.release();
        }
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

test('duplicate finish after commit returns restart without a new session', async () => {
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

        // A lost response replays the same proofs: no tokens are persisted
        // for replay, so the client gets a controlled restart instead.
        const second = await service.finish(input);
        assert.equal(second.outcome, 'restart_required');

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
        const ready = await startGoogle(service, oidc, email);
        await service.callback({ provider: 'google', callbackUrl: ready.callbackUrl, browserCookies: ready.cookies });

        const restart = await service.finish({
            attemptId: consumed.started.publicResult.attemptId,
            finishSecret: consumed.started.publicResult.finishSecret,
            browserCookie: consumed.started.callbackCookie.value,
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

test('expired attempts finish as restart with scrubbed secrets', async () => {
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
                'SELECT status, encrypted_verifier, nonce, encrypted_observation FROM student_auth_attempts WHERE id = $1',
                [started.publicResult.attemptId],
            );
            assert.deepEqual(row.rows[0], { status: 'failed', encrypted_verifier: null, nonce: null, encrypted_observation: null });
        } finally {
            check.release();
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
            const handoffAttempt = await insertAttempt('8 days', 'consumed', false);
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
            await setup.query(
                `INSERT INTO student_auth_reauth_grants (user_id, sid, purpose, secret_hash, expires_at, created_at)
                 VALUES ($1, $2, 'link', $3, clock_timestamp() - interval '8 days', clock_timestamp() - interval '8 days')`,
                [userId, randomUUID(), hashMicrosoftAttemptSecret(`grant-${uniqueLabel()}`)],
            );
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
        // both steps; no other suite backdates SSO transients.
        assert.equal(result.attemptsFailed, 1);
        assert.equal(result.handoffsScrubbed, 2);
        assert.equal(result.attemptsDeleted, 2);
        assert.equal(result.handoffsDeleted, 1);
        assert.equal(result.grantsDeleted, 1);

        const check = await pool.connect();
        try {
            const fresh = await check.query<{ status: string; encrypted_verifier: string | null }>(
                'SELECT status, encrypted_verifier FROM student_auth_attempts WHERE id = $1',
                [freshAttempt],
            );
            assert.equal(fresh.rows[0]!.status, 'pending');
            assert.ok(fresh.rows[0]!.encrypted_verifier);
            const scrubbed = await check.query<{ encrypted_observation: string }>(
                'SELECT encrypted_observation FROM student_auth_link_handoffs WHERE policy_id = $1',
                [policyId],
            );
            assert.equal(scrubbed.rows.length, 1);
            assert.equal(scrubbed.rows[0]!.encrypted_observation, 'scrubbed');
            const freshGrants = await check.query('SELECT id FROM student_auth_reauth_grants WHERE expires_at > clock_timestamp()');
            assert.ok(freshGrants.rows.length >= 1);
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
