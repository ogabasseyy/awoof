import assert from 'node:assert/strict';
import test from 'node:test';
import { ZodError } from 'zod';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../common/errors/AppError.js';
import type { StudentAssurance } from '../verification/student-assurance.types.js';
import type { VerificationMethodInfo } from '../verification/verification-orchestrator.service.js';
import {
    academicProfileInputSchema,
    boundInstitutionCountryCode,
    ESTIMATE_RULE_ID_MAX_LENGTH,
    ESTIMATE_SOURCE_VERSION_MAX_LENGTH,
    MAX_ESTIMABLE_PROGRAMME_ID_LENGTH,
    MAX_REVIEWED_DURATION_YEARS,
    normalizeArtifactCountryCode,
    type AcademicField,
    type AcademicProfileInput,
} from './academic-profile.types.js';
import {
    ACADEMIC_PROFILE_CLAIM_CHANGED,
    ACADEMIC_PROFILE_INSTITUTION_CHANGED,
    ACADEMIC_PROFILE_REVISION_CONFLICT,
    computeAttentionFields,
    computeOptionalUnansweredFields,
    computePromptDecision,
    effectiveEstimateCountryCode,
    isAcademicProfileCollectionEnabled,
    isEstimateStale,
    labelFromArtifact,
    purgeAcademicProfileForUser,
    readAcademicProfile,
    ruleFromArtifact,
    saveAcademicProfile,
    validateAndMergePatch,
    type AcademicProgrammeReference,
    type AcademicProfileDeps,
    type StoredAcademicProfile,
} from './academic-profile.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '99999999-9999-4999-8999-999999999999';
const STUDENT_ID = '22222222-2222-4222-8222-222222222222';
const UNIVERSITY_ID = '33333333-3333-4333-8333-333333333333';
const NEXT_UNIVERSITY_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-06-15T12:00:00.000Z');
const CURRENT_YEAR = 2026;

const pendingAssurance: StudentAssurance = {
    schoolAccountStatus: 'unverified',
    schoolAccountMethod: null,
    schoolAccountValidUntil: null,
    studentStatus: 'pending',
    enrollmentMethod: null,
    studentValidUntil: null,
    reason: 'awaiting_enrollment',
};

const verifiedAssurance: StudentAssurance = {
    schoolAccountStatus: 'verified',
    schoolAccountMethod: 'email_otp',
    schoolAccountValidUntil: '2026-12-01T00:00:00.000Z',
    studentStatus: 'verified',
    enrollmentMethod: 'registration',
    studentValidUntil: '2026-12-01T00:00:00.000Z',
    reason: null,
};

const noMethods = async (): Promise<VerificationMethodInfo[]> => [];
const registrationAvailable = async (): Promise<VerificationMethodInfo[]> => ([
    { methodType: 'registration', isAvailable: true, priority: 0 },
]);

const blockedReference: AcademicProgrammeReference = {
    sourceVersion: 'TEST-REF-v1',
    findReviewedRule: () => null,
    findProgrammeLabel: () => null,
};

const reviewedReference: AcademicProgrammeReference = {
    sourceVersion: 'TEST-REF-v1',
    findReviewedRule: (programmeId: string, route: string) => {
        if (programmeId === 'P-001' && route === 'utme') {
            return { durationYears: 4, ruleId: 'P-001:utme', sourceVersion: 'TEST-REF-v1' };
        }
        if (programmeId === 'P-001' && route === 'de_200') {
            return { durationYears: 3, ruleId: 'P-001:de_200', sourceVersion: 'TEST-REF-v1' };
        }
        return null;
    },
    findProgrammeLabel: (programmeId: string) => (programmeId === 'P-001' ? 'Stylised Physics' : null),
};

type FakeState = {
    user: { id: string; email: string; role: string; deleted_at: Date | null } | null;
    student: { id: string; university_id: string | null; identity_version: number; status: string } | null;
    university: { id: string; name: string; is_active: boolean } | null;
    profile: Record<string, unknown> | null;
    writes: Array<{ text: string; params: unknown[] }>;
    readUserIds: unknown[];
    statements: string[];
};

function profileRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        user_id: USER_ID,
        student_id: STUDENT_ID,
        canonical_institution_id: null,
        observed_identity_version: 1,
        revision: 1,
        claimed_institution_state: 'unanswered',
        claimed_institution_name: null,
        claimed_institution_country: null,
        programme_state: 'unanswered',
        programme_id: null,
        course_label: null,
        entry_year_state: 'unanswered',
        entry_year: null,
        entry_route_state: 'unanswered',
        entry_route: null,
        expected_graduation_year_state: 'unanswered',
        expected_graduation_year: null,
        graduation_year_origin: null,
        estimate_basis_programme_id: null,
        estimate_basis_entry_year: null,
        estimate_basis_entry_route: null,
        estimate_basis_rule_id: null,
        estimate_basis_source_version: null,
        estimate_stale: false,
        created_at: NOW,
        updated_at: NOW,
        ...overrides,
    };
}

function fakeState(overrides: Partial<FakeState> = {}): FakeState {
    return {
        user: { id: USER_ID, email: 'student@example.invalid', role: 'student', deleted_at: null },
        student: { id: STUDENT_ID, university_id: null, identity_version: 1, status: 'active' },
        university: null,
        profile: null,
        writes: [],
        readUserIds: [],
        statements: [],
        ...overrides,
    };
}

function boundState(overrides: Partial<FakeState> = {}): FakeState {
    const state = fakeState(overrides);
    state.student = { id: STUDENT_ID, university_id: UNIVERSITY_ID, identity_version: 1, status: 'active' };
    state.university = { id: UNIVERSITY_ID, name: 'Fixture University', is_active: true };
    return state;
}

function createFakePool(state: FakeState): { connect: () => Promise<unknown> } {
    const client = {
        query: async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
            const normalized = text.replace(/\s+/g, ' ').trim();
            state.statements.push(normalized);
            if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
                return { rows: [], rowCount: 0 };
            }
            if (normalized === 'SAVEPOINT academic_profile_assurance'
                || normalized === 'RELEASE SAVEPOINT academic_profile_assurance'
                || normalized === 'ROLLBACK TO SAVEPOINT academic_profile_assurance') {
                return { rows: [], rowCount: 0 };
            }
            if (normalized.startsWith('INSERT INTO student_academic_profiles')) {
                const match = normalized.match(/INSERT INTO student_academic_profiles \(([^)]+)\)/);
                assert.ok(match?.[1], 'upsert must list explicit columns');
                const columns = match[1].split(',').map((column) => column.trim());
                // updated_at is a clock_timestamp() literal, not a bound param.
                if (columns[columns.length - 1] === 'updated_at') columns.pop();
                assert.equal(columns.length, params.length, 'upsert columns must align with params');
                const row: Record<string, unknown> = { ...(state.profile ?? {}) };
                columns.forEach((column, index) => { row[column] = params[index]; });
                state.profile = row;
                state.writes.push({ text: normalized, params });
                return { rows: [row], rowCount: 1 };
            }
            if (normalized.startsWith('UPDATE student_academic_profiles')) {
                assert.ok(state.profile, 'invalidation requires an existing row');
                const cleared: Record<string, unknown> = {
                    claimed_institution_state: 'unanswered',
                    claimed_institution_name: null,
                    claimed_institution_country: null,
                    programme_state: 'unanswered',
                    programme_id: null,
                    course_label: null,
                    entry_year_state: 'unanswered',
                    entry_year: null,
                    entry_route_state: 'unanswered',
                    entry_route: null,
                    expected_graduation_year_state: 'unanswered',
                    expected_graduation_year: null,
                    graduation_year_origin: null,
                    estimate_basis_programme_id: null,
                    estimate_basis_entry_year: null,
                    estimate_basis_entry_route: null,
                    estimate_basis_rule_id: null,
                    estimate_basis_source_version: null,
                    estimate_stale: false,
                };
                state.profile = {
                    ...state.profile,
                    ...cleared,
                    canonical_institution_id: params[0],
                    observed_identity_version: params[1],
                    revision: (state.profile['revision'] as number) + 1,
                };
                state.writes.push({ text: normalized, params });
                return { rows: [{ revision: state.profile['revision'] }], rowCount: 1 };
            }
            if (normalized.startsWith('DELETE FROM student_academic_profiles')) {
                const deleted = state.profile !== null;
                state.profile = null;
                state.writes.push({ text: normalized, params });
                return { rows: [], rowCount: deleted ? 1 : 0 };
            }
            if (normalized.includes('FROM student_academic_profiles')) {
                return { rows: state.profile ? [state.profile] : [], rowCount: state.profile ? 1 : 0 };
            }
            if (normalized.includes('FROM users')) {
                state.readUserIds.push(params[0]);
                return { rows: state.user ? [state.user] : [], rowCount: state.user ? 1 : 0 };
            }
            if (normalized.includes('FROM students')) {
                return { rows: state.student ? [state.student] : [], rowCount: state.student ? 1 : 0 };
            }
            if (normalized.includes('FROM universities')) {
                return { rows: state.university ? [state.university] : [], rowCount: state.university ? 1 : 0 };
            }
            throw new Error(`Unexpected query: ${normalized}`);
        },
        release: (): void => undefined,
    };
    return { connect: async () => client };
}

