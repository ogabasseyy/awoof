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
import { createStudentAcademicProfileRouter, isAcademicCataloguePath } from './student-academic-profile.routes.js';
import { academicProfileInputSchema, type AcademicProfileProjection } from '../services/academic-profile/academic-profile.types.js';
import { estimateInputSchema, parseCatalogueQuery } from '../services/academic-profile/academic-programme-reference.service.js';

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

test('catalogue and estimate endpoints reject unauthenticated requests', async () => {
    const controller = new StudentAcademicProfileController({ isCollectionEnabled: () => true });
    await withServer(createStudentAcademicProfileRouter(controller), async (baseUrl) => {
        for (const [method, path] of [['GET', 'institutions'], ['GET', 'programmes']] as const) {
            const response = await fetch(`${baseUrl}/academic-profile/${path}`, { method });
            assert.equal(response.status, 401, path);
        }
        const estimate = await fetch(`${baseUrl}/academic-profile/estimate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ programmeId: null, entryYear: null, entryRoute: null }),
        });
        assert.equal(estimate.status, 401);
    });
});

test('catalogue and estimate endpoints reject requests while collection is disabled', async () => {
    const controller = new StudentAcademicProfileController({ isCollectionEnabled: () => false });
    await withServer(createStudentAcademicProfileRouter(controller), async (baseUrl) => {
        const headers = { authorization: `Bearer ${studentToken()}` };
        for (const path of ['institutions', 'programmes']) {
            const response = await fetch(`${baseUrl}/academic-profile/${path}?q=a`, { headers });
            assert.equal(response.status, 403, path);
        }
        const estimate = await fetch(`${baseUrl}/academic-profile/estimate`, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ programmeId: null, entryYear: null, entryRoute: null }),
        });
        assert.equal(estimate.status, 403);
    });
});

test('catalogue searches bind to the authenticated student and enforce bounded queries', async () => {
    const seen: Array<{ userId: string; query: unknown }> = [];
    const controller = new StudentAcademicProfileController({
        isCollectionEnabled: () => true,
        searchInstitutions: async (userId, query) => {
            seen.push({ userId, query });
            parseCatalogueQuery(query);
            return { items: [{ name: 'Fixture University', countryCode: 'NG' }], nextCursor: null };
        },
        searchProgrammes: async (userId, query) => {
            seen.push({ userId, query });
            parseCatalogueQuery(query);
            return { items: [{ programmeId: 'SYN-ENG', label: 'Synthetic Engineering', award: 'B.Eng' }], nextCursor: null };
        },
    });
    await withServer(createStudentAcademicProfileRouter(controller), async (baseUrl) => {
        const headers = { authorization: `Bearer ${studentToken()}` };
        const institutions = await fetch(`${baseUrl}/academic-profile/institutions?q=fixture&limit=5`, { headers });
        assert.equal(institutions.status, 200);
        const institutionBody = (await institutions.json()) as { success: boolean; data: { items: unknown[]; nextCursor: null } };
        assert.equal(institutionBody.success, true);
        assert.equal(institutionBody.data.items.length, 1);
        const programmes = await fetch(`${baseUrl}/academic-profile/programmes?q=eng`, { headers });
        assert.equal(programmes.status, 200);
        assert.deepEqual(seen.map((entry) => entry.userId), [ACTOR_ID, ACTOR_ID]);
        assert.deepEqual(JSON.parse(JSON.stringify(seen[0]?.query)), { q: 'fixture', limit: '5' });
        const overLimit = await fetch(`${baseUrl}/academic-profile/institutions?limit=500`, { headers });
        assert.equal(overLimit.status, 422);
        const smuggled = await fetch(`${baseUrl}/academic-profile/programmes?institutionId=${ACTOR_ID}`, { headers });
        assert.equal(smuggled.status, 422);
    });
});

test('estimate binds to the authenticated student and rejects country overrides', async () => {
    const seen: Array<{ userId: string; body: unknown }> = [];
    const controller = new StudentAcademicProfileController({
        isCollectionEnabled: () => true,
        estimateGraduationYear: async (userId, body) => {
            seen.push({ userId, body });
            estimateInputSchema.parse(body);
            return { state: 'unavailable', reason: 'unreviewed_rule' };
        },
    });
    await withServer(createStudentAcademicProfileRouter(controller), async (baseUrl) => {
        const headers = { authorization: `Bearer ${studentToken()}`, 'content-type': 'application/json' };
        const response = await fetch(`${baseUrl}/academic-profile/estimate`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ programmeId: 'SYN-ENG', entryYear: 2022, entryRoute: 'utme' }),
        });
        assert.equal(response.status, 200);
        const body = (await response.json()) as { success: boolean; data: { state: string; reason: string } };
        assert.equal(body.success, true);
        assert.deepEqual(body.data, { state: 'unavailable', reason: 'unreviewed_rule' });
        assert.deepEqual(seen.map((entry) => entry.userId), [ACTOR_ID]);
        const override = await fetch(`${baseUrl}/academic-profile/estimate`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ programmeId: 'SYN-ENG', entryYear: 2022, entryRoute: 'utme', countryCode: 'GH' }),
        });
        assert.equal(override.status, 422);
    });
});

test('generated OpenAPI includes the catalogue and estimate contracts', () => {
    const spec = swaggerSpec as { paths?: Record<string, unknown>; components?: { schemas?: Record<string, unknown> } };
    assert.ok(spec.paths?.['/api/students/academic-profile/institutions'], 'OpenAPI must document institution search');
    assert.ok(spec.paths?.['/api/students/academic-profile/programmes'], 'OpenAPI must document programme search');
    assert.ok(spec.paths?.['/api/students/academic-profile/estimate'], 'OpenAPI must document the estimate');
    for (const schema of [
        'AcademicProfileEntryYearSuggestion',
        'AcademicProfileCatalogueInstitutionItem',
        'AcademicProfileCatalogueProgrammeItem',
        'AcademicProfileInstitutionCataloguePage',
        'AcademicProfileProgrammeCataloguePage',
        'AcademicProfileEstimateInput',
        'AcademicProfileEstimateResult',
    ]) {
        assert.ok(spec.components?.schemas?.[schema], `OpenAPI must define ${schema}`);
    }
});

test('global limiter skips exactly the per-student catalogue paths', () => {
    assert.equal(isAcademicCataloguePath('GET', '/api/students/academic-profile/institutions'), true);
    assert.equal(isAcademicCataloguePath('GET', '/api/students/academic-profile/programmes'), true);
    assert.equal(isAcademicCataloguePath('POST', '/api/students/academic-profile/estimate'), true);
    assert.equal(isAcademicCataloguePath('GET', '/API/STUDENTS/ACADEMIC-PROFILE/PROGRAMMES'), true);
    for (const [method, path] of [
        ['POST', '/api/students/academic-profile/institutions'],
        ['GET', '/api/students/academic-profile/estimate'],
        ['PUT', '/api/students/academic-profile'],
        ['GET', '/api/students/academic-profile'],
        ['GET', '/api/students/academic-profile/programmes/extra'],
        ['GET', '/api/students'],
    ] as const) {
        assert.equal(isAcademicCataloguePath(method, path), false, `${method} ${path}`);
    }
});

test('pre-auth flood ceiling caps unauthenticated catalogue traffic without taxing successes', async () => {
    const controller = new StudentAcademicProfileController({
        isCollectionEnabled: () => true,
        searchProgrammes: async () => ({ items: [], nextCursor: null }),
    });
    await withServer(createStudentAcademicProfileRouter(controller, { floodCeilingMax: 2 }), async (baseUrl) => {
        const headers = { authorization: `Bearer ${studentToken()}` };
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const ok = await fetch(`${baseUrl}/academic-profile/programmes?q=eng`, { headers });
            assert.equal(ok.status, 200, `success ${attempt}`);
        }
        // Successful responses never consume the ceiling, so the first two
        // unauthenticated failures still have budget before the cap bites.
        const first = await fetch(`${baseUrl}/academic-profile/programmes?q=eng`);
        assert.equal(first.status, 401);
        const second = await fetch(`${baseUrl}/academic-profile/programmes?q=eng`);
        assert.equal(second.status, 401);
        const capped = await fetch(`${baseUrl}/academic-profile/programmes?q=eng`);
        assert.equal(capped.status, 429);
    });
});

test('pre-auth flood ceiling ignores authenticated failures', async () => {
    const controller = new StudentAcademicProfileController({
        isCollectionEnabled: () => true,
        searchProgrammes: async (userId, query) => {
            parseCatalogueQuery(query);
            return { items: [], nextCursor: null };
        },
    });
    await withServer(createStudentAcademicProfileRouter(controller, { floodCeilingMax: 2 }), async (baseUrl) => {
        const headers = { authorization: `Bearer ${studentToken()}` };
        // Authenticated validation failures are quota'd per student, so
        // they must not consume the shared pre-auth budget.
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const invalid = await fetch(`${baseUrl}/academic-profile/programmes?limit=500`, { headers });
            assert.equal(invalid.status, 422, `invalid ${attempt}`);
        }
        const first = await fetch(`${baseUrl}/academic-profile/programmes?q=eng`);
        assert.equal(first.status, 401);
        const second = await fetch(`${baseUrl}/academic-profile/programmes?q=eng`);
        assert.equal(second.status, 401);
        const capped = await fetch(`${baseUrl}/academic-profile/programmes?q=eng`);
        assert.equal(capped.status, 429);
    });
});
