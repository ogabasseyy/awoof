import assert from 'node:assert/strict';
import test from 'node:test';
import { unlinkMicrosoftIdentity } from './microsoft-identity-unlink.service.js';

const owner = '11111111-1111-4111-8111-111111111111';
const identity = '22222222-2222-4222-8222-222222222222';
const university = '33333333-3333-4333-8333-333333333333';

function transaction(resourceOwner = owner, revokedAt: Date | null = null): { tx: never; calls: string[] } {
    const calls: string[] = [];
    const response = (sql: string) => {
        if (sql.includes('FROM microsoft_identities WHERE id = $1')) {
            return { rows: [{ id: identity, user_id: resourceOwner, university_id: university, revoked_at: revokedAt }], rowCount: 1 };
        }
        if (sql.includes('SELECT id, university_id FROM students')) return { rows: [{ id: 'student', university_id: university }], rowCount: 1 };
        if (sql.includes('FROM universities')) return { rows: [{ id: university }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
    };
    return { tx: { query: async (sql: string) => { calls.push(sql); return response(sql); } } as never, calls };
}

test('owner unlink follows canonical locks, revokes dependent Microsoft evidence, and leaves email records untouched', async () => {
    const { tx, calls } = transaction();
    assert.deepEqual(await unlinkMicrosoftIdentity(tx, owner, identity), { identityId: identity, unlinked: true, recovery: 'support_required' });
    const position = (needle: string) => calls.findIndex((sql) => sql.includes(needle));
    assert.ok(position('FROM universities') < position('student_eligibility_state'));
    assert.ok(position('student_eligibility_state') < position('FROM verification_consents'));
    assert.ok(position('FROM verification_consents') < position('FROM microsoft_verification_attempts'));
    assert.ok(position('FROM microsoft_verification_attempts') < position('FROM microsoft_identities WHERE id = $1 FOR UPDATE'));
    assert.ok(position('FROM microsoft_identities WHERE id = $1 FOR UPDATE') < position('FROM microsoft_provider_proofs'));
    assert.ok(position('FROM microsoft_provider_proofs') < position('JOIN microsoft_provider_proofs proof ON proof.id = evidence.provider_proof_id'));
    const attemptUpdate = calls.find((sql) => sql.startsWith('UPDATE microsoft_verification_attempts'))!;
    assert.match(attemptUpdate, /status IN \('pending', 'processing', 'ready'\)/);
    assert.match(attemptUpdate, /finish_secret_hash = NULL/);
    const evidenceUpdate = calls.find((sql) => sql.startsWith('UPDATE eligibility_evidence'))!;
    assert.match(evidenceUpdate, /evidence\.provider_proof_id/);
    assert.match(evidenceUpdate, /COALESCE\(evidence\.revoked_at, clock_timestamp\(\)\)/);
    const proofUpdate = calls.find((sql) => sql.startsWith('UPDATE microsoft_provider_proofs'))!;
    assert.match(proofUpdate, /WHERE identity_id = \$1 AND revoked_at IS NULL/);
    const identityUpdate = calls.find((sql) => sql.startsWith('UPDATE microsoft_identities SET revoked_at'))!;
    assert.match(identityUpdate, /WHERE id = \$1 AND revoked_at IS NULL/);
    assert.equal(calls.some((sql) => /student_email|email_proof/i.test(sql)), false);
});

test('foreign Microsoft identity is denied before any mutation', async () => {
    const { tx, calls } = transaction('44444444-4444-4444-8444-444444444444');
    await assert.rejects(() => unlinkMicrosoftIdentity(tx, owner, identity), { statusCode: 403 });
    assert.equal(calls.some((sql) => sql.startsWith('UPDATE ')), false);
});

test('a repeated unlink is deliberately idempotent and keeps the tombstone restriction', async () => {
    const { tx } = transaction();
    const first = await unlinkMicrosoftIdentity(tx, owner, identity);
    const second = await unlinkMicrosoftIdentity(tx, owner, identity);
    assert.deepEqual(second, first);
    assert.equal(second.recovery, 'support_required');
});

test('a tombstone replay leaves later pending attempts untouched while retaining one-way revocation predicates', async () => {
    const { tx, calls } = transaction(owner, new Date('2026-01-01T00:00:00.000Z'));
    await unlinkMicrosoftIdentity(tx, owner, identity);
    assert.equal(calls.some((sql) => sql.startsWith('UPDATE microsoft_verification_attempts')), false);
    assert.match(calls.find((sql) => sql.startsWith('UPDATE microsoft_provider_proofs'))!, /revoked_at IS NULL/);
    assert.match(calls.find((sql) => sql.startsWith('UPDATE microsoft_identities SET revoked_at'))!, /revoked_at IS NULL/);
});