function serviceDeps(overrides: Partial<AcademicProfileDeps> = {}): AcademicProfileDeps {
    return {
        featureEnabled: true,
        reference: blockedReference,
        now: NOW,
        readAssurance: async () => pendingAssurance,
        listVerificationMethods: noMethods,
        ...overrides,
    };
}

function emptyStored(overrides: Partial<StoredAcademicProfile> = {}): StoredAcademicProfile {
    return {
        revision: 0,
        canonicalInstitutionId: null,
        observedIdentityVersion: 1,
        fields: {
            claimedInstitution: { state: 'unanswered' },
            programme: { state: 'unanswered' },
            entryYear: { state: 'unanswered' },
            entryRoute: { state: 'unanswered' },
            expectedGraduationYear: { state: 'unanswered' },
            graduationYearOrigin: null,
            estimateBasis: null,
            estimateStale: false,
        },
        ...overrides,
    };
}

function parsePatch(patch: unknown): AcademicProfileInput {
    return academicProfileInputSchema.parse(patch) as AcademicProfileInput;
}

test('input schema rejects unknown top-level fields and cross-user identifiers', () => {
    const forbidden: unknown[] = [
        { expectedRevision: 0, userId: USER_ID },
        { expectedRevision: 0, studentId: STUDENT_ID },
        { expectedRevision: 0, nickname: { state: 'supplied', value: 'x' } },
        { expectedRevision: 0, eligible: true },
        { expectedRevision: 0, studentStatus: 'verified' },
        { expectedRevision: 0, canonicalInstitutionId: UNIVERSITY_ID },
        { expectedRevision: 0, graduationYearOrigin: 'calculated' },
        { expectedRevision: 0, estimateBasis: { programmeId: 'P-001' } },
        { expectedRevision: 0, ruleId: 'P-001:utme' },
        { expectedRevision: 0, sourceVersion: 'TEST-REF-v1' },
        { expectedRevision: 0, origin: 'calculated' },
        { expectedRevision: 0, source: 'institution' },
    ];
    for (const body of forbidden) {
        assert.throws(() => academicProfileInputSchema.parse(body), ZodError, JSON.stringify(body));
    }
});

test('input schema rejects unknown nested keys and malformed field updates', () => {
    assert.throws(() => academicProfileInputSchema.parse({
        expectedRevision: 0,
        programme: { state: 'supplied', value: { programmeId: 'P-001', courseLabel: null }, extra: true },
    }), ZodError);
    assert.throws(() => academicProfileInputSchema.parse({
        expectedRevision: 0,
        entryYear: { state: 'supplied' },
    }), ZodError);
    assert.throws(() => academicProfileInputSchema.parse({
        expectedRevision: 0,
        entryYear: { state: 'unknown', value: 2022 },
    }), ZodError);
    assert.throws(() => academicProfileInputSchema.parse({ entryYear: { state: 'skipped' } }), ZodError);
    assert.throws(() => academicProfileInputSchema.parse({ expectedRevision: -1 }), ZodError);
    assert.throws(() => academicProfileInputSchema.parse({ expectedRevision: 1.5 }), ZodError);
});

test('input schema rejects conflicting or empty programme selections', () => {
    assert.throws(() => academicProfileInputSchema.parse({
        expectedRevision: 0,
        programme: { state: 'supplied', value: { programmeId: null, courseLabel: null } },
    }), ZodError);
    assert.throws(() => academicProfileInputSchema.parse({
        expectedRevision: 0,
        programme: { state: 'supplied', value: { programmeId: 'P-001', courseLabel: 'Physics' } },
    }), ZodError);
    assert.throws(() => academicProfileInputSchema.parse({
        expectedRevision: 0,
        programme: { state: 'supplied', value: { programmeId: '   ', courseLabel: null } },
    }), ZodError);
});

test('collection gate requires both the feature flag and an approved retention window', () => {
    assert.equal(isAcademicProfileCollectionEnabled({ enabled: false, retentionDays: 90 }), false);
    assert.equal(isAcademicProfileCollectionEnabled({ enabled: true, retentionDays: null }), false);
    assert.equal(isAcademicProfileCollectionEnabled({ enabled: true, retentionDays: 0 }), false);
    assert.equal(isAcademicProfileCollectionEnabled({ enabled: true, retentionDays: -30 }), false);
    assert.equal(isAcademicProfileCollectionEnabled({ enabled: true, retentionDays: 1.5 }), false);
    assert.equal(isAcademicProfileCollectionEnabled({ enabled: true, retentionDays: 90 }), true);
    assert.equal(isAcademicProfileCollectionEnabled({ enabled: true, retentionDays: 1e308 }), false);
    assert.equal(isAcademicProfileCollectionEnabled({ enabled: true, retentionDays: 1_000_000_000 }), false);
});

test('merge preserves omitted fields while applying a partial update', () => {
    const stored = emptyStored({
        fields: {
            ...emptyStored().fields,
            claimedInstitution: { state: 'supplied', value: { name: 'Example University', countryCode: 'NG' } },
            entryYear: { state: 'supplied', value: 2022 },
        },
    });
    const merged = validateAndMergePatch({
        stored,
        patch: parsePatch({ expectedRevision: 0, entryRoute: { state: 'supplied', value: 'utme' } }),
        serverBound: false,
        reference: blockedReference,
        currentYear: CURRENT_YEAR,
    });
    assert.deepEqual(merged.claimedInstitution, { state: 'supplied', value: { name: 'Example University', countryCode: 'NG' } });
    assert.deepEqual(merged.entryYear, { state: 'supplied', value: 2022 });
    assert.deepEqual(merged.entryRoute, { state: 'supplied', value: 'utme' });
    assert.deepEqual(merged.programme, { state: 'unanswered' });
});

test('merge treats explicit unanswered as clear and keeps unknown/skipped distinct', () => {
    const stored = emptyStored({
        fields: {
            ...emptyStored().fields,
            entryYear: { state: 'supplied', value: 2022 },
            entryRoute: { state: 'supplied', value: 'utme' },
            programme: { state: 'supplied', value: { programmeId: null, courseLabel: 'Physics' } },
        },
    });
    const merged = validateAndMergePatch({
        stored,
        patch: parsePatch({
            expectedRevision: 0,
            entryYear: { state: 'unanswered' },
            entryRoute: { state: 'unknown' },
            programme: { state: 'skipped' },
        }),
        serverBound: false,
        reference: blockedReference,
        currentYear: CURRENT_YEAR,
    });
    assert.deepEqual(merged.entryYear, { state: 'unanswered' });
    assert.deepEqual(merged.entryRoute, { state: 'unknown' });
    assert.deepEqual(merged.programme, { state: 'skipped' });
});

test('merge enforces entry-year bounds against the server clock', () => {
    for (const year of [1899, CURRENT_YEAR + 1, 3000]) {
        assert.throws(() => validateAndMergePatch({
            stored: emptyStored(),
            patch: parsePatch({ expectedRevision: 0, entryYear: { state: 'supplied', value: year } }),
            serverBound: false,
            reference: blockedReference,
            currentYear: CURRENT_YEAR,
        }), BadRequestError, `entry year ${year}`);
    }
    for (const year of [1900, 2022, CURRENT_YEAR]) {
        const merged = validateAndMergePatch({
            stored: emptyStored(),
            patch: parsePatch({ expectedRevision: 0, entryYear: { state: 'supplied', value: year } }),
            serverBound: false,
            reference: blockedReference,
            currentYear: CURRENT_YEAR,
        });
        assert.deepEqual(merged.entryYear, { state: 'supplied', value: year });
    }
});

test('merge bounds self-reported graduation years against entry year and horizon', () => {
    const withEntry = emptyStored({
        fields: { ...emptyStored().fields, entryYear: { state: 'supplied', value: 2022 } },
    });
    assert.throws(() => validateAndMergePatch({
        stored: withEntry,
        patch: parsePatch({ expectedRevision: 0, expectedGraduationYear: { state: 'supplied', value: { kind: 'self_reported', year: 2021 } } }),
        serverBound: false,
        reference: blockedReference,
        currentYear: CURRENT_YEAR,
    }), BadRequestError);
    assert.throws(() => validateAndMergePatch({
        stored: withEntry,
        patch: parsePatch({ expectedRevision: 0, expectedGraduationYear: { state: 'supplied', value: { kind: 'self_reported', year: CURRENT_YEAR + 21 } } }),
        serverBound: false,
        reference: blockedReference,
        currentYear: CURRENT_YEAR,
    }), BadRequestError);
    const sameYear = validateAndMergePatch({
        stored: withEntry,
        patch: parsePatch({ expectedRevision: 0, expectedGraduationYear: { state: 'supplied', value: { kind: 'self_reported', year: 2022 } } }),
        serverBound: false,
        reference: blockedReference,
        currentYear: CURRENT_YEAR,
    });
    assert.deepEqual(sameYear.expectedGraduationYear, { state: 'supplied', value: 2022 });
    assert.equal(sameYear.graduationYearOrigin, 'self_reported');
    assert.equal(sameYear.estimateBasis, null);
    assert.equal(sameYear.estimateStale, false);
});

