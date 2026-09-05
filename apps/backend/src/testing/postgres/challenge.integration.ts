import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import { consumeChallenge, requestChallenge } from '../../services/verification/challenge.service.js';
import { assertFixtureDatabase, createTestPool, inTransaction, validateTestEnvironment, withTestClient } from './test-database.js';

const purpose = 'student_signup' as const;
const subject = () => `student-${randomUUID()}@example.invalid`;
const bindings = () => ({ universityId: randomUUID(), name: 'Synthetic Student', verificationConsent: true, noticeVersion: 'v1' });
const wrongCode = (code: string) => code === '000000' ? '000001' : '000000';

async function issue(client: PoolClient, subjectKey = subject()) {
    return await inTransaction(client, () => requestChallenge(client, { purpose, subjectKey, bindings: bindings() }));
}

async function consume(client: PoolClient, subjectKey: string, challengeId: string, code: string) {
    return await inTransaction(client, () => consumeChallenge(client, { purpose, subjectKey, challengeId, code }));
}

async function backendPid(client: PoolClient): Promise<number> {
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    if (!pid) throw new Error('backend PID was not returned');
    return pid;
}

async function assertBlocked(observer: PoolClient, pid: number): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const blockers = await observer.query<{ pids: number[] }>('SELECT pg_blocking_pids($1) AS pids', [pid]);
        if ((blockers.rows[0]?.pids.length ?? 0) > 0) return;
        await delay(10);
    }
    throw new Error(`Expected backend PID ${pid} to be blocked before releasing the lock`);
}

