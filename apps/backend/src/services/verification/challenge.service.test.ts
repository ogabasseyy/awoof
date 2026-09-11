import assert from 'node:assert/strict';
import test from 'node:test';
import { challengeSubjectDigest, requestChallenge } from './challenge.service.js';

test('derives purpose-separated canonical subject digests', () => {
    assert.notEqual(challengeSubjectDigest('student_email', 'user-1'), challengeSubjectDigest('account_email', 'user-1'));
});

test('rejects non-object challenge bindings before querying a caller transaction', async () => {
    const tx = { query: async () => { throw new Error('must not query'); } };
    await assert.rejects(
        requestChallenge(tx as never, {
            purpose: 'student_signup', subjectKey: 'student@example.invalid', bindings: [] as never,
        }),
        /plain JSON object/,
    );
});

test('deliberately rejects oversized many-property bindings before SQL formatting can fail', async () => {
    const tx = { query: async () => { throw new Error('must not query'); } };
    const bindings = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`field_${index}`, 'x'.repeat(40)]));
    await assert.rejects(
        requestChallenge(tx as never, { purpose: 'student_signup', subjectKey: 'student@example.invalid', bindings }),
        /exceed the 4 KiB limit/,
    );
});
