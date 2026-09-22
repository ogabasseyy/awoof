import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import express from 'express';
import { db } from '../../config/database.js';
import { errorHandler } from '../../common/middleware/errorHandler.js';
import adminRouter from '../../routes/admin.routes.js';
import { jwtService } from '../../services/auth/jwt.service.js';
import { inTransaction, withTestClient } from './test-database.js';

after(() => db.close());

type DiagnosticFixture = {
    adminId: string;
    studentId: string;
    vendorId: string;
    universityId: string;
    universityName: string;
    noTerminalUniversityId: string;
    noTerminalUniversityName: string;
    correlationId: string;
    redactionCanaries: string[];
};

async function diagnosticFixture(): Promise<DiagnosticFixture> {
    return withTestClient((client) => inTransaction(client, async () => {
        const suffix = randomUUID().slice(0, 8);
        const adminId = (await client.query<{ id: string }>(`INSERT INTO users (email, role) VALUES ($1, 'admin') RETURNING id`, [`diagnostics-admin-${suffix}@example.invalid`])).rows[0]!.id;
        const studentId = (await client.query<{ id: string }>(`INSERT INTO users (email, role) VALUES ($1, 'student') RETURNING id`, [`diagnostics-student-${suffix}@example.invalid`])).rows[0]!.id;
        const vendorId = (await client.query<{ id: string }>(`INSERT INTO users (email, role) VALUES ($1, 'vendor') RETURNING id`, [`diagnostics-vendor-${suffix}@example.invalid`])).rows[0]!.id;
        const universityName = `Diagnostic ${suffix}`;
        const universityId = (await client.query<{ id: string }>(`INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id`, [universityName])).rows[0]!.id;
        await client.query(`INSERT INTO students (user_id, name, university_id) VALUES ($1, 'Diagnostic Student', $2)`, [studentId, universityId]);
        const tenantCanary = randomUUID();
        await client.query(
            `INSERT INTO institution_microsoft_policies
                 (university_id, tenant_id, enabled, mode, approved_until, approved_by, term_ends_at, max_evidence_hours, scopes, notice_version)
             VALUES ($1, $2, true, 'identity_only', clock_timestamp() + interval '30 days', $3, NULL, 24, ARRAY['openid'], 'microsoft-v1')`,
            [universityId, tenantCanary, adminId],
        );
        const noTerminalUniversityName = `No terminal ${suffix}`;
        const noTerminalUniversityId = (await client.query<{ id: string }>(`INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id`, [noTerminalUniversityName])).rows[0]!.id;
        await client.query(
            `INSERT INTO institution_microsoft_policies
                 (university_id, tenant_id, enabled, mode, approved_until, approved_by, term_ends_at, max_evidence_hours, scopes, notice_version)
             VALUES ($1, $2, true, 'identity_only', clock_timestamp() + interval '30 days', $3, NULL, 24, ARRAY['openid'], 'microsoft-v1')`,
            [noTerminalUniversityId, randomUUID(), adminId],
        );
        const processingGrantId = randomUUID();
        await client.query(`INSERT INTO verification_consents (id, user_id, kind, university_id, notice_version) VALUES ($1, $2, 'processing', $3, 'verification-v1')`, [processingGrantId, studentId, universityId]);
        const providerConsentId = randomUUID();
        await client.query(
            `INSERT INTO microsoft_verification_consents
                 (id, user_id, university_id, processing_grant_id, provider_policy_version, notice_version, mode, scopes)
             VALUES ($1, $2, $3, $4, 1, 'microsoft-v1', 'identity_only', ARRAY['openid'])`,
            [providerConsentId, studentId, universityId, processingGrantId],
        );
        const correlationId = randomUUID();
        const serverSessionCanary = randomUUID();
        const stateCanary = `state-canary-${randomUUID()}`;
        const browserSecretCanary = `browser-secret-canary-${randomUUID()}`;
        const finishSecretCanary = `finish-secret-canary-${randomUUID()}`;
        const createAttempt = async (correlation: string, expires: string, canaries?: {
            serverSessionId: string;
            stateHash: string;
            browserSecretHash: string;
            finishSecretHash: string;
        }) => {
            const values = canaries ?? {
                serverSessionId: randomUUID(),
                stateHash: `state-canary-${randomUUID()}`,
                browserSecretHash: `browser-secret-canary-${randomUUID()}`,
                finishSecretHash: `finish-secret-canary-${randomUUID()}`,
            };
            await client.query(
                `INSERT INTO microsoft_verification_attempts
                     (user_id, university_id, institution_policy_version, provider_policy_version, identity_version,
                      processing_grant_id, provider_consent_id, server_session_id, state_hash, browser_secret_hash,
                      finish_secret_hash, expires_at, status, diagnostic_correlation_id)
                 VALUES ($1, $2, 1, 1, 1, $3, $4, $5, $6, $7, $8, ${expires}, 'failed', $9)`,
                [studentId, universityId, processingGrantId, providerConsentId, values.serverSessionId, values.stateHash, values.browserSecretHash, values.finishSecretHash, correlation],
            );
        };
        await createAttempt(correlationId, "clock_timestamp() + interval '10 minutes'", {
            serverSessionId: serverSessionCanary,
            stateHash: stateCanary,
            browserSecretHash: browserSecretCanary,
            finishSecretHash: finishSecretCanary,
        });
        await client.query(
            `INSERT INTO verification_diagnostic_events
                 (correlation_id, stage, outcome, reason, http_status, duration_ms, recorded_at, institution_id, policy_version)
             VALUES
                 ($1, 'started', 'success', 'none', NULL, 2, clock_timestamp() - interval '30 seconds', $2, 1),
                 ($1, 'callback_received', 'success', 'none', NULL, 6, clock_timestamp() - interval '20 seconds', $2, 1),
                 ($1, 'finished', 'failure', 'permission_required', 403, 18, clock_timestamp() - interval '10 seconds', $2, 1)`,
            [correlationId, universityId],
        );
        const incompleteCorrelation = randomUUID();
        await createAttempt(incompleteCorrelation, "clock_timestamp() - interval '1 second'");
        await client.query(
            `INSERT INTO verification_diagnostic_events
                 (correlation_id, stage, outcome, reason, duration_ms, institution_id, policy_version)
             VALUES ($1, 'started', 'unknown', 'none', 1, $2, 1)`,
            [incompleteCorrelation, universityId],
        );
        return {
            adminId,
            studentId,
            vendorId,
            universityId,
            universityName,
            noTerminalUniversityId,
            noTerminalUniversityName,
            correlationId,
            redactionCanaries: [
                correlationId,
                tenantCanary,
                processingGrantId,
                providerConsentId,
                serverSessionCanary,
                stateCanary,
                browserSecretCanary,
                finishSecretCanary,
            ],
        };
    }));
}

