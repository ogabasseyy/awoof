import assert from 'node:assert/strict';
import { once } from 'node:events';
import test, { afterEach } from 'node:test';
import express from 'express';
import { errorHandler } from '../common/middleware/errorHandler.js';
import { ConflictError, ForbiddenError } from '../common/errors/AppError.js';
import { jwtService } from '../services/auth/jwt.service.js';
import { db } from '../config/database.js';
import { swaggerSpec } from '../config/swagger.js';
import { StudentAcademicProfileController } from '../controllers/student-academic-profile.controller.js';
import { createStudentAcademicProfileRouter } from './student-academic-profile.routes.js';
import { academicProfileInputSchema, type AcademicProfileProjection } from '../services/academic-profile/academic-profile.types.js';

const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const SID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const originalGetPool = db.getPool;

afterEach(() => {
    db.getPool = originalGetPool;
});

function stubSessionPool(): void {
    db.getPool = () => ({
        query: async () => ({
            rows: [{
                password_setup_requires_recovery_code: false,
                recovery_reenrollment_requires_password: false,
                recovery_session_binding_required: false,
                active_session_id: SID,
                deleted_at: null,
            }],
            rowCount: 1,
        }),
    } as never);
}

function studentToken(role = 'student'): string {
    return jwtService.generateAccessToken({
        userId: ACTOR_ID,
        email: 'owner@students.school.example',
        role,
        sid: SID,
    });
}

function fixtureProjection(): AcademicProfileProjection {
    return {
        revision: 1,
        fields: {
            claimedInstitution: { state: 'unanswered' },
            programme: { state: 'unanswered' },
            entryYear: { state: 'supplied', value: 2022 },
            entryRoute: { state: 'unanswered' },
            expectedGraduationYear: { state: 'unanswered' },
            graduationYearOrigin: null,
            estimateBasis: null,
            estimateStale: false,
        },
        institution: { displayName: null, countryCode: null, binding: 'unbound' },
        institutionConfirmedGraduationYear: null,
        entryYearSuggestion: null,
        optionalUnansweredFields: ['claimedInstitution', 'programme', 'entryRoute', 'expectedGraduationYear'],
        attentionFields: ['claimedInstitution', 'programme', 'entryRoute', 'expectedGraduationYear'],
        verificationRequirements: [],
        verificationContinuationAvailable: false,
        assuranceState: 'available',
        assurance: {
            schoolAccountStatus: 'unverified',
            schoolAccountMethod: null,
            schoolAccountValidUntil: null,
            studentStatus: 'pending',
            enrollmentMethod: null,
            studentValidUntil: null,
            reason: 'awaiting_enrollment',
        },
        referenceVersion: null,
        estimate: null,
        featureEnabled: true,
        promptDecision: 'complete_profile',
    };
}

async function withServer(
    router: ReturnType<typeof createStudentAcademicProfileRouter>,
    operation: (baseUrl: string) => Promise<void>,
): Promise<void> {
    stubSessionPool();
    const app = express();
    app.use(express.json());
    app.use('/api/students', router);
    app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture did not expose a loopback port');
    try {
        await operation(`http://127.0.0.1:${address.port}/api/students`);
    } finally {
        server.close();
        await once(server, 'close').catch(() => undefined);
    }
}

test('academic profile routes reject unauthenticated requests', async () => {
    const controller = new StudentAcademicProfileController({
        readAcademicProfile: async () => fixtureProjection(),
        saveAcademicProfile: async () => fixtureProjection(),
    });
    await withServer(createStudentAcademicProfileRouter(controller), async (baseUrl) => {
        const getResponse = await fetch(`${baseUrl}/academic-profile`);
        assert.equal(getResponse.status, 401);
        const putResponse = await fetch(`${baseUrl}/academic-profile`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ expectedRevision: 0 }),
        });
        assert.equal(putResponse.status, 401);
    });
});

test('academic profile routes reject non-student roles', async () => {
    const controller = new StudentAcademicProfileController({
        readAcademicProfile: async () => fixtureProjection(),
        saveAcademicProfile: async () => fixtureProjection(),
    });
    await withServer(createStudentAcademicProfileRouter(controller), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/academic-profile`, {
            headers: { authorization: `Bearer ${studentToken('vendor')}` },
        });
        assert.equal(response.status, 401);
    });
});

test('GET academic profile binds the read to the authenticated student', async () => {
    const seen: string[] = [];
    const controller = new StudentAcademicProfileController({
        readAcademicProfile: async (userId) => {
            seen.push(userId);
            return fixtureProjection();
        },
    });
    await withServer(createStudentAcademicProfileRouter(controller), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/academic-profile`, {
            headers: { authorization: `Bearer ${studentToken()}` },
        });
        assert.equal(response.status, 200);
        const body = (await response.json()) as { success: boolean; data: AcademicProfileProjection };
        assert.equal(body.success, true);
        assert.equal(body.data.revision, 1);
        assert.deepEqual(seen, [ACTOR_ID]);
    });
});

