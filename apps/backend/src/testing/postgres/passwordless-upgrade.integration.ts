import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { StudentSsoFlowService, studentSsoCookieName, type ApprovedLoginPolicy } from '../../services/auth/student-sso-flow.service.js';
import type { ProviderObservation, StudentOidcAdapter } from '../../services/auth/student-sso.types.js';
import { assertFixtureDatabase, createTestPool, withTestClient } from './test-database.js';

const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../database/migrations');
const passwordlessMigration = resolve(migrationsDirectory, '069_passwordless_credentials.sql');

function label(): string {
    return randomUUID().replaceAll('-', '').slice(0, 12);
}

type ExistingLoginFixture = {
    userId: string;
    universityId: string;
    identityId: string;
    policyId: string;
    handoffId: string;
    email: string;
    subject: string;
    issuer: string;
    realm: string;
};

async function seedExistingLogin(client: PoolClient): Promise<ExistingLoginFixture> {
    const suffix = label();
    const realm = `passwordless-${suffix}.school.example`;
    const email = `passwordless-upgrade-${suffix}@${realm}`;
    const issuer = 'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/v2.0';
    const subject = `oid-${suffix}`;
    const userId = (await client.query<{ id: string }>(
        `INSERT INTO users (email, role, password_hash)
         VALUES ($1, 'student', $2) RETURNING id`,
        [email, 'existing-password-hash'],
    )).rows[0]!.id;
    const universityId = (await client.query<{ id: string }>(
        'INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id',
        [`Passwordless upgrade ${suffix}`],
    )).rows[0]!.id;
    await client.query('INSERT INTO students (user_id, name, university_id) VALUES ($1, $2, $3)', [userId, `Passwordless student ${suffix}`, universityId]);
    const adminId = (await client.query<{ id: string }>(
        "INSERT INTO users (email, role) VALUES ($1, 'admin') RETURNING id",
        [`passwordless-upgrade-admin-${suffix}@example.invalid`],
    )).rows[0]!.id;
    const policy = (await client.query<{ id: string; version: number }>(
        `INSERT INTO institution_login_policies
             (university_id, provider, issuer, provider_realm, version, enabled, approved_until, approved_by, school_assertion_days)
         VALUES ($1, 'microsoft', $2, $3, 1, true, clock_timestamp() + interval '1 day', $4, 90)
         RETURNING id, version`,
        [
            universityId,
            issuer,
            '11111111-1111-4111-8111-111111111111',
            adminId,
        ],
    )).rows[0]!;
    await client.query('INSERT INTO institution_login_domains (domain, university_id, is_active) VALUES ($1, $2, true)', [realm, universityId]);
    await client.query(
        `INSERT INTO institution_login_domain_providers (domain, university_id, provider, policy_id)
         VALUES ($1, $2, 'microsoft', $3)`,
        [realm, universityId, policy.id],
    );
    const identityId = (await client.query<{ id: string }>(
        `INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject, observed_email)
         VALUES ($1, $2, 'microsoft', $3, $4, $5) RETURNING id`,
        [userId, universityId, issuer, subject, email],
    )).rows[0]!.id;
    const attemptId = (await client.query<{ id: string }>(
        `INSERT INTO student_auth_attempts
             (policy_id, policy_version, provider, requested_email, state_hash, callback_cookie_hash,
              finish_secret_hash, encrypted_verifier, nonce, status, expires_at, remember_me)
         VALUES ($1, $2, 'microsoft', $3, $4, $5, $6, $7, $8, 'pending',
                 clock_timestamp() + interval '5 minutes', false)
         RETURNING id`,
        [policy.id, policy.version, email, `state-${suffix}`, `cookie-${suffix}`, `finish-${suffix}`, `verifier-${suffix}`, `nonce-${suffix}`],
    )).rows[0]!.id;
    const handoffId = (await client.query<{ id: string }>(
        `INSERT INTO student_auth_link_handoffs
             (attempt_id, secret_hash, encrypted_observation, policy_id, policy_version, browser_binding_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp() + interval '5 minutes')
         RETURNING id`,
        [attemptId, `handoff-${suffix}`, `observation-${suffix}`, policy.id, policy.version, `browser-${suffix}`],
    )).rows[0]!.id;
    return { userId, universityId, identityId, policyId: policy.id, handoffId, email, subject, issuer, realm };
}

