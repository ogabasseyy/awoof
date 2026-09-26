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
