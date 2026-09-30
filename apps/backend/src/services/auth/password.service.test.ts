import assert from 'node:assert/strict';
import test from 'node:test';
import { passwordService } from './password.service.js';

test('password comparison fails closed for null or empty hashes', async () => {
    assert.equal(await passwordService.comparePassword('anything', null), false);
    assert.equal(await passwordService.comparePassword('anything', ''), false);
});

test('password comparison still verifies real hashes', async () => {
    const hash = await passwordService.hashPassword('Correct!horse-9-battery');
    assert.equal(await passwordService.comparePassword('Correct!horse-9-battery', hash), true);
    assert.equal(await passwordService.comparePassword('wrong-password', hash), false);
});
