import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { GOOGLE_ISSUER } from '../../services/auth/student-google-oidc.js';
import {
    StudentSsoLinkService,
    type StudentSsoLinkDependencies,
} from '../../services/auth/student-sso-link.service.js';
import { passwordService } from '../../services/auth/password.service.js';
import { issueActionGrant } from '../../services/auth/student-action-grant.service.js';
import { studentSsoCookieName } from '../../services/auth/student-sso-flow.service.js';
import {
    encryptMicrosoftAttemptVerifier,
    hashMicrosoftAttemptSecret,
} from '../../services/verification/microsoft-attempt-crypto.js';
import { lockStudentContext } from '../../services/verification/eligibility-context.service.js';
import { grantVerificationProcessing } from '../../services/verification/eligibility-consent.service.js';
import { consumeChallenge, requestChallenge } from '../../services/verification/challenge.service.js';
import { recordEmailAssurance } from '../../services/verification/eligibility-evidence.service.js';
import { updateInstitutionPolicy } from '../../services/verification/eligibility-policy.service.js';
import { VERIFICATION_NOTICE_VERSION } from '../../services/verification/verification-notices.js';
import { config } from '../../config/env.js';
import { assertFixtureDatabase, createTestPool } from './test-database.js';

const PASSWORD = 'Correct!horse-9-battery';
const MICROSOFT_TENANT = '11111111-1111-4111-8111-111111111111';

function uniqueLabel(): string {
    return randomUUID().replaceAll('-', '').slice(0, 12);
}

function secretHex(bytes = 32): string {
    return randomBytes(bytes).toString('hex');
}