test('merge recomputes accepted estimates from merged inputs and the reviewed reference', () => {
    const stored = emptyStored({
        fields: {
            ...emptyStored().fields,
            programme: { state: 'supplied', value: { programmeId: 'P-001', courseLabel: null } },
            entryYear: { state: 'supplied', value: 2022 },
        },
    });
    const merged = validateAndMergePatch({
        stored,
        patch: parsePatch({
            expectedRevision: 0,
            entryRoute: { state: 'supplied', value: 'utme' },
            expectedGraduationYear: { state: 'supplied', value: { kind: 'accept_estimate', year: 2026 } },
        }),
        serverBound: false,
        reference: reviewedReference,
        currentYear: CURRENT_YEAR,
    });
    assert.deepEqual(merged.expectedGraduationYear, { state: 'supplied', value: 2026 });
    assert.equal(merged.graduationYearOrigin, 'calculated');
    assert.deepEqual(merged.estimateBasis, {
        programmeId: 'P-001',
        entryYear: 2022,
        entryRoute: 'utme',
        ruleId: 'P-001:utme',
        sourceVersion: 'TEST-REF-v1',
    });
    assert.equal(merged.estimateStale, false);
});

test('merge applies remaining direct-entry durations at the actual entry level', () => {
    const merged = validateAndMergePatch({
        stored: emptyStored(),
        patch: parsePatch({
            expectedRevision: 0,
            programme: { state: 'supplied', value: { programmeId: 'P-001', courseLabel: null } },
            entryYear: { state: 'supplied', value: 2023 },
            entryRoute: { state: 'supplied', value: 'de_200' },
            expectedGraduationYear: { state: 'supplied', value: { kind: 'accept_estimate', year: 2026 } },
        }),
        serverBound: false,
        reference: reviewedReference,
        currentYear: CURRENT_YEAR,
    });
    assert.deepEqual(merged.expectedGraduationYear, { state: 'supplied', value: 2026 });
    assert.deepEqual(merged.estimateBasis, {
        programmeId: 'P-001',
        entryYear: 2023,
        entryRoute: 'de_200',
        ruleId: 'P-001:de_200',
        sourceVersion: 'TEST-REF-v1',
    });
});

test('merge rejects mismatched or unavailable accepted estimates', () => {
    const base = {
        stored: emptyStored({
            fields: {
                ...emptyStored().fields,
                programme: { state: 'supplied', value: { programmeId: 'P-001', courseLabel: null } },
                entryYear: { state: 'supplied', value: 2022 },
                entryRoute: { state: 'supplied', value: 'utme' },
            },
        }),
        serverBound: false,
        currentYear: CURRENT_YEAR,
    } as const;
    assert.throws(() => validateAndMergePatch({
        ...base,
        patch: parsePatch({ expectedRevision: 0, expectedGraduationYear: { state: 'supplied', value: { kind: 'accept_estimate', year: 2027 } } }),
        reference: reviewedReference,
    }), BadRequestError);
    assert.throws(() => validateAndMergePatch({
        ...base,
        patch: parsePatch({ expectedRevision: 0, expectedGraduationYear: { state: 'supplied', value: { kind: 'accept_estimate', year: 2026 } } }),
        reference: blockedReference,
    }), BadRequestError);
});

test('artifact rules never estimate a programme from another bound country', () => {
    const programmes = [{
        programmeId: 'P-001',
        countryCode: 'NG',
        routes: { utme: { durationYears: 4, reviewed: true, applicable: true, estimable: true } },
    }];
    assert.deepEqual(
        ruleFromArtifact(programmes, 'TEST-REF-v1', 'P-001', 'utme', 'GH'),
        null,
    );
    assert.deepEqual(
        ruleFromArtifact(programmes, 'TEST-REF-v1', 'P-001', 'utme', 'NG'),
        { durationYears: 4, ruleId: 'P-001:utme', sourceVersion: 'TEST-REF-v1' },
    );
    assert.deepEqual(
        ruleFromArtifact(programmes, 'TEST-REF-v1', 'P-001', 'utme', undefined),
        { durationYears: 4, ruleId: 'P-001:utme', sourceVersion: 'TEST-REF-v1' },
    );
    assert.deepEqual(
        ruleFromArtifact(programmes, 'TEST-REF-v1', 'P-001', 'utme', null),
        null,
    );
});

test('artifact rules never emit a rule id that overflows rule-id storage', () => {
    const longId = `p-${'0'.repeat(120)}`;
    assert.equal(`${longId}:de_300`.length, ESTIMATE_RULE_ID_MAX_LENGTH + 1);
    const programmes = [{
        programmeId: longId,
        countryCode: 'NG',
        routes: { de_300: { durationYears: 4, reviewed: true, applicable: true, estimable: true } },
    }];
    assert.deepEqual(ruleFromArtifact(programmes, 'TEST-REF-v1', longId, 'de_300'), null);
    const boundaryId = `p-${'0'.repeat(MAX_ESTIMABLE_PROGRAMME_ID_LENGTH - 2)}`;
    assert.equal(boundaryId.length, MAX_ESTIMABLE_PROGRAMME_ID_LENGTH);
    const boundaryProgrammes = [{
        programmeId: boundaryId,
        countryCode: 'NG',
        routes: { de_300: { durationYears: 4, reviewed: true, applicable: true, estimable: true } },
    }];
    assert.deepEqual(
        ruleFromArtifact(boundaryProgrammes, 'TEST-REF-v1', boundaryId, 'de_300'),
        { durationYears: 4, ruleId: `${boundaryId}:de_300`, sourceVersion: 'TEST-REF-v1' },
    );
});

test('artifact rules reject durations above the reviewed maximum', () => {
    const programmes = [{
        programmeId: 'P-001',
        countryCode: 'NG',
        routes: { utme: { durationYears: MAX_REVIEWED_DURATION_YEARS + 1, reviewed: true, applicable: true, estimable: true } },
    }];
    assert.deepEqual(ruleFromArtifact(programmes, 'TEST-REF-v1', 'P-001', 'utme'), null);
    const boundary = [{
        programmeId: 'P-001',
        countryCode: 'NG',
        routes: { utme: { durationYears: MAX_REVIEWED_DURATION_YEARS, reviewed: true, applicable: true, estimable: true } },
    }];
    assert.deepEqual(
        ruleFromArtifact(boundary, 'TEST-REF-v1', 'P-001', 'utme'),
        { durationYears: MAX_REVIEWED_DURATION_YEARS, ruleId: 'P-001:utme', sourceVersion: 'TEST-REF-v1' },
    );
});

test('artifact rules refuse pending routes even when estimable is hand-set', () => {
    const programmes = [{
        programmeId: 'P-001',
        countryCode: 'NG',
        routes: { de_200: { durationYears: 3, reviewed: true, applicable: true, estimable: true, pending: true } },
    }];
    assert.deepEqual(ruleFromArtifact(programmes, 'TEST-REF-v1', 'P-001', 'de_200'), null);
    const settled = [{
        programmeId: 'P-001',
        countryCode: 'NG',
        routes: { utme: { durationYears: 4, reviewed: true, applicable: true, estimable: true, pending: false } },
    }];
    assert.deepEqual(
        ruleFromArtifact(settled, 'TEST-REF-v1', 'P-001', 'utme'),
        { durationYears: 4, ruleId: 'P-001:utme', sourceVersion: 'TEST-REF-v1' },
    );
});

test('artifact rules reject source versions that overflow estimate storage', () => {
    const programmes = [{
        programmeId: 'P-001',
        countryCode: 'NG',
        routes: { utme: { durationYears: 4, reviewed: true, applicable: true, estimable: true } },
    }];
    const longVersion = `v${'0'.repeat(ESTIMATE_SOURCE_VERSION_MAX_LENGTH)}`;
    assert.equal(longVersion.length, ESTIMATE_SOURCE_VERSION_MAX_LENGTH + 1);
    assert.deepEqual(ruleFromArtifact(programmes, longVersion, 'P-001', 'utme'), null);
    const boundaryVersion = `v${'0'.repeat(ESTIMATE_SOURCE_VERSION_MAX_LENGTH - 1)}`;
    assert.deepEqual(
        ruleFromArtifact(programmes, boundaryVersion, 'P-001', 'utme'),
        { durationYears: 4, ruleId: 'P-001:utme', sourceVersion: boundaryVersion },
    );
});