test('PUT academic profile forwards the body and binds the save to the authenticated student', async () => {
    const seen: Array<{ userId: string; body: unknown }> = [];
    const controller = new StudentAcademicProfileController({
        saveAcademicProfile: async (userId, body) => {
            seen.push({ userId, body });
            academicProfileInputSchema.parse(body);
            return fixtureProjection();
        },
    });
    await withServer(createStudentAcademicProfileRouter(controller), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/academic-profile`, {
            method: 'PUT',
            headers: { authorization: `Bearer ${studentToken()}`, 'content-type': 'application/json' },
            body: JSON.stringify({ expectedRevision: 1, entryRoute: { state: 'skipped' } }),
        });
        assert.equal(response.status, 200);
        const body = (await response.json()) as { success: boolean; data: AcademicProfileProjection };
        assert.equal(body.success, true);
        assert.deepEqual(seen.map((entry) => entry.userId), [ACTOR_ID]);
        assert.deepEqual(seen[0]?.body, { expectedRevision: 1, entryRoute: { state: 'skipped' } });
    });
});

test('PUT academic profile rejects cross-user identifiers and server-owned fields', async () => {
    let calls = 0;
    const controller = new StudentAcademicProfileController({
        saveAcademicProfile: async (_userId, body) => {
            calls += 1;
            academicProfileInputSchema.parse(body);
            return fixtureProjection();
        },
    });
    await withServer(createStudentAcademicProfileRouter(controller), async (baseUrl) => {
        for (const body of [
            { expectedRevision: 1, userId: ACTOR_ID },
            { expectedRevision: 1, graduationYearOrigin: 'calculated' },
            { expectedRevision: 1, estimateBasis: { programmeId: 'P-001' } },
        ]) {
            const response = await fetch(`${baseUrl}/academic-profile`, {
                method: 'PUT',
                headers: { authorization: `Bearer ${studentToken()}`, 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            assert.equal(response.status, 422, JSON.stringify(body));
        }
        // Validation runs inside the service boundary; nothing was persisted.
        assert.equal(calls, 3);
    });
});

test('academic profile routes surface service conflicts and gate rejections', async () => {
    const controller = new StudentAcademicProfileController({
        readAcademicProfile: async () => { throw new ForbiddenError('Academic profile collection is not currently available'); },
        saveAcademicProfile: async () => {
            throw new ConflictError('Academic profile changed since it was read; reload and retry', {
                code: 'ACADEMIC_PROFILE_REVISION_CONFLICT',
                revision: 2,
            });
        },
    });
    await withServer(createStudentAcademicProfileRouter(controller), async (baseUrl) => {
        const headers = { authorization: `Bearer ${studentToken()}`, 'content-type': 'application/json' };
        const getResponse = await fetch(`${baseUrl}/academic-profile`, { headers });
        assert.equal(getResponse.status, 403);
        const putResponse = await fetch(`${baseUrl}/academic-profile`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ expectedRevision: 1 }),
        });
        assert.equal(putResponse.status, 409);
        const body = (await putResponse.json()) as { error: { details: { code: string; revision: number } } };
        assert.deepEqual(body.error.details, { code: 'ACADEMIC_PROFILE_REVISION_CONFLICT', revision: 2 });
    });
});

test('generated OpenAPI includes the academic profile contract', () => {
    const spec = swaggerSpec as { paths?: Record<string, unknown>; components?: { schemas?: Record<string, unknown> } };
    assert.ok(spec.paths?.['/api/students/academic-profile'], 'OpenAPI must document the academic profile path');
    const path = spec.paths?.['/api/students/academic-profile'] as Record<string, unknown>;
    assert.ok(path['get'], 'OpenAPI must document the academic profile read');
    assert.ok(path['put'], 'OpenAPI must document the academic profile write');
    assert.ok(spec.components?.schemas?.['AcademicProfileProjection'], 'OpenAPI must define the projection schema');
    assert.ok(spec.components?.schemas?.['AcademicProfileInput'], 'OpenAPI must define the input schema');
});