async function withLinkPool<T>(operation: (pool: Pool) => Promise<T>): Promise<T> {
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

function makeService(pool: Pool, attemptKey: string, overrides: Partial<StudentSsoLinkDependencies> = {}): StudentSsoLinkService {
    return new StudentSsoLinkService({
        pool,
        attemptKey,
        isEnabled: () => true,
        isProviderEnabled: () => true,
        ...overrides,
    });
}

type SeededOwner = {
    userId: string;
    studentId: string;
    universityId: string;
    email: string;
    sid: string;
    passwordHash: string;
    grantId: string;
};

async function seedOwner(
    client: PoolClient,
    options: { domain?: string; password?: string } = {},
): Promise<SeededOwner> {
    const label = uniqueLabel();
    const domain = options.domain ?? `link${label}.school.example`;
    const email = `owner-${label}@${domain}`;
    const passwordHash = await passwordService.hashPassword(options.password ?? PASSWORD);
    const adminId = (await client.query<{ id: string }>(
        `INSERT INTO users (email, role) VALUES ($1, 'admin') RETURNING id`,
        [`admin-${label}@example.invalid`],
    )).rows[0]!.id;
    const userId = (await client.query<{ id: string }>(
        `INSERT INTO users (email, role, password_hash) VALUES ($1, 'student', $2) RETURNING id`,
        [email, passwordHash],
    )).rows[0]!.id;
    const universityId = (await client.query<{ id: string }>(
        `INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id`,
        [`Link School ${label}`],
    )).rows[0]!.id;
    const studentId = (await client.query<{ id: string }>(
        `INSERT INTO students (user_id, name, university_id) VALUES ($1, $2, $3) RETURNING id`,
        [userId, `Link Student ${label}`, universityId],
    )).rows[0]!.id;
    await updateInstitutionPolicy(client, adminId, universityId, {
        domains: [domain],
        emailEvidenceValidityDays: 90,
        enrollmentValidityDays: 30,
        registrationNormalization: null,
        isActive: true,
    });
    const grantId = await grantVerificationProcessing(client, userId, universityId, {
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
    if (issued.status !== 'issued') throw new Error('Mailbox challenge was not issued');
    const consumed = await consumeChallenge(client, {
        purpose: 'student_email',
        subjectKey: userId,
        challengeId: issued.challengeId,
        code: issued.code,
    });
    assert.equal(consumed.status, 'verified');
    await recordEmailAssurance(client, userId, {
        challengeId: issued.challengeId,
        processingGrantId: grantId,
    });
    const sid = randomUUID();
    await client.query('UPDATE users SET active_session_id = $2 WHERE id = $1', [userId, sid]);
    return { userId, studentId, universityId, email, sid, passwordHash, grantId };
}

type SeededPolicy = { id: string; version: number; realm: string; issuer: string };

async function seedPolicy(
    client: PoolClient,
    universityId: string,
    domain: string,
    options: { provider?: string; issuer?: string; realm?: string; approvedUntil?: string; approvedBy?: string | null } = {},
): Promise<SeededPolicy> {
    const provider = options.provider ?? 'google';
    const realm = options.realm ?? domain;
    const issuer = options.issuer
        ?? (provider === 'google' ? GOOGLE_ISSUER : `https://login.microsoftonline.com/${realm}/v2.0`);
    // Enabled policies require a recorded approver; seed one unless the
    // caller explicitly opts out with approvedBy: null (negative tests).
    const approvedBy = options.approvedBy !== undefined
        ? options.approvedBy
        : (await client.query<{ id: string }>(
            'INSERT INTO users (email, role) VALUES ($1, $2) RETURNING id',
            [`sso-admin-${uniqueLabel()}@example.invalid`, 'admin'],
        )).rows[0]!.id;
    const row = (await client.query<{ id: string; version: number }>(
        `INSERT INTO institution_login_policies
             (university_id, provider, issuer, provider_realm, version, enabled, approved_until, approved_by, school_assertion_days)
         VALUES ($1, $2, $3, $4, 1, true, $5, $6, 90)
         RETURNING id, version`,
        [universityId, provider, issuer, realm, options.approvedUntil ?? new Date(Date.now() + 30 * 86_400_000).toISOString(), approvedBy],
    )).rows[0]!;
    await client.query(
        'INSERT INTO institution_login_domains (domain, university_id, is_active) VALUES ($1, $2, true)',
        [domain, universityId],
    );
    await client.query(
        'INSERT INTO institution_login_domain_providers (domain, university_id, provider, policy_id) VALUES ($1, $2, $3, $4)',
        [domain, universityId, provider, row.id],
    );
    return { id: row.id, version: row.version, realm, issuer };
}

type Observation = {
    provider: 'google' | 'microsoft';
    issuer: string;
    subject: string;
    email: string;
    mailboxVerified: boolean;
    realm: string;
    schoolMembershipAttested: boolean;
    objectId: string | null;
};

type SeededHandoff = {
    attemptId: string;
    handoffId: string;
    handoffSecret: string;
    cookieSecret: string;
    observation: Observation;
};

async function seedHandoff(
    client: PoolClient,
    attemptKey: string,
    policy: SeededPolicy,
    observation: Observation,
    options: { expiresAt?: string; consumed?: boolean } = {},
): Promise<SeededHandoff> {
    const attemptId = (await client.query<{ id: string }>(
        `INSERT INTO student_auth_attempts
             (policy_id, policy_version, provider, requested_email, state_hash,
              callback_cookie_hash, finish_secret_hash, encrypted_verifier, nonce,
              encrypted_observation, status, expires_at, remember_me)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, false)
         RETURNING id`,
        [
            policy.id, policy.version, observation.provider, observation.email,
            secretHex(), secretHex(), secretHex(), secretHex(), secretHex(16), null,
            new Date(Date.now() + 9 * 60 * 1000).toISOString(),
        ],
    )).rows[0]!.id;
    const handoffSecret = secretHex();
    const cookieSecret = secretHex();
    // The id is minted client-side so the ciphertext binds the final row in
    // a single INSERT: the consume-once trigger forbids UPDATEs to consumed
    // handoffs, so a placeholder-then-rewrite seed cannot stage them.
    const handoffId = randomUUID();
    await client.query(
        `INSERT INTO student_auth_link_handoffs
             (id, attempt_id, secret_hash, encrypted_observation, policy_id, policy_version,
              browser_binding_hash, expires_at${options.consumed ? ', consumed_at' : ''})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8${options.consumed ? ', clock_timestamp()' : ''})`,
        [
            handoffId,
            attemptId,
            hashMicrosoftAttemptSecret(handoffSecret),
            encryptMicrosoftAttemptVerifier(JSON.stringify(observation), attemptKey, handoffId),
            policy.id,
            policy.version,
            hashMicrosoftAttemptSecret(cookieSecret),
            options.expiresAt ?? new Date(Date.now() + 9 * 60 * 1000).toISOString(),
        ],
    );
    return { attemptId, handoffId, handoffSecret, cookieSecret, observation };
}

function googleObservation(realm: string, subject: string, email: string, overrides: Partial<Observation> = {}): Observation {
    return {
        provider: 'google',
        issuer: GOOGLE_ISSUER,
        subject,
        email,
        mailboxVerified: true,
        realm,
        schoolMembershipAttested: true,
        objectId: null,
        ...overrides,
    };
}

async function mintGrant(
    service: StudentSsoLinkService,
    userId: string,
    sid: string,
    password: string,
    purpose: 'link' | 'unlink' = 'link',
    targetIdentityId?: string,
): Promise<{ grantId: string; grantSecret: string }> {
    const result = await service.reauth({ userId, sid, password, purpose, ...(targetIdentityId === undefined ? {} : { targetIdentityId }) });
    return { grantId: result.grantId, grantSecret: result.grantSecret };
}

function cookiesFor(attemptId: string, cookieSecret: string): { name: string; value: string }[] {
    return [{ name: studentSsoCookieName(attemptId), value: cookieSecret }];
}

test('link binds a new google subject and records the school assertion', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let policy;
        let handoff;
        try {
            owner = await seedOwner(client, {});
            policy = await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!);
            handoff = await seedHandoff(
                client,
                attemptKey,
                policy,
                googleObservation(policy.realm, `link-sub-${uniqueLabel()}`, owner.email),
            );
        } finally {
            client.release();
        }
        const grant = await mintGrant(service, owner.userId, owner.sid, PASSWORD);
        const result = await service.link({
            userId: owner.userId,
            sid: owner.sid,
            handoffId: handoff.handoffId,
            handoffSecret: handoff.handoffSecret,
            browserCookies: cookiesFor(handoff.attemptId, handoff.cookieSecret),
            grantId: grant.grantId,
            grantSecret: grant.grantSecret,
        });
        assert.equal(result.outcome, 'linked');
        if (result.outcome !== 'linked') throw new Error('Link did not succeed');
        assert.equal(result.schoolAssertion, 'recorded');
        assert.equal(result.reactivated, false);
        assert.equal(result.identity.provider, 'google');
        const check = await pool.connect();
        try {
            const stored = await check.query<{ user_id: string; revoked_at: Date | null }>(
                'SELECT user_id, revoked_at FROM student_auth_identities WHERE id = $1',
                [result.identity.id],
            );
            assert.equal(stored.rows[0]!.user_id, owner.userId);
            assert.equal(stored.rows[0]!.revoked_at, null);
            const assertion = await check.query(
                `SELECT 1 FROM student_school_assertions
                 WHERE auth_identity_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
                [result.identity.id, owner.userId],
            );
            assert.equal(assertion.rowCount, 1);
            const spent = await check.query<{ consumed_at: Date | null; encrypted_observation: string | null; secret_hash: string | null; browser_binding_hash: string | null }>(
                'SELECT consumed_at, encrypted_observation, secret_hash, browser_binding_hash FROM student_auth_link_handoffs WHERE id = $1',
                [handoff.handoffId],
            );
            assert.notEqual(spent.rows[0]!.consumed_at, null);
            // Consuming the handoff NULLs its ciphertext and one-use
            // binding digests in the same write: retention cleanup excludes
            // consumed handoffs, so nothing waits out the tombstone window.
            assert.equal(spent.rows[0]!.encrypted_observation, null);
            assert.equal(spent.rows[0]!.secret_hash, null);
            assert.equal(spent.rows[0]!.browser_binding_hash, null);
            const audit = await check.query(
                `SELECT 1 FROM verification_audit_events
                 WHERE user_id = $1 AND event_type = 'student_sso_identity_linked'`,
                [owner.userId],
            );
            assert.equal(audit.rowCount, 1);
        } finally {
            check.release();
        }
        // A replay cannot prove the scrubbed binding and fails closed
        // instead of resolving a restart, matching consumed attempts.
        const replayGrant = await mintGrant(service, owner.userId, owner.sid, PASSWORD);
        await assert.rejects(
            service.link({
                userId: owner.userId,
                sid: owner.sid,
                handoffId: handoff.handoffId,
                handoffSecret: handoff.handoffSecret,
                browserCookies: cookiesFor(handoff.attemptId, handoff.cookieSecret),
                grantId: replayGrant.grantId,
                grantSecret: replayGrant.grantSecret,
            }),
            /no longer valid/,
        );
    });
});

test('link rejects a different returned google account and spends the handoff', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let policy;
        let handoff;
        try {
            owner = await seedOwner(client, {});
            policy = await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!);
            handoff = await seedHandoff(
                client,
                attemptKey,
                policy,
                googleObservation(policy.realm, `mismatch-sub-${uniqueLabel()}`, `someone-else@${policy.realm}`, {
                    mailboxVerified: true,
                }),
            );
        } finally {
            client.release();
        }
        const grant = await mintGrant(service, owner.userId, owner.sid, PASSWORD);
        const result = await service.link({
            userId: owner.userId,
            sid: owner.sid,
            handoffId: handoff.handoffId,
            handoffSecret: handoff.handoffSecret,
            browserCookies: cookiesFor(handoff.attemptId, handoff.cookieSecret),
            grantId: grant.grantId,
            grantSecret: grant.grantSecret,
        });
        assert.equal(result.outcome, 'mismatch');
        const check = await pool.connect();
        try {
            const identities = await check.query('SELECT 1 FROM student_auth_identities WHERE user_id = $1', [owner.userId]);
            assert.equal(identities.rowCount, 0);
        } finally {
            check.release();
        }
    });
});

test('link refuses a subject already active for another owner without revealing it', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let ownerA;
        let ownerB;
        let policy;
        let handoff;
        const subject = `shared-sub-${uniqueLabel()}`;
        try {
            ownerA = await seedOwner(client, {});
            ownerB = await seedOwner(client, { domain: ownerA.email.split('@')[1]! });
            policy = await seedPolicy(client, ownerA.universityId, ownerA.email.split('@')[1]!);
            await client.query(
                `INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject)
                 VALUES ($1, $2, 'google', $3, $4)`,
                [ownerB.userId, ownerB.universityId, GOOGLE_ISSUER, subject],
            );
            handoff = await seedHandoff(
                client,
                attemptKey,
                policy,
                googleObservation(policy.realm, subject, ownerA.email),
            );
        } finally {
            client.release();
        }
        const grant = await mintGrant(service, ownerA.userId, ownerA.sid, PASSWORD);
        await assert.rejects(
            service.link({
                userId: ownerA.userId,
                sid: ownerA.sid,
                handoffId: handoff.handoffId,
                handoffSecret: handoff.handoffSecret,
                browserCookies: cookiesFor(handoff.attemptId, handoff.cookieSecret),
                grantId: grant.grantId,
                grantSecret: grant.grantSecret,
            }),
            /already linked/,
        );
        const check = await pool.connect();
        try {
            const kept = await check.query<{ user_id: string }>(
                `SELECT user_id FROM student_auth_identities WHERE provider = 'google' AND subject = $1 AND revoked_at IS NULL`,
                [subject],
            );
            assert.equal(kept.rows[0]!.user_id, ownerB.userId);
        } finally {
            check.release();
        }
    });
});

test('link fails closed on a replaced session', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let policy;
        let handoff;
        try {
            owner = await seedOwner(client, {});
            policy = await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!);
            handoff = await seedHandoff(
                client,
                attemptKey,
                policy,
                googleObservation(policy.realm, `oldsess-sub-${uniqueLabel()}`, owner.email),
            );
        } finally {
            client.release();
        }
        const grant = await mintGrant(service, owner.userId, owner.sid, PASSWORD);
        const check = await pool.connect();
        try {
            await check.query('UPDATE users SET active_session_id = $2 WHERE id = $1', [owner.userId, randomUUID()]);
        } finally {
            check.release();
        }
        await assert.rejects(
            service.link({
                userId: owner.userId,
                sid: owner.sid,
                handoffId: handoff.handoffId,
                handoffSecret: handoff.handoffSecret,
                browserCookies: cookiesFor(handoff.attemptId, handoff.cookieSecret),
                grantId: grant.grantId,
                grantSecret: grant.grantSecret,
            }),
            /no longer valid/,
        );
    });
});

test('link fails closed on a password change after reauth', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let policy;
        let handoff;
        try {
            owner = await seedOwner(client, {});
            policy = await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!);
            handoff = await seedHandoff(
                client,
                attemptKey,
                policy,
                googleObservation(policy.realm, `pwchange-sub-${uniqueLabel()}`, owner.email),
            );
        } finally {
            client.release();
        }
        const grant = await mintGrant(service, owner.userId, owner.sid, PASSWORD);
        const check = await pool.connect();
        try {
            await check.query('UPDATE users SET password_hash = $2, credential_generation = credential_generation + 1 WHERE id = $1', [
                owner.userId,
                await passwordService.hashPassword('Brand!new-password-4'),
            ]);
        } finally {
            check.release();
        }
        await assert.rejects(
            service.link({
                userId: owner.userId,
                sid: owner.sid,
                handoffId: handoff.handoffId,
                handoffSecret: handoff.handoffSecret,
                browserCookies: cookiesFor(handoff.attemptId, handoff.cookieSecret),
                grantId: grant.grantId,
                grantSecret: grant.grantSecret,
            }),
            /no longer valid/,
        );
    });
});

test('link refuses a provider disabled after the handoff was issued', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const client = await pool.connect();
        let owner;
        let policy;
        let handoff;
        try {
            owner = await seedOwner(client, {});
            policy = await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!);
            handoff = await seedHandoff(
                client,
                attemptKey,
                policy,
                googleObservation(policy.realm, `killswitch-sub-${uniqueLabel()}`, owner.email),
            );
        } finally {
            client.release();
        }
        // The aggregate gate stays on (the other provider keeps working);
        // only this handoff's provider is switched off mid-flight.
        const service = makeService(pool, attemptKey, { isProviderEnabled: () => false });
        const grant = await mintGrant(service, owner.userId, owner.sid, PASSWORD);
        await assert.rejects(
            service.link({
                userId: owner.userId,
                sid: owner.sid,
                handoffId: handoff.handoffId,
                handoffSecret: handoff.handoffSecret,
                browserCookies: cookiesFor(handoff.attemptId, handoff.cookieSecret),
                grantId: grant.grantId,
                grantSecret: grant.grantSecret,
            }),
            /no longer valid/,
        );
        // Nothing is consumed on the refused path: the grant survives for a
        // re-enabled provider, and the handoff is not spent.
        const check = await pool.connect();
        try {
            const leftovers = await check.query(
                `SELECT (SELECT consumed_at FROM student_auth_reauth_grants WHERE id = $1) AS grant_consumed,
                        (SELECT consumed_at FROM student_auth_link_handoffs WHERE id = $2) AS handoff_consumed`,
                [grant.grantId, handoff.handoffId],
            );
            assert.equal(leftovers.rows[0]!.grant_consumed, null);
            assert.equal(leftovers.rows[0]!.handoff_consumed, null);
        } finally {
            check.release();
        }
    });
});

test('policy invalidation after a grant is issued restarts without linking an identity', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let policy;
        let handoff;
        try {
            owner = await seedOwner(client, {});
            policy = await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!);
            handoff = await seedHandoff(client, attemptKey, policy, googleObservation(policy.realm, `policy-after-grant-${uniqueLabel()}`, owner.email));
        } finally { client.release(); }
        const grant = await mintGrant(service, owner.userId, owner.sid, PASSWORD);
        const invalidator = await pool.connect();
        try { await invalidator.query('UPDATE institution_login_policies SET enabled = false, version = version + 1 WHERE id = $1', [policy.id]); }
        finally { invalidator.release(); }
        const result = await service.link({ userId: owner.userId, sid: owner.sid, handoffId: handoff.handoffId, handoffSecret: handoff.handoffSecret, browserCookies: cookiesFor(handoff.attemptId, handoff.cookieSecret), grantId: grant.grantId, grantSecret: grant.grantSecret });
        assert.deepEqual(result, { outcome: 'restart', attemptId: handoff.attemptId });
        const check = await pool.connect();
        try {
            const identities = await check.query('SELECT 1 FROM student_auth_identities WHERE user_id = $1 AND revoked_at IS NULL', [owner.userId]);
            assert.equal(identities.rowCount, 0);
        } finally { check.release(); }
    });
});

test('action grant transition permits only consume-and-scrub and keeps terminal grants immutable', async () => {
    await withLinkPool(async (pool) => {
        const client = await pool.connect();
        try {
            const owner = await seedOwner(client, {});
            const secret = hashMicrosoftAttemptSecret(secretHex());
            const grantId = (await client.query<{ id: string }>(
                `INSERT INTO student_auth_action_grants
                     (user_id, sid, credential_generation, purpose, secret_hash, expires_at)
                 VALUES ($1, $2, 0, 'link', $3, clock_timestamp() + interval '5 minutes')
                 RETURNING id`,
                [owner.userId, owner.sid, secret],
            )).rows[0]!.id;
            await client.query(
                "UPDATE student_auth_action_grants SET consumed_at = clock_timestamp(), secret_hash = 'scrubbed' WHERE id = $1",
                [grantId],
            );
            await assert.rejects(
                client.query("UPDATE student_auth_action_grants SET purpose = 'unlink' WHERE id = $1", [grantId]),
                /immutable/,
            );
            await assert.rejects(
                client.query("UPDATE student_auth_action_grants SET secret_hash = 'different' WHERE id = $1", [grantId]),
                /Terminal passwordless action grants cannot be replayed/,
            );
            const unconsumedId = (await client.query<{ id: string }>(
                `INSERT INTO student_auth_action_grants
                     (user_id, sid, credential_generation, purpose, secret_hash, expires_at)
                 VALUES ($1, $2, 0, 'link', $3, clock_timestamp() + interval '5 minutes')
                 RETURNING id`,
                [owner.userId, owner.sid, hashMicrosoftAttemptSecret(secretHex())],
            )).rows[0]!.id;
            await assert.rejects(
                client.query('UPDATE student_auth_action_grants SET consumed_at = clock_timestamp() WHERE id = $1', [unconsumedId]),
                /Terminal passwordless action grants cannot be replayed/,
            );
        } finally { client.release(); }
    });
});

test('link rejects a stale grant and a reused grant', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let policy;
        let handoff;
        try {
            owner = await seedOwner(client, {});
            policy = await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!);
            handoff = await seedHandoff(
                client,
                attemptKey,
                policy,
                googleObservation(policy.realm, `stalegrant-sub-${uniqueLabel()}`, owner.email),
            );
            await client.query(
                `INSERT INTO student_auth_reauth_grants (id, user_id, sid, purpose, secret_hash, expires_at)
                 VALUES ($1, $2, $3, 'link', $4, clock_timestamp() - interval '1 minute')`,
                [randomUUID(), owner.userId, owner.sid, hashMicrosoftAttemptSecret(secretHex())],
            );
        } finally {
            client.release();
        }
        await assert.rejects(
            service.link({
                userId: owner.userId,
                sid: owner.sid,
                handoffId: handoff.handoffId,
                handoffSecret: handoff.handoffSecret,
                browserCookies: cookiesFor(handoff.attemptId, handoff.cookieSecret),
                grantId: randomUUID(),
                grantSecret: secretHex(),
            }),
            /no longer valid/,
        );
    });
});

test('link restarts on consumed and expired handoffs', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let policy;
        let consumed;
        let expired;
        try {
            owner = await seedOwner(client, {});
            policy = await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!);
            consumed = await seedHandoff(
                client,
                attemptKey,
                policy,
                googleObservation(policy.realm, `consumed-sub-${uniqueLabel()}`, owner.email),
                { consumed: true },
            );
            expired = await seedHandoff(
                client,
                attemptKey,
                policy,
                googleObservation(policy.realm, `expired-sub-${uniqueLabel()}`, owner.email),
                { expiresAt: new Date(Date.now() - 60_000).toISOString() },
            );
        } finally {
            client.release();
        }
        for (const handoff of [consumed, expired]) {
            const grant = await mintGrant(service, owner.userId, owner.sid, PASSWORD);
            const result = await service.link({
                userId: owner.userId,
                sid: owner.sid,
                handoffId: handoff.handoffId,
                handoffSecret: handoff.handoffSecret,
                browserCookies: cookiesFor(handoff.attemptId, handoff.cookieSecret),
                grantId: grant.grantId,
                grantSecret: grant.grantSecret,
            });
            assert.equal(result.outcome, 'restart');
            assert.equal(result.attemptId, handoff.attemptId);
        }
    });
});

test('link reactivates a revoked identity for the original owner only', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let policy;
        let handoff;
        const subject = `reactivate-sub-${uniqueLabel()}`;
        let identityId = '';
        try {
            owner = await seedOwner(client, {});
            policy = await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!);
            identityId = (await client.query<{ id: string }>(
                `INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject, revoked_at)
                 VALUES ($1, $2, 'google', $3, $4, clock_timestamp()) RETURNING id`,
                [owner.userId, owner.universityId, GOOGLE_ISSUER, subject],
            )).rows[0]!.id;
            handoff = await seedHandoff(
                client,
                attemptKey,
                policy,
                googleObservation(policy.realm, subject, owner.email),
            );
        } finally {
            client.release();
        }
        const grant = await mintGrant(service, owner.userId, owner.sid, PASSWORD);
        const result = await service.link({
            userId: owner.userId,
            sid: owner.sid,
            handoffId: handoff.handoffId,
            handoffSecret: handoff.handoffSecret,
            browserCookies: cookiesFor(handoff.attemptId, handoff.cookieSecret),
            grantId: grant.grantId,
            grantSecret: grant.grantSecret,
        });
        assert.equal(result.outcome, 'linked');
        if (result.outcome !== 'linked') throw new Error('Reactivation did not succeed');
        assert.equal(result.reactivated, true);
        assert.equal(result.identity.id, identityId);
        const check = await pool.connect();
        try {
            const row = await check.query<{ revoked_at: Date | null }>(
                'SELECT revoked_at FROM student_auth_identities WHERE id = $1',
                [identityId],
            );
            assert.equal(row.rows[0]!.revoked_at, null);
            const audit = await check.query(
                `SELECT 1 FROM verification_audit_events
                 WHERE user_id = $1 AND event_type = 'student_sso_identity_reactivated'`,
                [owner.userId],
            );
            assert.equal(audit.rowCount, 1);
        } finally {
            check.release();
        }
    });
});

test('link refuses a subject revoked for another owner without transferring it', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let ownerA;
        let ownerB;
        let policy;
        let handoff;
        const subject = `revoked-other-sub-${uniqueLabel()}`;
        try {
            ownerA = await seedOwner(client, {});
            ownerB = await seedOwner(client, { domain: ownerA.email.split('@')[1]! });
            policy = await seedPolicy(client, ownerA.universityId, ownerA.email.split('@')[1]!);
            await client.query(
                `INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject, revoked_at)
                 VALUES ($1, $2, 'google', $3, $4, clock_timestamp())`,
                [ownerB.userId, ownerB.universityId, GOOGLE_ISSUER, subject],
            );
            handoff = await seedHandoff(
                client,
                attemptKey,
                policy,
                googleObservation(policy.realm, subject, ownerA.email),
            );
        } finally {
            client.release();
        }
        const grant = await mintGrant(service, ownerA.userId, ownerA.sid, PASSWORD);
        await assert.rejects(
            service.link({
                userId: ownerA.userId,
                sid: ownerA.sid,
                handoffId: handoff.handoffId,
                handoffSecret: handoff.handoffSecret,
                browserCookies: cookiesFor(handoff.attemptId, handoff.cookieSecret),
                grantId: grant.grantId,
                grantSecret: grant.grantSecret,
            }),
            /already linked/,
        );
    });
});

async function seedMicrosoftMembership(
    client: PoolClient,
    owner: SeededOwner,
    adminId: string,
    tenantId: string,
): Promise<{ objectId: string }> {
    await client.query(
        `INSERT INTO institution_microsoft_policies
             (university_id, tenant_id, enabled, mode, approved_until, approved_by,
              term_ends_at, max_evidence_hours, scopes, notice_version)
         VALUES ($1, $2, true, 'graph_enrollment', clock_timestamp() + interval '30 days', $3,
                 clock_timestamp() + interval '20 days', 24,
                 ARRAY['https://graph.microsoft.com/EduRoster.ReadBasic', 'openid', 'profile'], 'microsoft-v2')`,
        [owner.universityId, tenantId, adminId],
    );
    // Membership binds the owner's live mailbox evidence: the attempt and
    // enrollment rows inherit its versions, mirroring the canonical
    // eligibility seed. Hardcoded versions never match the locked context.
    const email = (await client.query<{ email_proof_id: string; identity_version: number; policy_version: number }>(
        `SELECT email_proof_id, identity_version, policy_version FROM eligibility_evidence
         WHERE student_id = $1 AND method = 'student_email' AND revoked_at IS NULL
         ORDER BY verified_at DESC, id DESC LIMIT 1`,
        [owner.studentId],
    )).rows[0]!;
    const consentId = randomUUID();
    const identityId = randomUUID();
    const objectId = randomUUID();
    const attemptId = randomUUID();
    const proofId = randomUUID();
    await client.query(
        `INSERT INTO microsoft_verification_consents
             (id, user_id, university_id, processing_grant_id, provider_policy_version,
              notice_version, mode, scopes)
         VALUES ($1, $2, $3, $4, 1, 'microsoft-v2', 'graph_enrollment',
                 ARRAY['https://graph.microsoft.com/EduRoster.ReadBasic', 'openid', 'profile'])`,
        [consentId, owner.userId, owner.universityId, owner.grantId],
    );
    await client.query(
        `INSERT INTO microsoft_identities (id, user_id, university_id, tenant_id, object_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [identityId, owner.userId, owner.universityId, tenantId, objectId],
    );
    await client.query(
        `INSERT INTO microsoft_verification_attempts
             (id, user_id, university_id, institution_policy_version, provider_policy_version,
              identity_version, processing_grant_id, provider_consent_id, server_session_id,
              state_hash, browser_secret_hash, finish_secret_hash, expires_at, status, result)
         VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, 'browser', 'finish',
                 clock_timestamp() + interval '1 hour', 'ready', '{}')`,
        [attemptId, owner.userId, owner.universityId, email.policy_version, email.identity_version,
            owner.grantId, consentId, randomUUID(), secretHex()],
    );
    await client.query(
        `INSERT INTO microsoft_provider_proofs
             (id, user_id, university_id, provider_consent_id, identity_id,
              provider_policy_version, attempt_id, observed_at, outcome, source)
         VALUES ($1, $2, $3, $4, $5, 1, $6, clock_timestamp(), 'student', 'microsoft-education:v1')`,
        [proofId, owner.userId, owner.universityId, consentId, identityId, attemptId],
    );
    await client.query(
        `INSERT INTO eligibility_evidence
             (student_id, university_id, email_proof_id, processing_grant_id, provider_proof_id,
              method, outcome, identity_version, policy_version, source, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'enrollment', 'verified', $6, $7,
                 'microsoft-education:v1', clock_timestamp() + interval '24 hours')`,
        [owner.studentId, owner.universityId, email.email_proof_id, owner.grantId, proofId,
            email.identity_version, email.policy_version],
    );
    return { objectId };
}

test('link records a school assertion for microsoft with trusted membership', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let policy;
        let handoff;
        let adminId = '';
        try {
            owner = await seedOwner(client, {});
            adminId = (await client.query<{ id: string }>(
                `INSERT INTO users (email, role) VALUES ($1, 'admin') RETURNING id`,
                [`msadmin-${uniqueLabel()}@example.invalid`],
            )).rows[0]!.id;
            const membership = await seedMicrosoftMembership(client, owner, adminId, MICROSOFT_TENANT);
            policy = await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!, {
                provider: 'microsoft',
                realm: MICROSOFT_TENANT,
            });
            handoff = await seedHandoff(client, attemptKey, policy, {
                provider: 'microsoft',
                issuer: policy.issuer,
                subject: `ms-sub-${uniqueLabel()}`,
                email: owner.email,
                mailboxVerified: false,
                realm: MICROSOFT_TENANT,
                schoolMembershipAttested: false,
                // The returned identity is the one the evidence was issued
                // for: directory object id must match, not just the tenant.
                objectId: membership.objectId,
            });
        } finally {
            client.release();
        }
        const grant = await mintGrant(service, owner.userId, owner.sid, PASSWORD);
        // The shared membership predicate honors the production OIDC switch.
        const originalOidc = config.microsoftOidc.enabled;
        config.microsoftOidc.enabled = true;
        let result;
        try {
            result = await service.link({
                userId: owner.userId,
                sid: owner.sid,
                handoffId: handoff.handoffId,
                handoffSecret: handoff.handoffSecret,
                browserCookies: cookiesFor(handoff.attemptId, handoff.cookieSecret),
                grantId: grant.grantId,
                grantSecret: grant.grantSecret,
            });
        } finally {
            config.microsoftOidc.enabled = originalOidc;
        }
        assert.equal(result.outcome, 'linked');
        if (result.outcome !== 'linked') throw new Error('Microsoft link did not succeed');
        assert.equal(result.schoolAssertion, 'recorded');
    });
});

