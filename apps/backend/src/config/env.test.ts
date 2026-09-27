import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRecoveryCodeKeys } from './env.js';

test('recovery-code keys retain the attempt key when adding the first dedicated key', () => {
    assert.deepEqual(
        resolveRecoveryCodeKeys({ dedicated: 'dddddddddddddddddddddddddddddddd', retained: 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr', explicitPrevious: null }),
        { codeKey: 'dddddddddddddddddddddddddddddddd', previousCodeKey: 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr' },
    );
    assert.deepEqual(
        resolveRecoveryCodeKeys({ dedicated: null, retained: 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr', explicitPrevious: null }),
        { codeKey: 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr', previousCodeKey: null },
    );
    assert.deepEqual(
        resolveRecoveryCodeKeys({ dedicated: null, retained: null, explicitPrevious: null }),
        { codeKey: null, previousCodeKey: null },
    );
});

test('recovery-code rotation retains the old dedicated key instead of the unrelated attempt key', () => {
    assert.deepEqual(
        resolveRecoveryCodeKeys({
            dedicated: 'k2222222222222222222222222222222',
            retained: 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr',
            explicitPrevious: 'k1111111111111111111111111111111',
        }),
        { codeKey: 'k2222222222222222222222222222222', previousCodeKey: 'k1111111111111111111111111111111' },
    );
    // A previous key equal to the effective key is a misconfiguration, not
    // a fallback: resolution falls through to the retained attempt key.
    assert.deepEqual(
        resolveRecoveryCodeKeys({
            dedicated: 'k2222222222222222222222222222222',
            retained: 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr',
            explicitPrevious: 'k2222222222222222222222222222222',
        }),
        { codeKey: 'k2222222222222222222222222222222', previousCodeKey: 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr' },
    );
});