test('merge rejects an accepted estimate from outside the bound country', () => {
    const stored = emptyStored({
        fields: {
            ...emptyStored().fields,
            programme: { state: 'supplied', value: { programmeId: 'P-001', courseLabel: null } },
            entryYear: { state: 'supplied', value: 2022 },
            entryRoute: { state: 'supplied', value: 'utme' },
        },
    });
    const countryAwareReference: AcademicProgrammeReference = {
        sourceVersion: 'TEST-REF-v1',
        findProgrammeLabel: () => null,
        findReviewedRule: (programmeId, route, expectedCountryCode) => {
            if (expectedCountryCode !== undefined && expectedCountryCode !== null && expectedCountryCode !== 'NG') return null;
            return reviewedReference.findReviewedRule(programmeId, route);
        },
    };
    assert.throws(() => validateAndMergePatch({
        stored,
        patch: parsePatch({ expectedRevision: 0, expectedGraduationYear: { state: 'supplied', value: { kind: 'accept_estimate', year: 2026 } } }),
        serverBound: true,
        reference: countryAwareReference,
        currentYear: CURRENT_YEAR,
        expectedCountryCode: 'GH',
    }), BadRequestError);
    const merged = validateAndMergePatch({
        stored,
        patch: parsePatch({ expectedRevision: 0, expectedGraduationYear: { state: 'supplied', value: { kind: 'accept_estimate', year: 2026 } } }),
        serverBound: true,
        reference: countryAwareReference,
        currentYear: CURRENT_YEAR,
        expectedCountryCode: 'NG',
    });
    assert.deepEqual(merged.expectedGraduationYear, { state: 'supplied', value: 2026 });
});

test('effective estimate country prefers the binding, then the claimed school', () => {
    const claimed = {
        ...emptyStored().fields,
        claimedInstitution: { state: 'supplied' as const, value: { name: 'Example University', countryCode: 'NG' } },
    };
    const unclaimed = emptyStored().fields;
    assert.equal(effectiveEstimateCountryCode({ serverBound: true, bindingCountryCode: 'GH', fields: claimed }), 'GH');
    assert.equal(effectiveEstimateCountryCode({ serverBound: true, bindingCountryCode: null, fields: claimed }), null);
    assert.equal(effectiveEstimateCountryCode({ serverBound: false, fields: claimed }), 'NG');
    assert.equal(effectiveEstimateCountryCode({ serverBound: false, fields: unclaimed }), undefined);
});

test('merge scopes unbound estimates to the claimed country once a school is claimed', () => {
    const inputs = {
        programme: { state: 'supplied' as const, value: { programmeId: 'P-001', courseLabel: null } },
        entryYear: { state: 'supplied' as const, value: 2022 },
        entryRoute: { state: 'supplied' as const, value: 'utme' as const },
    };
    const countryAwareReference: AcademicProgrammeReference = {
        sourceVersion: 'TEST-REF-v1',
        findProgrammeLabel: () => null,
        findReviewedRule: (programmeId, route, expectedCountryCode) => {
            if (expectedCountryCode !== undefined && expectedCountryCode !== 'NG') return null;
            return reviewedReference.findReviewedRule(programmeId, route);
        },
    };
    const accept = { expectedRevision: 0, expectedGraduationYear: { state: 'supplied', value: { kind: 'accept_estimate', year: 2026 } } };
    const claimedNg = emptyStored({
        fields: {
            ...emptyStored().fields,
            ...inputs,
            claimedInstitution: { state: 'supplied', value: { name: 'Example University', countryCode: 'NG' } },
        },
    });
    const merged = validateAndMergePatch({
        stored: claimedNg,
        patch: parsePatch(accept),
        serverBound: false,
        reference: countryAwareReference,
        currentYear: CURRENT_YEAR,
    });
    assert.deepEqual(merged.expectedGraduationYear, { state: 'supplied', value: 2026 });
    assert.throws(() => validateAndMergePatch({
        stored: claimedNg,
        patch: parsePatch({
            ...accept,
            claimedInstitution: { state: 'supplied', value: { name: 'Other School', countryCode: 'GH' } },
        }),
        serverBound: false,
        reference: countryAwareReference,
        currentYear: CURRENT_YEAR,
    }), BadRequestError);
    const unclaimed = validateAndMergePatch({
        stored: emptyStored({ fields: { ...emptyStored().fields, ...inputs } }),
        patch: parsePatch(accept),
        serverBound: false,
        reference: countryAwareReference,
        currentYear: CURRENT_YEAR,
    });
    assert.deepEqual(unclaimed.expectedGraduationYear, { state: 'supplied', value: 2026 });
});

test('bound institution country distinguishes unbound from unmapped', () => {
    assert.equal(boundInstitutionCountryCode(null, 'Nigeria'), undefined);
    assert.equal(boundInstitutionCountryCode(null, null), undefined);
    assert.equal(boundInstitutionCountryCode(UNIVERSITY_ID, 'Nigeria'), 'NG');
    assert.equal(boundInstitutionCountryCode(UNIVERSITY_ID, 'Kenya'), null);
    assert.equal(boundInstitutionCountryCode(UNIVERSITY_ID, null), null);
});

test('merge rejects an accepted estimate for a country-unmapped bound student', () => {
    const stored = emptyStored({
        fields: {
            ...emptyStored().fields,
            programme: { state: 'supplied', value: { programmeId: 'P-001', courseLabel: null } },
            entryYear: { state: 'supplied', value: 2022 },
            entryRoute: { state: 'supplied', value: 'utme' },
        },
    });
    const programmes = [{
        programmeId: 'P-001',
        countryCode: 'NG',
        label: 'Stylised Physics',
        routes: { utme: { durationYears: 4, reviewed: true, applicable: true, estimable: true } },
    }];
    const artifactReference: AcademicProgrammeReference = {
        sourceVersion: 'TEST-REF-v1',
        findReviewedRule: (programmeId, route, expectedCountryCode) => (
            ruleFromArtifact(programmes, 'TEST-REF-v1', programmeId, route, expectedCountryCode)
        ),
        findProgrammeLabel: (programmeId) => labelFromArtifact(programmes, programmeId),
    };
    assert.throws(() => validateAndMergePatch({
        stored,
        patch: parsePatch({ expectedRevision: 0, expectedGraduationYear: { state: 'supplied', value: { kind: 'accept_estimate', year: 2026 } } }),
        serverBound: true,
        reference: artifactReference,
        currentYear: CURRENT_YEAR,
        expectedCountryCode: boundInstitutionCountryCode(UNIVERSITY_ID, 'Kenya'),
    }), BadRequestError);
    const merged = validateAndMergePatch({
        stored,
        patch: parsePatch({ expectedRevision: 0, expectedGraduationYear: { state: 'supplied', value: { kind: 'accept_estimate', year: 2026 } } }),
        serverBound: true,
        reference: artifactReference,
        currentYear: CURRENT_YEAR,
        expectedCountryCode: boundInstitutionCountryCode(UNIVERSITY_ID, 'Nigeria'),
    });
    assert.deepEqual(merged.expectedGraduationYear, { state: 'supplied', value: 2026 });
});

test('merge never calculates transfer routes without an explicit reviewed rule', () => {
    const stored = emptyStored({
        fields: {
            ...emptyStored().fields,
            programme: { state: 'supplied', value: { programmeId: 'P-001', courseLabel: null } },
            entryYear: { state: 'supplied', value: 2022 },
            entryRoute: { state: 'supplied', value: 'transfer_other' },
        },
    });
    assert.throws(() => validateAndMergePatch({
        stored,
        patch: parsePatch({ expectedRevision: 0, expectedGraduationYear: { state: 'supplied', value: { kind: 'accept_estimate', year: 2026 } } }),
        serverBound: false,
        reference: reviewedReference,
        currentYear: CURRENT_YEAR,
    }), BadRequestError);
});

test('merge marks calculated years stale when inputs change without reconfirmation', () => {
    const calculated = emptyStored({
        fields: {
            ...emptyStored().fields,
            programme: { state: 'supplied', value: { programmeId: 'P-001', courseLabel: null } },
            entryYear: { state: 'supplied', value: 2022 },
            entryRoute: { state: 'supplied', value: 'utme' },
            expectedGraduationYear: { state: 'supplied', value: 2026 },
            graduationYearOrigin: 'calculated',
            estimateBasis: { programmeId: 'P-001', entryYear: 2022, entryRoute: 'utme', ruleId: 'P-001:utme', sourceVersion: 'TEST-REF-v1' },
            estimateStale: false,
        },
    });
    const stale = validateAndMergePatch({
        stored: calculated,
        patch: parsePatch({ expectedRevision: 0, entryRoute: { state: 'supplied', value: 'de_200' } }),
        serverBound: false,
        reference: reviewedReference,
        currentYear: CURRENT_YEAR,
    });
    assert.equal(stale.estimateStale, true);
    assert.deepEqual(stale.expectedGraduationYear, { state: 'supplied', value: 2026 });
    assert.equal(stale.graduationYearOrigin, 'calculated');

    const reconfirmed = validateAndMergePatch({
        stored: { ...calculated, fields: stale },
        patch: parsePatch({ expectedRevision: 0, expectedGraduationYear: { state: 'supplied', value: { kind: 'accept_estimate', year: 2025 } } }),
        serverBound: false,
        reference: reviewedReference,
        currentYear: CURRENT_YEAR,
    });
    assert.equal(reconfirmed.estimateStale, false);
    assert.deepEqual(reconfirmed.estimateBasis?.entryRoute, 'de_200');
});

