import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { StudentAccountRecoveryService } from './student-account-recovery.service.js';

test('recovery start accepts only the two server-bound recovery purposes', async () => {
    const service = new StudentAccountRecoveryService({
        pool: { connect: async () => { throw new Error('database must not be used for invalid input'); } } as never,
        recoveryCodeKey: 'test-recovery-code-key',
    });

    await assert.rejects(
        () => service.start({ email: 'student@example.test', purpose: 'replace_identity' as never }),
        /purpose is invalid/i,
    );
});

test('recovery start fails closed before database work when the OTP outbox key is unavailable', async () => {
    let databaseTouched = false;
    const service = new StudentAccountRecoveryService(Object.assign({
        pool: { connect: async () => { databaseTouched = true; throw new Error('database should not be reached'); } } as never,
        recoveryCodeKey: 'test-recovery-code-key',
    }, { outboxEncryptionKey: null }));

    await assert.rejects(
        () => service.start({ email: 'student@example.test', purpose: 'lost_access', idempotencyKey: 'retry-key' }),
        /outbox encryption key is unavailable/i,
    );
    assert.equal(databaseTouched, false, 'missing key must not create a recovery attempt or challenge');
});

test('recovery verify and complete reject malformed attempt ids before touching the database', async () => {
    const service = new StudentAccountRecoveryService({
        pool: { connect: async () => { throw new Error('database must not be used for invalid input'); } } as never,
        recoveryCodeKey: 'test-recovery-code-key',
    });

    await assert.rejects(
        () => service.verify({ attemptId: 'x', secret: 'secret', code: 'code', otp: '123456' }),
        /not available/i,
    );
    await assert.rejects(
        () => service.complete({ attemptId: 'x', secret: 'secret', password: 'ValidNew1!' }),
        /not available/i,
    );
});

test('account-recovery digest keys must have sufficient deployment-held entropy', () => {
    assert.throws(
        () => new StudentAccountRecoveryService({ pool: {} as never, recoveryCodeKey: 'short' }),
        /digest key is invalid/,
    );
    assert.throws(
        () => new StudentAccountRecoveryService({ pool: {} as never, recoveryCodeKey: 'test-recovery-code-key', previousRecoveryCodeKey: 'short' }),
        /previous digest key is invalid/,
    );
});

test('recovery account lookups lock the student row with the user row', async () => {
    const queries: string[] = [];
    const client = {
        query: async (text: string) => {
            queries.push(text);
            if (text.includes('SELECT clock_timestamp() AS now')) return { rows: [{ now: new Date() }], rowCount: 1 };
            if (text.includes('FROM users u LEFT JOIN students s')) {
                return { rows: [{ id: 'u1', email: 's@x.invalid', credential_generation: 0, deleted_at: null, student_status: 'active' }], rowCount: 1 };
            }
            // The inactive account falls into the decoy start, which issues
            // a real (unverifiable, undelivered) challenge so retry
            // deadlines stay stable: feed the budget issuance shape.
            if (text.includes('INSERT INTO verification_challenge_budgets')) {
                return {
                    rows: [{
                        current_challenge_id: null, window_started_at: new Date(), failed_attempts: 0,
                        send_count: 0, resend_available_at: new Date(0),
                    }], rowCount: 1,
                };
            }
            if (text.includes('octet_length($1::jsonb::text)')) return { rows: [{ bytes: 100 }], rowCount: 1 };
            return { rows: [], rowCount: 0 };
        },
        release: () => undefined,
    };
    const service = new StudentAccountRecoveryService({
        pool: { connect: async () => client } as never,
        recoveryCodeKey: 'test-recovery-code-key',
        outboxEncryptionKey: Buffer.alloc(32, 0x5a).toString('base64'),
    });

    await service.start({ email: 'student@example.test', purpose: 'lost_access' });
    const userLock = queries.findIndex((text) => text.includes('FROM users u LEFT JOIN students s'));
    const studentLock = queries.findIndex((text) => text.includes('FROM students WHERE user_id') && text.includes('FOR UPDATE'));
    assert.ok(userLock >= 0 && studentLock > userLock,
        'suspension must serialize with the active-status check via a locked student row after the user lock');
});

