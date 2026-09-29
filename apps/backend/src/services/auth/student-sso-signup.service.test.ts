import assert from 'node:assert/strict';
import test from 'node:test';
import { ConflictError } from '../../common/errors/AppError.js';
import { StudentSsoSignupService } from './student-sso-signup.service.js';

const handoffId = '11111111-1111-4111-8111-111111111111';

test('passwordless signup is disabled by default before it reads a handoff', async () => {
    let reads = 0;
    const service = new StudentSsoSignupService({
        pool: { connect: async () => { reads++; throw new Error('must not connect'); } },
        attemptKey: 'a'.repeat(43),
        isEnabled: () => false,
        deliverOtp: async () => ({ success: true }),
    });

    await assert.rejects(
        service.context({ handoffId, handoffSecret: 'secret', browserBinding: 'browser' }),
        (error: unknown) => error instanceof ConflictError && /not available/i.test(error.message),
    );
    assert.equal(reads, 0);
});
