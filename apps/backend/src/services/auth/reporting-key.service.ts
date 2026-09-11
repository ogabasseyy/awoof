import { createHash, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { UnauthorizedError, RateLimitError } from '../../common/errors/AppError.js';

const derive = promisify(pbkdf2);
const lookup = (token: string) => createHash('sha256').update(token).digest('hex');
type Database = Pick<Pool, 'query' | 'connect'>;

export async function rotateReportingKey(pool: Database, userId: string): Promise<string> {
    const token = `awoof_${randomBytes(32).toString('hex')}`;
    const salt = randomBytes(16);
    const digest = await derive(token, salt, 100000, 32, 'sha256');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const owner = await client.query(
            `SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL AND role = 'vendor' FOR UPDATE`, [userId],
        );
        if (owner.rows.length !== 1) throw new UnauthorizedError('Active vendor required');
        const vendor = await client.query(
            `SELECT id FROM vendors WHERE user_id = $1 AND deleted_at IS NULL AND status = 'active' FOR UPDATE`, [userId],
        );
        if (vendor.rows.length !== 1) throw new UnauthorizedError('Active vendor required');
        const vendorId = vendor.rows[0].id;
        await client.query(`UPDATE api_keys SET status = 'revoked', updated_at = CURRENT_TIMESTAMP
                            WHERE vendor_id = $1 AND status = 'active'`, [vendorId]);
        await client.query(
            `INSERT INTO api_keys (vendor_id, key_hash, lookup_hash, name, rate_limit, status)
             VALUES ($1, $2, $3, 'Transaction Reporting API Key', 1000, 'active')`,
            [vendorId, `${digest.toString('hex')}:${salt.toString('hex')}`, lookup(token)],
        );
        await client.query('COMMIT');
        return token;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

export async function authenticateReportingKey(pool: Pick<Pool, 'query'>, token: string) {
    if (!/^awoof_[a-f0-9]{64}$/.test(token)) throw new UnauthorizedError('Authentication failed');
    const result = await pool.query(
        `SELECT k.id, k.key_hash FROM api_keys k
         JOIN vendors v ON v.id = k.vendor_id JOIN users u ON u.id = v.user_id
         WHERE k.lookup_hash = $1 AND k.status = 'active'
           AND (k.expires_at IS NULL OR k.expires_at > CURRENT_TIMESTAMP)
           AND v.status = 'active' AND v.deleted_at IS NULL AND u.deleted_at IS NULL AND u.role = 'vendor'`,
        [lookup(token)],
    );
    if (result.rows.length !== 1) throw new UnauthorizedError('Authentication failed');
    const key = result.rows[0];
    if (!/^[a-f0-9]{64}:[a-f0-9]{32}$/.test(key.key_hash)) throw new UnauthorizedError('Authentication failed');
    const [hash, salt] = key.key_hash.split(':');
    const computed = await derive(token, Buffer.from(salt, 'hex'), 100000, 32, 'sha256');
    if (!timingSafeEqual(computed, Buffer.from(hash, 'hex'))) throw new UnauthorizedError('Authentication failed');

    // A single conditional UPDATE serializes concurrent requests and rechecks authority
    // after the asynchronous verifier. usage_count is lifetime; window_count is hourly.
    const admitted = await pool.query(
        `UPDATE api_keys k SET
           window_count = CASE WHEN window_started_at <= CURRENT_TIMESTAMP - INTERVAL '1 hour'
                               THEN 1 ELSE window_count + 1 END,
           window_started_at = CASE WHEN window_started_at <= CURRENT_TIMESTAMP - INTERVAL '1 hour'
                                    THEN CURRENT_TIMESTAMP ELSE window_started_at END,
           usage_count = LEAST(COALESCE(usage_count, 0)::bigint + 1, 2147483647),
           updated_at = CURRENT_TIMESTAMP
         FROM vendors v JOIN users u ON u.id = v.user_id
         WHERE k.id = $1 AND k.key_hash = $2 AND k.vendor_id = v.id AND k.status = 'active'
           AND (k.expires_at IS NULL OR k.expires_at > CURRENT_TIMESTAMP)
           AND v.status = 'active' AND v.deleted_at IS NULL AND u.deleted_at IS NULL AND u.role = 'vendor'
           AND COALESCE(k.rate_limit, 0) > 0
           AND (window_started_at <= CURRENT_TIMESTAMP - INTERVAL '1 hour' OR window_count < k.rate_limit)
         RETURNING u.id AS user_id, u.email`, [key.id, key.key_hash],
    );
    if (admitted.rows.length !== 1) throw new RateLimitError('Reporting key is unavailable or its hourly limit has been reached');
    return admitted.rows[0] as { user_id: string; email: string };
}
