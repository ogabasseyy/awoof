import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ override: false, quiet: true });
// The service import chain loads shared config (with its own dotenv call),
// so silence that notice before the deferred import below runs.
process.env.DOTENV_CONFIG_QUIET ??= 'true';

function cleanupPool(): pg.Pool {
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
        if (!reported) process.stderr.write('student SSO cleanup failed\n');
        reported = true;
        process.exitCode = 1;
    };
    try {
        const { cleanupStudentSsoTransients } = await import('../services/auth/student-sso-flow.service.js');
        pool = cleanupPool();
        // pg can surface an idle client error outside a query promise. Never
        // forward that object because it may include a connection URL/value.
        pool.on('error', fail);
        const client = await pool.connect();
        try {
            const result = await cleanupStudentSsoTransients(client);
            process.stdout.write(
                `student SSO cleanup complete: attemptsFailed=${result.attemptsFailed} handoffsScrubbed=${result.handoffsScrubbed} `
                + `attemptsDeleted=${result.attemptsDeleted} handoffsDeleted=${result.handoffsDeleted} grantsDeleted=${result.grantsDeleted}\n`,
            );
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