test('link with a different tenant identity records no school assertion', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let policy;
        let handoff;
        let adminId = '';
        try {
            owner = await seedOwner(client, {});
            adminId = (await client.query<{ id: string }>(
                `INSERT INTO users (email, role) VALUES ($1, 'admin') RETURNING id`,
                [`msadmin-${uniqueLabel()}@example.invalid`],
            )).rows[0]!.id;
            // A dedicated tenant: the shared suite database already holds
            // the constant tenant's policy from the sibling test.
            const tenant = randomUUID();
            await seedMicrosoftMembership(client, owner, adminId, tenant);
            policy = await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!, {
                provider: 'microsoft',
                realm: tenant,
            });
            // Membership evidence exists for another identity in the same
            // tenant; the returned identity supplied none, so the login
            // succeeds but stays unattested instead of borrowing it.
            handoff = await seedHandoff(client, attemptKey, policy, {
                provider: 'microsoft',
                issuer: policy.issuer,
                subject: `ms-other-${uniqueLabel()}`,
                email: owner.email,
                mailboxVerified: false,
                realm: tenant,
                schoolMembershipAttested: false,
                objectId: randomUUID(),
            });
        } finally {
            client.release();
        }
        const grant = await mintGrant(service, owner.userId, owner.sid, PASSWORD);
        const originalOidc = config.microsoftOidc.enabled;
        config.microsoftOidc.enabled = true;
        let result;
        try {
            result = await service.link({
                userId: owner.userId,
                sid: owner.sid,
                handoffId: handoff.handoffId,
                handoffSecret: handoff.handoffSecret,
                browserCookies: cookiesFor(handoff.attemptId, handoff.cookieSecret),
                grantId: grant.grantId,
                grantSecret: grant.grantSecret,
            });
        } finally {
            config.microsoftOidc.enabled = originalOidc;
        }
        assert.equal(result.outcome, 'linked');
        if (result.outcome !== 'linked') throw new Error('Microsoft link did not succeed');
        assert.equal(result.schoolAssertion, 'not_attested');
    });
});

