import assert from 'node:assert/strict';
import test from 'node:test';
import { createVerificationFlowService, VerificationFlowRateLimitError } from './verification-flow.service.js';
import type { PoolClient } from 'pg';

test('consent discovery scopes SQL to the owner and pages history without eligibility reads', async () => {
    const rows = Array.from({ length: 21 }, (_, index) => ({ id: `grant-${index}`, kind: 'processing', accepted_at: new Date('2026-09-01'), withdrawn_at: index === 0 ? new Date('2026-09-02') : null, origin: null, purpose: null }));
    const client = {
        query: async (sql: string, values?: unknown[]) => {
            if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [], rowCount: 0 };
            assert.match(sql, /FROM verification_consents/);
            assert.match(sql, /user_id = \$1/);
            assert.match(sql, /id > \$2::uuid/);
            assert.match(sql, /LIMIT 21/);
            assert.doesNotMatch(sql, /withdrawn_at IS NULL|eligibility|student_profiles/);
            assert.deepEqual(values, ['owner-a', 'cursor-id']);
            return { rows, rowCount: rows.length };
        },
        release: () => undefined,
    } as unknown as PoolClient;
    const service = createVerificationFlowService({ pool: { connect: async () => client }, isEmailConfigured: () => false, deliverOtp: async () => ({ success: false }) });
    const result = await service.listConsents('owner-a', 'cursor-id');
    assert.equal(result.items.length, 20);
    assert.equal(result.items[0]?.withdrawnAt?.toISOString(), '2026-09-02T00:00:00.000Z');
    assert.equal(result.nextCursor, 'grant-19');
});

test('preserves the persisted retry deadline when the controller must emit Retry-After', () => {
    const retryAt = new Date('2026-09-05T12:34:56.000Z');
    const error = new VerificationFlowRateLimitError('Please wait before requesting another verification code.', retryAt);

    assert.equal(error.statusCode, 429);
    assert.equal(error.retryAt.getTime(), retryAt.getTime());
    assert.deepEqual(error.details, { retryAt: '2026-09-05T12:34:56.000Z' });
});
