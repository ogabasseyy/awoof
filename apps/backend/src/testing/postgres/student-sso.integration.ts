import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { withTestClient } from './test-database.js';

// Task B1: durable login policy, identities, and attempts storage contract.
// Every test here targets migration 057 tables/constraints directly; no
// session is written and no Microsoft verification table is touched.

function uniqueLabel(): string {
    return randomUUID().replaceAll('-', '').slice(0, 12);
}

function secretHex(bytes = 32): string {
    return randomBytes(bytes).toString('hex');
}

async function assertPgError(operation: Promise<unknown>, code: string): Promise<void> {
    await assert.rejects(operation, (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, code);
        return true;
    });
}

async function createUser(client: PoolClient, role: 'student' | 'admin'): Promise<string> {
    const label = uniqueLabel();
    const id = (await client.query<{ id: string }>(
        `INSERT INTO users (email, role) VALUES ($1, $2) RETURNING id`,
        [`sso-${role}-${label}@example.invalid`, role],
    )).rows[0]!.id;
    return id;
}

async function createUniversity(client: PoolClient, isActive = true): Promise<string> {
    return (await client.query<{ id: string }>(
        `INSERT INTO universities (name, is_active) VALUES ($1, $2) RETURNING id`,
        [`SSO School ${uniqueLabel()}`, isActive],
    )).rows[0]!.id;
}

type PolicyOptions = {
    provider?: string;
    issuer?: string;
    realm?: string;
    version?: number;
    enabled?: boolean;
    approvedUntil?: string | null;
    approvedBy?: string | null;
    assertionDays?: number;
};

async function createPolicy(
    client: PoolClient,
    universityId: string,
    options: PolicyOptions = {},
): Promise<string> {
    const enabled = options.enabled ?? true;
    // Enabled policies require a recorded approver; seed one unless the
    // caller explicitly opts out with approvedBy: null (negative tests).
    const approvedBy = options.approvedBy !== undefined
        ? options.approvedBy
        : enabled ? await createUser(client, 'admin') : null;
    return (await client.query<{ id: string }>(
        `INSERT INTO institution_login_policies
             (university_id, provider, issuer, provider_realm, version, enabled,
              approved_until, approved_by, school_assertion_days)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
            universityId,
            options.provider ?? 'google',
            options.issuer ?? 'https://accounts.google.com',
            options.realm ?? 'students.school.example',
            options.version ?? 1,
            enabled,
            options.approvedUntil ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            approvedBy,
            options.assertionDays ?? 90,
        ],
    )).rows[0]!.id;
}

async function createDomain(
    client: PoolClient,
    domain: string,
    universityId: string,
    isActive = true,
): Promise<void> {
    await client.query(
        `INSERT INTO institution_login_domains (domain, university_id, is_active)
         VALUES ($1, $2, $3)`,
        [domain, universityId, isActive],
    );
}

async function createDomainProvider(
    client: PoolClient,
    domain: string,
    universityId: string,
    provider: string,
    policyId: string,
): Promise<void> {
    await client.query(
        `INSERT INTO institution_login_domain_providers (domain, university_id, provider, policy_id)
         VALUES ($1, $2, $3, $4)`,
        [domain, universityId, provider, policyId],
    );
}

async function createIdentity(
    client: PoolClient,
    userId: string,
    universityId: string,
    overrides: { provider?: string; issuer?: string; subject?: string; observedEmail?: string | null } = {},
): Promise<string> {
    return (await client.query<{ id: string }>(
        `INSERT INTO student_auth_identities
             (user_id, university_id, provider, issuer, subject, observed_email)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
            userId,
            universityId,
            overrides.provider ?? 'google',
            overrides.issuer ?? 'https://accounts.google.com',
            overrides.subject ?? `sub-${uniqueLabel()}`,
            overrides.observedEmail ?? null,
        ],
    )).rows[0]!.id;
}