test('link permits microsoft login without membership but records no assertion', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let policy;
        let handoff;
        try {
            owner = await seedOwner(client, {});
            policy = await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!, {
                provider: 'microsoft',
                realm: MICROSOFT_TENANT,
            });
            handoff = await seedHandoff(client, attemptKey, policy, {
                provider: 'microsoft',
                issuer: policy.issuer,
                subject: `ms-nomember-${uniqueLabel()}`,
                email: owner.email,
                mailboxVerified: false,
                realm: MICROSOFT_TENANT,
                schoolMembershipAttested: false,
                objectId: randomUUID(),
            });
        } finally {
            client.release();
        }
        const grant = await mintGrant(service, owner.userId, owner.sid, PASSWORD);
        const result = await service.link({
            userId: owner.userId,
            sid: owner.sid,
            handoffId: handoff.handoffId,
            handoffSecret: handoff.handoffSecret,
            browserCookies: cookiesFor(handoff.attemptId, handoff.cookieSecret),
            grantId: grant.grantId,
            grantSecret: grant.grantSecret,
        });
        assert.equal(result.outcome, 'linked');
        if (result.outcome !== 'linked') throw new Error('Microsoft link did not succeed');
        assert.equal(result.schoolAssertion, 'not_attested');
    });
});

test('link revalidates a revoked provider proof at grant consumption', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let policy;
        let handoff;
        let grantA: { grantId: string; grantSecret: string };
        let grantB: { grantId: string; grantSecret: string };
        try {
            owner = await seedOwner(client, {});
            policy = await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!, {
                provider: 'microsoft',
                realm: MICROSOFT_TENANT,
            });
            // Proof authority matches the mapping to the identity's own
            // mailbox domain, so the proofs observe the mapped mailbox.
            const proofA = (await client.query<{ id: string }>(
                `INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject, observed_email)
                 VALUES ($1, $2, 'microsoft', $3, $4, $5) RETURNING id`,
                [owner.userId, owner.universityId, policy.issuer, `proof-a-${uniqueLabel()}`, owner.email],
            )).rows[0]!.id;
            const proofB = (await client.query<{ id: string }>(
                `INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject, observed_email)
                 VALUES ($1, $2, 'microsoft', $3, $4, $5) RETURNING id`,
                [owner.userId, owner.universityId, policy.issuer, `proof-b-${uniqueLabel()}`, owner.email],
            )).rows[0]!.id;
            handoff = await seedHandoff(client, attemptKey, policy, {
                provider: 'microsoft',
                issuer: policy.issuer,
                subject: `ms-proof-${uniqueLabel()}`,
                email: owner.email,
                mailboxVerified: false,
                realm: MICROSOFT_TENANT,
                schoolMembershipAttested: false,
                objectId: randomUUID(),
            });
            grantA = await issueActionGrant(client, { userId: owner.userId, sid: owner.sid, purpose: 'link', credentialGeneration: 0, proofIdentityId: proofA });
            grantB = await issueActionGrant(client, { userId: owner.userId, sid: owner.sid, purpose: 'link', credentialGeneration: 0, proofIdentityId: proofB });
            // Revoke after issuance: the five-minute grant must not survive it.
            await client.query('UPDATE student_auth_identities SET revoked_at = clock_timestamp() WHERE id = $1', [proofA]);
        } finally {
            client.release();
        }
        const attempt = (grant: { grantId: string; grantSecret: string }) => service.link({
            userId: owner.userId,
            sid: owner.sid,
            handoffId: handoff.handoffId,
            handoffSecret: handoff.handoffSecret,
            browserCookies: cookiesFor(handoff.attemptId, handoff.cookieSecret),
            grantId: grant.grantId,
            grantSecret: grant.grantSecret,
        });
        await assert.rejects(() => attempt(grantA), /no longer valid/,
            'a provider proof revoked mid-grant must not authorize linking another identity');
        // The failed consumption spent neither the handoff nor the live grant.
        const result = await attempt(grantB);
        assert.equal(result.outcome, 'linked');
    });
});

