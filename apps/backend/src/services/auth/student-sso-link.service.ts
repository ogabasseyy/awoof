import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
    BadRequestError,
    ConflictError,
    ForbiddenError,
    NotFoundError,
    UnauthorizedError,
} from '../../common/errors/AppError.js';
import {
    decryptMicrosoftAttemptVerifier as decryptSsoSecret,
    hashMicrosoftAttemptSecret as hashSsoSecret,
} from '../verification/microsoft-attempt-crypto.js';
import { lockStudentContext } from '../verification/eligibility-context.service.js';
import { passwordService } from './password.service.js';
import { studentSsoCookieName } from './student-sso-flow.service.js';
import {
    StudentSsoAuthorityInvalidatedError,
    assertCurrentLoginPolicy,
    decodeProviderObservation,
    hasCurrentMicrosoftMembership,
    readProvenSchoolMailbox,
    revokeSsoSchoolAssertions,
    writeSsoSchoolAssertion,
} from './student-sso-onboarding.service.js';
import type { LoginProvider } from './student-sso.types.js';

/**
 * First-use SSO linking, recovery, and self-service unlink (Task B4).
 *
 * A provider handoff never authorizes by itself: linking binds it to a
 * freshly password-proven owner session in one transaction, and unlinking
 * revokes the identity plus its school assertions while leaving independent
 * enrollment consents untouched. Lock order extends the B3 chain (see the
 * onboarding module): users → students → universities → handoffs →
 * policies → identities → grants → verification authority → assertions.
 * Handoff rows are exclusively locked here; no other writer touches them.
 *
 * Disabled providers refuse link-purpose reauth and linking (outstanding
 * flows are cancelled on rollback) but keep unlink-purpose reauth, identity
 * listing, and unlink operational.
 */

export const STUDENT_SSO_REAUTH_LIFETIME_SECONDS = 5 * 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type StudentSsoReauthPurpose = 'link' | 'unlink';

export type StudentSsoReauthResult = {
    grantId: string;
    grantSecret: string;
    expiresAt: string;
};

export type StudentSsoLinkedIdentity = {
    id: string;
    provider: LoginProvider;
    universityName: string;
    linkedAt: string;
};

export type StudentSsoLinkResult =
    | {
        outcome: 'linked';
        identity: StudentSsoLinkedIdentity;
        schoolAssertion: 'recorded' | 'not_attested';
        reactivated: boolean;
        attemptId: string;
    }
    | { outcome: 'mismatch'; attemptId: string }
    | { outcome: 'restart'; attemptId: string | null };

export type StudentSsoUnlinkResult =
    | { unlinked: true }
    | { outcome: 'last_method' };

export type StudentSsoLinkDependencies = {
    pool: Pool;
    attemptKey: string;
    /** Deployment gate. Linking requires it; owner unlink and listing do not. */
    isEnabled?: () => boolean;
    /** Bcrypt comparison; injectable so unit tests never hash. */
    comparePassword?: (password: string, hash: string) => Promise<boolean>;
};

type HandoffRow = {
    id: string;
    attempt_id: string;
    secret_hash: string;
    encrypted_observation: string;
    policy_id: string;
    policy_version: number;
    browser_binding_hash: string;
    expires_at: Date;
    consumed_at: Date | null;
};

type GrantRow = {
    id: string;
    user_id: string;
    sid: string;
    purpose: string;
    secret_hash: string;
    password_hash: string | null;
    expires_at: Date;
    consumed_at: Date | null;
};

function secret(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
}

function validOpaque(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}

function validUuid(value: unknown): value is string {
    return typeof value === 'string' && UUID.test(value);
}

function invalidLink(): ConflictError {
    return new ConflictError('Student SSO link is no longer valid');
}

function invalidUnlink(): ConflictError {
    return new ConflictError('Student SSO unlink is no longer valid');
}

function unavailableAccount(): UnauthorizedError {
    return new UnauthorizedError('Student SSO linking is not available for this account');
}

