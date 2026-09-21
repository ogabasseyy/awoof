import pg from 'pg';
import dotenv from 'dotenv';
import { revokeUnusedLegacyTokens } from '../services/verification/verification-token.service.js';

dotenv.config({ override: false, quiet: true });

function retirementPool(): pg.Pool {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl) {
        return new pg.Pool({ connectionString: databaseUrl, max: 1, idleTimeoutMillis: 1_000, connectionTimeoutMillis: 2_000 });
    }
    if (!process.env.DB_HOST || !process.env.DB_NAME || !process.env.DB_USER) throw new Error('Database connection configuration is unavailable');
    return new pg.Pool({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        max: 1,
        idleTimeoutMillis: 1_000,
        connectionTimeoutMillis: 2_000,
    });
}

async function main(): Promise<void> {
    let pool: pg.Pool | undefined;
    let reported = false;
    const fail = (): void => {
        if (!reported) process.stderr.write('verification token retirement failed\n');
        reported = true;
        process.exitCode = 1;
    };
    try {
        pool = retirementPool();
        // pg can surface an idle client error outside a query promise. Never
        // forward that object because it may include a connection URL/value.
        pool.on('error', fail);
        const client = await pool.connect();
        try {
            const revoked = await revokeUnusedLegacyTokens(client);
            process.stdout.write(`verification token retirement complete: revoked=${revoked}\n`);
        } finally {
            client.release();
        }
    } catch {
        fail();
    } finally {
        if (pool) {
            try { await pool.end(); }
            catch { fail(); }
        }
    }
}

void main();
