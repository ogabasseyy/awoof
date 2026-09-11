import pg, { type PoolClient } from 'pg';

const DATABASE_NAME = /^awoof_test_[a-z0-9_]+$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]']);

export function validateTestEnvironment(environment: NodeJS.ProcessEnv = process.env): string {
    if (environment.NODE_ENV !== 'test') throw new Error('PostgreSQL integration tests require NODE_ENV=test');
    const url = environment.AWOOF_TEST_DATABASE_URL;
    if (!url || environment.DATABASE_URL !== url) {
        throw new Error('PostgreSQL integration tests require AWOOF_TEST_DATABASE_URL to exactly equal DATABASE_URL');
    }
    if (!environment.AWOOF_TEST_GUARD || environment.AWOOF_TEST_GUARD.length < 32) {
        throw new Error('PostgreSQL integration tests require a runner-generated AWOOF_TEST_GUARD');
    }
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error('AWOOF_TEST_DATABASE_URL must be a valid PostgreSQL URL');
    }
    if (parsed.search || parsed.hash) {
        throw new Error('AWOOF_TEST_DATABASE_URL must not include query parameters or fragments');
    }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !LOOPBACK_HOSTS.has(parsed.hostname)) {
        throw new Error('AWOOF_TEST_DATABASE_URL must use a literal loopback PostgreSQL host');
    }
    const database = decodeURIComponent(parsed.pathname.slice(1));
    if (!DATABASE_NAME.test(database)) {
        throw new Error('AWOOF_TEST_DATABASE_URL must target an awoof_test_<suffix> database');
    }
    return url;
}

export function createTestPool(): pg.Pool {
    return new pg.Pool({ connectionString: validateTestEnvironment() });
}

export async function assertFixtureDatabase(client: PoolClient): Promise<void> {
    const actual = await client.query<{ current_database: string }>('SELECT current_database()');
    const name = actual.rows[0]?.current_database;
    if (!name || !DATABASE_NAME.test(name)) throw new Error('Refusing fixtures outside a disposable awoof_test database');
}

export async function inTransaction<T>(client: PoolClient, operation: () => Promise<T>): Promise<T> {
    await client.query('BEGIN');
    try {
        const result = await operation();
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
}

export async function withTestClient<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        await assertFixtureDatabase(client);
        return await operation(client);
    } finally {
        client.release();
        await pool.end();
    }
}