export class StudentSsoLinkService {
    constructor(private readonly deps: StudentSsoLinkDependencies) {}

    private async transaction<T>(operation: (tx: PoolClient) => Promise<T>): Promise<T> {
        const tx = await this.deps.pool.connect();
        try {
            await tx.query('BEGIN');
            const result = await operation(tx);
            await tx.query('COMMIT');
            return result;
        } catch (error) {
            await tx.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            tx.release();
        }
    }

    private assertLinkingEnabled(): void {
        if (this.deps.isEnabled?.() !== true) throw invalidLink();
    }

    /**
     * Password-backed recent proof bound to the current user and session.
     * The comparison runs outside any lock; the transaction re-verifies the
     * exact compared hash, the current session id, and the active student
     * role, and pins the verified hash into the grant row, so a password
     * reset or session replacement invalidates the grant.
     */
    async reauth(input: { userId: unknown; sid: unknown; password: unknown; purpose: unknown }): Promise<StudentSsoReauthResult> {
        if (input.purpose !== 'link' && input.purpose !== 'unlink') {
            throw new BadRequestError('Student SSO reauthentication purpose is invalid');
        }
        if (typeof input.password !== 'string' || input.password.length === 0 || input.password.length > 1024) {
            throw new BadRequestError('Student SSO reauthentication request is invalid');
        }
        if (!validUuid(input.userId)) throw new UnauthorizedError('Student SSO reauthentication failed');
        // Legacy tokens without a session id cannot bind a grant: fail closed.
        if (!validUuid(input.sid)) throw new UnauthorizedError('Student SSO reauthentication is not available for this session');
        if (input.purpose === 'link') this.assertLinkingEnabled();
        const userId = input.userId;
        const sid = input.sid;
        const password = input.password;
        const purpose: StudentSsoReauthPurpose = input.purpose;

        const pre = await this.deps.pool.query<{ password_hash: string | null; role: string; deleted_at: Date | null }>(
            'SELECT password_hash, role, deleted_at FROM users WHERE id = $1',
            [userId],
        );
        const row = pre.rows[0];
        if (!row || row.deleted_at !== null || row.role !== 'student') {
            throw new UnauthorizedError('Student SSO reauthentication failed');
        }
        if (typeof row.password_hash !== 'string' || row.password_hash === '') {
            // This release requires an active usable password; independent
            // recent provider reauthentication for passwordless accounts is
            // not implemented.
            throw new ForbiddenError('Password reauthentication is not available for this account');
        }
        const verifiedHash = row.password_hash;
        const compare = this.deps.comparePassword
            ?? ((candidate: string, hash: string) => passwordService.comparePassword(candidate, hash));
        if (!await compare(password, verifiedHash)) throw new UnauthorizedError('Current password is incorrect');

        return this.transaction(async (tx) => {
            let context;
            try {
                context = await lockStudentContext(tx, userId);
            } catch (error) {
                if (error instanceof NotFoundError) throw unavailableAccount();
                throw error;
            }
            if (!context.active) throw unavailableAccount();
            const locked = await tx.query<{ password_hash: string | null; active_session_id: string | null }>(
                'SELECT password_hash, active_session_id FROM users WHERE id = $1',
                [userId],
            );
            if (locked.rows[0]?.password_hash !== verifiedHash || locked.rows[0]?.active_session_id !== sid) {
                throw new UnauthorizedError('Student SSO reauthentication failed');
            }
            const grantId = randomUUID();
            const grantSecret = secret();
            const inserted = await tx.query<{ expires_at: Date }>(
                `INSERT INTO student_auth_reauth_grants (id, user_id, sid, purpose, secret_hash, password_hash, expires_at)
                 VALUES ($1, $2, $3::uuid, $4, $5, $6, clock_timestamp() + interval '5 minutes')
                 RETURNING expires_at`,
                [grantId, userId, sid, purpose, hashSsoSecret(grantSecret), verifiedHash],
            );
            return { grantId, grantSecret, expiresAt: inserted.rows[0]!.expires_at.toISOString() };
        });
    }