test('admin redacted diagnostics use persisted events, audit access, preserve incomplete semantics, and reject current authority changes', async (t) => {
    const pool = db.getPool();
    t.mock.method(db, 'getPool', () => pool);
    const data = await diagnosticFixture();
    const token = (userId: string, role: 'admin' | 'student' | 'vendor') => jwtService.generateAccessToken({ userId, email: `${role}@example.invalid`, role });
    const app = express(); app.use('/admin', adminRouter); app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback server');
    const endpoint = `http://127.0.0.1:${address.port}/admin/verification-diagnostics/${data.correlationId}`;
    try {
        const success = await fetch(endpoint, { headers: { authorization: `Bearer ${token(data.adminId, 'admin')}` } });
        assert.equal(success.status, 200);
        assert.equal(success.headers.get('cache-control'), 'no-store');
        const body = await success.json() as { data: {
            timeline: Array<{ stage: string; outcome: string; reason: string; httpStatus: number | null; durationMs: number; recordedAt: string }>;
            aggregateWindow: string;
            measuredAt: string;
            windowStartedAt: string;
            aggregates: Array<{ institutionId: string; institutionName: string; finishedAttemptCount: number; averageFinishedRequestDurationMs: number | null; p95FinishedRequestDurationMs: number | null; incompleteAttempts: number; failureCategories: Array<{ category: string; eventCount: number }> }>;
        } };
        assert.deepEqual(Object.keys(body).sort(), ['data', 'success']);
        assert.deepEqual(Object.keys(body.data).sort(), ['aggregateWindow', 'aggregates', 'measuredAt', 'timeline', 'windowStartedAt']);
        for (const event of body.data.timeline) {
            assert.deepEqual(Object.keys(event).sort(), ['durationMs', 'httpStatus', 'outcome', 'reason', 'recordedAt', 'stage']);
        }
        assert.deepEqual(body.data.timeline.map(({ stage, outcome, reason, httpStatus, durationMs }) => ({ stage, outcome, reason, httpStatus, durationMs })), [
            { stage: 'started', outcome: 'success', reason: 'none', httpStatus: null, durationMs: 2 },
            { stage: 'callback_received', outcome: 'success', reason: 'none', httpStatus: null, durationMs: 6 },
            { stage: 'finished', outcome: 'failure', reason: 'permission_required', httpStatus: 403, durationMs: 18 },
        ]);
        assert.equal(body.data.aggregateWindow, 'last_30_days');
        assert.ok(Number.isFinite(Date.parse(body.data.measuredAt)));
        assert.ok(Number.isFinite(Date.parse(body.data.windowStartedAt)));
        // The shared PostgreSQL suite intentionally retains policies created by
        // other fixtures. Assert this test's two institutions without making
        // the production aggregate contract hide legitimate configured rows.
        const fixtureInstitutionIds = new Set([data.universityId, data.noTerminalUniversityId]);
        const fixtureAggregates = body.data.aggregates
            .filter((aggregate) => fixtureInstitutionIds.has(aggregate.institutionId))
            .sort((left, right) => left.institutionId.localeCompare(right.institutionId));
        assert.deepEqual(fixtureAggregates, [
            {
                institutionId: data.universityId,
                institutionName: data.universityName,
                finishedAttemptCount: 1,
                averageFinishedRequestDurationMs: 18,
                p95FinishedRequestDurationMs: 18,
                incompleteAttempts: 1,
                failureCategories: [{ category: 'permission_required', eventCount: 1 }],
            },
            {
                institutionId: data.noTerminalUniversityId,
                institutionName: data.noTerminalUniversityName,
                finishedAttemptCount: 0,
                averageFinishedRequestDurationMs: null,
                p95FinishedRequestDurationMs: null,
                incompleteAttempts: 0,
                failureCategories: [],
            },
        ].sort((left, right) => left.institutionId.localeCompare(right.institutionId)));
        for (const aggregate of body.data.aggregates) {
            assert.deepEqual(Object.keys(aggregate).sort(), ['averageFinishedRequestDurationMs', 'failureCategories', 'finishedAttemptCount', 'incompleteAttempts', 'institutionId', 'institutionName', 'p95FinishedRequestDurationMs']);
            assert.match(aggregate.institutionId, /^[0-9a-f-]{36}$/i);
            assert.equal(typeof aggregate.institutionName, 'string');
            assert.ok(aggregate.institutionName.length > 0);
            assert.ok(Number.isInteger(aggregate.finishedAttemptCount) && aggregate.finishedAttemptCount >= 0);
            assert.ok(aggregate.averageFinishedRequestDurationMs === null || Number.isFinite(aggregate.averageFinishedRequestDurationMs));
            assert.ok(aggregate.p95FinishedRequestDurationMs === null || Number.isFinite(aggregate.p95FinishedRequestDurationMs));
            assert.ok(Number.isInteger(aggregate.incompleteAttempts) && aggregate.incompleteAttempts >= 0);
            for (const category of aggregate.failureCategories) {
                assert.deepEqual(Object.keys(category).sort(), ['category', 'eventCount']);
                assert.equal(typeof category.category, 'string');
                assert.ok(Number.isInteger(category.eventCount) && category.eventCount >= 0);
            }
        }
        const serialized = JSON.stringify(body);
        for (const forbidden of [data.studentId, data.vendorId, ...data.redactionCanaries]) assert.equal(serialized.includes(forbidden), false);
        const audit = await withTestClient((client) => client.query<{ actor_user_id: string; university_id: string; event_type: string; metadata: unknown }>(
            `SELECT actor_user_id, university_id, event_type, metadata FROM verification_audit_events
             WHERE actor_user_id=$1 AND event_type='verification_diagnostics_viewed' ORDER BY created_at DESC LIMIT 1`, [data.adminId],
        ));
        assert.deepEqual(audit.rows[0], { actor_user_id: data.adminId, university_id: data.universityId, event_type: 'verification_diagnostics_viewed', metadata: { surface: 'redacted_admin' } });

        assert.equal((await fetch(endpoint)).status, 401);
        // `requireRole('admin')` intentionally returns 401 for a valid JWT with
        // another role, before the current-admin database guard/controller.
        for (const [id, role] of [[data.studentId, 'student'], [data.vendorId, 'vendor']] as const) {
            const denied = await fetch(endpoint, { headers: { authorization: `Bearer ${token(id, role)}` } });
            assert.equal(denied.status, 401);
            assert.equal((await denied.text()).includes(data.studentId), false);
        }
        const missing = await fetch(`${endpoint.slice(0, -data.correlationId.length)}${randomUUID()}`, { headers: { authorization: `Bearer ${token(data.adminId, 'admin')}` } });
        assert.equal(missing.status, 404);
        assert.equal((await missing.text()).includes(data.studentId), false);
        await withTestClient((client) => client.query(`UPDATE users SET role='student' WHERE id=$1`, [data.adminId]));
        // A JWT retaining its old admin claim reaches `requireCurrentAdmin` and
        // is correctly denied as a current-authority failure.
        const demoted = await fetch(endpoint, { headers: { authorization: `Bearer ${token(data.adminId, 'admin')}` } });
        assert.equal(demoted.status, 403);
        assert.equal((await demoted.text()).includes(data.studentId), false);
    } finally { server.close(); await once(server, 'close'); }
});
