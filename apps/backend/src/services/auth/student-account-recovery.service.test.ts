import assert from 'node:assert/strict';
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
            return { rows: [], rowCount: 0 };
        },
        release: () => undefined,
    };
    const service = new StudentAccountRecoveryService({
        pool: { connect: async () => client } as never,
        recoveryCodeKey: 'test-recovery-code-key',
    });

    await service.start({ email: 'student@example.test', purpose: 'lost_access' });
    const userLock = queries.findIndex((text) => text.includes('FROM users u LEFT JOIN students s'));
    const studentLock = queries.findIndex((text) => text.includes('FROM students WHERE user_id') && text.includes('FOR UPDATE'));
    assert.ok(userLock >= 0 && studentLock > userLock,
        'suspension must serialize with the active-status check via a locked student row after the user lock');
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