test('unlink revalidates a revoked provider proof at grant consumption', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let target: string;
        let grant: { grantId: string; grantSecret: string };
        try {
            owner = await seedOwner(client, {});
            // The proof revalidation requires a live policy for the proof
            // identity's exact university, provider, and issuer.
            await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!);
            const proof = (await client.query<{ id: string }>(
                `INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject)
                 VALUES ($1, $2, 'google', $3, $4) RETURNING id`,
                [owner.userId, owner.universityId, GOOGLE_ISSUER, `proof-${uniqueLabel()}`],
            )).rows[0]!.id;
            target = (await client.query<{ id: string }>(
                `INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject)
                 VALUES ($1, $2, 'google', $3, $4) RETURNING id`,
                [owner.userId, owner.universityId, GOOGLE_ISSUER, `target-${uniqueLabel()}`],
            )).rows[0]!.id;
            grant = await issueActionGrant(client, { userId: owner.userId, sid: owner.sid, purpose: 'unlink', credentialGeneration: 0, proofIdentityId: proof, targetIdentityId: target });
            await client.query('UPDATE student_auth_identities SET revoked_at = clock_timestamp() WHERE id = $1', [proof]);
        } finally {
            client.release();
        }
        await assert.rejects(
            () => service.unlink({ userId: owner.userId, sid: owner.sid, identityId: target, grantId: grant.grantId, grantSecret: grant.grantSecret }),
            /no longer valid/,
            'a provider proof revoked mid-grant must not authorize removing another identity',
        );
        const check = await pool.connect();
        try {
            const kept = await check.query<{ revoked_at: Date | null }>(
                'SELECT revoked_at FROM student_auth_identities WHERE id = $1', [target],
            );
            assert.equal(kept.rows[0]!.revoked_at, null);
        } finally {
            check.release();
        }
    });
});

async function linkIdentity(
    service: StudentSsoLinkService,
    owner: SeededOwner,
    handoff: SeededHandoff,
): Promise<string> {
    const grant = await mintGrant(service, owner.userId, owner.sid, PASSWORD);
    const result = await service.link({
        userId: owner.userId,
        sid: owner.sid,
        handoffId: handoff.handoffId,
        handoffSecret: handoff.handoffSecret,
        browserCookies: cookiesFor(handoff.attemptId, handoff.cookieSecret),
        grantId: grant.grantId,
        grantSecret: grant.grantSecret,
    });
    assert.equal(result.outcome, 'linked');
    if (result.outcome !== 'linked') throw new Error('Setup link did not succeed');
    return result.identity.id;
}

test('unlink revokes the identity and clears only its own session', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let policy;
        let handoff;
        try {
            owner = await seedOwner(client, {});
            policy = await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!);
            handoff = await seedHandoff(
                client,
                attemptKey,
                policy,
                googleObservation(policy.realm, `unlink-sub-${uniqueLabel()}`, owner.email),
            );
        } finally {
            client.release();
        }
        const identityId = await linkIdentity(service, owner, handoff);
        // Stage the current session as issued by the linked identity: unlink
        // clears a session only when it belongs to the removed identity.
        const attributer = await pool.connect();
        try {
            await attributer.query('UPDATE users SET active_session_auth_identity_id = $2 WHERE id = $1', [
                owner.userId,
                identityId,
            ]);
        } finally {
            attributer.release();
        }
        const grant = await mintGrant(service, owner.userId, owner.sid, PASSWORD, 'unlink', identityId);
        const result = await service.unlink({
            userId: owner.userId,
            sid: owner.sid,
            identityId,
            grantId: grant.grantId,
            grantSecret: grant.grantSecret,
        });
        assert.deepEqual(result, { unlinked: true, sessionRevoked: true });
        const check = await pool.connect();
        try {
            const identity = await check.query<{ revoked_at: Date | null }>(
                'SELECT revoked_at FROM student_auth_identities WHERE id = $1',
                [identityId],
            );
            assert.notEqual(identity.rows[0]!.revoked_at, null);
            const assertions = await check.query(
                `SELECT 1 FROM student_school_assertions WHERE auth_identity_id = $1 AND revoked_at IS NULL`,
                [identityId],
            );
            assert.equal(assertions.rowCount, 0);
            const account = await check.query<{
                active_session_id: string | null;
                refresh_token_hash: string | null;
                active_session_auth_identity_id: string | null;
            }>(
                'SELECT active_session_id, refresh_token_hash, active_session_auth_identity_id FROM users WHERE id = $1',
                [owner.userId],
            );
            assert.equal(account.rows[0]!.active_session_id, null);
            assert.equal(account.rows[0]!.refresh_token_hash, null);
            assert.equal(account.rows[0]!.active_session_auth_identity_id, null);
            const consents = await check.query('SELECT 1 FROM verification_consents WHERE user_id = $1', [owner.userId]);
            assert.ok((consents.rowCount ?? 0) > 0);
            const audit = await check.query(
                `SELECT 1 FROM verification_audit_events
                 WHERE user_id = $1 AND event_type = 'student_sso_identity_unlinked'`,
                [owner.userId],
            );
            assert.equal(audit.rowCount, 1);
        } finally {
            check.release();
        }
    });
});

test('unlink preserves a session issued by another method', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let policy;
        let handoff;
        let otherHandoff;
        try {
            owner = await seedOwner(client, {});
            policy = await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!);
            handoff = await seedHandoff(
                client,
                attemptKey,
                policy,
                googleObservation(policy.realm, `unlink-other-sub-${uniqueLabel()}`, owner.email),
            );
            otherHandoff = await seedHandoff(
                client,
                attemptKey,
                policy,
                googleObservation(policy.realm, `unlink-keeper-sub-${uniqueLabel()}`, owner.email),
            );
        } finally {
            client.release();
        }
        const identityId = await linkIdentity(service, owner, handoff);
        // The surviving session belongs to a second live identity: the
        // pointer must reference a real row, and unlinking the first
        // identity must leave both the session and the pointer intact.
        const keeperId = await linkIdentity(service, owner, otherHandoff);
        const check = await pool.connect();
        try {
            await check.query(
                'UPDATE users SET active_session_auth_identity_id = $2 WHERE id = $1',
                [owner.userId, keeperId],
            );
        } finally {
            check.release();
        }
        const grant = await mintGrant(service, owner.userId, owner.sid, PASSWORD, 'unlink', identityId);
        const result = await service.unlink({
            userId: owner.userId,
            sid: owner.sid,
            identityId,
            grantId: grant.grantId,
            grantSecret: grant.grantSecret,
        });
        assert.deepEqual(result, { unlinked: true, sessionRevoked: false });
        const verify = await pool.connect();
        try {
            const account = await verify.query<{
                active_session_id: string | null;
                active_session_auth_identity_id: string | null;
            }>(
                'SELECT active_session_id, active_session_auth_identity_id FROM users WHERE id = $1',
                [owner.userId],
            );
            assert.equal(account.rows[0]!.active_session_id, owner.sid);
            assert.equal(account.rows[0]!.active_session_auth_identity_id, keeperId);
        } finally {
            verify.release();
        }
    });
});

test('unlink refuses the last login method without revoking anything', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let policy;
        let handoff;
        try {
            owner = await seedOwner(client, {});
            policy = await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!);
            handoff = await seedHandoff(
                client,
                attemptKey,
                policy,
                googleObservation(policy.realm, `unlink-last-sub-${uniqueLabel()}`, owner.email),
            );
        } finally {
            client.release();
        }
        const identityId = await linkIdentity(service, owner, handoff);
        const remover = await pool.connect();
        try {
            await remover.query('UPDATE users SET password_hash = NULL WHERE id = $1', [owner.userId]);
        } finally {
            remover.release();
        }
        const unlinkSecret = secretHex();
        const inserter = await pool.connect();
        let grantId = '';
        try {
            grantId = (await inserter.query<{ id: string }>(
                `INSERT INTO student_auth_action_grants (user_id, sid, credential_generation, purpose, secret_hash, target_identity_id, expires_at)
                 VALUES ($1, $2, 0, 'unlink', $3, $4, clock_timestamp() + interval '5 minutes') RETURNING id`,
                [owner.userId, owner.sid, hashMicrosoftAttemptSecret(unlinkSecret), identityId],
            )).rows[0]!.id;
        } finally {
            inserter.release();
        }
        const grant = { grantId, grantSecret: unlinkSecret };
        const result = await service.unlink({
            userId: owner.userId,
            sid: owner.sid,
            identityId,
            grantId: grant.grantId,
            grantSecret: grant.grantSecret,
        });
        assert.deepEqual(result, { outcome: 'last_method' });
        const check = await pool.connect();
        try {
            const row = await check.query<{ revoked_at: Date | null }>(
                'SELECT revoked_at FROM student_auth_identities WHERE id = $1',
                [identityId],
            );
            assert.equal(row.rows[0]!.revoked_at, null);
        } finally {
            check.release();
        }
    });

});

test('unlink treats a legacy empty password hash as no password', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let policy;
        let handoff;
        try {
            owner = await seedOwner(client, {});
            policy = await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!);
            handoff = await seedHandoff(
                client,
                attemptKey,
                policy,
                googleObservation(policy.realm, `unlink-empty-sub-${uniqueLabel()}`, owner.email),
            );
        } finally {
            client.release();
        }
        const identityId = await linkIdentity(service, owner, handoff);
        const remover = await pool.connect();
        try {
            await remover.query('UPDATE users SET password_hash = \'\' WHERE id = $1', [owner.userId]);
        } finally {
            remover.release();
        }
        const unlinkSecret = secretHex();
        const inserter = await pool.connect();
        let grantId = '';
        try {
            grantId = (await inserter.query<{ id: string }>(
                `INSERT INTO student_auth_action_grants (user_id, sid, credential_generation, purpose, secret_hash, target_identity_id, expires_at)
                 VALUES ($1, $2, 0, 'unlink', $3, $4, clock_timestamp() + interval '5 minutes') RETURNING id`,
                [owner.userId, owner.sid, hashMicrosoftAttemptSecret(unlinkSecret), identityId],
            )).rows[0]!.id;
        } finally {
            inserter.release();
        }
        const result = await service.unlink({
            userId: owner.userId,
            sid: owner.sid,
            identityId,
            grantId,
            grantSecret: unlinkSecret,
        });
        assert.deepEqual(result, { outcome: 'last_method' });
        const check = await pool.connect();
        try {
            const row = await check.query<{ revoked_at: Date | null }>(
                'SELECT revoked_at FROM student_auth_identities WHERE id = $1',
                [identityId],
            );
            assert.equal(row.rows[0]!.revoked_at, null);
        } finally {
            check.release();
        }
    });

});

