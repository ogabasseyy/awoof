import assert from 'node:assert/strict';
import test from 'node:test';
import { requestChallenge } from './challenge.service.js';

test('rejects non-object challenge bindings before querying a caller transaction', async () => {
    const tx = { query: async () => { throw new Error('must not query'); } };
    await assert.rejects(
        requestChallenge(tx as never, {
            purpose: 'student_signup', subjectKey: 'student@example.invalid', bindings: [] as never,
        }),
        /plain JSON object/,
    );
});