test('merge preserves self-reported overrides across input changes', () => {
    const reported = emptyStored({
        fields: {
            ...emptyStored().fields,
            programme: { state: 'supplied', value: { programmeId: null, courseLabel: 'Physics' } },
            entryYear: { state: 'supplied', value: 2022 },
            expectedGraduationYear: { state: 'supplied', value: 2027 },
            graduationYearOrigin: 'self_reported',
            estimateBasis: null,
            estimateStale: false,
        },
    });
    const merged = validateAndMergePatch({
        stored: reported,
        patch: parsePatch({ expectedRevision: 0, entryYear: { state: 'supplied', value: 2023 } }),
        serverBound: false,
        reference: reviewedReference,
        currentYear: CURRENT_YEAR,
    });
    assert.deepEqual(merged.expectedGraduationYear, { state: 'supplied', value: 2027 });
    assert.equal(merged.graduationYearOrigin, 'self_reported');
    assert.equal(merged.estimateStale, false);
});

test('merge revalidates a preserved self-reported year when the entry year moves under it', () => {
    const reported = emptyStored({
        fields: {
            ...emptyStored().fields,
            entryYear: { state: 'supplied', value: 2022 },
            expectedGraduationYear: { state: 'supplied', value: 2025 },
            graduationYearOrigin: 'self_reported',
            estimateBasis: null,
            estimateStale: false,
        },
    });
    assert.throws(() => validateAndMergePatch({
        stored: reported,
        patch: parsePatch({ expectedRevision: 0, entryYear: { state: 'supplied', value: 2026 } }),
        serverBound: false,
        reference: reviewedReference,
        currentYear: CURRENT_YEAR,
    }), /outside the plausible range/);
    const kept = validateAndMergePatch({
        stored: reported,
        patch: parsePatch({ expectedRevision: 0, entryYear: { state: 'supplied', value: 2021 } }),
        serverBound: false,
        reference: reviewedReference,
        currentYear: CURRENT_YEAR,
    });
    assert.deepEqual(kept.expectedGraduationYear, { state: 'supplied', value: 2025 });
    assert.equal(kept.graduationYearOrigin, 'self_reported');
});

test('merge clears server-owned origin and basis when the year is unanswered', () => {
    const calculated = emptyStored({
        fields: {
            ...emptyStored().fields,
            expectedGraduationYear: { state: 'supplied', value: 2026 },
            graduationYearOrigin: 'calculated',
            estimateBasis: { programmeId: 'P-001', entryYear: 2022, entryRoute: 'utme', ruleId: 'P-001:utme', sourceVersion: 'TEST-REF-v1' },
            estimateStale: true,
        },
    });
    for (const state of ['unanswered', 'unknown', 'skipped'] as const) {
        const merged = validateAndMergePatch({
            stored: calculated,
            patch: parsePatch({ expectedRevision: 0, expectedGraduationYear: { state } }),
            serverBound: false,
            reference: reviewedReference,
            currentYear: CURRENT_YEAR,
        });
        assert.deepEqual(merged.expectedGraduationYear, { state });
        assert.equal(merged.graduationYearOrigin, null);
        assert.equal(merged.estimateBasis, null);
        assert.equal(merged.estimateStale, false);
    }
});

test('merge rejects claimed-institution writes while a school is server-bound', () => {
    assert.throws(() => validateAndMergePatch({
        stored: emptyStored(),
        patch: parsePatch({ expectedRevision: 0, claimedInstitution: { state: 'supplied', value: { name: 'Other School', countryCode: 'NG' } } }),
        serverBound: true,
        reference: blockedReference,
        currentYear: CURRENT_YEAR,
    }), BadRequestError);
    assert.throws(() => validateAndMergePatch({
        stored: emptyStored(),
        patch: parsePatch({ expectedRevision: 0, claimedInstitution: { state: 'unknown' } }),
        serverBound: true,
        reference: blockedReference,
        currentYear: CURRENT_YEAR,
    }), BadRequestError);
});

test('merge normalizes claimed institutions and enforces ISO country codes', () => {
    const merged = validateAndMergePatch({
        stored: emptyStored(),
        patch: parsePatch({ expectedRevision: 0, claimedInstitution: { state: 'supplied', value: { name: '  Example University  ', countryCode: 'ng' } } }),
        serverBound: false,
        reference: blockedReference,
        currentYear: CURRENT_YEAR,
    });
    assert.deepEqual(merged.claimedInstitution, { state: 'supplied', value: { name: 'Example University', countryCode: 'NG' } });
    assert.throws(() => academicProfileInputSchema.parse({
        expectedRevision: 0,
        claimedInstitution: { state: 'supplied', value: { name: 'Example University', countryCode: 'NGA' } },
    }), ZodError);
    assert.throws(() => academicProfileInputSchema.parse({
        expectedRevision: 0,
        claimedInstitution: { state: 'supplied', value: { name: '   ', countryCode: 'NG' } },
    }), ZodError);
});

test('unanswered computation excludes server-bound institutions', () => {
    const fields = emptyStored().fields;
    assert.deepEqual(
        computeOptionalUnansweredFields(fields, 'server_bound'),
        ['programme', 'entryYear', 'entryRoute', 'expectedGraduationYear'] satisfies AcademicField[],
    );
    assert.deepEqual(
        computeOptionalUnansweredFields(fields, 'unbound'),
        ['claimedInstitution', 'programme', 'entryYear', 'entryRoute', 'expectedGraduationYear'] satisfies AcademicField[],
    );
    const answered = {
        ...fields,
        claimedInstitution: { state: 'supplied' as const, value: { name: 'Example University', countryCode: 'NG' } },
        programme: { state: 'skipped' as const },
        entryRoute: { state: 'unknown' as const },
    };
    assert.deepEqual(computeOptionalUnansweredFields(answered, 'student_claimed'), ['entryYear', 'expectedGraduationYear']);
});

test('stale detection covers stored flags, basis drift, and reference drift', () => {
    const fresh = {
        ...emptyStored().fields,
        programme: { state: 'supplied' as const, value: { programmeId: 'P-001', courseLabel: null } },
        entryYear: { state: 'supplied' as const, value: 2022 },
        entryRoute: { state: 'supplied' as const, value: 'utme' as const },
        expectedGraduationYear: { state: 'supplied' as const, value: 2026 },
        graduationYearOrigin: 'calculated' as const,
        estimateBasis: { programmeId: 'P-001', entryYear: 2022, entryRoute: 'utme' as const, ruleId: 'P-001:utme', sourceVersion: 'TEST-REF-v1' },
        estimateStale: false,
    };
    assert.equal(isEstimateStale(fresh, 'TEST-REF-v1'), false);
    assert.equal(isEstimateStale({ ...fresh, estimateStale: true }, 'TEST-REF-v1'), true);
    assert.equal(isEstimateStale({ ...fresh, entryYear: { state: 'supplied', value: 2023 } }, 'TEST-REF-v1'), true);
    assert.equal(isEstimateStale(fresh, 'TEST-REF-v2'), true);
    assert.equal(isEstimateStale(fresh, null), false);
    assert.equal(isEstimateStale({ ...fresh, graduationYearOrigin: 'self_reported', estimateBasis: null }, 'TEST-REF-v2'), false);
});

test('attention fields add stale calculated years to unanswered optionals', () => {
    const fields = {
        ...emptyStored().fields,
        claimedInstitution: { state: 'supplied' as const, value: { name: 'Example University', countryCode: 'NG' } },
        programme: { state: 'supplied' as const, value: { programmeId: 'P-001', courseLabel: null } },
        entryYear: { state: 'supplied' as const, value: 2022 },
        entryRoute: { state: 'supplied' as const, value: 'utme' as const },
        expectedGraduationYear: { state: 'supplied' as const, value: 2026 },
        graduationYearOrigin: 'calculated' as const,
        estimateBasis: { programmeId: 'P-001', entryYear: 2022, entryRoute: 'utme' as const, ruleId: 'P-001:utme', sourceVersion: 'TEST-REF-v1' },
        estimateStale: true,
    };
    assert.deepEqual(computeAttentionFields({ fields, binding: 'student_claimed', currentSourceVersion: 'TEST-REF-v1' }), ['expectedGraduationYear']);
    assert.deepEqual(computeAttentionFields({ fields: { ...fields, estimateStale: false }, binding: 'student_claimed', currentSourceVersion: 'TEST-REF-v1' }), []);
});