test('a refused last-method removal preserves the grant for retry', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let identityId = '';
        try {
            owner = await seedOwner(client, {});
            const policy = await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!);
            identityId = (await client.query<{ id: string }>(
                `INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject)
                 VALUES ($1, $2, 'google', $3, $4) RETURNING id`,
                [owner.userId, owner.universityId, policy.issuer, `retry-sub-${uniqueLabel()}`],
            )).rows[0]!.id;
        } finally {
            client.release();
        }
        const grant = await mintGrant(service, owner.userId, owner.sid, PASSWORD, 'unlink', identityId);
        const editor = await pool.connect();
        try {
            await editor.query('UPDATE users SET password_hash = NULL WHERE id = $1', [owner.userId]);
        } finally {
            editor.release();
        }
        assert.deepEqual(await service.unlink({
            userId: owner.userId, sid: owner.sid, identityId, grantId: grant.grantId, grantSecret: grant.grantSecret,
        }), { outcome: 'last_method' });
        const liveness = await pool.connect();
        try {
            const row = await liveness.query<{ consumed_at: Date | null }>(
                'SELECT consumed_at FROM student_auth_action_grants WHERE id = $1', [grant.grantId],
            );
            assert.equal(row.rows[0]!.consumed_at, null, 'the guard must not spend the target-bound grant');
            // The user adds another method, then retries with the same grant.
            await liveness.query('UPDATE users SET password_hash = $2 WHERE id = $1', [owner.userId, 'restored-hash']);
        } finally {
            liveness.release();
        }
        assert.deepEqual(await service.unlink({
            userId: owner.userId, sid: owner.sid, identityId, grantId: grant.grantId, grantSecret: grant.grantSecret,
        }), { unlinked: true, sessionRevoked: false });
    });
});

test('unlink keeps the last Microsoft identity on a passwordless account but releases Google', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let microsoftId = '';
        let googleId = '';
        try {
            owner = await seedOwner(client, {});
            const domain = owner.email.split('@')[1]!;
            const googlePolicy = await seedPolicy(client, owner.universityId, domain);
            // A second provider needs its own domain mapping row.
            const microsoftPolicy = await seedPolicy(client, owner.universityId, `ms-${uniqueLabel()}.school.example`, {
                provider: 'microsoft', realm: MICROSOFT_TENANT,
            });
            microsoftId = (await client.query<{ id: string }>(
                `INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject)
                 VALUES ($1, $2, 'microsoft', $3, $4) RETURNING id`,
                [owner.userId, owner.universityId, microsoftPolicy.issuer, `proof-ms-sub-${uniqueLabel()}`],
            )).rows[0]!.id;
            googleId = (await client.query<{ id: string }>(
                `INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject)
                 VALUES ($1, $2, 'google', $3, $4) RETURNING id`,
                [owner.userId, owner.universityId, googlePolicy.issuer, `proof-google-sub-${uniqueLabel()}`],
            )).rows[0]!.id;
        } finally {
            client.release();
        }
        const microsoftGrant = await mintGrant(service, owner.userId, owner.sid, PASSWORD, 'unlink', microsoftId);
        const googleGrant = await mintGrant(service, owner.userId, owner.sid, PASSWORD, 'unlink', googleId);
        const editor = await pool.connect();
        try {
            await editor.query('UPDATE users SET password_hash = NULL WHERE id = $1', [owner.userId]);
        } finally {
            editor.release();
        }
        // Google stays a usable login, so last_method would pass — but
        // every fresh-proof action needs a live Microsoft identity, and a
        // null password cannot reauthenticate. The removal waits.
        assert.deepEqual(await service.unlink({
            userId: owner.userId, sid: owner.sid, identityId: microsoftId,
            grantId: microsoftGrant.grantId, grantSecret: microsoftGrant.grantSecret,
        }), { outcome: 'last_proof_method' });
        const liveness = await pool.connect();
        try {
            const grant = await liveness.query<{ consumed_at: Date | null }>(
                'SELECT consumed_at FROM student_auth_action_grants WHERE id = $1', [microsoftGrant.grantId],
            );
            assert.equal(grant.rows[0]!.consumed_at, null, 'the proof guard must not spend the target-bound grant');
            const identity = await liveness.query<{ revoked_at: Date | null }>(
                'SELECT revoked_at FROM student_auth_identities WHERE id = $1', [microsoftId],
            );
            assert.equal(identity.rows[0]!.revoked_at, null);
        } finally {
            liveness.release();
        }
        // Removing Google instead leaves Microsoft for fresh proof: allowed.
        assert.deepEqual(await service.unlink({
            userId: owner.userId, sid: owner.sid, identityId: googleId,
            grantId: googleGrant.grantId, grantSecret: googleGrant.grantSecret,
        }), { unlinked: true, sessionRevoked: false });
    });
});

test('unlink ignores a sibling from a replaced tenant when guarding the last login method', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let policy;
        let identityId = '';
        try {
            owner = await seedOwner(client, {});
            policy = await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!, { provider: 'microsoft' });
            identityId = (await client.query<{ id: string }>(
                `INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject)
                 VALUES ($1, $2, 'microsoft', $3, $4) RETURNING id`,
                [owner.userId, owner.universityId, policy.issuer, `current-sub-${uniqueLabel()}`],
            )).rows[0]!.id;
            await client.query(
                `INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject)
                 VALUES ($1, $2, 'microsoft', $3, $4)`,
                [owner.userId, owner.universityId, `https://login.microsoftonline.com/old-tenant-${uniqueLabel()}/v2.0`, `stale-sub-${uniqueLabel()}`],
            );
        } finally {
            client.release();
        }
        // Proof precedes the destructive precondition: the grant pins the
        // credential generation, and the password is removed only after.
        const grant = await mintGrant(service, owner.userId, owner.sid, PASSWORD, 'unlink', identityId);
        const remover = await pool.connect();
        try {
            await remover.query('UPDATE users SET password_hash = NULL WHERE id = $1', [owner.userId]);
        } finally {
            remover.release();
        }
        const result = await service.unlink({
            userId: owner.userId,
            sid: owner.sid,
            identityId,
            grantId: grant.grantId,
            grantSecret: grant.grantSecret,
        });
        assert.deepEqual(result, { outcome: 'last_method' });
    });
});

test('unlink of another owner identity reports not found', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let ownerA;
        let ownerB;
        let identityId = '';
        let ownerIdentityId = '';
        try {
            ownerA = await seedOwner(client, {});
            ownerB = await seedOwner(client, { domain: ownerA.email.split('@')[1]! });
            identityId = (await client.query<{ id: string }>(
                `INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject)
                 VALUES ($1, $2, 'google', $3, $4) RETURNING id`,
                [ownerB.userId, ownerB.universityId, GOOGLE_ISSUER, `other-owner-sub-${uniqueLabel()}`],
            )).rows[0]!.id;
            ownerIdentityId = (await client.query<{ id: string }>(
                `INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject)
                 VALUES ($1, $2, 'google', $3, $4) RETURNING id`,
                [ownerA.userId, ownerA.universityId, GOOGLE_ISSUER, `owner-sub-${uniqueLabel()}`],
            )).rows[0]!.id;
        } finally {
            client.release();
        }
        const grant = await mintGrant(service, ownerA.userId, ownerA.sid, PASSWORD, 'unlink', ownerIdentityId);
        await assert.rejects(
            service.unlink({
                userId: ownerA.userId,
                sid: ownerA.sid,
                identityId,
                grantId: grant.grantId,
                grantSecret: grant.grantSecret,
            }),
            /not found/,
        );
    });
});

test('reauth issuance rejects foreign, missing, and revoked action targets without a grant', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let ownerA;
        let ownerB;
        let foreignIdentity = '';
        let revokedIdentity = '';
        let foreignCode = '';
        let ownCode = '';
        try {
            ownerA = await seedOwner(client, {});
            ownerB = await seedOwner(client, { domain: ownerA.email.split('@')[1]! });
            foreignIdentity = (await client.query<{ id: string }>(
                `INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject)
                 VALUES ($1, $2, 'google', $3, $4) RETURNING id`,
                [ownerB.userId, ownerB.universityId, GOOGLE_ISSUER, `foreign-sub-${uniqueLabel()}`],
            )).rows[0]!.id;
            revokedIdentity = (await client.query<{ id: string }>(
                `INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject, revoked_at)
                 VALUES ($1, $2, 'google', $3, $4, clock_timestamp()) RETURNING id`,
                [ownerA.userId, ownerA.universityId, GOOGLE_ISSUER, `revoked-sub-${uniqueLabel()}`],
            )).rows[0]!.id;
            foreignCode = (await client.query<{ id: string }>(
                `INSERT INTO student_auth_recovery_codes (user_id, generation, code_digest, status, activated_at)
                 VALUES ($1, 1, 'foreign-digest', 'active', clock_timestamp()) RETURNING id`,
                [ownerB.userId],
            )).rows[0]!.id;
            ownCode = (await client.query<{ id: string }>(
                `INSERT INTO student_auth_recovery_codes (user_id, generation, code_digest, status, activated_at)
                 VALUES ($1, 1, 'own-digest', 'active', clock_timestamp()) RETURNING id`,
                [ownerA.userId],
            )).rows[0]!.id;
        } finally {
            client.release();
        }
        const notFound = (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND';
        await assert.rejects(
            service.reauth({ userId: ownerA.userId, sid: ownerA.sid, password: PASSWORD, purpose: 'unlink', targetIdentityId: foreignIdentity }),
            notFound,
        );
        await assert.rejects(
            service.reauth({ userId: ownerA.userId, sid: ownerA.sid, password: PASSWORD, purpose: 'unlink', targetIdentityId: randomUUID() }),
            notFound,
        );
        await assert.rejects(
            service.reauth({ userId: ownerA.userId, sid: ownerA.sid, password: PASSWORD, purpose: 'unlink', targetIdentityId: revokedIdentity }),
            notFound,
        );
        await assert.rejects(
            service.reauth({ userId: ownerA.userId, sid: ownerA.sid, password: PASSWORD, purpose: 'recovery_code_activate', pendingCodeId: foreignCode }),
            notFound,
        );
        // Owned targets still issue.
        const issued = await service.reauth({ userId: ownerA.userId, sid: ownerA.sid, password: PASSWORD, purpose: 'recovery_code_activate', pendingCodeId: ownCode });
        assert.ok(issued.grantId);
    });
});

