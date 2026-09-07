import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { authenticateReportingKey, rotateReportingKey } from '../../services/auth/reporting-key.service.js';
import { assertFixtureDatabase, createTestPool } from './test-database.js';

test('reporting key rotation, quotas and owner revocation use durable authority', async (t) => {
    const pool = createTestPool();
    t.after(() => pool.end());
    const client = await pool.connect();
    await assertFixtureDatabase(client);
    client.release();
    const userId = randomUUID();
    await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'synthetic-hash', 'vendor')`,
        [userId, `${randomUUID()}@example.invalid`]);
    const vendor = await pool.query(`INSERT INTO vendors (user_id, name, status) VALUES ($1, 'Synthetic Vendor', 'active') RETURNING id`, [userId]);
    const vendorId = vendor.rows[0].id;

    await t.test('overlapping rotations leave exactly one usable key', async () => {
        const tokens = await Promise.all([rotateReportingKey(pool, userId), rotateReportingKey(pool, userId)]);
        const outcomes = await Promise.allSettled(tokens.map((token) => authenticateReportingKey(pool, token)));
        assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
        const active = await pool.query(`SELECT count(*)::int AS count FROM api_keys WHERE vendor_id = $1 AND status = 'active'`, [vendorId]);
        assert.equal(active.rows[0].count, 1);
    });

    const token = await rotateReportingKey(pool, userId);
    await t.test('concurrent requests cannot exceed the hourly quota; reset keeps lifetime accounting', async () => {
        await pool.query(`UPDATE api_keys SET rate_limit = 2 WHERE vendor_id = $1 AND status = 'active'`, [vendorId]);
        const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => authenticateReportingKey(pool, token)));
        assert.equal(attempts.filter((outcome) => outcome.status === 'fulfilled').length, 2);
        const usage = await pool.query(`SELECT usage_count, window_count FROM api_keys WHERE vendor_id = $1 AND status = 'active'`, [vendorId]);
        assert.deepEqual(usage.rows[0], { usage_count: 2, window_count: 2 });
        await pool.query(`UPDATE api_keys SET window_started_at = CURRENT_TIMESTAMP - INTERVAL '2 hours' WHERE vendor_id = $1`, [vendorId]);
        await authenticateReportingKey(pool, token);
        const reset = await pool.query(`SELECT usage_count, window_count FROM api_keys WHERE vendor_id = $1 AND status = 'active'`, [vendorId]);
        assert.deepEqual(reset.rows[0], { usage_count: 3, window_count: 1 });
    });

    await t.test('deleted owners and suspended vendors cannot authenticate or rotate', async () => {
        await pool.query(`UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [userId]);
        await assert.rejects(authenticateReportingKey(pool, token));
        await assert.rejects(rotateReportingKey(pool, userId));
        await pool.query(`UPDATE users SET deleted_at = NULL WHERE id = $1`, [userId]);
        await pool.query(`UPDATE vendors SET status = 'suspended' WHERE id = $1`, [vendorId]);
        await assert.rejects(authenticateReportingKey(pool, token));
        await assert.rejects(rotateReportingKey(pool, userId));
    });
});