    /**
     * Bind an unlinked provider handoff to the freshly proven owner. New
     * subjects link; revoked subjects reactivate for the original owner only.
     * A subject active anywhere else — or revoked for another owner — fails
     * owner-safely without revealing the match.
     */
    async link(input: {
        userId: unknown;
        sid: unknown;
        handoffId: unknown;
        handoffSecret: unknown;
        browserCookies: readonly { name: string; value: string }[];
        grantId: unknown;
        grantSecret: unknown;
    }): Promise<StudentSsoLinkResult> {
        this.assertLinkingEnabled();
        if (!validUuid(input.userId) || !validUuid(input.sid)) throw unavailableAccount();
        if (!validUuid(input.handoffId) || !validUuid(input.grantId)
            || !validOpaque(input.handoffSecret) || !validOpaque(input.grantSecret)) {
            throw invalidLink();
        }
        const userId = input.userId;
        const sid = input.sid;
        const handoffId = input.handoffId;
        const handoffSecret = input.handoffSecret;
        const grantId = input.grantId;
        const grantSecret = input.grantSecret;

        try {
            return await this.transaction(async (tx): Promise<StudentSsoLinkResult> => {
                let context;
                try {
                    context = await lockStudentContext(tx, userId);
                } catch (error) {
                    if (error instanceof NotFoundError) throw unavailableAccount();
                    throw error;
                }
                if (!context.active) throw unavailableAccount();
                const account = await tx.query<{ password_hash: string | null; active_session_id: string | null }>(
                    'SELECT password_hash, active_session_id FROM users WHERE id = $1',
                    [userId],
                );
                // The grant was bound to this exact session; the password
                // binding is rechecked with the grant below, so a password
                // reset or session replacement since reauth fails the link.
                if (account.rows[0]?.active_session_id !== sid) {
                    throw invalidLink();
                }
                const handoffResult = await tx.query<HandoffRow>(
                    'SELECT * FROM student_auth_link_handoffs WHERE id = $1 FOR UPDATE',
                    [handoffId],
                );
                const handoff = handoffResult.rows[0];
                if (!handoff || hashSsoSecret(handoffSecret) !== handoff.secret_hash) throw invalidLink();
                if (handoff.consumed_at !== null) return { outcome: 'restart', attemptId: handoff.attempt_id };
                const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
                if (handoff.expires_at <= clock.rows[0]!.now) {
                    await this.consumeHandoff(tx, handoff.id, userId, sid);
                    return { outcome: 'restart', attemptId: handoff.attempt_id };
                }
                // The handoff inherits the attempt's browser binding: only the
                // browser that completed the provider return can link it.
                const browserCookie = input.browserCookies.find(
                    (cookie) => cookie.name === studentSsoCookieName(handoff.attempt_id),
                )?.value;
                if (!browserCookie || hashSsoSecret(browserCookie) !== handoff.browser_binding_hash) {
                    throw invalidLink();
                }
                const attempt = await tx.query<{ requested_email: string }>(
                    'SELECT requested_email FROM student_auth_attempts WHERE id = $1',
                    [handoff.attempt_id],
                );
                if (!attempt.rows[0]) throw invalidLink();
                let policy;
                try {
                    policy = await assertCurrentLoginPolicy(tx, handoff.policy_id, handoff.policy_version, attempt.rows[0].requested_email);
                } catch (error) {
                    // A lapsed policy cancels the outstanding flow: the owner
                    // restarts provider linking, nothing links.
                    if (error instanceof StudentSsoAuthorityInvalidatedError) {
                        return { outcome: 'restart', attemptId: handoff.attempt_id };
                    }
                    throw error;
                }
                let observation;
                try {
                    observation = decodeProviderObservation(decryptSsoSecret(handoff.encrypted_observation, this.deps.attemptKey, handoff.id));
                } catch {
                    return { outcome: 'restart', attemptId: handoff.attempt_id };
                }
                if (observation.provider !== policy.provider || observation.issuer !== policy.issuer) throw invalidLink();
                const existing = await tx.query<{ id: string; user_id: string; revoked_at: Date | null; linked_at: Date }>(
                    `SELECT id, user_id, revoked_at, linked_at FROM student_auth_identities
                     WHERE provider = $1 AND issuer = $2 AND subject = $3 FOR UPDATE`,
                    [observation.provider, observation.issuer, observation.subject],
                );
                const found = existing.rows[0];
                if (found && (found.revoked_at === null || found.user_id !== userId)) {
                    // Active anywhere, or revoked for another owner: no link,
                    // no transfer, and no revelation of the match.
                    throw new ConflictError('Student SSO identity is already linked');
                }
                const grant = await tx.query<GrantRow>(
                    'SELECT * FROM student_auth_reauth_grants WHERE id = $1 FOR UPDATE',
                    [grantId],
                );
                if (!this.grantSatisfies(grant.rows[0], userId, sid, 'link', account.rows[0]?.password_hash ?? null, clock.rows[0]!.now, grantSecret)) {
                    throw invalidLink();
                }
                // Mailbox binding: the owner must hold an independently proven
                // school mailbox whose domain this policy approves, at the
                // policy's university. Email claim equality alone never links.
                const proven = await readProvenSchoolMailbox(tx, userId, context);
                if (!proven) {
                    throw new ConflictError('Student SSO link requires a verified school mailbox');
                }
                if (context.universityId !== policy.universityId) {
                    throw new ConflictError('Student SSO link requires the approved university binding');
                }
                const provenDomain = proven.email.slice(proven.email.lastIndexOf('@') + 1);
                const mapping = await tx.query(
                    `SELECT 1
                     FROM institution_login_domain_providers dp
                     JOIN institution_login_domains d
                       ON d.domain = dp.domain
                      AND d.university_id = dp.university_id
                      AND d.is_active
                     WHERE dp.policy_id = $1
                       AND dp.provider = $2
                       AND dp.university_id = $3
                       AND d.domain = $4`,
                    [policy.id, observation.provider, policy.universityId, provenDomain],
                );
                if ((mapping.rowCount ?? 0) === 0) {
                    throw new ConflictError('Student SSO link requires an approved school mailbox domain');
                }
                if (observation.provider === 'google') {
                    const observed = (observation.email ?? '').trim().toLowerCase();
                    if (!observation.mailboxVerified || observed === '' || observed !== proven.email) {
                        // A different returned Google account is an explicit
                        // mismatch: the handoff is spent and linking restarts.
                        await this.consumeHandoff(tx, handoff.id, userId, sid);
                        await this.consumeGrant(tx, grantId);
                        return { outcome: 'mismatch', attemptId: handoff.attempt_id };
                    }
                }
                let identityId: string;
                let linkedAt: Date;
                let reactivated = false;
                if (found) {
                    reactivated = true;
                    const reactivatedRow = await tx.query<{ linked_at: Date }>(
                        `UPDATE student_auth_identities
                         SET revoked_at = NULL, observed_email = $2
                         WHERE id = $1
                         RETURNING linked_at`,
                        [found.id, observation.email],
                    );
                    identityId = found.id;
                    linkedAt = reactivatedRow.rows[0]!.linked_at;
                    await tx.query(
                        `INSERT INTO verification_audit_events (user_id, university_id, event_type, metadata)
                         VALUES ($1, $2, 'student_sso_identity_reactivated', jsonb_build_object('provider', $3::text))`,
                        [userId, context.universityId, observation.provider],
                    );
                } else {
                    const inserted = await tx.query<{ id: string; linked_at: Date }>(
                        `INSERT INTO student_auth_identities (user_id, university_id, provider, issuer, subject, observed_email)
                         VALUES ($1, $2, $3, $4, $5, $6)
                         RETURNING id, linked_at`,
                        [userId, context.universityId, observation.provider, observation.issuer, observation.subject, observation.email],
                    );
                    identityId = inserted.rows[0]!.id;
                    linkedAt = inserted.rows[0]!.linked_at;
                    await tx.query(
                        `INSERT INTO verification_audit_events (user_id, university_id, event_type, metadata)
                         VALUES ($1, $2, 'student_sso_identity_linked', jsonb_build_object('provider', $3::text))`,
                        [userId, context.universityId, observation.provider],
                    );
                }
                const microsoftMembershipAttested = observation.provider === 'microsoft'
                    && await hasCurrentMicrosoftMembership(tx, userId, context, policy.realm);
                const schoolAssertion = await writeSsoSchoolAssertion(tx, {
                    userId,
                    universityId: context.universityId,
                    identityVersion: context.identityVersion,
                    identityId,
                    policy: {
                        id: policy.id,
                        version: policy.version,
                        schoolAssertionDays: policy.schoolAssertionDays,
                        approvedUntil: policy.approvedUntil,
                    },
                    observation,
                    microsoftMembershipAttested,
                });
                await this.consumeHandoff(tx, handoff.id, userId, sid);
                await this.consumeGrant(tx, grantId);
                const university = await tx.query<{ name: string }>(
                    'SELECT name FROM universities WHERE id = $1',
                    [context.universityId],
                );
                return {
                    outcome: 'linked',
                    identity: {
                        id: identityId,
                        provider: observation.provider,
                        universityName: university.rows[0]?.name ?? '',
                        linkedAt: linkedAt.toISOString(),
                    },
                    schoolAssertion,
                    reactivated,
                    attemptId: handoff.attempt_id,
                };
            });
        } catch (error) {
            // A lost insert race means the subject linked concurrently: the
            // outcome is decided, so report it as invalid, never raw SQL.
            if ((error as { code?: unknown }).code === '23505') throw invalidLink();
            throw error;
        }
    }