test('refuses a direct integration invocation without its runner guard', () => {
    assert.throws(() => validateTestEnvironment({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://awoof_test@127.0.0.1:5432/awoof_test_guard' }), /AWOOF_TEST_DATABASE_URL/);
});

test('refuses PostgreSQL URL query, fragment, and socket overrides before connecting', () => {
    const base = 'postgresql://awoof_test@127.0.0.1:5432/awoof_test_guard';
    const environment = { NODE_ENV: 'test', DATABASE_URL: base, AWOOF_TEST_DATABASE_URL: base, AWOOF_TEST_GUARD: 'a'.repeat(32) };
    for (const suffix of ['?host=remote.example.invalid', '?port=6543', '?host=/tmp', '#fragment']) {
        assert.throws(() => validateTestEnvironment({ ...environment, DATABASE_URL: `${base}${suffix}`, AWOOF_TEST_DATABASE_URL: `${base}${suffix}` }), /must not include query parameters or fragments/);
    }
});

test('issues a six-digit challenge without persisting raw subject or OTP', async () => {
    await withTestClient(async (client) => {
        const subjectKey = subject();
        const expectedBindings = bindings();
        const issued = await inTransaction(client, () => requestChallenge(client, { purpose, subjectKey, bindings: expectedBindings }));
        assert.equal(issued.status, 'issued');
        if (issued.status !== 'issued') return;
        assert.match(issued.code, /^\d{6}$/);
        const stored = await client.query<{ subject_digest: string; secret_digest: string; bindings: unknown }>(
            'SELECT subject_digest, secret_digest, bindings FROM verification_challenges WHERE id = $1', [issued.challengeId],
        );
        assert.equal(stored.rowCount, 1);
        assert.notEqual(stored.rows[0]?.subject_digest, subjectKey);
        assert.notEqual(stored.rows[0]?.secret_digest, issued.code);
        assert.deepEqual(stored.rows[0]?.bindings, expectedBindings);
    });
});

test('issues distinct immutable bindings after cooldown', async () => {
    await withTestClient(async (client) => {
        const subjectKey = subject();
        const firstBindings = bindings();
        const first = await inTransaction(client, () => requestChallenge(client, { purpose, subjectKey, bindings: firstBindings }));
        assert.equal(first.status, 'issued');
        if (first.status !== 'issued') return;
        firstBindings.name = 'Mutated Caller Object';
        await client.query(`UPDATE verification_challenge_budgets SET resend_available_at = clock_timestamp() - interval '1 second' WHERE current_challenge_id = $1`, [first.challengeId]);
        const second = await inTransaction(client, () => requestChallenge(client, { purpose, subjectKey, bindings: bindings() }));
        assert.equal(second.status, 'issued');
        if (second.status !== 'issued') return;
        assert.notEqual(first.challengeId, second.challengeId);
        const original = await client.query<{ bindings: { name: string } }>('SELECT bindings FROM verification_challenges WHERE id = $1', [first.challengeId]);
        assert.equal(original.rows[0]?.bindings.name, 'Synthetic Student');
    });
});

test('accepts a near-limit canonical binding and deliberately rejects exponent expansion', async () => {
    await withTestClient(async (client) => {
        const nearLimit = Object.fromEntries(Array.from({ length: 190 }, (_, index) => [`field_${index}`, 'value']));
        const canonicalBytes = await client.query<{ bytes: number }>('SELECT octet_length($1::jsonb::text) AS bytes', [JSON.stringify(nearLimit)]);
        assert.ok((canonicalBytes.rows[0]?.bytes ?? 0) > 0.95 * 4096);
        assert.ok((canonicalBytes.rows[0]?.bytes ?? Infinity) <= 4096);
        const accepted = await inTransaction(client, () => requestChallenge(client, { purpose, subjectKey: subject(), bindings: nearLimit }));
        assert.equal(accepted.status, 'issued');
        await assert.rejects(
            inTransaction(client, () => requestChallenge(client, { purpose, subjectKey: subject(), bindings: { values: Array(30).fill(1e308) } })),
            /canonical JSONB size limit/,
        );
    });
});

test('rejects wrong subject, purpose, id, malformed code, and secret', async () => {
    await withTestClient(async (client) => {
        const subjectKey = subject();
        const issued = await issue(client, subjectKey);
        assert.equal(issued.status, 'issued');
        if (issued.status !== 'issued') return;
        assert.equal((await consume(client, subject(), issued.challengeId, issued.code)).status, 'invalid');
        const wrongPurpose = await inTransaction(client, () => consumeChallenge(client, { purpose: 'account_email', subjectKey, challengeId: issued.challengeId, code: issued.code }));
        assert.equal(wrongPurpose.status, 'invalid');
        assert.equal((await consume(client, subjectKey, randomUUID(), issued.code)).status, 'invalid');
        assert.equal((await consume(client, subjectKey, issued.challengeId, 'not-a-code')).status, 'invalid');
        assert.equal((await consume(client, subjectKey, issued.challengeId, wrongCode(issued.code))).status, 'invalid');
    });
});

test('locks after exactly five failed guesses', async () => {
    await withTestClient(async (client) => {
        const subjectKey = subject();
        const issued = await issue(client, subjectKey);
        assert.equal(issued.status, 'issued');
        if (issued.status !== 'issued') return;
        for (let attempt = 0; attempt < 5; attempt += 1) {
            assert.equal((await consume(client, subjectKey, issued.challengeId, wrongCode(issued.code))).status, 'invalid');
        }
        assert.equal((await consume(client, subjectKey, issued.challengeId, issued.code)).status, 'locked');
    });
});

test('enforces cooldown, supersedes resends, and retains failure and send budgets', async () => {
    await withTestClient(async (client) => {
        const subjectKey = subject();
        const first = await issue(client, subjectKey);
        assert.equal(first.status, 'issued');
        if (first.status !== 'issued') return;
        assert.equal((await inTransaction(client, () => requestChallenge(client, { purpose, subjectKey, bindings: bindings() }))).status, 'cooldown');
        assert.equal((await consume(client, subjectKey, first.challengeId, wrongCode(first.code))).status, 'invalid');
        await client.query(`UPDATE verification_challenge_budgets SET resend_available_at = clock_timestamp() - interval '1 second' WHERE current_challenge_id = $1`, [first.challengeId]);
        const second = await inTransaction(client, () => requestChallenge(client, { purpose, subjectKey, bindings: bindings() }));
        assert.equal(second.status, 'issued');
        if (second.status !== 'issued') return;
        assert.equal((await consume(client, subjectKey, first.challengeId, first.code)).status, 'invalid');
        const budget = await client.query<{ failed_attempts: number; send_count: number }>('SELECT failed_attempts, send_count FROM verification_challenge_budgets WHERE current_challenge_id = $1', [second.challengeId]);
        assert.deepEqual(budget.rows[0], { failed_attempts: 2, send_count: 2 });
    });
});

test('preserves cooldown when request or consume resets the fixed budget window', async () => {
    await withTestClient(async (client) => {
        const subjectKey = subject();
        const issued = await issue(client, subjectKey);
        assert.equal(issued.status, 'issued');
        if (issued.status !== 'issued') return;
        await client.query(`UPDATE verification_challenge_budgets SET window_started_at = clock_timestamp() - interval '10 minutes 1 second', resend_available_at = clock_timestamp() + interval '50 seconds' WHERE current_challenge_id = $1`, [issued.challengeId]);
        const requestResult = await inTransaction(client, () => requestChallenge(client, { purpose, subjectKey, bindings: bindings() }));
        assert.equal(requestResult.status, 'cooldown');
        await client.query(`UPDATE verification_challenge_budgets SET window_started_at = clock_timestamp() - interval '10 minutes 1 second', resend_available_at = clock_timestamp() + interval '50 seconds' WHERE current_challenge_id = $1`, [issued.challengeId]);
        assert.equal((await consume(client, subjectKey, randomUUID(), issued.code)).status, 'invalid');
        const budget = await client.query<{ resend_available_at: Date }>('SELECT resend_available_at FROM verification_challenge_budgets WHERE current_challenge_id = $1', [issued.challengeId]);
        assert.ok((budget.rows[0]?.resend_available_at.getTime() ?? 0) > Date.now() + 40_000);
    });
});

test('locks additional sends at the fixed-window limit of ten', async () => {
    await withTestClient(async (client) => {
        const subjectKey = subject();
        let latest = await issue(client, subjectKey);
        assert.equal(latest.status, 'issued');
        for (let send = 1; send < 10; send += 1) {
            if (latest.status !== 'issued') throw new Error('challenge unexpectedly rejected before send limit');
            await client.query(`UPDATE verification_challenge_budgets SET resend_available_at = clock_timestamp() - interval '1 second' WHERE current_challenge_id = $1`, [latest.challengeId]);
            latest = await inTransaction(client, () => requestChallenge(client, { purpose, subjectKey, bindings: bindings() }));
            assert.equal(latest.status, 'issued');
        }
        assert.equal((await inTransaction(client, () => requestChallenge(client, { purpose, subjectKey, bindings: bindings() }))).status, 'locked');
    });
});

test('expires OTPs and only resets a budget after its fixed window', async () => {
    await withTestClient(async (client) => {
        const subjectKey = subject();
        const expired = await issue(client, subjectKey);
        assert.equal(expired.status, 'issued');
        if (expired.status !== 'issued') return;
        await client.query(`UPDATE verification_challenges SET created_at = clock_timestamp() - interval '20 minutes', expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [expired.challengeId]);
        assert.equal((await consume(client, subjectKey, expired.challengeId, expired.code)).status, 'expired');
        await client.query(`UPDATE verification_challenge_budgets
            SET failed_attempts = 5, send_count = 10, window_started_at = clock_timestamp() - interval '10 minutes 1 second', resend_available_at = clock_timestamp() - interval '1 second'
            WHERE current_challenge_id = $1`, [expired.challengeId]);
        const reset = await inTransaction(client, () => requestChallenge(client, { purpose, subjectKey, bindings: bindings() }));
        assert.equal(reset.status, 'issued');
        if (reset.status !== 'issued') return;
        const budget = await client.query<{ failed_attempts: number; send_count: number }>('SELECT failed_attempts, send_count FROM verification_challenge_budgets WHERE current_challenge_id = $1', [reset.challengeId]);
        assert.deepEqual(budget.rows[0], { failed_attempts: 0, send_count: 1 });
    });
});

test('serializes concurrent first requests and concurrent confirmations', async () => {
    const pool = createTestPool();
    const firstClient = await pool.connect();
    const secondClient = await pool.connect();
    const observer = await pool.connect();
    try {
        await assertFixtureDatabase(firstClient);
        await assertFixtureDatabase(secondClient);
        await assertFixtureDatabase(observer);
        const secondPid = await backendPid(secondClient);
        const subjectKey = subject();
        await firstClient.query('BEGIN');
        const firstRequest = await requestChallenge(firstClient, { purpose, subjectKey, bindings: bindings() });
        assert.equal(firstRequest.status, 'issued');
        if (firstRequest.status !== 'issued') throw new Error('first request unexpectedly rejected');
        await secondClient.query('BEGIN');
        const blockedRequest = requestChallenge(secondClient, { purpose, subjectKey, bindings: bindings() });
        await assertBlocked(observer, secondPid);
        await firstClient.query('COMMIT');
        const secondRequest = await blockedRequest;
        await secondClient.query('COMMIT');
        assert.equal(secondRequest.status, 'cooldown');
        const budget = await firstClient.query<{ send_count: number }>('SELECT send_count FROM verification_challenge_budgets WHERE current_challenge_id = $1', [firstRequest.challengeId]);
        assert.equal(budget.rows[0]?.send_count, 1);

        await firstClient.query('BEGIN');
        const firstConfirmation = await consumeChallenge(firstClient, { purpose, subjectKey, challengeId: firstRequest.challengeId, code: firstRequest.code });
        await secondClient.query('BEGIN');
        const blockedConfirmation = consumeChallenge(secondClient, { purpose, subjectKey, challengeId: firstRequest.challengeId, code: firstRequest.code });
        await assertBlocked(observer, secondPid);
        await firstClient.query('COMMIT');
        const secondConfirmation = await blockedConfirmation;
        await secondClient.query('COMMIT');
        assert.equal([firstConfirmation, secondConfirmation].filter((result) => result.status === 'verified').length, 1);
    } finally {
        firstClient.release();
        secondClient.release();
        observer.release();
        await pool.end();
    }
});

test('serializes a resend behind a concurrent confirmation', async () => {
    const pool = createTestPool();
    const confirmClient = await pool.connect();
    const resendClient = await pool.connect();
    const observer = await pool.connect();
    try {
        await assertFixtureDatabase(confirmClient);
        await assertFixtureDatabase(resendClient);
        await assertFixtureDatabase(observer);
        const resendPid = await backendPid(resendClient);
        const subjectKey = subject();
        const issued = await issue(confirmClient, subjectKey);
        assert.equal(issued.status, 'issued');
        if (issued.status !== 'issued') return;
        await confirmClient.query(`UPDATE verification_challenge_budgets SET resend_available_at = clock_timestamp() - interval '1 second' WHERE current_challenge_id = $1`, [issued.challengeId]);
        await confirmClient.query('BEGIN');
        const confirmation = await consumeChallenge(confirmClient, { purpose, subjectKey, challengeId: issued.challengeId, code: issued.code });
        await resendClient.query('BEGIN');
        const resend = requestChallenge(resendClient, { purpose, subjectKey, bindings: bindings() });
        await assertBlocked(observer, resendPid);
        await confirmClient.query('COMMIT');
        const replacement = await resend;
        await resendClient.query('COMMIT');
        assert.equal(confirmation.status, 'verified');
        assert.equal(replacement.status, 'issued');
    } finally {
        confirmClient.release();
        resendClient.release();
        observer.release();
        await pool.end();
    }
});

test('rejects an old confirmation when a serialized resend wins first', async () => {
    const pool = createTestPool();
    const resendClient = await pool.connect();
    const confirmClient = await pool.connect();
    const observer = await pool.connect();
    try {
        await assertFixtureDatabase(resendClient);
        await assertFixtureDatabase(confirmClient);
        await assertFixtureDatabase(observer);
        const confirmPid = await backendPid(confirmClient);
        const subjectKey = subject();
        const issued = await issue(resendClient, subjectKey);
        assert.equal(issued.status, 'issued');
        if (issued.status !== 'issued') return;
        await resendClient.query(`UPDATE verification_challenge_budgets SET resend_available_at = clock_timestamp() - interval '1 second' WHERE current_challenge_id = $1`, [issued.challengeId]);
        await resendClient.query('BEGIN');
        const replacement = await requestChallenge(resendClient, { purpose, subjectKey, bindings: bindings() });
        await confirmClient.query('BEGIN');
        const oldConfirmation = consumeChallenge(confirmClient, { purpose, subjectKey, challengeId: issued.challengeId, code: issued.code });
        await assertBlocked(observer, confirmPid);
        await resendClient.query('COMMIT');
        const confirmation = await oldConfirmation;
        await confirmClient.query('COMMIT');
        assert.equal(replacement.status, 'issued');
        assert.equal(confirmation.status, 'invalid');
    } finally {
        resendClient.release();
        confirmClient.release();
        observer.release();
        await pool.end();
    }
});

test('serializes wrong guesses and makes rolled-back consumption available again', async () => {
    const pool = createTestPool();
    const firstClient = await pool.connect();
    const secondClient = await pool.connect();
    const observer = await pool.connect();
    try {
        await assertFixtureDatabase(firstClient);
        await assertFixtureDatabase(secondClient);
        await assertFixtureDatabase(observer);
        const secondPid = await backendPid(secondClient);
        const subjectKey = subject();
        const issued = await issue(firstClient, subjectKey);
        assert.equal(issued.status, 'issued');
        if (issued.status !== 'issued') return;
        await firstClient.query('BEGIN');
        const firstWrong = await consumeChallenge(firstClient, { purpose, subjectKey, challengeId: issued.challengeId, code: wrongCode(issued.code) });
        await secondClient.query('BEGIN');
        const secondWrong = consumeChallenge(secondClient, { purpose, subjectKey, challengeId: issued.challengeId, code: wrongCode(issued.code) });
        await assertBlocked(observer, secondPid);
        await firstClient.query('COMMIT');
        assert.equal(firstWrong.status, 'invalid');
        assert.equal((await secondWrong).status, 'invalid');
        await secondClient.query('COMMIT');
        const counted = await firstClient.query<{ failed_attempts: number }>('SELECT failed_attempts FROM verification_challenge_budgets WHERE current_challenge_id = $1', [issued.challengeId]);
        assert.equal(counted.rows[0]?.failed_attempts, 2);

        await assert.rejects(inTransaction(firstClient, async () => {
            const consumed = await consumeChallenge(firstClient, { purpose, subjectKey, challengeId: issued.challengeId, code: issued.code });
            assert.equal(consumed.status, 'verified');
            throw new Error('synthetic proof write failed');
        }), /synthetic proof write failed/);
        assert.equal((await consume(firstClient, subjectKey, issued.challengeId, issued.code)).status, 'verified');
    } finally {
        firstClient.release();
        secondClient.release();
        observer.release();
        await pool.end();
    }
});
