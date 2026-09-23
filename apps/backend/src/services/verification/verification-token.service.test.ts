import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createVerificationToken, validateAndConsumeToken, validateToken } from './verification-token.service.js';

describe('retired verification tokens', () => {
    it('refuses to issue legacy tokens', async () => {
        await assert.rejects(createVerificationToken('student', 'vendor'), /retired/);
    });

    it('refuses to consume legacy tokens', async () => {
        await assert.rejects(validateAndConsumeToken('awoof_legacy', 'vendor'), /retired/);
    });

    it('reports every legacy token invalid without consuming it', async () => {
        const result = await validateToken('awoof_legacy', 'vendor');
        assert.equal(result.valid, false);
        assert.match(result.error ?? '', /retired/);
    });
});