test('prompt decision derives only from feature state, assurance, attention, and continuation', () => {
    const base = {
        featureEnabled: true,
        assuranceState: 'available' as const,
        assurance: pendingAssurance,
        attentionFields: ['programme'] as AcademicField[],
        verificationContinuationAvailable: false,
    };
    assert.equal(computePromptDecision(base), 'complete_profile');
    assert.equal(computePromptDecision({ ...base, featureEnabled: false }), 'continue');
    assert.equal(computePromptDecision({ ...base, assuranceState: 'unavailable', assurance: null }), 'continue');
    assert.equal(computePromptDecision({ ...base, assurance: verifiedAssurance }), 'continue');
    assert.equal(computePromptDecision({ ...base, attentionFields: [] }), 'continue');
    assert.equal(computePromptDecision({ ...base, verificationContinuationAvailable: true }), 'continue');
    assert.equal(computePromptDecision({ ...base, assurance: { ...pendingAssurance, studentStatus: 'expired' } }), 'continue');
});

test('read binds strictly to the authenticated user and projects an empty profile', async () => {
    const state = fakeState();
    const projection = await readAcademicProfile(createFakePool(state) as never, USER_ID, serviceDeps());
    assert.deepEqual(state.readUserIds, [USER_ID]);
    assert.equal(projection.revision, 0);
    assert.deepEqual(projection.fields.programme, { state: 'unanswered' });
    assert.deepEqual(projection.institution, { displayName: null, countryCode: null, binding: 'unbound' });
    assert.equal(projection.institutionConfirmedGraduationYear, null);
    assert.equal(projection.entryYearSuggestion, null);
    assert.deepEqual(projection.optionalUnansweredFields, ['claimedInstitution', 'programme', 'entryYear', 'entryRoute', 'expectedGraduationYear']);
    assert.deepEqual(projection.verificationRequirements, []);
    assert.equal(projection.verificationContinuationAvailable, false);
    assert.equal(projection.assuranceState, 'available');
    assert.deepEqual(projection.assurance, pendingAssurance);
    assert.equal(projection.referenceVersion, 'TEST-REF-v1');
    assert.equal(projection.estimate, null);
    assert.equal(projection.featureEnabled, true);
    assert.equal(projection.promptDecision, 'complete_profile');
});

test('read projects claimed institutions without exposing canonical identifiers', async () => {
    const state = fakeState({
        profile: profileRow({
            claimed_institution_state: 'supplied',
            claimed_institution_name: 'Example University',
            claimed_institution_country: 'NG',
        }),
    });
    const projection = await readAcademicProfile(createFakePool(state) as never, USER_ID, serviceDeps());
    assert.deepEqual(projection.institution, { displayName: 'Example University', countryCode: 'NG', binding: 'student_claimed' });
    assert.deepEqual(projection.fields.claimedInstitution, { state: 'supplied', value: { name: 'Example University', countryCode: 'NG' } });
    assert.ok(!('canonicalInstitutionId' in projection));
    assert.ok(!JSON.stringify(projection).includes(STUDENT_ID));
});

test('read projects server-bound institutions as read-only display values', async () => {
    const state = boundState({
        profile: profileRow({ canonical_institution_id: UNIVERSITY_ID }),
    });
    const projection = await readAcademicProfile(createFakePool(state) as never, USER_ID, serviceDeps());
    assert.deepEqual(projection.institution, { displayName: 'Fixture University', countryCode: null, binding: 'server_bound' });
    assert.ok(!projection.optionalUnansweredFields.includes('claimedInstitution'));
    assert.ok(!JSON.stringify(projection).includes(UNIVERSITY_ID));
});

test('read resolves the saved programme label for catalogue selections', async () => {
    const state = fakeState({ profile: profileRow({ programme_state: 'supplied', programme_id: 'P-001', course_label: null }) });
    const labelled = await readAcademicProfile(createFakePool(state) as never, USER_ID, serviceDeps({ reference: reviewedReference }));
    assert.equal(labelled.programmeLabel, 'Stylised Physics');
    const unlabelled = await readAcademicProfile(createFakePool(state) as never, USER_ID, serviceDeps());
    assert.equal(unlabelled.programmeLabel, null);
    const freeText = fakeState({ profile: profileRow({ programme_state: 'supplied', programme_id: null, course_label: 'Free text' }) });
    const free = await readAcademicProfile(createFakePool(freeText) as never, USER_ID, serviceDeps({ reference: reviewedReference }));
    assert.equal(free.programmeLabel, null);
});

test('artifact root country defaults once and rejects malformed values', () => {
    assert.equal(normalizeArtifactCountryCode(undefined), 'NG');
    assert.equal(normalizeArtifactCountryCode('GH'), 'GH');
    assert.equal(normalizeArtifactCountryCode(null), null);
    assert.equal(normalizeArtifactCountryCode(''), null);
    assert.equal(normalizeArtifactCountryCode('ng'), null);
    assert.equal(normalizeArtifactCountryCode(42), null);
});

test('artifact labels resolve display text and fail closed on malformed entries', () => {
    const programmes = [
        { programmeId: 'P-001', countryCode: 'NG', label: '  Stylised Physics  ', routes: {} },
        { programmeId: 'P-002', countryCode: 'NG', label: '', routes: {} },
        { programmeId: 'P-003', countryCode: 'NG', label: 42, routes: {} },
    ];
    assert.equal(labelFromArtifact(programmes, 'P-001'), 'Stylised Physics');
    assert.equal(labelFromArtifact(programmes, 'P-002'), null);
    assert.equal(labelFromArtifact(programmes, 'P-003'), null);
    assert.equal(labelFromArtifact(programmes, 'P-404'), null);
});

test('read derives verification requirements from operational method availability', async () => {
    const state = boundState({ profile: profileRow({ canonical_institution_id: UNIVERSITY_ID }) });
    const seen: Array<string | null> = [];
    const projection = await readAcademicProfile(
        createFakePool(state) as never,
        USER_ID,
        serviceDeps({
            listVerificationMethods: async (tx, universityId) => {
                assert.ok(tx, 'method resolver receives the transaction client');
                seen.push(universityId);
                return registrationAvailable();
            },
        }),
    );
    assert.deepEqual(seen, [UNIVERSITY_ID]);
    assert.equal(projection.verificationContinuationAvailable, true);
    assert.deepEqual(projection.verificationRequirements, ['registration_number', 'processing_consent']);
    assert.equal(projection.promptDecision, 'continue');
});

test('read fails closed to no-prompt when the method resolver fails', async () => {
    const state = boundState({ profile: profileRow({ canonical_institution_id: UNIVERSITY_ID }) });
    const projection = await readAcademicProfile(
        createFakePool(state) as never,
        USER_ID,
        serviceDeps({ listVerificationMethods: async () => { throw new Error('resolver down'); } }),
    );
    assert.equal(projection.verificationContinuationAvailable, true);
    assert.deepEqual(projection.verificationRequirements, []);
    assert.equal(projection.promptDecision, 'continue');
});

test('read reports assurance unavailable instead of failing the projection', async () => {
    const state = fakeState();
    const projection = await readAcademicProfile(
        createFakePool(state) as never,
        USER_ID,
        serviceDeps({ readAssurance: async () => { throw new Error('assurance down'); } }),
    );
    assert.equal(projection.assuranceState, 'unavailable');
    assert.equal(projection.assurance, null);
    assert.equal(projection.promptDecision, 'continue');
});

test('read withholds superseded values after an institution change', async () => {
    const state = boundState({
        profile: profileRow({
            canonical_institution_id: NEXT_UNIVERSITY_ID,
            programme_state: 'supplied',
            programme_id: 'P-001',
            entry_year_state: 'supplied',
            entry_year: 2022,
        }),
    });
    state.student = { id: STUDENT_ID, university_id: UNIVERSITY_ID, identity_version: 1, status: 'active' };
    const projection = await readAcademicProfile(createFakePool(state) as never, USER_ID, serviceDeps());
    assert.equal(projection.revision, 1);
    assert.deepEqual(projection.fields.programme, { state: 'unanswered' });
    assert.deepEqual(projection.fields.entryYear, { state: 'unanswered' });
    assert.deepEqual(projection.institution.binding, 'server_bound');
    assert.equal(state.writes.length, 0);
});

test('read hides soft-deleted accounts and unknown users', async () => {
    const deleted = fakeState();
    deleted.user = { id: USER_ID, email: 'gone@example.invalid', role: 'student', deleted_at: NOW };
    await assert.rejects(readAcademicProfile(createFakePool(deleted) as never, USER_ID, serviceDeps()), NotFoundError);
    const missing = fakeState({ user: null, student: null });
    await assert.rejects(readAcademicProfile(createFakePool(missing) as never, OTHER_USER_ID, serviceDeps()), NotFoundError);
});

