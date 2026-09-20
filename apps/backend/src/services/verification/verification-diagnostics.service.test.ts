import assert from 'node:assert/strict';
import test from 'node:test';
import { recordDiagnosticBestEffort, serializeDiagnostic, VerificationDiagnosticsService } from './verification-diagnostics.service.js';

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

test('persists only the validated diagnostic allowlist and safe server context', async () => {
    const calls: Array<{ text: string; values: unknown[] | undefined }> = [];
    const client = {
        query: async (text: string, values?: unknown[]) => {
            calls.push({ text, values });
            if (text.includes('FROM universities')) return { rowCount: 1, rows: [{ id: 'c1f7c4b1-5b7d-45a7-8d61-27f94d315e57' }] };
            return { rowCount: 1, rows: [] };
        },
        release: () => undefined,
    };
    const service = new VerificationDiagnosticsService({
        connect: async () => client,
    } as never);

    await service.record({ institutionId: 'c1f7c4b1-5b7d-45a7-8d61-27f94d315e57', policyVersion: 3 }, {
        ...validEvent,
        access_token: 'TOKEN_CANARY',
        provider_response: { email: 'PRIVATE_CANARY' },
    });

    assert.deepEqual(calls.map((call) => call.text), [
        'BEGIN',
        'SET LOCAL statement_timeout = 4500',
        'SELECT id FROM universities WHERE id=$1 FOR KEY SHARE',
                 `INSERT INTO verification_diagnostic_events
                     (correlation_id, stage, outcome, reason, http_status, duration_ms, institution_id, policy_version)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (correlation_id) WHERE stage = 'finished' DO NOTHING`,
        'COMMIT',
    ]);
    assert.deepEqual(calls[3]!.values, [
        validEvent.correlationId, validEvent.stage, validEvent.outcome, validEvent.reason,
        null, validEvent.durationMs, 'c1f7c4b1-5b7d-45a7-8d61-27f94d315e57', 3,
    ]);
    assert.equal(JSON.stringify(calls).includes('CANARY'), false);
});

test('best-effort recorder keeps a secret-bearing persistence failure out of the alert', async () => {
    const alerts: unknown[][] = [];
    await recordDiagnosticBestEffort(
        { record: async () => { throw new Error('TOKEN_CANARY must never reach logs'); } },
        { institutionId: 'c1f7c4b1-5b7d-45a7-8d61-27f94d315e57', policyVersion: 3 },
        validEvent,
        (...args: unknown[]) => { alerts.push(args); },
    );
    assert.deepEqual(alerts, [['verification diagnostic persistence failed']]);
});

test('best-effort recorder abandons a never-settling write instead of blocking the user flow', async () => {
    const alerts: unknown[][] = [];
    let settled = false;
    const startedAt = Date.now();
    await recordDiagnosticBestEffort(
        { record: () => new Promise<void>(() => undefined) },
        { institutionId: 'c1f7c4b1-5b7d-45a7-8d61-27f94d315e57', policyVersion: 3 },
        validEvent,
        (...args: unknown[]) => { alerts.push(args); },
        20,
    );
    settled = true;
    assert.equal(settled, true);
    assert.ok(Date.now() - startedAt < 5_000, 'the stalled write must resolve at the deadline');
    assert.deepEqual(alerts, [['verification diagnostic persistence failed']]);
});