async function createEmailProof(client: PoolClient, userId: string): Promise<string> {
    const email = `sso-student-${uniqueLabel()}@students.school.example`;
    const challengeId = randomUUID();
    await client.query(
        `INSERT INTO verification_challenges
             (id, purpose, subject_digest, secret_digest, bindings, created_at, expires_at)
         VALUES ($1, 'student_email', $2, $3, '{}',
                 clock_timestamp(), clock_timestamp() + interval '10 minutes')`,
        [challengeId, secretHex(), secretHex()],
    );
    return (await client.query<{ id: string }>(
        `INSERT INTO user_email_proofs (user_id, email, challenge_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [userId, email, challengeId],
    )).rows[0]!.id;
}

type AttemptOptions = {
    status?: string;
    verifier?: string | null;
    nonce?: string | null;
    observation?: string | null;
    stateHash?: string;
    expiresAt?: string;
    provider?: string;
};

async function createAttempt(
    client: PoolClient,
    policyId: string,
    options: AttemptOptions = {},
): Promise<string> {
    return (await client.query<{ id: string }>(
        `INSERT INTO student_auth_attempts
             (policy_id, policy_version, provider, requested_email, state_hash,
              callback_cookie_hash, finish_secret_hash, encrypted_verifier, nonce,
              encrypted_observation, status, expires_at, remember_me)
         VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false)
         RETURNING id`,
        [
            policyId,
            options.provider ?? 'google',
            `sso-attempt-${uniqueLabel()}@students.school.example`,
            options.stateHash ?? secretHex(),
            secretHex(),
            secretHex(),
            options.verifier !== undefined ? options.verifier : 'enc:verifier',
            options.nonce !== undefined ? options.nonce : secretHex(16),
            options.observation !== undefined ? options.observation : null,
            options.status ?? 'pending',
            options.expiresAt ?? new Date(Date.now() + 9 * 60 * 1000).toISOString(),
        ],
    )).rows[0]!.id;
}

async function createHandoff(
    client: PoolClient,
    attemptId: string,
    policyId: string,
    options: { targetUserId?: string | null; targetSid?: string | null; expiresAt?: string } = {},
): Promise<string> {
    return (await client.query<{ id: string }>(
        `INSERT INTO student_auth_link_handoffs
             (attempt_id, secret_hash, encrypted_observation, policy_id, policy_version,
              browser_binding_hash, target_user_id, target_sid, expires_at)
         VALUES ($1, $2, 'enc:observation', $3, 1, $4, $5, $6, $7)
         RETURNING id`,
        [
            attemptId,
            secretHex(),
            policyId,
            secretHex(),
            options.targetUserId ?? null,
            options.targetSid ?? null,
            options.expiresAt ?? new Date(Date.now() + 9 * 60 * 1000).toISOString(),
        ],
    )).rows[0]!.id;
}

async function createReauthGrant(
    client: PoolClient,
    userId: string,
    options: { purpose?: string; secretHash?: string; expiresAt?: string } = {},
): Promise<string> {
    return (await client.query<{ id: string }>(
        `INSERT INTO student_auth_reauth_grants (user_id, sid, purpose, secret_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
            userId,
            randomUUID(),
            options.purpose ?? 'link',
            options.secretHash ?? secretHex(),
            options.expiresAt ?? new Date(Date.now() + 4 * 60 * 1000).toISOString(),
        ],
    )).rows[0]!.id;
}

test('login policy is unique per university and provider', async () => {
    await withTestClient(async (client) => {
        const universityId = await createUniversity(client);
        await createPolicy(client, universityId, { provider: 'google' });
        await assertPgError(createPolicy(client, universityId, { provider: 'google' }), '23505');
        const microsoftId = await createPolicy(client, universityId, {
            provider: 'microsoft',
            issuer: 'https://login.microsoftonline.com/tenant-a/v2.0',
            realm: 'tenant-a',
        });
        assert.ok(microsoftId);
    });
});

test('login policy validates provider, version, and assertion window', async () => {
    await withTestClient(async (client) => {
        const universityId = await createUniversity(client);
        await assertPgError(createPolicy(client, universityId, { provider: 'github' }), '23514');
        await assertPgError(createPolicy(client, universityId, { version: 0 }), '23514');
        await assertPgError(createPolicy(client, universityId, { assertionDays: 0 }), '23514');
        await assertPgError(createPolicy(client, universityId, { assertionDays: 91 }), '23514');
        const adminId = await createUser(client, 'admin');
        const policyId = await createPolicy(client, universityId, {
            enabled: false,
            approvedBy: adminId,
            assertionDays: 1,
        });
        const row = (await client.query<{ enabled: boolean; version: number }>(
            `SELECT enabled, version FROM institution_login_policies WHERE id = $1`,
            [policyId],
        )).rows[0]!;
        assert.equal(row.enabled, false);
        assert.equal(row.version, 1);
    });
});