test('saves lock the bound university against metadata races while reads share it', async () => {
    const saved = boundState();
    await saveAcademicProfile(
        createFakePool(saved) as never,
        USER_ID,
        { expectedRevision: 0, entryYear: { state: 'supplied', value: 2022 } },
        serviceDeps(),
    );
    const saveLock = saved.statements.find((text) => text.includes('FROM universities'));
    assert.ok(saveLock?.endsWith('FOR SHARE'), saveLock);
    const read = boundState();
    await readAcademicProfile(createFakePool(read) as never, USER_ID, serviceDeps());
    const readLock = read.statements.find((text) => text.includes('FROM universities'));
    assert.ok(readLock?.endsWith('FOR KEY SHARE'), readLock);
});

test('save creates the first revision and binds the server-owned canonical institution', async () => {
    const state = boundState();
    const projection = await saveAcademicProfile(
        createFakePool(state) as never,
        USER_ID,
        {
            expectedRevision: 0,
            programme: { state: 'supplied', value: { programmeId: null, courseLabel: 'Physics' } },
            entryYear: { state: 'supplied', value: 2022 },
        },
        serviceDeps(),
    );
    assert.equal(projection.revision, 1);
    assert.deepEqual(projection.fields.programme, { state: 'supplied', value: { programmeId: null, courseLabel: 'Physics' } });
    assert.equal(state.writes.length, 1);
    assert.ok(state.writes[0]?.params.includes(UNIVERSITY_ID), 'stored binding must come from server context');
    assert.ok(state.writes[0]?.params.includes(1), 'stored revision must increment');
    assert.equal(state.profile?.['canonical_institution_id'], UNIVERSITY_ID);
    assert.equal(state.profile?.['revision'], 1);
});

test('save binds every statement to the authenticated user id', async () => {
    const state = fakeState();
    await saveAcademicProfile(
        createFakePool(state) as never,
        USER_ID,
        { expectedRevision: 0, entryRoute: { state: 'skipped' } },
        serviceDeps(),
    );
    assert.deepEqual(state.readUserIds, [USER_ID]);
    assert.ok(state.writes[0]?.params.includes(USER_ID));
});

test('save rejects stale revisions without writing', async () => {
    const state = fakeState({ profile: profileRow({ revision: 3 }) });
    await assert.rejects(
        saveAcademicProfile(createFakePool(state) as never, USER_ID, { expectedRevision: 2 }, serviceDeps()),
        (error: unknown) => {
            assert.ok(error instanceof ConflictError);
            assert.deepEqual(error.details, { code: ACADEMIC_PROFILE_REVISION_CONFLICT, revision: 3 });
            return true;
        },
    );
    assert.equal(state.writes.length, 0);
});

test('save rejects institution replacement attempts on bound profiles', async () => {
    const state = boundState({ profile: profileRow({ revision: 1, canonical_institution_id: UNIVERSITY_ID }) });
    await assert.rejects(
        saveAcademicProfile(
            createFakePool(state) as never,
            USER_ID,
            { expectedRevision: 1, claimedInstitution: { state: 'supplied', value: { name: 'Other School', countryCode: 'NG' } } },
            serviceDeps(),
        ),
        BadRequestError,
    );
    assert.equal(state.writes.length, 0);
});

test('save conflicts on institution drift and commits only the invalidation', async () => {
    const state = boundState({
        profile: profileRow({
            revision: 2,
            canonical_institution_id: NEXT_UNIVERSITY_ID,
            programme_state: 'supplied',
            programme_id: 'P-001',
            entry_year_state: 'supplied',
            entry_year: 2022,
        }),
    });
    await assert.rejects(
        saveAcademicProfile(
            createFakePool(state) as never,
            USER_ID,
            { expectedRevision: 2, entryRoute: { state: 'supplied', value: 'utme' } },
            serviceDeps(),
        ),
        (error: unknown) => {
            assert.ok(error instanceof ConflictError);
            assert.deepEqual(error.details, { code: ACADEMIC_PROFILE_INSTITUTION_CHANGED, revision: 3 });
            return true;
        },
    );
    assert.equal(state.writes.length, 1);
    assert.equal(state.profile?.['revision'], 3);
    assert.equal(state.profile?.['canonical_institution_id'], UNIVERSITY_ID);
    assert.equal(state.profile?.['programme_state'], 'unanswered');
    assert.equal(state.profile?.['programme_id'], null);
    assert.equal(state.profile?.['entry_year'], null);
    assert.equal(state.profile?.['entry_route_state'], 'unanswered');

    const retry = await saveAcademicProfile(
        createFakePool(state) as never,
        USER_ID,
        { expectedRevision: 3, entryRoute: { state: 'supplied', value: 'utme' } },
        serviceDeps(),
    );
    assert.equal(retry.revision, 4);
    assert.deepEqual(retry.fields.entryRoute, { state: 'supplied', value: 'utme' });
});

test('save previews unbound estimates under the claimed country', async () => {
    const countryAwareReference: AcademicProgrammeReference = {
        sourceVersion: 'TEST-REF-v1',
        findProgrammeLabel: () => null,
        findReviewedRule: (programmeId, route, expectedCountryCode) => {
            if (expectedCountryCode !== undefined && expectedCountryCode !== 'NG') return null;
            return reviewedReference.findReviewedRule(programmeId, route);
        },
    };
    const inputs = {
        expectedRevision: 0,
        programme: { state: 'supplied', value: { programmeId: 'P-001', courseLabel: null } },
        entryYear: { state: 'supplied', value: 2022 },
        entryRoute: { state: 'supplied', value: 'utme' },
    } as const;
    const mismatched = await saveAcademicProfile(
        createFakePool(fakeState()) as never,
        USER_ID,
        { ...inputs, claimedInstitution: { state: 'supplied', value: { name: 'Other School', countryCode: 'GH' } } },
        serviceDeps({ reference: countryAwareReference }),
    );
    assert.equal(mismatched.estimate, null);
    const matched = await saveAcademicProfile(
        createFakePool(fakeState()) as never,
        USER_ID,
        { ...inputs, claimedInstitution: { state: 'supplied', value: { name: 'Example University', countryCode: 'NG' } } },
        serviceDeps({ reference: countryAwareReference }),
    );
    assert.deepEqual(matched.estimate, { year: 2026, ruleId: 'P-001:utme', sourceVersion: 'TEST-REF-v1' });
});

test('save conflicts when the claimed school moves under carried catalogue answers', async () => {
    const state = fakeState({
        profile: profileRow({
            revision: 1,
            claimed_institution_state: 'supplied',
            claimed_institution_name: 'Old School',
            claimed_institution_country: 'NG',
            programme_state: 'supplied',
            programme_id: 'P-001',
            entry_year_state: 'supplied',
            entry_year: 2022,
            entry_route_state: 'supplied',
            entry_route: 'utme',
        }),
    });
    await assert.rejects(
        saveAcademicProfile(
            createFakePool(state) as never,
            USER_ID,
            { expectedRevision: 1, claimedInstitution: { state: 'supplied', value: { name: 'New School', countryCode: 'GH' } } },
            serviceDeps(),
        ),
        (error: unknown) => {
            assert.ok(error instanceof ConflictError);
            assert.deepEqual(error.details, { code: ACADEMIC_PROFILE_CLAIM_CHANGED, revision: 1 });
            return true;
        },
    );
    assert.equal(state.writes.length, 0);
    assert.equal(state.profile?.['revision'], 1);
    assert.equal(state.profile?.['claimed_institution_country'], 'NG');

    const retry = await saveAcademicProfile(
        createFakePool(state) as never,
        USER_ID,
        {
            expectedRevision: 1,
            claimedInstitution: { state: 'supplied', value: { name: 'New School', countryCode: 'GH' } },
            programme: { state: 'supplied', value: { programmeId: 'P-001', courseLabel: null } },
            entryYear: { state: 'supplied', value: 2022 },
            entryRoute: { state: 'supplied', value: 'utme' },
        },
        serviceDeps(),
    );
    assert.equal(retry.revision, 2);
    assert.deepEqual(retry.fields.claimedInstitution, { state: 'supplied', value: { name: 'New School', countryCode: 'GH' } });
});

test('save conflicts when a school is first claimed above a carried calculated estimate', async () => {
    const state = fakeState({
        profile: profileRow({
            revision: 1,
            programme_state: 'supplied',
            programme_id: 'P-001',
            entry_year_state: 'supplied',
            entry_year: 2022,
            entry_route_state: 'supplied',
            entry_route: 'utme',
            expected_graduation_year_state: 'supplied',
            expected_graduation_year: 2026,
            graduation_year_origin: 'calculated',
            estimate_basis_programme_id: 'P-001',
            estimate_basis_entry_year: 2022,
            estimate_basis_entry_route: 'utme',
            estimate_basis_rule_id: 'P-001:utme',
            estimate_basis_source_version: 'TEST-REF-v1',
        }),
    });
    await assert.rejects(
        saveAcademicProfile(
            createFakePool(state) as never,
            USER_ID,
            { expectedRevision: 1, claimedInstitution: { state: 'supplied', value: { name: 'New School', countryCode: 'GH' } } },
            serviceDeps(),
        ),
        (error: unknown) => {
            assert.ok(error instanceof ConflictError);
            assert.deepEqual(error.details, { code: ACADEMIC_PROFILE_CLAIM_CHANGED, revision: 1 });
            return true;
        },
    );
    assert.equal(state.writes.length, 0);

    const retry = await saveAcademicProfile(
        createFakePool(state) as never,
        USER_ID,
        {
            expectedRevision: 1,
            claimedInstitution: { state: 'supplied', value: { name: 'New School', countryCode: 'GH' } },
            programme: { state: 'supplied', value: { programmeId: 'P-001', courseLabel: null } },
            entryYear: { state: 'supplied', value: 2022 },
            entryRoute: { state: 'supplied', value: 'utme' },
            expectedGraduationYear: { state: 'unanswered' },
        },
        serviceDeps(),
    );
    assert.equal(retry.revision, 2);
    assert.equal(retry.fields.graduationYearOrigin, null);
});