    /**
     * Owner-only revocation of one login identity. The active session is
     * cleared only when it was issued by the removed identity; an unrelated
     * password or provider session survives. Independent enrollment consents
     * are never mutated here, and verification unlink cannot reach this path.
     */
    async unlink(input: { userId: unknown; sid: unknown; identityId: unknown; grantId: unknown; grantSecret: unknown }): Promise<StudentSsoUnlinkResult> {
        if (!validUuid(input.userId) || !validUuid(input.sid)) throw unavailableAccount();
        if (!validUuid(input.identityId) || !validUuid(input.grantId) || !validOpaque(input.grantSecret)) {
            throw invalidUnlink();
        }
        const userId = input.userId;
        const sid = input.sid;
        const identityId = input.identityId;
        const grantId = input.grantId;
        const grantSecret = input.grantSecret;

        return this.transaction(async (tx): Promise<StudentSsoUnlinkResult> => {
            // Parallel removals serialize on the user lock below, so two
            // concurrent last-method removals cannot both succeed.
            let context;
            try {
                context = await lockStudentContext(tx, userId);
            } catch (error) {
                if (error instanceof NotFoundError) throw unavailableAccount();
                throw error;
            }
            if (!context.active) throw unavailableAccount();
            const account = await tx.query<{ password_hash: string | null; active_session_id: string | null }>(
                'SELECT password_hash, active_session_id FROM users WHERE id = $1',
                [userId],
            );
            if (account.rows[0]?.active_session_id !== sid) throw invalidUnlink();
            const identity = await tx.query<{ id: string; user_id: string; university_id: string; provider: string; revoked_at: Date | null }>(
                'SELECT id, user_id, university_id, provider, revoked_at FROM student_auth_identities WHERE id = $1 FOR UPDATE',
                [identityId],
            );
            const row = identity.rows[0];
            // Another owner's identity — or a revoked one — is
            // indistinguishable from a missing one.
            if (!row || row.user_id !== userId || row.revoked_at !== null) {
                throw new NotFoundError('Student SSO login identity not found');
            }
            const grant = await tx.query<GrantRow>(
                'SELECT * FROM student_auth_reauth_grants WHERE id = $1 FOR UPDATE',
                [grantId],
            );
            const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
            if (!this.grantSatisfies(grant.rows[0], userId, sid, 'unlink', account.rows[0]?.password_hash ?? null, clock.rows[0]!.now, grantSecret)) {
                throw invalidUnlink();
            }
            const sibling = await tx.query(
                `SELECT 1 FROM student_auth_identities
                 WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL
                 LIMIT 1`,
                [userId, identityId],
            );
            // Another usable login method must remain: a usable password or a
            // second active identity. Nothing is consumed on this path.
            if (account.rows[0]?.password_hash == null && (sibling.rowCount ?? 0) === 0) {
                return { outcome: 'last_method' };
            }
            await this.consumeGrant(tx, grantId);
            await tx.query('UPDATE student_auth_identities SET revoked_at = clock_timestamp() WHERE id = $1', [identityId]);
            await revokeSsoSchoolAssertions(tx, identityId);
            await tx.query(
                `UPDATE users
                 SET active_session_id = NULL,
                     refresh_token_hash = NULL,
                     refresh_token_expires_at = NULL,
                     active_session_auth_identity_id = NULL
                 WHERE id = $1 AND active_session_auth_identity_id = $2`,
                [userId, identityId],
            );
            await tx.query(
                `INSERT INTO verification_audit_events (user_id, university_id, event_type, metadata)
                 VALUES ($1, $2, 'student_sso_identity_unlinked', jsonb_build_object('provider', $3::text))`,
                [userId, row.university_id, row.provider],
            );
            return { unlinked: true };
        });
    }