test('enabling a login policy without an approver is rejected', async () => {
    await withTestClient(async (client) => {
        const universityId = await createUniversity(client);
        await assertPgError(createPolicy(client, universityId, { approvedBy: null }), '23514');
        const draftId = await createPolicy(client, universityId, { enabled: false, approvedBy: null });
        await assert.rejects(
            client.query(
                'UPDATE institution_login_policies SET enabled = true WHERE id = $1',
                [draftId],
            ),
            /institution_login_policies_enabled_requires_approver/,
        );
    });
});

test('login domains are lowercase and map to exactly one university', async () => {
    await withTestClient(async (client) => {
        const firstId = await createUniversity(client);
        const secondId = await createUniversity(client);
        const domain = `school-${uniqueLabel()}.example`;
        await createDomain(client, domain, firstId);
        await assertPgError(createDomain(client, domain.toUpperCase(), firstId), '23514');
        await assertPgError(createDomain(client, domain, secondId), '23505');
        await assertPgError(createDomain(client, domain, firstId), '23505');
    });
});

test('one domain can serve multiple providers without ambiguous ownership', async () => {
    await withTestClient(async (client) => {
        const universityId = await createUniversity(client);
        const domain = `multi-${uniqueLabel()}.example`;
        await createDomain(client, domain, universityId);
        const googleId = await createPolicy(client, universityId, { provider: 'google' });
        const microsoftId = await createPolicy(client, universityId, {
            provider: 'microsoft',
            issuer: 'https://login.microsoftonline.com/tenant-b/v2.0',
            realm: 'tenant-b',
        });
        await createDomainProvider(client, domain, universityId, 'google', googleId);
        await createDomainProvider(client, domain, universityId, 'microsoft', microsoftId);
        const rows = await client.query(
            `SELECT provider FROM institution_login_domain_providers WHERE domain = $1 ORDER BY provider`,
            [domain],
        );
        assert.deepEqual(rows.rows.map((row) => (row as { provider: string }).provider), ['google', 'microsoft']);
    });
});

test('domain providers reject ambiguous university or policy bindings', async () => {
    await withTestClient(async (client) => {
        const universityId = await createUniversity(client);
        const otherId = await createUniversity(client);
        const domain = `ambig-${uniqueLabel()}.example`;
        await createDomain(client, domain, universityId);
        const googleId = await createPolicy(client, universityId, { provider: 'google' });
        const otherPolicyId = await createPolicy(client, otherId, { provider: 'google' });
        // The (domain, university) pair must match the owning domain row.
        await assertPgError(
            createDomainProvider(client, domain, otherId, 'google', otherPolicyId),
            '23503',
        );
        // The (policy, university, provider) triple must match one policy row.
        await assertPgError(
            createDomainProvider(client, domain, universityId, 'google', otherPolicyId),
            '23503',
        );
        await assertPgError(
            createDomainProvider(client, domain, universityId, 'microsoft', googleId),
            '23503',
        );
    });
});

