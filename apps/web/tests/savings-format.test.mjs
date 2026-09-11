import assert from 'node:assert/strict';
import test from 'node:test';
import * as format from '../src/lib/format.ts';

test('savings labels distinguish complete zero, partial recorded amounts, and unknown history', () => {
    const savings = format.formatSavings;
    assert.equal(typeof savings, 'function');
    assert.equal(savings(0, 0), '₦0');
    assert.equal(savings(20, 20), '₦20');
    assert.equal(savings(null, 20), '₦20 recorded · partial');
    assert.equal(savings(null, 0), 'Unknown');
    assert.equal(savings(undefined, undefined), 'Unknown');
});