test('recovery start runs workload mirrors for unknown addresses', async () => {
    const queries: string[] = [];
    const client = {
        query: async (text: string) => {
            queries.push(text);
            if (text.includes('SELECT clock_timestamp() AS now')) return { rows: [{ now: new Date() }], rowCount: 1 };
            if (text.includes('INSERT INTO verification_challenge_budgets')) {
                return {
                    rows: [{
                        current_challenge_id: null, window_started_at: new Date(), failed_attempts: 0,
                        send_count: 0, resend_available_at: new Date(0),
                    }], rowCount: 1,
                };
            }
            if (text.includes('octet_length($1::jsonb::text)')) return { rows: [{ bytes: 100 }], rowCount: 1 };
            return { rows: [], rowCount: 0 };
        },
        release: () => undefined,
    };
    const service = new StudentAccountRecoveryService({
        pool: { connect: async () => client } as never,
        recoveryCodeKey: 'test-recovery-code-key',
        outboxEncryptionKey: Buffer.alloc(32, 0x5a).toString('base64'),
    });

    await service.start({ email: 'unknown@example.test', purpose: 'lost_access' });
    // The decoy must cost the same database shapes as a committed start
    // in the same order, or repeated unknown-address probes become a
    // latency oracle: the student-row lock after the user miss (known
    // accounts lock it for real), the live-attempt lock then the code
    // lock before issuance (attempt-then-code, matching verify),
    // terminalization after issuance, and one more probe for the
    // attempt-INSERT round trip. Random ids miss every lock and update
    // zero rows; no attempt row is ever written on the decoy path.
    const userProbe = queries.findIndex((text) => text.includes('FROM users u LEFT JOIN students s'));
    const studentProbes = queries
        .map((text, index) => ({ text, index }))
        .filter(({ text }) => text.includes('FROM students WHERE user_id') && text.includes('FOR UPDATE'))
        .map(({ index }) => index);
    const codeProbe = queries.findIndex((text) => text.includes('FROM student_auth_recovery_codes WHERE user_id'));
    const liveLock = queries.findIndex((text) => text.includes('FROM student_auth_recovery_attempts attempt'));
    const issuance = queries.findIndex((text) => text.includes('INSERT INTO verification_challenge_budgets'));
    const terminalize = queries.findIndex((text) => text.includes("SET status = 'failed', secret_hash = NULL"));
    assert.ok(userProbe >= 0 && studentProbes.length === 2 && studentProbes[0]! > userProbe && studentProbes[0]! < codeProbe,
        'decoy start must probe the student row after the user miss, like known accounts lock it');
    assert.ok(liveLock > studentProbes[0]! && codeProbe > liveLock && issuance > codeProbe && terminalize > issuance && studentProbes[1]! > terminalize,
        'decoy start must mirror live-attempt lock, code lock, issuance, terminalization, and the insert round trip in order');
    assert.ok(!queries.some((text) => text.includes('INSERT INTO student_auth_recovery_attempts')),
        'decoy start must never write an attempt row');
});

test('recovery verify runs decoy reads for handles without an attempt row', async () => {
    const queries: string[] = [];
    const client = {
        query: async (text: string) => {
            queries.push(text);
            if (text.includes('SELECT clock_timestamp() AS now')) return { rows: [{ now: new Date() }], rowCount: 1 };
            return { rows: [], rowCount: 0 };
        },
        release: () => undefined,
    };
    const service = new StudentAccountRecoveryService({
        pool: { connect: async () => client } as never,
        recoveryCodeKey: 'test-recovery-code-key',
    });

    await assert.rejects(
        () => service.verify({ attemptId: '11111111-1111-4111-8111-111111111111', secret: 'secret', code: 'code', otp: '123456' }),
        /not available/i,
    );
    // A decoy handle must cost the same database shapes as a recoverable
    // address (owner, users, students, attempt, clock, code) or repeated
    // bogus proofs become a latency oracle.
    for (const shape of [
        'FROM student_auth_recovery_attempts WHERE id = $1',
        'SELECT u.id, u.email',
        'FROM students WHERE user_id',
        'SELECT * FROM student_auth_recovery_attempts WHERE id = $1',
        'SELECT clock_timestamp() AS now',
        'FROM student_auth_recovery_codes WHERE user_id',
    ]) {
        assert.ok(queries.some((text) => text.includes(shape)), `decoy verify must probe ${shape}`);
    }
});