async function applyExistingMigrations(client: PoolClient): Promise<void> {
    const baseline = readdirSync(migrationsDirectory)
        .filter((name) => name.endsWith('.sql') && !name.startsWith('clear_') && name < '069_')
        .sort();
    for (const name of baseline) {
        await client.query(readFileSync(resolve(migrationsDirectory, name), 'utf8'));
    }
}

async function withPasswordlessPool<T>(operation: (pool: Pool) => Promise<T>): Promise<T> {
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

test('upgradePreservesExistingLogin keeps current policy and identity usable with safe credential defaults', async () => {
    await withTestClient(async (client) => {
        const schema = `passwordless_upgrade_${label()}`;
        await client.query('BEGIN');
        try {
            await client.query(`CREATE SCHEMA ${schema}`);
            await client.query(`SET LOCAL search_path TO ${schema}, public`);
            await applyExistingMigrations(client);
            const existing = await seedExistingLogin(client);
            const policyBefore = await client.query(
                `SELECT id, university_id, provider, issuer, provider_realm, version, enabled,
                        approved_until, approved_by, school_assertion_days
                 FROM institution_login_policies WHERE id = $1`,
                [existing.policyId],
            );
            const identityBefore = await client.query(
                `SELECT id, user_id, university_id, provider, issuer, subject, observed_email,
                        revoked_at, linked_at
                 FROM student_auth_identities WHERE id = $1`,
                [existing.identityId],
            );
            await client.query(readFileSync(passwordlessMigration, 'utf8'));

            const currentLogin = await client.query<{
                user_id: string; identity_id: string; policy_id: string; password_hash: string;
                password_setup_requires_recovery_code: boolean; recovery_reenrollment_requires_password: boolean;
                credential_generation: string;
            }>(
                `SELECT identities.user_id, identities.id AS identity_id, policies.id AS policy_id, users.password_hash,
                        users.password_setup_requires_recovery_code, users.recovery_reenrollment_requires_password,
                        users.credential_generation
                 FROM student_auth_identities identities
                 JOIN users ON users.id = identities.user_id
                 JOIN institution_login_policies policies ON policies.id = $2
                 WHERE identities.id = $1
                   AND identities.revoked_at IS NULL
                   AND policies.enabled
                   AND policies.approved_until > clock_timestamp()`,
                [existing.identityId, existing.policyId],
            );

            assert.deepEqual(currentLogin.rows, [{
                user_id: existing.userId,
                identity_id: existing.identityId,
                policy_id: existing.policyId,
                password_hash: 'existing-password-hash',
                password_setup_requires_recovery_code: false,
                recovery_reenrollment_requires_password: false,
                credential_generation: '0',
            }]);
            const policyAfter = await client.query(
                `SELECT id, university_id, provider, issuer, provider_realm, version, enabled,
                        approved_until, approved_by, school_assertion_days
                 FROM institution_login_policies WHERE id = $1`,
                [existing.policyId],
            );
            const identityAfter = await client.query(
                `SELECT id, user_id, university_id, provider, issuer, subject, observed_email,
                        revoked_at, linked_at
                 FROM student_auth_identities WHERE id = $1`,
                [existing.identityId],
            );
            assert.deepEqual(policyAfter.rows, policyBefore.rows);
            assert.deepEqual(identityAfter.rows, identityBefore.rows);
        } finally {
            await client.query('ROLLBACK');
        }
    });
});

test('fresh harness applies 069 and canonical finish authenticates an existing linked identity', async () => {
    await withPasswordlessPool(async (pool) => {
        const setup = await pool.connect();
        let existing: ExistingLoginFixture;
        try {
            const migration = await setup.query<{ count: number }>(
                `SELECT count(*)::int AS count FROM migrations WHERE filename = '069_passwordless_credentials.sql'`,
            );
            assert.equal(migration.rows[0]!.count, 1);
            existing = await seedExistingLogin(setup);
        } finally {
            setup.release();
        }

        let state = '';
        const oidc = {
            forPolicy: (_policy: ApprovedLoginPolicy): StudentOidcAdapter => ({
                authorize: async ({ state: receivedState }) => {
                    state = receivedState;
                    return new URL(`https://provider.example.invalid/authorize?state=${receivedState}`);
                },
                redeem: async (): Promise<ProviderObservation> => ({
                    provider: 'microsoft', issuer: existing.issuer, subject: existing.subject,
                    email: existing.email, mailboxVerified: false, realm: '11111111-1111-4111-8111-111111111111',
                    schoolMembershipAttested: false, objectId: existing.subject,
                }),
            }),
        };
        const callback = new URL('https://api.example.invalid/api/auth/student/sso/microsoft/callback');
        const service = new StudentSsoFlowService({
            pool, oidc, attemptKey: randomBytes(32).toString('base64url'),
            callbackUrls: {
                google: new URL('https://api.example.invalid/api/auth/student/sso/google/callback'),
                microsoft: callback,
            },
            completionUrl: new URL('https://app.example.invalid/auth/student/sso/complete'),
            isEnabled: () => true,
            isProviderEnabled: () => true,
        });
        const started = await service.start({ provider: 'microsoft', email: existing.email });
        callback.searchParams.set('code', 'opaque-code');
        callback.searchParams.set('state', state);
        await service.callback({
            provider: 'microsoft', callbackUrl: callback,
            browserCookies: [{ name: studentSsoCookieName(started.publicResult.attemptId), value: started.callbackCookie.value }],
        });
        const finished = await service.finish({
            attemptId: started.publicResult.attemptId,
            finishSecret: started.publicResult.finishSecret,
            browserCookie: started.callbackCookie.value,
        });
        assert.equal(finished.outcome, 'authenticated');
        if (finished.outcome !== 'authenticated') throw new Error('Expected canonical SSO finish to authenticate the linked identity');
        assert.equal(finished.user.id, existing.userId);
        assert.equal(finished.user.email, existing.email);
    });
});

test('signup challenge is unique per existing handoff', async () => {
    await withTestClient(async (client) => {
        const existing = await seedExistingLogin(client);
        await client.query(
            `INSERT INTO student_auth_signup_challenges
                 (handoff_id, secret_hash, browser_binding_hash, expires_at)
             VALUES ($1, $2, $3, clock_timestamp() + interval '10 minutes')`,
            [existing.handoffId, `signup-secret-${label()}`, `signup-browser-${label()}`],
        );

        await assert.rejects(
            client.query(
                `INSERT INTO student_auth_signup_challenges
                     (handoff_id, secret_hash, browser_binding_hash, expires_at)
                 VALUES ($1, $2, $3, clock_timestamp() + interval '10 minutes')`,
                [existing.handoffId, `signup-secret-${label()}`, `signup-browser-${label()}`],
            ),
            /unique/i,
        );
    });
});

test('recovery code lifecycle permits one active code and rejects terminal replay', async () => {
    await withTestClient(async (client) => {
        const first = await seedExistingLogin(client);
        const second = await seedExistingLogin(client);
        const pendingSid = randomUUID();
        await client.query('UPDATE users SET active_session_id = $2::uuid WHERE id = $1', [first.userId, pendingSid]);
        const codeId = (await client.query<{ id: string }>(
            `INSERT INTO student_auth_recovery_codes
                 (user_id, generation, code_digest, status, expires_at,
                  pending_sid, pending_credential_generation, pending_proof_identity_id)
             VALUES ($1, 1, $2, 'pending', clock_timestamp() + interval '10 minutes', $3::uuid, 0, $4)
             RETURNING id`,
            [first.userId, `digest-${label()}`, pendingSid, first.identityId],
        )).rows[0]!.id;
        await client.query(
            `UPDATE student_auth_recovery_codes
             SET status = 'active', expires_at = NULL, activated_at = clock_timestamp(),
                 pending_sid = NULL, pending_credential_generation = NULL, pending_proof_identity_id = NULL
             WHERE id = $1`,
            [codeId],
        );

        await assert.rejects(
            client.query(
                `INSERT INTO student_auth_recovery_codes
                     (user_id, generation, code_digest, status, activated_at)
                 VALUES ($1, 2, $2, 'active', clock_timestamp())`,
                [first.userId, `second-active-${label()}`],
            ),
            /unique/i,
        );

        await client.query(
            `UPDATE student_auth_recovery_codes
             SET status = 'consumed', consumed_at = clock_timestamp(), code_digest = NULL
             WHERE id = $1`,
            [codeId],
        );
        await assert.rejects(
            client.query(
                "UPDATE student_auth_recovery_codes SET status = 'active' WHERE id = $1",
                [codeId],
            ),
            /terminal|replay|immutable/i,
        );

        await client.query(
            `INSERT INTO student_auth_recovery_codes
                 (user_id, generation, code_digest, status, activated_at)
             VALUES ($1, 1, $2, 'active', clock_timestamp())`,
            [second.userId, `other-active-${label()}`],
        );
    });
});
