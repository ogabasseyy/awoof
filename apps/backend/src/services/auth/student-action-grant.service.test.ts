import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';

import { consumeActionGrant } from './student-action-grant.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const GRANT_ID = '33333333-3333-4333-8333-333333333333';
const TARGET_ID = '44444444-4444-4444-8444-444444444444';

function grant(overrides: Record<string, unknown> = {}) {
    return {
        id: GRANT_ID,
        user_id: USER_ID,
        sid: SID,
        credential_generation: 4,
        purpose: 'unlink',
        secret_hash: 'digest',
        proof_identity_id: null,
        target_identity_id: TARGET_ID,
        pending_code_id: null,
        active_code_generation: null,
        consumed_at: null,
        revoked_at: null,
        expires_at: new Date(Date.now() + 60_000),
        ...overrides,
    };
}

function txFor(row: Record<string, unknown>, account = { active_session_id: SID, credential_generation: 4 }) {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const tx = {
        query: async (text: string, values?: unknown[]) => {
            calls.push({ text, values });
            if (text.startsWith('SELECT * FROM student_auth_action_grants')) return { rows: [row], rowCount: 1 };
            if (text.startsWith('SELECT active_session_id')) return { rows: [account], rowCount: 1 };
            if (text.startsWith('SELECT clock_timestamp')) return { rows: [{ now: new Date() }], rowCount: 1 };
            if (text.startsWith('UPDATE student_auth_action_grants')) return { rows: [], rowCount: 1 };
            throw new Error(`unexpected query: ${text}`);
        },
    } as unknown as PoolClient;
    return { tx, calls };
}

test('consumes only a current grant bound to its exact unlink target', async () => {
    const { tx, calls } = txFor(grant());
    await consumeActionGrant(tx, {
        userId: USER_ID,
        sid: SID,
        grantId: GRANT_ID,
        secret: 'grant-secret',
        purpose: 'unlink',
        targetIdentityId: TARGET_ID,
    }, { hashSecret: () => 'digest' });
    assert.ok(calls.some((call) => call.text.startsWith('UPDATE student_auth_action_grants')));
});

test('consumes an action grant whose PostgreSQL bigint binding is returned as a string', async () => {
    const { tx } = txFor(grant({
        purpose: 'recovery_code_generate',
        target_identity_id: null,
        active_code_generation: '1',
    }));
    await consumeActionGrant(tx, {
        userId: USER_ID, sid: SID, grantId: GRANT_ID, secret: 'grant-secret',
        purpose: 'recovery_code_generate', activeCodeGeneration: 1,
    }, { hashSecret: () => 'digest' });
});

for (const [name, row, input] of [
    ['a consumed grant', grant({ consumed_at: new Date() }), {}],
    ['a grant for another target', grant({ target_identity_id: USER_ID }), {}],
    ['a grant from an old credential generation', grant({ credential_generation: 3 }), {}],
    ['a grant from an old session', grant({ sid: TARGET_ID }), {}],
] as const) {
    test(`rejects ${name}`, async () => {
        const { tx } = txFor(row);
        await assert.rejects(
            () => consumeActionGrant(tx, {
                userId: USER_ID, sid: SID, grantId: GRANT_ID, secret: 'grant-secret', purpose: 'unlink', targetIdentityId: TARGET_ID, ...input,
            }, { hashSecret: () => 'digest' }),
            /not valid/,
        );
    });
}