test('compromise recovery complete locks handoffs before identities', async () => {
    const queries: string[] = [];
    const secret = 'attempt-secret';
    const digest = createHmac('sha256', 'test-recovery-code-key').update(`attempt\0${secret}`).digest('base64url');
    const attemptId = '11111111-1111-4111-8111-111111111111';
    const attempt = {
        id: attemptId, user_id: 'u1', credential_generation: 0, purpose: 'compromise', secret_hash: digest,
        recovery_code_generation: 7, mailbox_challenge_id: 'm1', status: 'verified', expires_at: new Date(Date.now() + 600_000),
    };
    const client = {
        query: async (text: string) => {
            queries.push(text);
            if (text.includes('SELECT user_id FROM student_auth_recovery_attempts')) return { rows: [{ user_id: 'u1' }], rowCount: 1 };
            if (text.includes('SELECT * FROM student_auth_recovery_attempts')) return { rows: [attempt], rowCount: 1 };
            if (text.includes('SELECT status, secret_hash, expires_at FROM student_auth_recovery_attempts')) {
                return { rows: [{ status: 'verified', secret_hash: digest, expires_at: attempt.expires_at }], rowCount: 1 };
            }
            if (text.includes('FROM users u LEFT JOIN students s')) {
                return { rows: [{ id: 'u1', email: 's@x.invalid', credential_generation: 0, deleted_at: null }], rowCount: 1 };
            }
            if (text.includes('SELECT status FROM students WHERE user_id')) return { rows: [{ status: 'active' }], rowCount: 1 };
            if (text.includes('FROM student_auth_recovery_codes WHERE user_id')) {
                return { rows: [{ id: 'c1', generation: 7, code_digest: 'x', status: 'active' }], rowCount: 1 };
            }
            if (text.includes('SELECT clock_timestamp() AS now')) return { rows: [{ now: new Date() }], rowCount: 1 };
            if (text.includes("SET status = 'consumed'")) return { rows: [], rowCount: 1 };
            return { rows: [], rowCount: 0 };
        },
        release: () => undefined,
    };
    const service = new StudentAccountRecoveryService({
        pool: { connect: async () => client } as never,
        recoveryCodeKey: 'test-recovery-code-key',
        validatePassword: () => ({ valid: true, errors: [] }),
        hashPassword: async () => 'hashed',
        notify: async () => ({ success: true }),
    });

    await service.complete({ attemptId, secret, password: 'ValidNew1!' });
    assert.ok(queries.some((text) => text.includes("SET status = 'consumed'")), 'the verified attempt must commit as consumed');
    // Link and signup completion lock handoff before identity; recovery
    // must take them in the same order or a racing completion deadlocks
    // the security reset and aborts without revoking anything.
    const handoffLock = queries.findIndex((text) => text.includes('FROM student_auth_link_handoffs handoff') && text.includes('FOR UPDATE'));
    // The handoff lookup itself reads identity aliases unlocked; match the
    // revocation select (SELECT id) so only the lock counts.
    const identityLock = queries.findIndex((text) => text.includes('SELECT id FROM student_auth_identities WHERE user_id') && text.includes('FOR UPDATE'));
    assert.ok(handoffLock >= 0 && identityLock > handoffLock,
        'compromise recovery must lock stale handoffs before revoking identities');
});

test('recovery verify mirrors decoy work before rejecting an altered handle secret', async () => {
    const queries: string[] = [];
    const stored = createHmac('sha256', 'test-recovery-code-key').update(`attempt\0${'returned-secret'}`).digest('base64url');
    const attemptId = '22222222-2222-4222-8222-222222222222';
    const client = {
        query: async (text: string) => {
            queries.push(text);
            if (text.includes('SELECT user_id FROM student_auth_recovery_attempts')) return { rows: [{ user_id: 'u1' }], rowCount: 1 };
            if (text.includes('SELECT * FROM student_auth_recovery_attempts')) {
                return {
                    rows: [{
                        id: attemptId, user_id: 'u1', credential_generation: 0, purpose: 'lost_access',
                        secret_hash: stored, recovery_code_generation: 7, mailbox_challenge_id: 'm1',
                        status: 'pending', expires_at: new Date(Date.now() + 600_000),
                    }], rowCount: 1,
                };
            }
            if (text.includes('FROM users u LEFT JOIN students s')) {
                return { rows: [{ id: 'u1', email: 's@x.invalid', credential_generation: 0, deleted_at: null }], rowCount: 1 };
            }
            if (text.includes('SELECT status FROM students WHERE user_id')) return { rows: [{ status: 'active' }], rowCount: 1 };
            if (text.includes('SELECT clock_timestamp() AS now')) return { rows: [{ now: new Date() }], rowCount: 1 };
            return { rows: [], rowCount: 0 };
        },
        release: () => undefined,
    };
    const service = new StudentAccountRecoveryService({
        pool: { connect: async () => client } as never,
        recoveryCodeKey: 'test-recovery-code-key',
    });

    await assert.rejects(
        () => service.verify({ attemptId, secret: 'altered-secret', code: 'code', otp: '123456' }),
        /not available/i,
    );
    // The rowless decoy runs a second student-row probe and the
    // active-code probe before its identical 409; the altered-secret
    // rejection must pay the same reads or alternating the two secrets
    // times account existence without burning OTP budget.
    const studentProbes = queries.filter((text) => text.includes('SELECT status FROM students WHERE user_id')).length;
    assert.equal(studentProbes, 2, 'altered-secret rejection must run the mirrored student-row probe');
    assert.ok(queries.some((text) => text.includes('FROM student_auth_recovery_codes WHERE user_id')),
        'altered-secret rejection must run the mirrored active-code probe');
});

test('recovery complete does not hash passwords for unknown attempts', async () => {
    let hashes = 0;
    const client = { query: async () => ({ rows: [], rowCount: 0 }), release: () => undefined };
    const service = new StudentAccountRecoveryService({
        pool: { connect: async () => client } as never,
        recoveryCodeKey: 'test-recovery-code-key',
        validatePassword: () => ({ valid: true, errors: [] }),
        hashPassword: async () => { hashes++; return 'hashed'; },
    });

    await assert.rejects(
        () => service.complete({ attemptId: '11111111-1111-4111-8111-111111111111', secret: 'secret', password: 'ValidNew1!' }),
        /not available/i,
    );
    assert.equal(hashes, 0);
});