test('approval-ready lookup joins only active universities and live approvals', async () => {
    await withTestClient(async (client) => {
        // Canonical discovery join shape: B2 login-options must resolve
        // providers through active universities, enabled unexpired policies,
        // and active domain mappings only.
        const lookup = async (domain: string, provider: string): Promise<number> => {
            const rows = await client.query(
                `SELECT p.id
                 FROM institution_login_policies p
                 JOIN universities u ON u.id = p.university_id AND u.is_active
                 JOIN institution_login_domain_providers dp
                   ON dp.policy_id = p.id
                  AND dp.university_id = p.university_id
                  AND dp.provider = p.provider
                 JOIN institution_login_domains d
                   ON d.domain = dp.domain
                  AND d.university_id = dp.university_id
                  AND d.is_active
                 WHERE p.enabled
                   AND p.approved_until IS NOT NULL
                   AND p.approved_until > clock_timestamp()
                   AND d.domain = $1 AND p.provider = $2`,
                [domain, provider],
            );
            return rows.rowCount ?? 0;
        };
        const activeId = await createUniversity(client, true);
        const activeDomain = `live-${uniqueLabel()}.example`;
        await createDomain(client, activeDomain, activeId);
        const livePolicyId = await createPolicy(client, activeId, { provider: 'google' });
        await createDomainProvider(client, activeDomain, activeId, 'google', livePolicyId);
        assert.equal(await lookup(activeDomain, 'google'), 1);

        const dormantId = await createUniversity(client, false);
        const dormantDomain = `dormant-${uniqueLabel()}.example`;
        await createDomain(client, dormantDomain, dormantId);
        const dormantPolicyId = await createPolicy(client, dormantId, { provider: 'google' });
        await createDomainProvider(client, dormantDomain, dormantId, 'google', dormantPolicyId);
        assert.equal(await lookup(dormantDomain, 'google'), 0);

        const disabledDomain = `disabled-${uniqueLabel()}.example`;
        await createDomain(client, disabledDomain, activeId);
        const disabledId = await createPolicy(client, activeId, {
            provider: 'microsoft',
            issuer: 'https://login.microsoftonline.com/tenant-c/v2.0',
            realm: 'tenant-c',
            enabled: false,
        });
        await createDomainProvider(client, disabledDomain, activeId, 'microsoft', disabledId);
        assert.equal(await lookup(disabledDomain, 'microsoft'), 0);
    });
});

test('provider identities are unique per issuer subject', async () => {
    await withTestClient(async (client) => {
        const userId = await createUser(client, 'student');
        const universityId = await createUniversity(client);
        const subject = `sub-${uniqueLabel()}`;
        await createIdentity(client, userId, universityId, { subject });
        await assertPgError(
            createIdentity(client, userId, universityId, { subject }),
            '23505',
        );
        // Same subject under another issuer is a different identity.
        const otherIssuerId = await createIdentity(client, userId, universityId, {
            subject,
            issuer: 'https://login.microsoftonline.com/tenant-d/v2.0',
            provider: 'microsoft',
        });
        assert.ok(otherIssuerId);
        // Another institution identity on the same provider stays allowed.
        const secondId = await createIdentity(client, userId, universityId, {
            observedEmail: `second-${uniqueLabel()}@students.school.example`,
        });
        assert.ok(secondId);
    });
});

test('identity ownership is immutable and cannot transfer after revocation', async () => {
    await withTestClient(async (client) => {
        const userId = await createUser(client, 'student');
        const otherId = await createUser(client, 'student');
        const universityId = await createUniversity(client);
        const identityId = await createIdentity(client, userId, universityId);
        await assertPgError(
            client.query(`UPDATE student_auth_identities SET user_id = $1 WHERE id = $2`, [otherId, identityId]),
            'P0001',
        );
        await client.query(
            `UPDATE student_auth_identities SET revoked_at = clock_timestamp() WHERE id = $1`,
            [identityId],
        );
        await assertPgError(
            client.query(`UPDATE student_auth_identities SET user_id = $1 WHERE id = $2`, [otherId, identityId]),
            'P0001',
        );
        await assertPgError(
            client.query(`UPDATE student_auth_identities SET subject = $1 WHERE id = $2`, ['intruder', identityId]),
            'P0001',
        );
        await assertPgError(
            client.query(`DELETE FROM student_auth_identities WHERE id = $1`, [identityId]),
            'P0001',
        );
        const row = (await client.query<{ user_id: string; revoked_at: string }>(
            `SELECT user_id, revoked_at FROM student_auth_identities WHERE id = $1`,
            [identityId],
        )).rows[0]!;
        assert.equal(row.user_id, userId);
        assert.ok(row.revoked_at);
    });
});

test('user_email_proofs carries the owner composite key', async () => {
    await withTestClient(async (client) => {
        const rows = await client.query<{ definition: string }>(
            `SELECT pg_get_constraintdef(oid) AS definition
             FROM pg_constraint
             WHERE conrelid = 'user_email_proofs'::regclass AND contype = 'u'`,
        );
        assert.ok(
            rows.rows.some((row) => row.definition.includes('(id, user_id)')),
            'migration 057 must add UNIQUE(id, user_id) to user_email_proofs',
        );
    });
});

