import assert from 'node:assert/strict';
import test from 'node:test';
import { independentlyValidEnrollmentEvidence } from './eligibility-read.service.js';

const context = {
    userId: '11111111-1111-4111-8111-111111111111',
    studentId: '22222222-2222-4222-8222-222222222222',
    email: 'student@students.school.example',
    universityId: '33333333-3333-4333-8333-333333333333',
    identityVersion: 2,
    policyVersion: 3,
    active: true,
};

const now = new Date('2026-09-20T12:00:00.000Z');

function candidate(id: string, grantId: string, expiresAt: Date) {
    return {
        authoritative_denial: false,
        evidence_id: id,
        method: 'enrollment',
        outcome: 'verified',
        verified_at: new Date('2026-09-10T12:00:00.000Z'),
        expires_at: expiresAt,
        revoked_at: null,
        evidence_identity_version: 2,
        evidence_policy_version: 3,
        processing_grant_id: grantId,
        proof_email: context.email,
        source: 'institution-registration:v1',
        provider_proof_id: null,
    };
}

test('enrollment fallback pre-filters expired evidence so only live rows reach row locks', async () => {
    const expired = candidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '44444444-4444-4444-8444-444444444444', new Date('2026-09-19T12:00:00.000Z'));
    const fresh = candidate('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '55555555-5555-4555-8555-555555555555', new Date('2026-12-19T12:00:00.000Z'));
    const byId = new Map([[expired.evidence_id, expired], [fresh.evidence_id, fresh]]);
    const lockedIds: unknown[] = [];
    let candidatesSql = '';
    const tx = {
        query: async (text: string, params?: unknown[]) => {
            if (text.includes('ORDER BY evidence.verified_at DESC')) {
                candidatesSql = text;
                // Emulate the database-side expiry predicate under test.
                const live = [expired, fresh].filter((row) => row.expires_at! > now);
                return { rows: live, rowCount: live.length };
            }
            if (text.includes('FROM verification_consents')) return { rows: [{ '1': 1 }], rowCount: 1 };
            if (text.includes('FOR UPDATE OF evidence')) {
                lockedIds.push(params?.[0]);
                return { rows: [byId.get(params?.[0] as string)], rowCount: 1 };
            }
            if (text.includes('SELECT clock_timestamp() AS now')) return { rows: [{ now }], rowCount: 1 };
            throw new Error(`Unexpected query: ${text}`);
        },
    };
    const selected = await independentlyValidEnrollmentEvidence(tx as never, context.userId, context);
    // The candidate set is enrollment-only: mailbox evidence can never reach
    // benefit selection, and retained-but-expired history is filtered by the
    // database clock before any grant, lock, or clock query runs for it.
    assert.match(candidatesSql, /AND evidence\.method = 'enrollment'/);
    assert.match(candidatesSql, /AND evidence\.expires_at > clock_timestamp\(\)/);
    assert.deepEqual(lockedIds, [fresh.evidence_id]);
    assert.equal(selected?.evidence_id, fresh.evidence_id);
});

test('enrollment fallback skips candidates whose processing grant was withdrawn', async () => {
    const withdrawn = candidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '44444444-4444-4444-8444-444444444444', new Date('2026-12-19T12:00:00.000Z'));
    const current = candidate('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '55555555-5555-4555-8555-555555555555', new Date('2026-12-19T12:00:00.000Z'));
    const byId = new Map([[withdrawn.evidence_id, withdrawn], [current.evidence_id, current]]);
    const tx = {
        query: async (text: string, params?: unknown[]) => {
            if (text.includes('ORDER BY evidence.verified_at DESC')) {
                return { rows: [withdrawn, current], rowCount: 2 };
            }
            if (text.includes('FROM verification_consents')) {
                const currentGrant = params?.[0] === current.processing_grant_id;
                return currentGrant ? { rows: [{ '1': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
            }
            if (text.includes('FOR UPDATE OF evidence')) {
                return { rows: [byId.get(params?.[0] as string)], rowCount: 1 };
            }
            if (text.includes('SELECT clock_timestamp() AS now')) return { rows: [{ now }], rowCount: 1 };
            throw new Error(`Unexpected query: ${text}`);
        },
    };
    const selected = await independentlyValidEnrollmentEvidence(tx as never, context.userId, context);
    assert.equal(selected?.evidence_id, current.evidence_id);
});
