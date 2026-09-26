import assert from 'node:assert/strict';
import test from 'node:test';

import { assertFreshAuthTime } from './student-reauth.service.js';

const startedAt = new Date('2026-09-26T12:00:00.000Z');
const now = new Date('2026-09-26T12:01:00.000Z');

test('accepts the exact sixty-second freshness-skew boundaries', () => {
    assert.doesNotThrow(() => assertFreshAuthTime(Math.floor(startedAt.getTime() / 1000) - 60, startedAt, now));
    assert.doesNotThrow(() => assertFreshAuthTime(Math.floor(now.getTime() / 1000) + 60, startedAt, now));
});

for (const [name, value] of [
    ['missing auth_time', undefined],
    ['auth_time 61 seconds before start', Math.floor(startedAt.getTime() / 1000) - 61],
    ['auth_time 61 seconds in the future', Math.floor(now.getTime() / 1000) + 61],
] as const) {
    test(`rejects ${name}`, () => {
        assert.throws(() => assertFreshAuthTime(value, startedAt, now), /Fresh Microsoft authentication/);
    });
}