async function insertAssertion(
    client: PoolClient,
    userId: string,
    universityId: string,
    options: {
        source?: string;
        emailProofId?: string | null;
        identityId?: string | null;
        policyId?: string | null;
    },
): Promise<string> {
    return (await client.query<{ id: string }>(
        `INSERT INTO student_school_assertions
             (user_id, university_id, source, email_proof_id, auth_identity_id,
              login_policy_id, policy_version, identity_version, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 1, 1, clock_timestamp() + interval '30 days')
         RETURNING id`,
        [
            userId,
            universityId,
            options.source ?? 'email_otp',
            options.emailProofId ?? null,
            options.identityId ?? null,
            options.policyId ?? null,
        ],
    )).rows[0]!.id;
}

test('school assertions require exactly one evidence source', async () => {
    await withTestClient(async (client) => {
        const userId = await createUser(client, 'student');
        const universityId = await createUniversity(client);
        const proofId = await createEmailProof(client, userId);
        const policyId = await createPolicy(client, universityId, { provider: 'google' });
        const identityId = await createIdentity(client, userId, universityId);
        // Each invalid source combination fails its evidence check.
        await assertPgError(insertAssertion(client, userId, universityId, {}), '23514');
        await assertPgError(
            insertAssertion(client, userId, universityId, { emailProofId: proofId, identityId }),
            '23514',
        );
        await assertPgError(
            insertAssertion(client, userId, universityId, { emailProofId: proofId, policyId }),
            '23514',
        );
        await assertPgError(
            insertAssertion(client, userId, universityId, {
                source: 'google_workspace', emailProofId: proofId, identityId, policyId,
            }),
            '23514',
        );
        await assertPgError(
            insertAssertion(client, userId, universityId, {
                source: 'google_workspace', policyId,
            }),
            '23514',
        );
        await assertPgError(
            insertAssertion(client, userId, universityId, {
                source: 'microsoft_school', identityId,
            }),
            '23514',
        );
        await assertPgError(
            insertAssertion(client, userId, universityId, {
                source: 'portal_receipt', emailProofId: proofId,
            }),
            '23514',
        );
        const emailAssertionId = await insertAssertion(client, userId, universityId, {
            emailProofId: proofId,
        });
        assert.ok(emailAssertionId);
        const ssoAssertionId = await insertAssertion(client, userId, universityId, {
            source: 'google_workspace', identityId, policyId,
        });
        assert.ok(ssoAssertionId);
    });
});

test('school assertions bind evidence to the same owner', async () => {
    await withTestClient(async (client) => {
        const userId = await createUser(client, 'student');
        const otherId = await createUser(client, 'student');
        const universityId = await createUniversity(client);
        const proofId = await createEmailProof(client, userId);
        const policyId = await createPolicy(client, universityId, { provider: 'google' });
        const identityId = await createIdentity(client, userId, universityId);
        await assertPgError(
            insertAssertion(client, otherId, universityId, { emailProofId: proofId }),
            '23503',
        );
        await assertPgError(
            insertAssertion(client, otherId, universityId, {
                source: 'google_workspace', identityId, policyId,
            }),
            '23503',
        );
    });
});

test('school assertions are immutable except one-way revocation', async () => {
    await withTestClient(async (client) => {
        const userId = await createUser(client, 'student');
        const universityId = await createUniversity(client);
        const proofId = await createEmailProof(client, userId);
        const assertionId = await insertAssertion(client, userId, universityId, {
            emailProofId: proofId,
        });
        await assertPgError(
            client.query(
                `UPDATE student_school_assertions SET expires_at = clock_timestamp() WHERE id = $1`,
                [assertionId],
            ),
            'P0001',
        );
        await assertPgError(
            client.query(
                `UPDATE student_school_assertions SET source = 'google_workspace' WHERE id = $1`,
                [assertionId],
            ),
            'P0001',
        );
        await client.query(
            `UPDATE student_school_assertions SET revoked_at = clock_timestamp() WHERE id = $1`,
            [assertionId],
        );
        await assertPgError(
            client.query(
                `UPDATE student_school_assertions SET revoked_at = NULL WHERE id = $1`,
                [assertionId],
            ),
            'P0001',
        );
        await assertPgError(
            client.query(`DELETE FROM student_school_assertions WHERE id = $1`, [assertionId]),
            'P0001',
        );
    });
});

