import assert from 'node:assert/strict';
import { randomBytes, pbkdf2 } from 'node:crypto';
import test from 'node:test';
import { promisify } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { exchangeMerchantAssertion } from './merchant-assertion.service.js';

const derive = promisify(pbkdf2);

const assertionId = 'a1b2c3d4-0000-4000-8000-000000000001';
const vendorId = 'b1b2c3d4-0000-4000-8000-000000000002';
const studentId = 'c1b2c3d4-0000-4000-8000-000000000003';
const ownerId = 'd1b2c3d4-0000-4000-8000-000000000004';
const keyId = 'e1b2c3d4-0000-4000-8000-000000000005';
const campaignId = 'autumn-2026';
const purpose = '10% student discount';

function committedReceipt(): Record<string, unknown> {
    return {
        receiptId: 'f1b2c3d4-0000-4000-8000-000000000006',
        merchantSubject: 'a1b2c3d4-0000-4000-8000-000000000007',
        eligible: true,
        assuranceMethod: 'enrollment',
        institutionId: 'b1b2c3d4-0000-4000-8000-000000000008',
        verifiedAt: '2026-09-21T00:00:00.000Z',
        validUntil: '2026-09-28T00:00:00.000Z',
        campaignId,
    };
}

async function retryFixture(storedReceipt: Record<string, unknown>) {
    const token = `awoof_${randomBytes(32).toString('hex')}`;
    const salt = randomBytes(16);
    const digest = await derive(token, salt, 100000, 32, 'sha256');
    const keyHash = `${digest.toString('hex')}:${salt.toString('hex')}`;
    const assertion = {
        id: assertionId, vendor_id: vendorId, user_id: studentId,
        origin: 'https://shop.example.test', purpose, campaign_id: campaignId,
        disclosure_grant_id: 'c1b2c3d4-0000-4000-8000-000000000009',
        evidence_id: 'c1b2c3d4-0000-4000-8000-00000000000a',
        processing_grant_id: 'c1b2c3d4-0000-4000-8000-00000000000b',
        claim_session_id: null, product_id: null,
    };
    const txStatements: string[] = [];
    const tx = {
        query: async (sql: string) => {
            txStatements.push(sql);
            if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [], rowCount: 0 };
            if (sql.includes('FROM vendors') && sql.includes('FOR UPDATE')) {
                return { rows: [{ id: vendorId, user_id: ownerId, status: 'active', deleted_at: null }], rowCount: 1 };
            }
            if (sql.includes('FROM vendors')) return { rows: [{ user_id: ownerId }], rowCount: 1 };
            if (sql.includes('FROM users')) {
                return {
                    rows: [
                        { id: studentId, role: 'student', deleted_at: null },
                        { id: ownerId, role: 'vendor', deleted_at: null },
                    ],
                    rowCount: 2,
                };
            }
            if (sql.includes('FROM api_keys')) return { rows: [{ id: keyId }], rowCount: 1 };
            if (sql.includes('FROM merchant_assertion_receipts')) {
                assert.match(sql, /JOIN merchant_assertions/, 'retry read must join the linked assertion for purpose');
                return { rows: [{ assertion_id: assertionId, receipt: storedReceipt, purpose }], rowCount: 1 };
            }
            throw new Error(`unexpected tx query: ${sql}`);
        },
        release: () => undefined,
    } as unknown as PoolClient;
    const pool = {
        query: async (sql: string) => {
            if (sql.includes('SELECT k.id, k.key_hash')) return { rows: [{ id: keyId, key_hash: keyHash }], rowCount: 1 };
            if (sql.startsWith('UPDATE api_keys')) {
                return { rows: [{ user_id: ownerId, email: 'vendor@example.invalid' }], rowCount: 1 };
            }
            if (sql.includes('FROM merchant_assertions')) return { rows: [assertion], rowCount: 1 };
            if (sql.includes('FROM merchant_assertion_receipts')) return { rows: [{ assertion_id: assertionId }], rowCount: 1 };
            throw new Error(`unexpected pool query: ${sql}`);
        },
        connect: async () => tx,
    } as unknown as Pool;
    return { pool, token, txStatements };
}

test('idempotency retry fills purpose on a legacy purpose-less committed receipt', async () => {
    const stored = committedReceipt();
    assert.equal('purpose' in stored, false);
    const { pool, token, txStatements } = await retryFixture(stored);
    const receipt = await exchangeMerchantAssertion(pool, token, {
        code: 'C'.repeat(43), campaignId, idempotencyKey: 'order-12345',
    });
    assert.equal(receipt.purpose, purpose);
    assert.deepEqual({ ...receipt, purpose: undefined }, { ...stored, purpose: undefined });
    for (const statement of txStatements) {
        assert.doesNotMatch(statement, /INSERT INTO merchant_assertion_receipts|UPDATE merchant_assertions|INSERT INTO merchant_subjects/);
    }
});

test('idempotency retry returns a current committed receipt unchanged', async () => {
    const stored = { ...committedReceipt(), purpose };
    const { pool, token } = await retryFixture(stored);
    const receipt = await exchangeMerchantAssertion(pool, token, {
        code: 'C'.repeat(43), campaignId, idempotencyKey: 'order-12345',
    });
    assert.deepEqual(receipt, stored);
});
