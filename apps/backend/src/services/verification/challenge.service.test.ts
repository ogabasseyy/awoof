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

test('returns expired without burning budget when the caller deadline elapsed', async () => {
    const now = new Date('2026-09-29T00:00:00.000Z');
    const queries: string[] = [];
    const tx = { query: async (text: string) => { queries.push(text); return { rows: [{ now }] }; } };
    const outcome = await requestChallenge(tx as never, {
        purpose: 'student_sso_signup', subjectKey: 'student@example.invalid', bindings: { email: 'student@example.invalid' },
        expiresAt: new Date(now.getTime() - 1000),
    });
    assert.equal(outcome.status, 'expired');
    assert.ok(!queries.some((text) => text.includes('INSERT INTO verification_challenges')),
        'an elapsed deadline must not mint a challenge row');
    assert.ok(!queries.some((text) => text.includes('send_count = send_count + 1')),
        'an elapsed deadline must not burn send allowance');
});

test('returns expired when the caller deadline lacks a usable lifetime', async () => {
    const now = new Date('2026-09-29T00:00:00.000Z');
    const tx = { query: async () => ({ rows: [{ now }] }) };
    const outcome = await requestChallenge(tx as never, {
        purpose: 'student_sso_signup', subjectKey: 'student@example.invalid', bindings: { email: 'student@example.invalid' },
        expiresAt: new Date(now.getTime() + 500),
    });
    assert.equal(outcome.status, 'expired');
});