test('attempt payloads match their status', async () => {
    await withTestClient(async (client) => {
        const universityId = await createUniversity(client);
        const policyId = await createPolicy(client, universityId, { provider: 'google' });
        await assertPgError(
            createAttempt(client, policyId, { status: 'pending', verifier: null }),
            '23514',
        );
        await assertPgError(
            createAttempt(client, policyId, { status: 'processing', nonce: null }),
            '23514',
        );
        await assertPgError(
            createAttempt(client, policyId, { status: 'ready', observation: null }),
            '23514',
        );
        await assertPgError(
            createAttempt(client, policyId, { status: 'consumed', observation: 'enc:obs' }),
            '23514',
        );
        await assertPgError(
            createAttempt(client, policyId, { status: 'failed' }),
            '23514',
        );
        await assertPgError(
            createAttempt(client, policyId, { status: 'approved' }),
            '23514',
        );
        // The pending -> ready -> consumed lifecycle stays reachable.
        const attemptId = await createAttempt(client, policyId);
        await client.query(
            `UPDATE student_auth_attempts
             SET status = 'ready', encrypted_observation = 'enc:obs' WHERE id = $1`,
            [attemptId],
        );
        await client.query(
            `UPDATE student_auth_attempts
             SET status = 'consumed', encrypted_verifier = NULL, nonce = NULL,
                 encrypted_observation = NULL WHERE id = $1`,
            [attemptId],
        );
        const row = (await client.query<{ status: string; encrypted_observation: string | null }>(
            `SELECT status, encrypted_observation FROM student_auth_attempts WHERE id = $1`,
            [attemptId],
        )).rows[0]!;
        assert.equal(row.status, 'consumed');
        assert.equal(row.encrypted_observation, null);
    });
});

test('terminal attempts cannot transition back', async () => {
    await withTestClient(async (client) => {
        const universityId = await createUniversity(client);
        const policyId = await createPolicy(client, universityId, { provider: 'google' });
        const stateHash = secretHex();
        const consumedId = await createAttempt(client, policyId, {
            status: 'consumed', verifier: null, nonce: null, observation: null, stateHash,
        });
        await assertPgError(createAttempt(client, policyId, { stateHash }), '23505');
        await assertPgError(
            client.query(
                `UPDATE student_auth_attempts
                 SET status = 'processing', encrypted_verifier = 'enc:v', nonce = 'n' WHERE id = $1`,
                [consumedId],
            ),
            'P0001',
        );
        const failedId = await createAttempt(client, policyId, {
            status: 'failed', verifier: null, nonce: null, observation: null,
        });
        await assertPgError(
            client.query(
                `UPDATE student_auth_attempts
                 SET status = 'pending', encrypted_verifier = 'enc:v', nonce = 'n' WHERE id = $1`,
                [failedId],
            ),
            'P0001',
        );
    });
});

test('link handoffs are single-use per attempt with paired targets', async () => {
    await withTestClient(async (client) => {
        const userId = await createUser(client, 'student');
        const universityId = await createUniversity(client);
        const policyId = await createPolicy(client, universityId, { provider: 'google' });
        const attemptId = await createAttempt(client, policyId);
        const handoffId = await createHandoff(client, attemptId, policyId);
        await assertPgError(createHandoff(client, attemptId, policyId), '23505');
        const secretHash = (await client.query<{ secret_hash: string }>(
            `SELECT secret_hash FROM student_auth_link_handoffs WHERE id = $1`,
            [handoffId],
        )).rows[0]!.secret_hash;
        const otherAttemptId = await createAttempt(client, policyId);
        await assertPgError(
            client.query(
                `INSERT INTO student_auth_link_handoffs
                     (attempt_id, secret_hash, encrypted_observation, policy_id, policy_version,
                      browser_binding_hash, expires_at)
                 VALUES ($1, $2, 'enc:obs', $3, 1, $4, clock_timestamp() + interval '9 minutes')`,
                [otherAttemptId, secretHash, policyId, secretHex()],
            ),
            '23505',
        );
        await assertPgError(
            createHandoff(client, otherAttemptId, policyId, { targetUserId: userId }),
            '23514',
        );
        await assertPgError(
            createHandoff(client, otherAttemptId, policyId, { targetSid: randomUUID() }),
            '23514',
        );
        const pairedId = await createHandoff(client, otherAttemptId, policyId, {
            targetUserId: userId,
            targetSid: randomUUID(),
        });
        assert.ok(pairedId);
        await client.query(
            `UPDATE student_auth_link_handoffs SET consumed_at = clock_timestamp() WHERE id = $1`,
            [handoffId],
        );
        await assertPgError(
            client.query(
                `UPDATE student_auth_link_handoffs SET consumed_at = NULL WHERE id = $1`,
                [handoffId],
            ),
            'P0001',
        );
    });
});

