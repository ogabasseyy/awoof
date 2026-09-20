import assert from 'node:assert/strict';
import test from 'node:test';
import { trustedMicrosoftObservation } from './eligibility-evidence.service.js';

const identity = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    objectId: '22222222-2222-4222-8222-222222222222',
};

test('trusted Microsoft observation accepts only the canonical graph-ready student result', () => {
    const observedAt = new Date('2026-09-12T10:00:00.000Z');
    assert.deepEqual(trustedMicrosoftObservation({
        identity,
        educationObservation: { outcome: 'student', objectId: identity.objectId, observedAt: observedAt.toISOString() },
    }), { identity, observedAt });
});

test('trusted Microsoft observation refuses identity-only, unknown, mismatched, and untrusted timestamps', () => {
    assert.equal(trustedMicrosoftObservation(identity), null);
    assert.equal(trustedMicrosoftObservation({ identity, educationObservation: { outcome: 'unknown', reason: 'role_not_confirmed' } }), null);
    assert.equal(trustedMicrosoftObservation({ identity, educationObservation: { outcome: 'student', objectId: 'other', observedAt: new Date().toISOString() } }), null);
    assert.equal(trustedMicrosoftObservation({ identity, educationObservation: { outcome: 'student', objectId: identity.objectId, observedAt: 'not-a-date' } }), null);
});
