import type { PoolClient } from 'pg';
import { getPool } from '../../config/database.js';

export async function inTransaction<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
    const tx = await getPool().connect();
    try {
        await tx.query('BEGIN');
        const value = await work(tx);
        await tx.query('COMMIT');
        return value;
    } catch (error) {
        await tx.query('ROLLBACK');
        throw error;
    } finally {
        tx.release();
    }
}