test('concurrent unlink attempts serialize to a single revocation', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let policy;
        let handoff;
        try {
            owner = await seedOwner(client, {});
            policy = await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!);
            handoff = await seedHandoff(
                client,
                attemptKey,
                policy,
                googleObservation(policy.realm, `unlink-race-sub-${uniqueLabel()}`, owner.email),
            );
        } finally {
            client.release();
        }
        const identityId = await linkIdentity(service, owner, handoff);
        const grantA = await mintGrant(service, owner.userId, owner.sid, PASSWORD, 'unlink', identityId);
        const grantB = await mintGrant(service, owner.userId, owner.sid, PASSWORD, 'unlink', identityId);
        const outcomes = await Promise.allSettled([
            service.unlink({
                userId: owner.userId,
                sid: owner.sid,
                identityId,
                grantId: grantA.grantId,
                grantSecret: grantA.grantSecret,
            }),
            service.unlink({
                userId: owner.userId,
                sid: owner.sid,
                identityId,
                grantId: grantB.grantId,
                grantSecret: grantB.grantSecret,
            }),
        ]);
        const succeeded = outcomes.filter(
            (outcome): outcome is PromiseFulfilledResult<{ unlinked: true; sessionRevoked: boolean }> =>
                outcome.status === 'fulfilled' && 'unlinked' in outcome.value && outcome.value.unlinked === true,
        );
        assert.equal(succeeded.length, 1);
    });
});

test('concurrent removal of the final two methods leaves one usable identity', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let first = '';
        let second = '';
        try {
            owner = await seedOwner(client, {});
            await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!);
            first = (await client.query<{ id: string }>(`INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject) VALUES ($1, $2, 'google', $3, $4) RETURNING id`, [owner.userId, owner.universityId, GOOGLE_ISSUER, `last-a-${uniqueLabel()}`])).rows[0]!.id;
            second = (await client.query<{ id: string }>(`INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject) VALUES ($1, $2, 'google', $3, $4) RETURNING id`, [owner.userId, owner.universityId, GOOGLE_ISSUER, `last-b-${uniqueLabel()}`])).rows[0]!.id;
        } finally { client.release(); }
        const grantA = await mintGrant(service, owner.userId, owner.sid, PASSWORD, 'unlink', first);
        const grantB = await mintGrant(service, owner.userId, owner.sid, PASSWORD, 'unlink', second);
        const remover = await pool.connect();
        try { await remover.query('UPDATE users SET password_hash = NULL WHERE id = $1', [owner.userId]); }
        finally { remover.release(); }
        const results = await Promise.allSettled([
            service.unlink({ userId: owner.userId, sid: owner.sid, identityId: first, grantId: grantA.grantId, grantSecret: grantA.grantSecret }),
            service.unlink({ userId: owner.userId, sid: owner.sid, identityId: second, grantId: grantB.grantId, grantSecret: grantB.grantSecret }),
        ]);
        assert.equal(results.filter((result) => result.status === 'fulfilled' && 'unlinked' in result.value).length, 1);
        const check = await pool.connect();
        try {
            const active = await check.query('SELECT 1 FROM student_auth_identities WHERE user_id = $1 AND revoked_at IS NULL', [owner.userId]);
            assert.equal(active.rowCount, 1);
        } finally { check.release(); }
    });
});

test('reauth mints a usable grant with the real password check', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        try {
            owner = await seedOwner(client, {});
        } finally {
            client.release();
        }
        const result = await service.reauth({ userId: owner.userId, sid: owner.sid, password: PASSWORD, purpose: 'link' });
        assert.ok(result.grantId);
        assert.ok(result.grantSecret);
        await assert.rejects(
            service.reauth({ userId: owner.userId, sid: owner.sid, password: 'Wrong!password-0', purpose: 'link' }),
            /incorrect/,
        );
    });
});

test('unlink keeps the last method when the sibling policy expired', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let first = '';
        let second = '';
        try {
            owner = await seedOwner(client, {});
            await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!, { approvedUntil: new Date(Date.now() - 1000).toISOString() });
            first = (await client.query<{ id: string }>(`INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject) VALUES ($1, $2, 'google', $3, $4) RETURNING id`, [owner.userId, owner.universityId, GOOGLE_ISSUER, `expired-a-${uniqueLabel()}`])).rows[0]!.id;
            second = (await client.query<{ id: string }>(`INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject) VALUES ($1, $2, 'google', $3, $4) RETURNING id`, [owner.userId, owner.universityId, GOOGLE_ISSUER, `expired-b-${uniqueLabel()}`])).rows[0]!.id;
        } finally { client.release(); }
        const grantA = await mintGrant(service, owner.userId, owner.sid, PASSWORD, 'unlink', first);
        const grantB = await mintGrant(service, owner.userId, owner.sid, PASSWORD, 'unlink', second);
        const remover = await pool.connect();
        try { await remover.query('UPDATE users SET password_hash = NULL WHERE id = $1', [owner.userId]); }
        finally { remover.release(); }
        assert.deepEqual(await service.unlink({ userId: owner.userId, sid: owner.sid, identityId: first, grantId: grantA.grantId, grantSecret: grantA.grantSecret }), { outcome: 'last_method' });
        assert.deepEqual(await service.unlink({ userId: owner.userId, sid: owner.sid, identityId: second, grantId: grantB.grantId, grantSecret: grantB.grantSecret }), { outcome: 'last_method' });
        const check = await pool.connect();
        try {
            const active = await check.query('SELECT 1 FROM student_auth_identities WHERE user_id = $1 AND revoked_at IS NULL', [owner.userId]);
            assert.equal(active.rowCount, 2);
        } finally { check.release(); }
    });
});

test('unlink keeps the last method when the sibling provider is disabled', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let first = '';
        let second = '';
        try {
            owner = await seedOwner(client, {});
            await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!);
            first = (await client.query<{ id: string }>(`INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject) VALUES ($1, $2, 'google', $3, $4) RETURNING id`, [owner.userId, owner.universityId, GOOGLE_ISSUER, `disabled-a-${uniqueLabel()}`])).rows[0]!.id;
            second = (await client.query<{ id: string }>(`INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject) VALUES ($1, $2, 'google', $3, $4) RETURNING id`, [owner.userId, owner.universityId, GOOGLE_ISSUER, `disabled-b-${uniqueLabel()}`])).rows[0]!.id;
        } finally { client.release(); }
        const grantA = await mintGrant(service, owner.userId, owner.sid, PASSWORD, 'unlink', first);
        const grantB = await mintGrant(service, owner.userId, owner.sid, PASSWORD, 'unlink', second);
        const remover = await pool.connect();
        try { await remover.query('UPDATE users SET password_hash = NULL WHERE id = $1', [owner.userId]); }
        finally { remover.release(); }
        const gated = makeService(pool, attemptKey, { isProviderEnabled: () => false });
        assert.deepEqual(await gated.unlink({ userId: owner.userId, sid: owner.sid, identityId: first, grantId: grantA.grantId, grantSecret: grantA.grantSecret }), { outcome: 'last_method' });
        assert.deepEqual(await gated.unlink({ userId: owner.userId, sid: owner.sid, identityId: second, grantId: grantB.grantId, grantSecret: grantB.grantSecret }), { outcome: 'last_method' });
        const check = await pool.connect();
        try {
            const active = await check.query('SELECT 1 FROM student_auth_identities WHERE user_id = $1 AND revoked_at IS NULL', [owner.userId]);
            assert.equal(active.rowCount, 2);
        } finally { check.release(); }
    });
});

test('unlink keeps the last method when the sibling domain mapping is withdrawn', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let first = '';
        let second = '';
        try {
            owner = await seedOwner(client, {});
            const domain = owner.email.split('@')[1]!;
            await seedPolicy(client, owner.universityId, domain);
            // The policy row stays live while login discovery rejects the
            // domain: the sibling cannot authenticate, so it must not
            // satisfy the last-method guard.
            await client.query('UPDATE institution_login_domains SET is_active = false WHERE domain = $1 AND university_id = $2', [domain, owner.universityId]);
            first = (await client.query<{ id: string }>(`INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject) VALUES ($1, $2, 'google', $3, $4) RETURNING id`, [owner.userId, owner.universityId, GOOGLE_ISSUER, `withdrawn-a-${uniqueLabel()}`])).rows[0]!.id;
            second = (await client.query<{ id: string }>(`INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject) VALUES ($1, $2, 'google', $3, $4) RETURNING id`, [owner.userId, owner.universityId, GOOGLE_ISSUER, `withdrawn-b-${uniqueLabel()}`])).rows[0]!.id;
        } finally { client.release(); }
        const grantA = await mintGrant(service, owner.userId, owner.sid, PASSWORD, 'unlink', first);
        const grantB = await mintGrant(service, owner.userId, owner.sid, PASSWORD, 'unlink', second);
        const remover = await pool.connect();
        try { await remover.query('UPDATE users SET password_hash = NULL WHERE id = $1', [owner.userId]); }
        finally { remover.release(); }
        assert.deepEqual(await service.unlink({ userId: owner.userId, sid: owner.sid, identityId: first, grantId: grantA.grantId, grantSecret: grantA.grantSecret }), { outcome: 'last_method' });
        assert.deepEqual(await service.unlink({ userId: owner.userId, sid: owner.sid, identityId: second, grantId: grantB.grantId, grantSecret: grantB.grantSecret }), { outcome: 'last_method' });
        const check = await pool.connect();
        try {
            const active = await check.query('SELECT 1 FROM student_auth_identities WHERE user_id = $1 AND revoked_at IS NULL', [owner.userId]);
            assert.equal(active.rowCount, 2);
        } finally { check.release(); }
    });
});