test('save conflicts on claim renames and clears above carried answers', async () => {
    const carried = {
        revision: 1,
        claimed_institution_state: 'supplied',
        claimed_institution_name: 'Old School',
        claimed_institution_country: 'NG',
        programme_state: 'supplied',
        programme_id: 'P-001',
    };
    for (const claimedInstitution of [
        { state: 'supplied', value: { name: 'Renamed School', countryCode: 'NG' } },
        { state: 'unanswered' },
        { state: 'unknown' },
    ] as const) {
        const state = fakeState({ profile: profileRow({ ...carried }) });
        await assert.rejects(
            saveAcademicProfile(
                createFakePool(state) as never,
                USER_ID,
                { expectedRevision: 1, claimedInstitution },
                serviceDeps(),
            ),
            (error: unknown) => {
                assert.ok(error instanceof ConflictError);
                assert.deepEqual(error.details, { code: ACADEMIC_PROFILE_CLAIM_CHANGED, revision: 1 });
                return true;
            },
        );
        assert.equal(state.writes.length, 0);
    }
});

test('save allows claim changes that carry no supplied school answers', async () => {
    const claimOnly = await saveAcademicProfile(
        createFakePool(fakeState({
            profile: profileRow({
                revision: 1,
                claimed_institution_state: 'supplied',
                claimed_institution_name: 'Old School',
                claimed_institution_country: 'NG',
                entry_year_state: 'unknown',
            }),
        })) as never,
        USER_ID,
        { expectedRevision: 1, claimedInstitution: { state: 'supplied', value: { name: 'New School', countryCode: 'GH' } } },
        serviceDeps(),
    );
    assert.equal(claimOnly.revision, 2);

    const cleared = await saveAcademicProfile(
        createFakePool(fakeState({
            profile: profileRow({
                revision: 1,
                claimed_institution_state: 'supplied',
                claimed_institution_name: 'Old School',
                claimed_institution_country: 'NG',
            }),
        })) as never,
        USER_ID,
        { expectedRevision: 1, claimedInstitution: { state: 'unanswered' } },
        serviceDeps(),
    );
    assert.equal(cleared.revision, 2);
});

test('save preserves values across identity-version changes without touching identity', async () => {
    const state = boundState({
        profile: profileRow({
            revision: 1,
            canonical_institution_id: UNIVERSITY_ID,
            observed_identity_version: 1,
            entry_year_state: 'supplied',
            entry_year: 2022,
        }),
    });
    state.student = { id: STUDENT_ID, university_id: UNIVERSITY_ID, identity_version: 2, status: 'active' };
    const projection = await saveAcademicProfile(
        createFakePool(state) as never,
        USER_ID,
        { expectedRevision: 1, entryRoute: { state: 'supplied', value: 'utme' } },
        serviceDeps(),
    );
    assert.equal(projection.revision, 2);
    assert.deepEqual(projection.fields.entryYear, { state: 'supplied', value: 2022 });
    assert.equal(state.profile?.['observed_identity_version'], 2);
});

test('save succeeds when assurance is unavailable and reports it explicitly', async () => {
    const state = fakeState();
    const projection = await saveAcademicProfile(
        createFakePool(state) as never,
        USER_ID,
        { expectedRevision: 0, entryRoute: { state: 'skipped' } },
        serviceDeps({ readAssurance: async () => { throw new Error('assurance down'); } }),
    );
    assert.equal(projection.revision, 1);
    assert.equal(projection.assuranceState, 'unavailable');
    assert.equal(projection.assurance, null);
});

test('save surfaces the available estimate for reviewed inputs', async () => {
    const state = fakeState();
    const projection = await saveAcademicProfile(
        createFakePool(state) as never,
        USER_ID,
        {
            expectedRevision: 0,
            programme: { state: 'supplied', value: { programmeId: 'P-001', courseLabel: null } },
            entryYear: { state: 'supplied', value: 2022 },
            entryRoute: { state: 'supplied', value: 'utme' },
        },
        serviceDeps({ reference: reviewedReference }),
    );
    assert.deepEqual(projection.estimate, { year: 2026, ruleId: 'P-001:utme', sourceVersion: 'TEST-REF-v1' });
    assert.deepEqual(projection.fields.expectedGraduationYear, { state: 'unanswered' });
});

test('save hides free-text programmes from estimates', async () => {
    const state = fakeState();
    const projection = await saveAcademicProfile(
        createFakePool(state) as never,
        USER_ID,
        {
            expectedRevision: 0,
            programme: { state: 'supplied', value: { programmeId: null, courseLabel: 'Custom Course' } },
            entryYear: { state: 'supplied', value: 2022 },
            entryRoute: { state: 'supplied', value: 'utme' },
        },
        serviceDeps({ reference: reviewedReference }),
    );
    assert.equal(projection.estimate, null);
});

test('feature-off writes are rejected before any database access', async () => {
    const state = fakeState();
    const pool = createFakePool(state);
    await assert.rejects(
        saveAcademicProfile(pool as never, USER_ID, { expectedRevision: 0 }, serviceDeps({ featureEnabled: false })),
        ForbiddenError,
    );
    assert.deepEqual(state.readUserIds, []);
    assert.equal(state.writes.length, 0);
});

test('feature-off reads stay available without estimates or prompts', async () => {
    const state = fakeState({
        profile: profileRow({
            programme_state: 'supplied',
            programme_id: 'P-001',
            entry_year_state: 'supplied',
            entry_year: 2022,
            entry_route_state: 'supplied',
            entry_route: 'utme',
        }),
    });
    const projection = await readAcademicProfile(
        createFakePool(state) as never,
        USER_ID,
        serviceDeps({ featureEnabled: false, reference: reviewedReference }),
    );
    assert.equal(projection.featureEnabled, false);
    assert.equal(projection.estimate, null);
    assert.equal(projection.promptDecision, 'continue');
    assert.deepEqual(projection.fields.programme, { state: 'supplied', value: { programmeId: 'P-001', courseLabel: null } });
});

test('feature defaults to disabled when the environment leaves the flag unset', async () => {
    const state = fakeState();
    await assert.rejects(
        saveAcademicProfile(createFakePool(state) as never, USER_ID, { expectedRevision: 0 }, serviceDeps({ featureEnabled: undefined })),
        ForbiddenError,
    );
});

test('suspended students keep read access but cannot save', async () => {
    const state = fakeState();
    state.student = { id: STUDENT_ID, university_id: null, identity_version: 1, status: 'suspended' };
    const projection = await readAcademicProfile(createFakePool(state) as never, USER_ID, serviceDeps());
    assert.equal(projection.revision, 0);
    await assert.rejects(
        saveAcademicProfile(createFakePool(state) as never, USER_ID, { expectedRevision: 0 }, serviceDeps()),
        ForbiddenError,
    );
});

test('non-student roles and deleted students are denied', async () => {
    const vendor = fakeState();
    vendor.user = { id: USER_ID, email: 'vendor@example.invalid', role: 'vendor', deleted_at: null };
    await assert.rejects(readAcademicProfile(createFakePool(vendor) as never, USER_ID, serviceDeps()), ForbiddenError);
    await assert.rejects(
        saveAcademicProfile(createFakePool(vendor) as never, USER_ID, { expectedRevision: 0 }, serviceDeps()),
        ForbiddenError,
    );
    const deletedStudent = fakeState();
    deletedStudent.student = { id: STUDENT_ID, university_id: null, identity_version: 1, status: 'deleted' };
    await assert.rejects(readAcademicProfile(createFakePool(deletedStudent) as never, USER_ID, serviceDeps()), NotFoundError);
});

test('purge deletes the academic row and reports whether anything was removed', async () => {
    const state = fakeState({ profile: profileRow() });
    const pool = createFakePool(state);
    const client = (await pool.connect()) as { query: (text: string, params?: unknown[]) => Promise<unknown> };
    const first = await purgeAcademicProfileForUser(client as never, USER_ID);
    assert.deepEqual(first, { deleted: true });
    assert.equal(state.profile, null);
    const second = await purgeAcademicProfileForUser(client as never, USER_ID);
    assert.deepEqual(second, { deleted: false });
});
