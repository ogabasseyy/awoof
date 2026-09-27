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