test('unlink keeps the last method when the sibling university is deactivated', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let first = '';
        let second = '';
        let siblingUniversityId = '';
        try {
            owner = await seedOwner(client, {});
            await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!);
            first = (await client.query<{ id: string }>(`INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject) VALUES ($1, $2, 'google', $3, $4) RETURNING id`, [owner.userId, owner.universityId, GOOGLE_ISSUER, `deactivated-a-${uniqueLabel()}`])).rows[0]!.id;
            siblingUniversityId = (await client.query<{ id: string }>(
                'INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id',
                [`Sibling School ${uniqueLabel()}`],
            )).rows[0]!.id;
            await seedPolicy(client, siblingUniversityId, `sibling${uniqueLabel()}.school.example`);
            second = (await client.query<{ id: string }>(`INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject) VALUES ($1, $2, 'google', $3, $4) RETURNING id`, [owner.userId, siblingUniversityId, GOOGLE_ISSUER, `deactivated-b-${uniqueLabel()}`])).rows[0]!.id;
        } finally { client.release(); }
        const grantA = await mintGrant(service, owner.userId, owner.sid, PASSWORD, 'unlink', first);
        const grantB = await mintGrant(service, owner.userId, owner.sid, PASSWORD, 'unlink', second);
        const remover = await pool.connect();
        try {
            await remover.query('UPDATE users SET password_hash = NULL WHERE id = $1', [owner.userId]);
            // The canonical university stays active while the sibling's
            // university is deactivated with its policy row intact: login
            // through the sibling is impossible, so removing the live
            // identity must refuse as the last method.
            await remover.query('UPDATE universities SET is_active = false WHERE id = $1', [siblingUniversityId]);
        }
        finally { remover.release(); }
        assert.deepEqual(await service.unlink({ userId: owner.userId, sid: owner.sid, identityId: first, grantId: grantA.grantId, grantSecret: grantA.grantSecret }), { outcome: 'last_method' });
        // The reverse direction still succeeds: the live sibling satisfies
        // the guard, so the dead identity can be removed.
        const removed = await service.unlink({ userId: owner.userId, sid: owner.sid, identityId: second, grantId: grantB.grantId, grantSecret: grantB.grantSecret });
        assert.ok(!('outcome' in removed) && removed.unlinked === true);
        const check = await pool.connect();
        try {
            const active = await check.query('SELECT id FROM student_auth_identities WHERE user_id = $1 AND revoked_at IS NULL', [owner.userId]);
            assert.deepEqual(active.rows.map(row => row.id), [first]);
        } finally { check.release(); }
    });
});

test('unlink ignores a sibling outside the canonical university when guarding the last login method', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let first = '';
        let second = '';
        try {
            owner = await seedOwner(client, {});
            await seedPolicy(client, owner.universityId, owner.email.split('@')[1]!);
            first = (await client.query<{ id: string }>(`INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject) VALUES ($1, $2, 'google', $3, $4) RETURNING id`, [owner.userId, owner.universityId, GOOGLE_ISSUER, `canonical-a-${uniqueLabel()}`])).rows[0]!.id;
            // A fully live sibling at a previous institution: active
            // university, live policy, live mapping — but login rejects it
            // because the student's canonical university moved on.
            const previousUniversityId = (await client.query<{ id: string }>(
                'INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id',
                [`Previous School ${uniqueLabel()}`],
            )).rows[0]!.id;
            await seedPolicy(client, previousUniversityId, `previous${uniqueLabel()}.school.example`);
            second = (await client.query<{ id: string }>(`INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject) VALUES ($1, $2, 'google', $3, $4) RETURNING id`, [owner.userId, previousUniversityId, GOOGLE_ISSUER, `previous-b-${uniqueLabel()}`])).rows[0]!.id;
        } finally { client.release(); }
        const grantA = await mintGrant(service, owner.userId, owner.sid, PASSWORD, 'unlink', first);
        const grantB = await mintGrant(service, owner.userId, owner.sid, PASSWORD, 'unlink', second);
        const remover = await pool.connect();
        try { await remover.query('UPDATE users SET password_hash = NULL WHERE id = $1', [owner.userId]); }
        finally { remover.release(); }
        // Removing the only currently usable identity must refuse: the
        // live-but-stale sibling cannot sign in, so removal would lock
        // the student out.
        assert.deepEqual(await service.unlink({ userId: owner.userId, sid: owner.sid, identityId: first, grantId: grantA.grantId, grantSecret: grantA.grantSecret }), { outcome: 'last_method' });
        // The reverse direction still succeeds: the canonical sibling
        // satisfies the guard, so the stale identity can be removed.
        const removed = await service.unlink({ userId: owner.userId, sid: owner.sid, identityId: second, grantId: grantB.grantId, grantSecret: grantB.grantSecret });
        assert.ok(!('outcome' in removed) && removed.unlinked === true);
    });
});

test('unlink evaluates every sibling provider before reporting the last method', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const client = await pool.connect();
        let owner;
        let target = '';
        let disabledSibling = '';
        let enabledSibling = '';
        try {
            owner = await seedOwner(client, {});
            const domain = owner.email.split('@')[1]!;
            const google = await seedPolicy(client, owner.universityId, domain);
            // Domains map to exactly one university but each domain row is
            // unique: the second provider needs its own domain.
            const microsoft = await seedPolicy(client, owner.universityId, `ms-${domain}`, { provider: 'microsoft', realm: MICROSOFT_TENANT });
            target = (await client.query<{ id: string }>(`INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject) VALUES ($1, $2, 'google', $3, $4) RETURNING id`, [owner.userId, owner.universityId, google.issuer, `multi-target-${uniqueLabel()}`])).rows[0]!.id;
            disabledSibling = (await client.query<{ id: string }>(`INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject) VALUES ($1, $2, 'google', $3, $4) RETURNING id`, [owner.userId, owner.universityId, google.issuer, `multi-disabled-${uniqueLabel()}`])).rows[0]!.id;
            enabledSibling = (await client.query<{ id: string }>(`INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject) VALUES ($1, $2, 'microsoft', $3, $4) RETURNING id`, [owner.userId, owner.universityId, microsoft.issuer, `multi-enabled-${uniqueLabel()}`])).rows[0]!.id;
        } finally { client.release(); }
        const full = makeService(pool, attemptKey);
        const grantTarget = await mintGrant(full, owner.userId, owner.sid, PASSWORD, 'unlink', target);
        const grantEnabled = await mintGrant(full, owner.userId, owner.sid, PASSWORD, 'unlink', enabledSibling);
        const remover = await pool.connect();
        try { await remover.query('UPDATE users SET password_hash = NULL WHERE id = $1', [owner.userId]); }
        finally { remover.release(); }
        // Google is disabled deployment-wide while Microsoft stays live:
        // the guard must find the enabled Microsoft sibling instead of
        // sampling a disabled Google row and crying last_method.
        const gated = makeService(pool, attemptKey, { isProviderEnabled: (provider) => provider === 'microsoft' });
        const removed = await gated.unlink({ userId: owner.userId, sid: owner.sid, identityId: target, grantId: grantTarget.grantId, grantSecret: grantTarget.grantSecret });
        assert.ok(!('outcome' in removed) && removed.unlinked === true);
        // With only the disabled sibling left beside it, the enabled
        // identity is now genuinely the last method.
        assert.deepEqual(await gated.unlink({ userId: owner.userId, sid: owner.sid, identityId: enabledSibling, grantId: grantEnabled.grantId, grantSecret: grantEnabled.grantSecret }), { outcome: 'last_method' });
        const check = await pool.connect();
        try {
            const active = await check.query('SELECT id FROM student_auth_identities WHERE user_id = $1 AND revoked_at IS NULL', [owner.userId]);
            assert.deepEqual(new Set(active.rows.map(row => row.id)), new Set([disabledSibling, enabledSibling]));
        } finally { check.release(); }
    });
});

test('unlink keeps the last method when the sibling approval is withdrawn', async () => {
    await withLinkPool(async (pool) => {
        const attemptKey = randomBytes(32).toString('base64url');
        const service = makeService(pool, attemptKey);
        const client = await pool.connect();
        let owner;
        let first = '';
        let second = '';
        try {
            owner = await seedOwner(client, {});
            const domain = owner.email.split('@')[1]!;
            const google = await seedPolicy(client, owner.universityId, domain);
            const microsoft = await seedPolicy(client, owner.universityId, `ms-${domain}`, { provider: 'microsoft', realm: MICROSOFT_TENANT });
            first = (await client.query<{ id: string }>(`INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject) VALUES ($1, $2, 'google', $3, $4) RETURNING id`, [owner.userId, owner.universityId, google.issuer, `approval-a-${uniqueLabel()}`])).rows[0]!.id;
            second = (await client.query<{ id: string }>(`INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject) VALUES ($1, $2, 'microsoft', $3, $4) RETURNING id`, [owner.userId, owner.universityId, microsoft.issuer, `approval-b-${uniqueLabel()}`])).rows[0]!.id;
            // Both siblings are canonical with live, unexpired policies;
            // approval withdrawal (disabled with the approver cleared) on
            // the Microsoft policy alone removes that sibling from login
            // authority.
            await client.query(`UPDATE institution_login_policies SET enabled = false, approved_by = NULL WHERE university_id = $1 AND provider = 'microsoft'`, [owner.universityId]);
        } finally { client.release(); }
        const grantA = await mintGrant(service, owner.userId, owner.sid, PASSWORD, 'unlink', first);
        const grantB = await mintGrant(service, owner.userId, owner.sid, PASSWORD, 'unlink', second);
        const remover = await pool.connect();
        try { await remover.query('UPDATE users SET password_hash = NULL WHERE id = $1', [owner.userId]); }
        finally { remover.release(); }
        assert.deepEqual(await service.unlink({ userId: owner.userId, sid: owner.sid, identityId: first, grantId: grantA.grantId, grantSecret: grantA.grantSecret }), { outcome: 'last_method' });
        const removed = await service.unlink({ userId: owner.userId, sid: owner.sid, identityId: second, grantId: grantB.grantId, grantSecret: grantB.grantSecret });
        assert.ok(!('outcome' in removed) && removed.unlinked === true);
    });
});
