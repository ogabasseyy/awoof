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
        const deleteResponse = await fetch(`${baseUrl}/academic-profile`, {
            method: 'DELETE',
        });
        assert.equal(deleteResponse.status, 401);
    });
});

test('academic profile routes reject non-student roles', async () => {
    const controller = new StudentAcademicProfileController({
        readAcademicProfile: async () => fixtureProjection(),
        saveAcademicProfile: async () => fixtureProjection(),
        eraseAcademicProfile: async () => ({ erased: true, userId: ACTOR_ID, generationId: null, erasedAt: new Date().toISOString(), remainingAccountActive: true }),
    });
    await withServer(createStudentAcademicProfileRouter(controller), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/academic-profile`, {
            headers: { authorization: `Bearer ${studentToken('vendor')}` },
        });
        assert.equal(response.status, 401);
        const deleteResponse = await fetch(`${baseUrl}/academic-profile`, {
            method: 'DELETE',
            headers: { authorization: `Bearer ${studentToken('vendor')}` },
        });
        assert.equal(deleteResponse.status, 401);
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

test('academic profile GET responses are never cacheable', async () => {
    const controller = new StudentAcademicProfileController({
        isCollectionEnabled: () => true,
        readAcademicProfile: async () => fixtureProjection(),
        searchInstitutions: async () => ({ items: [], nextCursor: null }),
        searchProgrammes: async () => ({ items: [], nextCursor: null }),
    });
    await withServer(createStudentAcademicProfileRouter(controller), async (baseUrl) => {
        const headers = { authorization: `Bearer ${studentToken()}` };
        for (const path of ['/academic-profile', '/academic-profile/institutions?q=eng', '/academic-profile/programmes?q=eng']) {
            const response = await fetch(`${baseUrl}${path}`, { headers });
            assert.equal(response.status, 200, path);
            assert.equal(response.headers.get('cache-control'), 'no-store', path);
        }
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
    assert.ok(path['delete'], 'OpenAPI must document the academic profile erasure');
    assert.ok(spec.components?.schemas?.['AcademicProfileProjection'], 'OpenAPI must define the projection schema');
    assert.ok(spec.components?.schemas?.['AcademicProfileInput'], 'OpenAPI must define the input schema');
    assert.ok(spec.components?.schemas?.['AcademicProfileErasureResponse'], 'OpenAPI must define the erasure response schema');
});

test('DELETE academic profile binds the erasure to the authenticated student and sets no-store', async () => {
    const seen: string[] = [];
    const controller = new StudentAcademicProfileController({
        eraseAcademicProfile: async (userId) => {
            seen.push(userId);
            return {
                erased: true,
                userId,
                generationId: '11111111-1111-4111-8111-111111111111',
                erasedAt: '2026-10-18T12:00:00.000Z',
                remainingAccountActive: true,
            };
        },
    });
    await withServer(createStudentAcademicProfileRouter(controller), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/academic-profile`, {
            method: 'DELETE',
            headers: { authorization: `Bearer ${studentToken()}` },
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const body = (await response.json()) as {
            success: boolean;
            data: {
                erased: boolean;
                userId: string;
                generationId: string;
                erasedAt: string;
                remainingAccountActive: boolean;
            };
        };
        assert.equal(body.success, true);
        assert.equal(body.data.erased, true);
        assert.equal(body.data.userId, ACTOR_ID);
        assert.equal(body.data.generationId, '11111111-1111-4111-8111-111111111111');
        assert.equal(body.data.erasedAt, '2026-10-18T12:00:00.000Z');
        assert.equal(body.data.remainingAccountActive, true);
        assert.deepEqual(seen, [ACTOR_ID]);
    });
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

test('per-token ceiling caps session work before authentication runs', async () => {
    const controller = new StudentAcademicProfileController({
        isCollectionEnabled: () => true,
        searchProgrammes: async () => ({ items: [], nextCursor: null }),
    });
    await withServer(createStudentAcademicProfileRouter(controller, { tokenCeilingMax: 3 }), async (baseUrl) => {
        // Every request costs a session lookup, so unlike the flood
        // ceiling this cap counts successes too.
        const headers = { authorization: `Bearer ${studentToken()}` };
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const ok = await fetch(`${baseUrl}/academic-profile/programmes?q=eng`, { headers });
            assert.equal(ok.status, 200, `success ${attempt}`);
        }
        const capped = await fetch(`${baseUrl}/academic-profile/programmes?q=eng`, { headers });
        assert.equal(capped.status, 429);
    });
});

test('pre-auth flood ceiling refunds the credential ceiling rejections', async () => {
    const controller = new StudentAcademicProfileController({
        isCollectionEnabled: () => true,
        searchProgrammes: async () => ({ items: [], nextCursor: null }),
    });
    await withServer(
        createStudentAcademicProfileRouter(controller, { floodCeilingMax: 2, tokenCeilingMax: 2 }),
        async (baseUrl) => {
            const headers = { authorization: `Bearer ${studentToken()}` };
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const ok = await fetch(`${baseUrl}/academic-profile/programmes?q=eng`, { headers });
                assert.equal(ok.status, 200, `success ${attempt}`);
            }
            // The token ceiling rejects pre-authentication (req.user
            // unset), but those 429s must not spend the shared budget.
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const capped = await fetch(`${baseUrl}/academic-profile/programmes?q=eng`, { headers });
                assert.equal(capped.status, 429, `token-capped ${attempt}`);
            }
            const first = await fetch(`${baseUrl}/academic-profile/programmes?q=eng`);
            assert.equal(first.status, 401);
            const second = await fetch(`${baseUrl}/academic-profile/programmes?q=eng`);
            assert.equal(second.status, 401);
            const capped = await fetch(`${baseUrl}/academic-profile/programmes?q=eng`);
            assert.equal(capped.status, 429);
        },
    );
});

test('pre-auth flood ceiling counts non-student role rejections', async () => {
    const controller = new StudentAcademicProfileController({
        isCollectionEnabled: () => true,
        searchProgrammes: async () => ({ items: [], nextCursor: null }),
    });
    await withServer(createStudentAcademicProfileRouter(controller, { floodCeilingMax: 2 }), async (baseUrl) => {
        // Vendor tokens are rejected before the per-student limiter, so
        // unlike student requests they must spend the shared budget.
        const headers = { authorization: `Bearer ${studentToken('vendor')}` };
        const first = await fetch(`${baseUrl}/academic-profile/programmes?q=eng`, { headers });
        assert.equal(first.status, 401);
        const second = await fetch(`${baseUrl}/academic-profile/programmes?q=eng`, { headers });
        assert.equal(second.status, 401);
        const capped = await fetch(`${baseUrl}/academic-profile/programmes?q=eng`, { headers });
        assert.equal(capped.status, 429);
    });
});
