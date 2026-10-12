import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { afterEach } from 'node:test';
import express from 'express';
import { errorHandler } from '../common/middleware/errorHandler.js';
import { config } from '../config/env.js';
import { db } from '../config/database.js';
import { jwtService } from '../services/auth/jwt.service.js';
import { StudentAcademicProfileController } from '../controllers/student-academic-profile.controller.js';
import { createStudentAcademicProfileRouter } from './student-academic-profile.routes.js';
import type { AcademicProfileProjection } from '../services/academic-profile/academic-profile.types.js';

const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const SID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
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

function studentToken(): string {
    return jwtService.generateAccessToken({
        userId: ACTOR_ID,
        email: 'owner@students.school.example',
        role: 'student',
        sid: SID,
    });
}

function disabledProjection(): AcademicProfileProjection {
    return {
        revision: 3,
        fields: {
            claimedInstitution: { state: 'unanswered' },
            programme: { state: 'unanswered' },
            entryYear: { state: 'supplied', value: 2021 },
            entryRoute: { state: 'unanswered' },
            expectedGraduationYear: { state: 'unanswered' },
            graduationYearOrigin: null,
            estimateBasis: null,
            estimateStale: false,
        },
        institution: { displayName: null, countryCode: null, binding: 'unbound' },
        institutionConfirmedGraduationYear: null,
        entryYearSuggestion: null,
        optionalUnansweredFields: ['claimedInstitution'],
        attentionFields: [],
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
        featureEnabled: false,
        promptDecision: 'continue',
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

test('collection defaults to disabled in code', () => {
    const source = readFileSync(join(backendRoot, 'src/config/env.ts'), 'utf8');
    assert.match(source, /ACADEMIC_PROFILE_ENABLED: z\.enum\(\['true', 'false'\]\)\.default\('false'\)/);
    assert.equal(source.includes('ACADEMIC_PROFILE_RETENTION_DAYS'), true);
});

test('environment example keeps collection off and retention unset', () => {
    const example = readFileSync(join(backendRoot, 'env.example'), 'utf8');
    assert.equal(example.includes('# ACADEMIC_PROFILE_ENABLED=false'), true);
    assert.equal(example.includes('# ACADEMIC_PROFILE_RETENTION_DAYS='), true);
    assert.doesNotMatch(example, /^ACADEMIC_PROFILE_ENABLED=/m);
});

test('default wiring rejects writes while collection is disabled', async () => {
    assert.equal(
        process.env.ACADEMIC_PROFILE_ENABLED,
        undefined,
        'feature-off verification requires the flag to be unset',
    );
    assert.equal(config.academicProfile.enabled, false);
    const controller = new StudentAcademicProfileController();
    await withServer(createStudentAcademicProfileRouter(controller), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/academic-profile`, {
            method: 'PUT',
            headers: { authorization: `Bearer ${studentToken()}`, 'content-type': 'application/json' },
            body: JSON.stringify({ expectedRevision: 3, entryRoute: { state: 'skipped' } }),
        });
        assert.equal(response.status, 403);
        const body = (await response.json()) as { success: boolean; error: { message: string } };
        assert.equal(body.success, false);
        assert.match(body.error.message, /not currently available/);
    });
});

test('default wiring rejects catalogue search and estimate while collection is disabled', async () => {
    const controller = new StudentAcademicProfileController();
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

test('browser-supplied flags cannot enable writes, search, or estimate', async () => {
    const controller = new StudentAcademicProfileController();
    await withServer(createStudentAcademicProfileRouter(controller), async (baseUrl) => {
        const headers = { authorization: `Bearer ${studentToken()}`, 'content-type': 'application/json' };
        for (const body of [
            { expectedRevision: 3, featureEnabled: true },
            { expectedRevision: 3, enabled: true },
            { expectedRevision: 3, ACADEMIC_PROFILE_ENABLED: true },
            { expectedRevision: 3, collectionEnabled: true },
        ]) {
            const response = await fetch(`${baseUrl}/academic-profile`, {
                method: 'PUT',
                headers,
                body: JSON.stringify(body),
            });
            assert.equal(response.status, 403, JSON.stringify(body));
        }
        for (const query of ['q=a&featureEnabled=true', 'q=a&enabled=true', 'q=a&ACADEMIC_PROFILE_ENABLED=true']) {
            const response = await fetch(`${baseUrl}/academic-profile/institutions?${query}`, { headers });
            assert.equal(response.status, 403, query);
        }
        const headerSmuggle = await fetch(`${baseUrl}/academic-profile/programmes?q=a`, {
            headers: { ...headers, 'x-academic-profile-enabled': 'true', 'x-feature-enabled': 'true' },
        });
        assert.equal(headerSmuggle.status, 403);
        const estimate = await fetch(`${baseUrl}/academic-profile/estimate`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ programmeId: null, entryYear: null, entryRoute: null, featureEnabled: true }),
        });
        assert.equal(estimate.status, 403);
    });
});

test('authenticated self-read stays available while collection is disabled', async () => {
    const controller = new StudentAcademicProfileController({
        isCollectionEnabled: () => false,
        readAcademicProfile: async () => disabledProjection(),
    });
    await withServer(createStudentAcademicProfileRouter(controller), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/academic-profile`, {
            headers: { authorization: `Bearer ${studentToken()}` },
        });
        assert.equal(response.status, 200);
        const body = (await response.json()) as { success: boolean; data: AcademicProfileProjection };
        assert.equal(body.success, true);
        assert.equal(body.data.featureEnabled, false);
        assert.equal(body.data.promptDecision, 'continue');
    });
});
