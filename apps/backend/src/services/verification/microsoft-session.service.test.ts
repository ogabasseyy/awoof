import assert from 'node:assert/strict';
import test from 'node:test';
import { assertMicrosoftSession } from './microsoft-session.service.js';

const userId = '11111111-1111-4111-8111-111111111111';
const sid = '22222222-2222-4222-8222-222222222222';

test('issuance requires a signed UUID session ID while owner history permits an inactive student with a live session', async () => {
    const calls: string[] = [];
    const tx = {
        query: async (text: string) => {
            calls.push(text);
            if (text.includes('FROM users')) return { rowCount: 1, rows: [{ id: userId, email: 'student@example.invalid', role: 'student' }] };
            return { rowCount: 1, rows: [{ user_id: userId, status: 'suspended' }] };
        },
    };

    await assert.rejects(assertMicrosoftSession(tx as never, userId, undefined, 'issuance'), /requires reauthentication/i);
    await assert.rejects(assertMicrosoftSession(tx as never, userId, 'not-a-uuid', 'owner'), /requires reauthentication/i);
    await assert.rejects(assertMicrosoftSession(tx as never, userId, sid, 'issuance'), /active student/i);
    const owner = await assertMicrosoftSession(tx as never, userId, sid, 'owner');
    assert.equal(owner.userId, userId);
    assert.match(calls[0] ?? '', /FOR UPDATE/);
    assert.match(calls[calls.length - 1] ?? '', /FOR UPDATE/);
});
