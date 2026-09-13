import assert from 'node:assert/strict';
import test from 'node:test';
import { listMicrosoftIdentities } from './microsoft-identity.service.js';

const owner = '00000000-0000-4000-8000-000000000001';
const identity = '00000000-0000-4000-8000-000000000011';

test('owner identity history exposes only a safe bounded connection resource', async () => {
    const calls: string[] = [];
    const tx = { query: async (sql: string) => {
        calls.push(sql);
        return { rowCount: 1, rows: [{ id: identity, university_id: '00000000-0000-4000-8000-000000000010', university_name: 'Safe University', linked_at: new Date('2026-09-01T00:00:00.000Z'), revoked_at: null }] };
    } };
    const result = await listMicrosoftIdentities(tx as never, owner, undefined);
    assert.deepEqual(result, { items: [{ id: identity, universityId: '00000000-0000-4000-8000-000000000010', universityName: 'Safe University', linkedAt: new Date('2026-09-01T00:00:00.000Z'), revokedAt: null, status: 'connected' }], nextCursor: null });
    assert.match(calls[0]!, /ORDER BY identity\.linked_at DESC, identity\.id DESC/);
    assert.match(calls[0]!, /LIMIT 21/);
    assert.doesNotMatch(calls[0]!, /tenant_id|object_id/i);
});

test('a foreign or malformed identity cursor is rejected instead of becoming an empty owner page', async () => {
    let call = 0;
    const tx = { query: async () => {
        call += 1;
        return call === 1 ? { rowCount: 0, rows: [] } : { rowCount: 0, rows: [] };
    } };
    await assert.rejects(() => listMicrosoftIdentities(tx as never, owner, identity), { statusCode: 400 });
});
