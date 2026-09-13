import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { db } from '../config/database.js';
import { errorHandler } from '../common/middleware/errorHandler.js';
import adminRouter from '../routes/admin.routes.js';
import { jwtService } from '../services/auth/jwt.service.js';

const actorId = '35176342-b6fc-43e8-bad2-31052c61cf88';
const correlationId = '92d71887-18a0-4c0d-b696-138bc9d54f20';
const institutionId = '80dcaee5-d77e-4eb2-bc35-a54d83b5ade4';

function token(role: 'admin' | 'student' | 'vendor') {
    return jwtService.generateAccessToken({ userId: actorId, email: `${role}@example.invalid`, role });
}

async function assertErrorEnvelope(response: Response, statusCode: 401 | 403 | 404 | 422 | 500, message: string, code: string) {
    assert.equal(response.status, statusCode);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    assert.deepEqual(await response.json(), {
        success: false,
        error: { message, code, statusCode },
    });
}

test('admin diagnostic read is redacted, audited, no-store, and fenced by a transaction-local current-admin check', async (t) => {
    let currentRole = 'admin';
    const queries: Array<{ text: string; params: unknown[] | undefined }> = [];
    const client = {
        async query(text: string, params?: unknown[]) {
            queries.push({ text, params });
            if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
            if (text === 'SELECT role, deleted_at FROM users WHERE id = $1 FOR UPDATE') {
                return { rows: [{ role: currentRole, deleted_at: null }], rowCount: 1 };
            }
            if (text.includes('FROM verification_diagnostic_events') && text.includes('ORDER BY recorded_at ASC')) {
                return { rows: [{ stage: 'finished', outcome: 'success', reason: 'none', http_status: null, duration_ms: 18, recorded_at: new Date('2026-09-13T09:00:00.000Z') }], rowCount: 1 };
            }
            if (text === 'SELECT clock_timestamp() AS measured_at') return { rows: [{ measured_at: new Date('2026-09-13T10:00:00.000Z') }], rowCount: 1 };
            if (text.includes('average_finished_request_duration_ms')) {
                return { rows: [{ institution_id: institutionId, institution_name: 'Approved Alpha University', finished_attempt_count: 2, average_finished_request_duration_ms: 12.5, p95_finished_request_duration_ms: 18 }], rowCount: 1 };
            }
            if (text.includes("AND event.outcome = 'failure'")) {
                return { rows: [{ institution_id: institutionId, reason: 'permission_required', event_count: 1 }], rowCount: 1 };
            }
            if (text.includes('incomplete_attempts')) {
                return { rows: [{ institution_id: institutionId, incomplete_attempts: 1 }], rowCount: 1 };
            }
            if (text.includes("'verification_diagnostics_viewed'")) return { rows: [], rowCount: 1 };
            throw new Error(`Unexpected query: ${text}`);
        },
        release() {},
    };
    t.mock.method(db, 'query', async () => ({ rows: [{ role: 'admin', deleted_at: null }], rowCount: 1 }));
    t.mock.method(db, 'getPool', () => ({ connect: async () => client }) as ReturnType<typeof db.getPool>);
    const app = express(); app.use('/admin', adminRouter); app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a loopback port');
    const endpoint = `http://127.0.0.1:${address.port}/admin/verification-diagnostics/${correlationId}`;
    try {
        const response = await fetch(endpoint, { headers: { authorization: `Bearer ${token('admin')}` } });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const body = await response.json() as { data: {
            timeline: Array<Record<string, unknown>>;
            aggregateWindow: string;
            measuredAt: string;
            windowStartedAt: string;
            aggregates: Array<Record<string, unknown>>;
        } };
        assert.deepEqual(body.data.timeline, [{ stage: 'finished', outcome: 'success', reason: 'none', httpStatus: null, durationMs: 18, recordedAt: '2026-09-13T09:00:00.000Z' }]);
        assert.equal(body.data.aggregateWindow, 'last_30_days');
        assert.equal(body.data.measuredAt, '2026-09-13T10:00:00.000Z');
        assert.equal(body.data.windowStartedAt, '2026-08-14T10:00:00.000Z');
        assert.deepEqual(body.data.aggregates, [{
            institutionId,
            institutionName: 'Approved Alpha University',
            finishedAttemptCount: 2,
            averageFinishedRequestDurationMs: 12.5,
            p95FinishedRequestDurationMs: 18,
            incompleteAttempts: 1,
            failureCategories: [{ category: 'permission_required', eventCount: 1 }],
        }]);
        const rendered = JSON.stringify(body);
        for (const secret of ['student@example.invalid', 'TOKEN_CANARY', 'tenant-id', 'provider-profile']) assert.equal(rendered.includes(secret), false);
        const audit = queries.find((query) => query.text.includes("'verification_diagnostics_viewed'"));
        assert.ok(audit);
        assert.equal(audit?.params?.includes(correlationId), true);
        assert.equal(audit?.params?.includes(actorId), true);
        assert.equal(audit?.text.includes('request_url'), false);
        assert.equal(audit?.text.includes('provider'), false);

        // Role-bearing JWTs other than an admin cannot reach the controller.
        for (const role of ['student', 'vendor'] as const) {
            const denied = await fetch(endpoint, { headers: { authorization: `Bearer ${token(role)}` } });
            await assertErrorEnvelope(denied, 401, 'Insufficient permissions', 'UNAUTHORIZED');
        }
        await assertErrorEnvelope(await fetch(endpoint), 401, 'Authentication failed', 'UNAUTHORIZED');

        // The outer middleware sees an older admin row, then the controller's
        // FOR UPDATE recheck sees a concurrent demotion and refuses the read.
        currentRole = 'student';
        const demoted = await fetch(endpoint, { headers: { authorization: `Bearer ${token('admin')}` } });
        await assertErrorEnvelope(demoted, 403, 'Current administrator authority required', 'FORBIDDEN');
        assert.ok(queries.some((query) => query.text === 'SELECT role, deleted_at FROM users WHERE id = $1 FOR UPDATE'));
    } finally { server.close(); await once(server, 'close'); }
});

