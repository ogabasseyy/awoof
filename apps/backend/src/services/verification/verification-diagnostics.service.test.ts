import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeDiagnostic } from './verification-diagnostics.service.js';

const validEvent = {
    correlationId: 'bcbddbbc-116c-4cfa-99c0-ea901257fbd0',
    stage: 'callback_received',
    outcome: 'success',
    reason: 'none',
    durationMs: 10,
};

test('serializes only the diagnostic allowlist', () => {
    const line = serializeDiagnostic({
        ...validEvent,
        access_token: 'TOKEN_CANARY',
        email: 'PRIVATE_CANARY',
        error_description: 'RAW_CANARY',
    });

    assert.equal(line.includes('CANARY'), false);
    assert.deepEqual(JSON.parse(line), validEvent);
});

test('includes a validated optional HTTP status and rejects invalid values', () => {
    assert.deepEqual(JSON.parse(serializeDiagnostic({ ...validEvent, httpStatus: 403 })), { ...validEvent, httpStatus: 403 });

    for (const event of [
        null,
        [],
        { ...validEvent, correlationId: 'not-a-uuid' },
        { ...validEvent, correlationId: { toString: () => validEvent.correlationId } },
        { ...validEvent, correlationId: { toJSON: () => validEvent.correlationId } },
        { ...validEvent, stage: 'untrusted_stage' },
        { ...validEvent, outcome: 'maybe' },
        { ...validEvent, reason: 'provider_error' },
        { ...validEvent, httpStatus: 99 },
        { ...validEvent, httpStatus: 600 },
        { ...validEvent, httpStatus: Number.NaN },
        { ...validEvent, httpStatus: 200.5 },
        { ...validEvent, durationMs: -1 },
        { ...validEvent, durationMs: Number.POSITIVE_INFINITY },
        { ...validEvent, durationMs: '10' },
    ]) {
        assert.throws(() => serializeDiagnostic(event), /Invalid diagnostic event/);
    }
});

test('validation failures contain no raw diagnostic input', () => {
    const canary = 'RAW_INPUT_CANARY';
    assert.throws(
        () => serializeDiagnostic({ ...validEvent, correlationId: canary }),
        (error: unknown) => error instanceof TypeError && !error.message.includes(canary),
    );
});

test('normalizes matching-message getter errors into a fresh payload-free error', () => {
    const canary = 'TOKEN_CANARY';
    const providerError = Object.assign(new TypeError('Invalid diagnostic event'), { providerDetail: canary });
    const event = { ...validEvent };
    Object.defineProperty(event, 'correlationId', {
        enumerable: true,
        get: () => { throw providerError; },
    });

    assert.throws(() => serializeDiagnostic(event), (error: unknown) => {
        assert.notEqual(error, providerError);
        assert.ok(error instanceof TypeError);
        assert.equal(error.message, 'Invalid diagnostic event');
        assert.equal(JSON.stringify(error).includes(canary), false);
        assert.equal(Object.values(error).some((value) => String(value).includes(canary)), false);
        return true;
    });
});

test('normalizes a revoked proxy rejected during object validation', () => {
    const { proxy, revoke } = Proxy.revocable([], {});
    revoke();
    assert.throws(() => serializeDiagnostic(proxy), /Invalid diagnostic event/);
});