    /** Owner listing for self-service recovery. Subject and issuer material never leaves this boundary. */
    async listIdentities(userId: unknown): Promise<StudentSsoLinkedIdentity[]> {
        if (!validUuid(userId)) throw unavailableAccount();
        const rows = await this.deps.pool.query<{ id: string; provider: string; university_name: string; linked_at: Date }>(
            `SELECT identity.id, identity.provider, university.name AS university_name, identity.linked_at
             FROM student_auth_identities identity
             JOIN universities university ON university.id = identity.university_id
             WHERE identity.user_id = $1 AND identity.revoked_at IS NULL
             ORDER BY identity.linked_at DESC, identity.id DESC`,
            [userId],
        );
        return rows.rows
            .filter((row): row is typeof row & { provider: LoginProvider } => row.provider === 'google' || row.provider === 'microsoft')
            .map((row) => ({
                id: row.id,
                provider: row.provider,
                universityName: row.university_name,
                linkedAt: row.linked_at.toISOString(),
            }));
    }

    private grantSatisfies(
        grant: GrantRow | undefined,
        userId: string,
        sid: string,
        purpose: StudentSsoReauthPurpose,
        passwordHash: string | null,
        now: Date,
        grantSecret: string,
    ): grant is GrantRow {
        // The binding pins the exact password hash verified at reauth: a
        // reset or removal since then fails the grant. Both sides null only
        // occurs for forged rows, never for minted grants, which reauth
        // refuses for passwordless accounts.
        const bindingIntact = grant?.password_hash === passwordHash
            || (grant?.password_hash == null && passwordHash == null);
        return !!grant
            && grant.user_id === userId
            && grant.sid === sid
            && grant.purpose === purpose
            && grant.consumed_at === null
            && grant.expires_at > now
            && bindingIntact
            && hashSsoSecret(grantSecret) === grant.secret_hash;
    }

    private async consumeHandoff(tx: PoolClient, handoffId: string, userId: string, sid: string): Promise<void> {
        await tx.query(
            `UPDATE student_auth_link_handoffs
             SET consumed_at = clock_timestamp(), target_user_id = $2, target_sid = $3::uuid
             WHERE id = $1 AND consumed_at IS NULL`,
            [handoffId, userId, sid],
        );
    }

    private async consumeGrant(tx: PoolClient, grantId: string): Promise<void> {
        await tx.query(
            'UPDATE student_auth_reauth_grants SET consumed_at = clock_timestamp() WHERE id = $1 AND consumed_at IS NULL',
            [grantId],
        );
    }
}