test('missing diagnostic IDs are generic and never append an administrative read audit', async (t) => {
    const queries: string[] = [];
    const client = {
        async query(text: string) {
            queries.push(text);
            if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
            if (text === 'SELECT role, deleted_at FROM users WHERE id = $1 FOR UPDATE') return { rows: [{ role: 'admin', deleted_at: null }], rowCount: 1 };
            if (text.includes('FROM verification_diagnostic_events')) return { rows: [], rowCount: 0 };
            throw new Error(`Unexpected query: ${text}`);
        },
        release() {},
    };
    t.mock.method(db, 'query', async () => ({ rows: [{ role: 'admin', deleted_at: null }], rowCount: 1 }));
    t.mock.method(db, 'getPool', () => ({ connect: async () => client }) as ReturnType<typeof db.getPool>);
    const app = express(); app.use('/admin', adminRouter); app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a loopback port');
    try {
        const response = await fetch(`http://127.0.0.1:${address.port}/admin/verification-diagnostics/${correlationId}`, { headers: { authorization: `Bearer ${token('admin')}` } });
        await assertErrorEnvelope(response, 404, 'Verification diagnostic not found', 'NOT_FOUND');
        assert.equal(queries.some((query) => query.includes("'verification_diagnostics_viewed'")), false);
        const malformed = await fetch(`http://127.0.0.1:${address.port}/admin/verification-diagnostics/not-a-correlation-id`, { headers: { authorization: `Bearer ${token('admin')}` } });
        await assertErrorEnvelope(malformed, 422, 'Invalid verification diagnostic identifier', 'VALIDATION_ERROR');
    } finally { server.close(); await once(server, 'close'); }
});

test('diagnostic route boundary masks an injected operational error in both the client envelope and logger', async (t) => {
    const consoleErrors: string[] = [];
    const client = {
        async query(text: string) {
            if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
            if (text === 'SELECT role, deleted_at FROM users WHERE id = $1 FOR UPDATE') return { rows: [{ role: 'admin', deleted_at: null }], rowCount: 1 };
            if (text.includes('FROM verification_diagnostic_events')) throw new Error('DATABASE_ERROR_CANARY');
            throw new Error(`Unexpected query: ${text}`);
        },
        release() {},
    };
    t.mock.method(console, 'error', (...args: unknown[]) => { consoleErrors.push(args.map(String).join(' ')); });
    t.mock.method(db, 'query', async () => ({ rows: [{ role: 'admin', deleted_at: null }], rowCount: 1 }));
    t.mock.method(db, 'getPool', () => ({ connect: async () => client }) as ReturnType<typeof db.getPool>);
    const app = express(); app.use('/admin', adminRouter); app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a loopback port');
    try {
        const response = await fetch(`http://127.0.0.1:${address.port}/admin/verification-diagnostics/${correlationId}`, { headers: { authorization: `Bearer ${token('admin')}` } });
        await assertErrorEnvelope(response, 500, 'Verification diagnostics are temporarily unavailable', 'INTERNAL_SERVER_ERROR');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(consoleErrors.some((line) => line.includes('DATABASE_ERROR_CANARY')), false);
        assert.deepEqual(consoleErrors, ['Verification diagnostics request failed']);
    } finally { server.close(); await once(server, 'close'); }
});
