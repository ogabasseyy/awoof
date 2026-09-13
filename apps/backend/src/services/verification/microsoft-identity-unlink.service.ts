import type { PoolClient } from 'pg';
import { ForbiddenError, NotFoundError } from '../../common/errors/AppError.js';

export type MicrosoftIdentityUnlinkResult = {
    identityId: string;
    unlinked: true;
    /** A revoked identity is retained as a tombstone and cannot be restored or transferred automatically. */
    recovery: 'support_required';
};

type IdentityRow = { id: string; user_id: string; university_id: string; revoked_at: Date | null };

/**
 * The caller has already acquired the live owner session's user and student
 * locks. Continue in the lifecycle order: sorted institutions, state/consent,
 * attempts, identity, proof/evidence. This path deliberately does not inspect
 * issuance policy, so an authenticated owner can unlink during a policy or
 * feature rollback.
 */
export async function unlinkMicrosoftIdentity(
    tx: PoolClient,
    userId: string,
    identityId: string,
): Promise<MicrosoftIdentityUnlinkResult> {
    const located = await tx.query<IdentityRow>(
        'SELECT id, user_id, university_id, revoked_at FROM microsoft_identities WHERE id = $1',
        [identityId],
    );
    const resource = located.rows[0];
    if (!resource) throw new NotFoundError('Microsoft identity not found');
    if (resource.user_id !== userId) throw new ForbiddenError('Microsoft identity belongs to another user');

    const studentResult = await tx.query<{ id: string; university_id: string | null }>(
        'SELECT id, university_id FROM students WHERE user_id = $1 FOR UPDATE', [userId],
    );
    const student = studentResult.rows[0];
    if (!student) throw new NotFoundError('Student profile not found');
    const universityIds = [student.university_id, resource.university_id]
        .filter((id): id is string => id !== null)
        .filter((id, index, all) => all.indexOf(id) === index)
        .sort();
    for (const universityId of universityIds) {
        const university = await tx.query('SELECT id FROM universities WHERE id = $1 FOR UPDATE', [universityId]);
        if (university.rowCount !== 1) throw new NotFoundError('Microsoft identity institution not found');
    }
    for (const universityId of universityIds) {
        await tx.query(
            'SELECT student_id FROM student_eligibility_state WHERE student_id = $1 AND university_id = $2 FOR UPDATE',
            [student.id, universityId],
        );
    }
    // Lock both parent and provider grants even if withdrawn. Unlinking does
    // not reactivate either grant, and must serialize with callback authority.
    await tx.query(
        `SELECT id FROM verification_consents
         WHERE user_id = $1 AND university_id = $2
         ORDER BY id FOR UPDATE`,
        [userId, resource.university_id],
    );
    await tx.query(
        `SELECT id FROM microsoft_verification_consents
         WHERE user_id = $1 AND university_id = $2
         ORDER BY id FOR UPDATE`,
        [userId, resource.university_id],
    );
    await tx.query(
        `SELECT id FROM microsoft_verification_attempts
         WHERE user_id = $1 AND university_id = $2 AND status IN ('pending', 'processing', 'ready')
         ORDER BY id FOR UPDATE`,
        [userId, resource.university_id],
    );
    const locked = await tx.query<IdentityRow>(
        `SELECT id, user_id, university_id, revoked_at
         FROM microsoft_identities WHERE id = $1 FOR UPDATE`,
        [identityId],
    );
    const identity = locked.rows[0];
    if (!identity) throw new NotFoundError('Microsoft identity not found');
    if (identity.user_id !== userId || identity.university_id !== resource.university_id) {
        throw new ForbiddenError('Microsoft identity belongs to another user');
    }
    await tx.query(
        `SELECT id FROM microsoft_provider_proofs
         WHERE identity_id = $1 ORDER BY id FOR UPDATE`,
        [identityId],
    );
    await tx.query(
        `SELECT evidence.id FROM eligibility_evidence evidence
         JOIN microsoft_provider_proofs proof ON proof.id = evidence.provider_proof_id
         WHERE proof.identity_id = $1 ORDER BY evidence.id FOR UPDATE`,
        [identityId],
    );
    if (identity.revoked_at === null) {
        await tx.query(
            `UPDATE microsoft_verification_attempts
             SET status = 'failed', state_hash = NULL, browser_secret_hash = NULL,
                 finish_secret_hash = NULL, encrypted_verifier = NULL, nonce = NULL, result = NULL
             WHERE user_id = $1 AND university_id = $2 AND status IN ('pending', 'processing', 'ready')`,
            [userId, resource.university_id],
        );
    }
    await tx.query(
        `UPDATE eligibility_evidence evidence
         SET revoked_at = COALESCE(evidence.revoked_at, clock_timestamp())
         FROM microsoft_provider_proofs proof
         WHERE evidence.provider_proof_id = proof.id AND proof.identity_id = $1 AND evidence.revoked_at IS NULL`,
        [identityId],
    );
    await tx.query(
        'UPDATE microsoft_provider_proofs SET revoked_at = clock_timestamp() WHERE identity_id = $1 AND revoked_at IS NULL',
        [identityId],
    );
    await tx.query(
        'UPDATE microsoft_identities SET revoked_at = clock_timestamp() WHERE id = $1 AND revoked_at IS NULL',
        [identityId],
    );
    // A tombstoned identity deliberately cannot be restored or transferred by
    // a new browser attempt. Replays do no additional audit mutation.
    if (identity.revoked_at === null) {
        await tx.query(
            `INSERT INTO verification_audit_events (user_id, university_id, event_type, metadata)
             VALUES ($1, $2, 'microsoft_identity_unlinked', '{}'::jsonb)`,
            [userId, resource.university_id],
        );
    }
    return { identityId, unlinked: true, recovery: 'support_required' };
}