test('transient records expire and bounded lifetimes hold', async () => {
    await withTestClient(async (client) => {
        const userId = await createUser(client, 'student');
        const universityId = await createUniversity(client);
        const policyId = await createPolicy(client, universityId, { provider: 'google' });
        await assertPgError(
            createAttempt(client, policyId, {
                expiresAt: new Date(Date.now() + 11 * 60 * 1000).toISOString(),
            }),
            '23514',
        );
        const attemptId = await createAttempt(client, policyId);
        await assertPgError(
            createHandoff(client, attemptId, policyId, {
                expiresAt: new Date(Date.now() + 11 * 60 * 1000).toISOString(),
            }),
            '23514',
        );
        await assertPgError(
            createReauthGrant(client, userId, {
                expiresAt: new Date(Date.now() + 6 * 60 * 1000).toISOString(),
            }),
            '23514',
        );
        // Already-expired rows persist for audit/cleanup selection.
        const expiredAttemptId = (await client.query<{ id: string }>(
            `INSERT INTO student_auth_attempts
                 (policy_id, policy_version, provider, requested_email, state_hash,
                  callback_cookie_hash, finish_secret_hash, status, expires_at, remember_me,
                  created_at)
             VALUES ($1, 1, 'google', 'expired@example.invalid', $2, $3, $4,
                     'failed', clock_timestamp() - interval '2 minutes', false,
                     clock_timestamp() - interval '11 minutes')
             RETURNING id`,
            [policyId, secretHex(), secretHex(), secretHex()],
        )).rows[0]!.id;
        const expired = await client.query(
            `SELECT id FROM student_auth_attempts WHERE id = $1 AND expires_at < clock_timestamp()`,
            [expiredAttemptId],
        );
        assert.equal(expired.rowCount, 1);
    });
});

test('reauth grants are single-purpose and single-use', async () => {
    await withTestClient(async (client) => {
        const userId = await createUser(client, 'student');
        await assertPgError(createReauthGrant(client, userId, { purpose: 'login' }), '23514');
        const secretHash = secretHex();
        const grantId = await createReauthGrant(client, userId, { purpose: 'unlink', secretHash });
        await assertPgError(createReauthGrant(client, userId, { secretHash }), '23505');
        await client.query(
            `UPDATE student_auth_reauth_grants SET consumed_at = clock_timestamp() WHERE id = $1`,
            [grantId],
        );
        await assertPgError(
            client.query(
                `UPDATE student_auth_reauth_grants SET consumed_at = NULL WHERE id = $1`,
                [grantId],
            ),
            'P0001',
        );
    });
});

test('users carry nullable SSO session provenance without backfill', async () => {
    await withTestClient(async (client) => {
        const userId = await createUser(client, 'student');
        const universityId = await createUniversity(client);
        const identityId = await createIdentity(client, userId, universityId);
        const before = (await client.query<{ active_session_auth_identity_id: string | null }>(
            `SELECT active_session_auth_identity_id FROM users WHERE id = $1`,
            [userId],
        )).rows[0]!;
        assert.equal(before.active_session_auth_identity_id, null);
        await assertPgError(
            client.query(
                `UPDATE users SET active_session_auth_identity_id = $1 WHERE id = $2`,
                [randomUUID(), userId],
            ),
            '23503',
        );
        // Password sessions write NULL; SSO sessions write the linked identity.
        await client.query(
            `UPDATE users SET active_session_auth_identity_id = NULL WHERE id = $1`,
            [userId],
        );
        await client.query(
            `UPDATE users SET active_session_auth_identity_id = $1 WHERE id = $2`,
            [identityId, userId],
        );
        const after = (await client.query<{ active_session_auth_identity_id: string }>(
            `SELECT active_session_auth_identity_id FROM users WHERE id = $1`,
            [userId],
        )).rows[0]!;
        assert.equal(after.active_session_auth_identity_id, identityId);
    });
});
