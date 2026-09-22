import type { PoolClient } from 'pg';
import { BadRequestError } from '../../common/errors/AppError.js';
import type { MicrosoftIdentityHistoryItem } from './microsoft.types.js';

/**
 * Lists only the opaque resource an authenticated owner needs to sever a
 * connection. This deliberately excludes tenant/object/provider payloads.
 */
export async function listMicrosoftIdentities(
    tx: PoolClient, userId: string, cursor: string | undefined,
): Promise<{ items: MicrosoftIdentityHistoryItem[]; nextCursor: string | null }> {
    const result = await tx.query<{
        id: string; university_id: string; university_name: string; linked_at: Date; revoked_at: Date | null;
    }>(
        `WITH cursor_row AS (
             SELECT linked_at, id FROM microsoft_identities WHERE id = $2 AND user_id = $1
         )
         SELECT identity.id, identity.university_id, university.name AS university_name, identity.linked_at, identity.revoked_at
         FROM microsoft_identities identity
         JOIN universities university ON university.id = identity.university_id
         WHERE identity.user_id = $1
           AND ($2::uuid IS NULL OR (identity.linked_at, identity.id) < (SELECT linked_at, id FROM cursor_row))
         ORDER BY identity.linked_at DESC, identity.id DESC
         LIMIT 21`,
        [userId, cursor ?? null],
    );
    if (cursor && result.rows.length === 0) {
        const valid = await tx.query('SELECT 1 FROM microsoft_identities WHERE id = $1 AND user_id = $2', [cursor, userId]);
        if (valid.rowCount !== 1) throw new BadRequestError('Invalid Microsoft identity cursor');
    }
    const page = result.rows.slice(0, 20);
    return {
        items: page.map((row) => ({
            id: row.id,
            universityId: row.university_id,
            universityName: row.university_name,
            linkedAt: row.linked_at,
            revokedAt: row.revoked_at,
            status: row.revoked_at === null ? 'connected' : 'revoked',
        })),
        nextCursor: result.rows.length > 20 ? page.at(-1)!.id : null,
    };
}
