/**
 * Academic Profile Service
 *
 * Isolated student-owned academic details with optimistic versioning. Reads
 * and writes lock the active user/student/university rows directly (never via
 * `lockStudentContext`, which rejects null-canonical-institution students) and
 * recheck context plus profile revision inside one transaction, so an
 * institution switch racing a save yields a reconfirmation conflict instead of
 * committing obsolete school data. Academic edits never touch canonical
 * identity fields or eligibility evidence.
 */

import { readFileSync } from 'node:fs';
import type { Pool, PoolClient } from 'pg';
import { config } from '../../config/env.js';
import {
    BadRequestError,
    ConflictError,
    ForbiddenError,
    InternalServerError,
    NotFoundError,
} from '../../common/errors/AppError.js';
import { readStudentAssurance } from '../verification/student-assurance.service.js';
import type { StudentAssurance } from '../verification/student-assurance.types.js';
import {
    getAvailableVerificationMethods,
    type VerificationMethodInfo,
} from '../verification/verification-orchestrator.service.js';
import {
    ACADEMIC_FIELDS,
    ENTRY_YEAR_MIN,
    GRADUATION_HORIZON_YEARS,
    academicProfileInputSchema,
    type AcademicField,
    type AcademicProfileFields,
    type AcademicProfileInstitution,
    type AcademicProfileProjection,
    type EntryRoute,
    type ParsedAcademicProfileInput,
    type ProfileFieldState,
    type PurgeResult,
    type VerificationRequirement,
} from './academic-profile.types.js';

export const ACADEMIC_PROFILE_REVISION_CONFLICT = 'ACADEMIC_PROFILE_REVISION_CONFLICT';
export const ACADEMIC_PROFILE_INSTITUTION_CHANGED = 'ACADEMIC_PROFILE_INSTITUTION_CHANGED';

const ESTIMABLE_ROUTES: readonly string[] = ['utme', 'de_200', 'de_300'];
const MAX_DURATION_YEARS = 20;

export type ReviewedRouteRule = { durationYears: number; ruleId: string; sourceVersion: string };

export type AcademicProgrammeReference = {
    sourceVersion: string | null;
    findReviewedRule: (programmeId: string, route: string) => ReviewedRouteRule | null;
};

type ReferenceArtifactProgramme = { programmeId: unknown; routes: unknown };
type ReferenceArtifactRoute = { durationYears: unknown; reviewed: unknown; applicable: unknown; estimable: unknown };

function ruleFromArtifact(
    programmes: ReferenceArtifactProgramme[],
    sourceVersion: string,
    programmeId: string,
    route: string,
): ReviewedRouteRule | null {
    if (!ESTIMABLE_ROUTES.includes(route)) return null;
    const programme = programmes.find((candidate) => candidate.programmeId === programmeId);
    if (!programme || typeof programme.routes !== 'object' || programme.routes === null) return null;
    const rule = (programme.routes as Record<string, unknown>)[route] as ReferenceArtifactRoute | undefined;
    if (!rule || typeof rule !== 'object') return null;
    // Fail closed: require the builder's explicit estimable flag plus every
    // input behind it. Imported labels and bare numbers are never approval.
    if (rule.estimable !== true || rule.reviewed !== true || rule.applicable !== true) return null;
    if (typeof rule.durationYears !== 'number' || !Number.isInteger(rule.durationYears)
        || rule.durationYears < 1 || rule.durationYears > MAX_DURATION_YEARS) return null;
    return { durationYears: rule.durationYears, ruleId: `${programmeId}:${route}`, sourceVersion };
}

/**
 * Minimal reviewed-reference reader over the Task 1 normalized artifact. Any
 * load, shape, or redistribution problem fails closed to "no estimable rule"
 * while still reporting the artifact's source version for display.
 */
export function loadAcademicProgrammeReference(): AcademicProgrammeReference {
    try {
        const raw = readFileSync(
            new URL('../../data/academic-programmes/nuc-v2.normalized.json', import.meta.url),
            'utf8',
        );
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) {
            return { sourceVersion: null, findReviewedRule: () => null };
        }
        const artifact = parsed as { calculationsEnabled?: unknown; sourceVersion?: unknown; programmes?: unknown };
        const sourceVersion = typeof artifact.sourceVersion === 'string' && artifact.sourceVersion.length > 0
            ? artifact.sourceVersion
            : null;
        if (artifact.calculationsEnabled !== true || !Array.isArray(artifact.programmes) || sourceVersion === null) {
            return { sourceVersion, findReviewedRule: () => null };
        }
        const programmes = artifact.programmes as ReferenceArtifactProgramme[];
        return {
            sourceVersion,
            findReviewedRule: (programmeId, route) => ruleFromArtifact(programmes, sourceVersion, programmeId, route),
        };
    } catch {
        return { sourceVersion: null, findReviewedRule: () => null };
    }
}

/**
 * Collection gate. The feature flag alone is not enough: an unset (or
 * invalid) approved retention window keeps collection disabled and makes the
 * purge command refuse to run. Reads of existing own-profile data and
 * authorized purge stay available while disabled.
 */
export function isAcademicProfileCollectionEnabled(input: { enabled: boolean; retentionDays: number | null }): boolean {
    return input.enabled === true
        && typeof input.retentionDays === 'number'
        && Number.isInteger(input.retentionDays)
        && input.retentionDays > 0;
}

export type StoredAcademicProfile = {
    revision: number;
    canonicalInstitutionId: string | null;
    observedIdentityVersion: number;
    fields: AcademicProfileFields;
};

export type AcademicProfileRow = {
    user_id: string;
    student_id: string;
    canonical_institution_id: string | null;
    observed_identity_version: number;
    revision: number;
    claimed_institution_state: string;
    claimed_institution_name: string | null;
    claimed_institution_country: string | null;
    programme_state: string;
    programme_id: string | null;
    course_label: string | null;
    entry_year_state: string;
    entry_year: number | null;
    entry_route_state: string;
    entry_route: string | null;
    expected_graduation_year_state: string;
    expected_graduation_year: number | null;
    graduation_year_origin: string | null;
    estimate_basis_programme_id: string | null;
    estimate_basis_entry_year: number | null;
    estimate_basis_entry_route: string | null;
    estimate_basis_rule_id: string | null;
    estimate_basis_source_version: string | null;
    estimate_stale: boolean;
};

function asFieldState(value: unknown): ProfileFieldState {
    if (value === 'unanswered' || value === 'supplied' || value === 'unknown' || value === 'skipped') return value;
    throw new InternalServerError('Academic profile row carries an unknown field state');
}

function asEntryRoute(value: unknown): EntryRoute {
    if (value === 'utme' || value === 'de_200' || value === 'de_300' || value === 'transfer_other') return value;
    throw new InternalServerError('Academic profile row carries an unknown entry route');
}

function emptyFields(): AcademicProfileFields {
    return {
        claimedInstitution: { state: 'unanswered' },
        programme: { state: 'unanswered' },
        entryYear: { state: 'unanswered' },
        entryRoute: { state: 'unanswered' },
        expectedGraduationYear: { state: 'unanswered' },
        graduationYearOrigin: null,
        estimateBasis: null,
        estimateStale: false,
    };
}

function rowToStoredProfile(row: AcademicProfileRow): StoredAcademicProfile {
    const claimedState = asFieldState(row.claimed_institution_state);
    const programmeState = asFieldState(row.programme_state);
    const entryYearState = asFieldState(row.entry_year_state);
    const entryRouteState = asFieldState(row.entry_route_state);
    const graduationState = asFieldState(row.expected_graduation_year_state);
    const origin = row.graduation_year_origin === null
        || row.graduation_year_origin === 'calculated'
        || row.graduation_year_origin === 'self_reported'
        ? row.graduation_year_origin
        : (() => { throw new InternalServerError('Academic profile row carries an unknown graduation origin'); })();
    return {
        revision: row.revision,
        canonicalInstitutionId: row.canonical_institution_id,
        observedIdentityVersion: row.observed_identity_version,
        fields: {
            claimedInstitution: claimedState === 'supplied'
                ? {
                    state: 'supplied',
                    value: {
                        name: row.claimed_institution_name ?? '',
                        countryCode: row.claimed_institution_country ?? '',
                    },
                }
                : { state: claimedState },
            programme: programmeState === 'supplied'
                ? {
                    state: 'supplied',
                    value: row.programme_id !== null
                        ? { programmeId: row.programme_id, courseLabel: null }
                        : { programmeId: null, courseLabel: row.course_label ?? '' },
                }
                : { state: programmeState },
            entryYear: entryYearState === 'supplied'
                ? { state: 'supplied', value: row.entry_year ?? ENTRY_YEAR_MIN }
                : { state: entryYearState },
            entryRoute: entryRouteState === 'supplied'
                ? { state: 'supplied', value: asEntryRoute(row.entry_route) }
                : { state: entryRouteState },
            expectedGraduationYear: graduationState === 'supplied'
                ? { state: 'supplied', value: row.expected_graduation_year ?? ENTRY_YEAR_MIN }
                : { state: graduationState },
            graduationYearOrigin: origin,
            estimateBasis: origin === 'calculated'
                ? {
                    programmeId: row.estimate_basis_programme_id ?? '',
                    entryYear: row.estimate_basis_entry_year ?? ENTRY_YEAR_MIN,
                    entryRoute: asEntryRoute(row.estimate_basis_entry_route),
                    ruleId: row.estimate_basis_rule_id ?? '',
                    sourceVersion: row.estimate_basis_source_version ?? '',
                }
                : null,
            estimateStale: row.estimate_stale,
        },
    };
}

function storedOrEmpty(row: AcademicProfileRow | null): StoredAcademicProfile {
    if (!row) {
        return { revision: 0, canonicalInstitutionId: null, observedIdentityVersion: 1, fields: emptyFields() };
    }
    return rowToStoredProfile(row);
}

export function estimateFromFields(
    fields: AcademicProfileFields,
    reference: AcademicProgrammeReference,
): { year: number; ruleId: string; sourceVersion: string } | null {
    if (fields.programme.state !== 'supplied' || fields.programme.value.programmeId === null) return null;
    if (fields.entryYear.state !== 'supplied' || fields.entryRoute.state !== 'supplied') return null;
    if (fields.entryYear.value < ENTRY_YEAR_MIN) return null;
    const rule = reference.findReviewedRule(fields.programme.value.programmeId, fields.entryRoute.value);
    if (!rule) return null;
    return { year: fields.entryYear.value + rule.durationYears, ruleId: rule.ruleId, sourceVersion: rule.sourceVersion };
}

export function isEstimateStale(fields: AcademicProfileFields, currentSourceVersion: string | null): boolean {
    if (fields.graduationYearOrigin !== 'calculated' || !fields.estimateBasis) return false;
    if (fields.estimateStale) return true;
    const basis = fields.estimateBasis;
    if (fields.programme.state !== 'supplied' || fields.programme.value.programmeId !== basis.programmeId) return true;
    if (fields.entryYear.state !== 'supplied' || fields.entryYear.value !== basis.entryYear) return true;
    if (fields.entryRoute.state !== 'supplied' || fields.entryRoute.value !== basis.entryRoute) return true;
    if (currentSourceVersion !== null && basis.sourceVersion !== currentSourceVersion) return true;
    return false;
}

export function computeOptionalUnansweredFields(
    fields: AcademicProfileFields,
    binding: AcademicProfileInstitution['binding'],
): AcademicField[] {
    return ACADEMIC_FIELDS.filter((field) => {
        if (field === 'claimedInstitution' && binding === 'server_bound') return false;
        return fields[field].state === 'unanswered';
    });
}

export function computeAttentionFields(input: {
    fields: AcademicProfileFields;
    binding: AcademicProfileInstitution['binding'];
    currentSourceVersion: string | null;
}): AcademicField[] {
    const unanswered = computeOptionalUnansweredFields(input.fields, input.binding);
    if (input.fields.expectedGraduationYear.state === 'supplied'
        && isEstimateStale(input.fields, input.currentSourceVersion)
        && !unanswered.includes('expectedGraduationYear')) {
        return [...unanswered, 'expectedGraduationYear'];
    }
    return unanswered;
}

export function computePromptDecision(input: {
    featureEnabled: boolean;
    assuranceState: 'available' | 'unavailable';
    assurance: StudentAssurance | null;
    attentionFields: AcademicField[];
    verificationContinuationAvailable: boolean;
}): 'complete_profile' | 'continue' {
    if (!input.featureEnabled) return 'continue';
    if (input.assuranceState !== 'available' || !input.assurance) return 'continue';
    if (input.assurance.studentStatus !== 'pending') return 'continue';
    if (input.attentionFields.length === 0) return 'continue';
    if (input.verificationContinuationAvailable) return 'continue';
    return 'complete_profile';
}

function inputsChanged(previous: AcademicProfileFields, next: AcademicProfileFields): boolean {
    const programmeBefore = previous.programme.state === 'supplied' ? previous.programme.value : null;
    const programmeAfter = next.programme.state === 'supplied' ? next.programme.value : null;
    if (JSON.stringify(programmeBefore) !== JSON.stringify(programmeAfter)) return true;
    const entryYearBefore = previous.entryYear.state === 'supplied' ? previous.entryYear.value : previous.entryYear.state;
    const entryYearAfter = next.entryYear.state === 'supplied' ? next.entryYear.value : next.entryYear.state;
    if (entryYearBefore !== entryYearAfter) return true;
    const entryRouteBefore = previous.entryRoute.state === 'supplied' ? previous.entryRoute.value : previous.entryRoute.state;
    const entryRouteAfter = next.entryRoute.state === 'supplied' ? next.entryRoute.value : next.entryRoute.state;
    return entryRouteBefore !== entryRouteAfter;
}

/**
 * Merge a validated patch onto the locked stored profile. Omitted fields stay
 * unchanged; explicit `unanswered` clears; `unknown`/`skipped` persist as
 * distinct answers. Accepted estimates are recomputed from the merged inputs
 * against the current reviewed reference; the browser cannot set origin, rule,
 * or provenance. Throws BadRequestError on semantic violations.
 */
export function validateAndMergePatch(input: {
    stored: StoredAcademicProfile;
    patch: ParsedAcademicProfileInput;
    serverBound: boolean;
    reference: AcademicProgrammeReference;
    currentYear: number;
}): AcademicProfileFields {
    const { stored, patch, serverBound, reference, currentYear } = input;
    const merged: AcademicProfileFields = {
        claimedInstitution: stored.fields.claimedInstitution,
        programme: stored.fields.programme,
        entryYear: stored.fields.entryYear,
        entryRoute: stored.fields.entryRoute,
        expectedGraduationYear: stored.fields.expectedGraduationYear,
        graduationYearOrigin: stored.fields.graduationYearOrigin,
        estimateBasis: stored.fields.estimateBasis,
        estimateStale: stored.fields.estimateStale,
    };
    if (patch.claimedInstitution !== undefined) {
        if (serverBound) {
            throw new BadRequestError('Institution is managed by the bound school and cannot be replaced here');
        }
        merged.claimedInstitution = patch.claimedInstitution.state === 'supplied'
            ? { state: 'supplied', value: patch.claimedInstitution.value }
            : { state: patch.claimedInstitution.state };
    }
    if (patch.programme !== undefined) {
        merged.programme = patch.programme.state === 'supplied'
            ? { state: 'supplied', value: patch.programme.value }
            : { state: patch.programme.state };
    }
    if (patch.entryYear !== undefined) {
        if (patch.entryYear.state === 'supplied'
            && (patch.entryYear.value < ENTRY_YEAR_MIN || patch.entryYear.value > currentYear)) {
            throw new BadRequestError(`Entry year must be between ${ENTRY_YEAR_MIN} and the current year`);
        }
        merged.entryYear = patch.entryYear.state === 'supplied'
            ? { state: 'supplied', value: patch.entryYear.value }
            : { state: patch.entryYear.state };
    }
    if (patch.entryRoute !== undefined) {
        merged.entryRoute = patch.entryRoute.state === 'supplied'
            ? { state: 'supplied', value: patch.entryRoute.value }
            : { state: patch.entryRoute.state };
    }
    const estimateInputsChanged = inputsChanged(stored.fields, merged);
    if (patch.expectedGraduationYear !== undefined) {
        const update = patch.expectedGraduationYear;
        if (update.state !== 'supplied') {
            merged.expectedGraduationYear = { state: update.state };
            merged.graduationYearOrigin = null;
            merged.estimateBasis = null;
            merged.estimateStale = false;
        } else if (update.value.kind === 'self_reported') {
            const entryYear = merged.entryYear.state === 'supplied' ? merged.entryYear.value : ENTRY_YEAR_MIN;
            if (update.value.year < entryYear || update.value.year > currentYear + GRADUATION_HORIZON_YEARS) {
                throw new BadRequestError('Self-reported graduation year is outside the plausible range for the entry year');
            }
            merged.expectedGraduationYear = { state: 'supplied', value: update.value.year };
            merged.graduationYearOrigin = 'self_reported';
            merged.estimateBasis = null;
            merged.estimateStale = false;
        } else {
            const estimate = estimateFromFields(merged, reference);
            if (!estimate) {
                throw new BadRequestError('No reviewed graduation estimate is available for these entries');
            }
            if (update.value.year !== estimate.year) {
                throw new BadRequestError('Submitted graduation year does not match the current reviewed estimate');
            }
            if (merged.programme.state !== 'supplied' || merged.programme.value.programmeId === null
                || merged.entryYear.state !== 'supplied' || merged.entryRoute.state !== 'supplied') {
                throw new BadRequestError('No reviewed graduation estimate is available for these entries');
            }
            merged.expectedGraduationYear = { state: 'supplied', value: estimate.year };
            merged.graduationYearOrigin = 'calculated';
            merged.estimateBasis = {
                programmeId: merged.programme.value.programmeId,
                entryYear: merged.entryYear.value,
                entryRoute: merged.entryRoute.value,
                ruleId: estimate.ruleId,
                sourceVersion: estimate.sourceVersion,
            };
            merged.estimateStale = false;
        }
    } else if (estimateInputsChanged && merged.graduationYearOrigin === 'calculated') {
        merged.estimateStale = true;
    }
    if (merged.graduationYearOrigin === 'calculated' && merged.estimateBasis
        && reference.sourceVersion !== null && merged.estimateBasis.sourceVersion !== reference.sourceVersion) {
        merged.estimateStale = true;
    }
    return merged;
}

/** Withhold institution-scoped values that can no longer satisfy the current binding. */
function scopedUnanswered(fields: AcademicProfileFields): AcademicProfileFields {
    return {
        ...fields,
        claimedInstitution: { state: 'unanswered' },
        programme: { state: 'unanswered' },
        entryYear: { state: 'unanswered' },
        entryRoute: { state: 'unanswered' },
        expectedGraduationYear: { state: 'unanswered' },
        graduationYearOrigin: null,
        estimateBasis: null,
        estimateStale: false,
    };
}

export type AcademicProfileDeps = {
    featureEnabled?: boolean;
    reference?: AcademicProgrammeReference;
    now?: Date;
    readAssurance?: (tx: PoolClient, userId: string) => Promise<StudentAssurance>;
    listVerificationMethods?: (universityId: string | null) => Promise<VerificationMethodInfo[]>;
};

type AcademicProfileContext = {
    userId: string;
    studentId: string;
    universityId: string | null;
    identityVersion: number;
    universityName: string | null;
};

async function defaultReadAssurance(tx: PoolClient, userId: string): Promise<StudentAssurance> {
    return readStudentAssurance(tx, userId);
}

async function defaultListVerificationMethods(universityId: string | null): Promise<VerificationMethodInfo[]> {
    if (universityId === null) return [];
    return getAvailableVerificationMethods(universityId);
}

function resolveDeps(deps: AcademicProfileDeps): {
    featureEnabled: boolean;
    reference: AcademicProgrammeReference;
    readAssurance: (tx: PoolClient, userId: string) => Promise<StudentAssurance>;
    listVerificationMethods: (universityId: string | null) => Promise<VerificationMethodInfo[]>;
} {
    return {
        featureEnabled: deps.featureEnabled ?? isAcademicProfileCollectionEnabled(config.academicProfile),
        reference: deps.reference ?? loadAcademicProgrammeReference(),
        readAssurance: deps.readAssurance ?? defaultReadAssurance,
        listVerificationMethods: deps.listVerificationMethods ?? defaultListVerificationMethods,
    };
}

/**
 * Lock the user/student rows (plus the bound university row, when any)
 * directly. Soft-deleted users and deleted student rows project as missing so
 * academic data stays invisible; suspended students keep read access.
 */
async function lockAcademicProfileContext(
    tx: PoolClient,
    userId: string,
    mode: 'read' | 'write',
): Promise<AcademicProfileContext> {
    const userResult = await tx.query<{ id: string; role: string; deleted_at: Date | null }>(
        `SELECT id, role, deleted_at FROM users WHERE id = $1 FOR UPDATE`,
        [userId],
    );
    const user = userResult.rows[0];
    if (!user || user.deleted_at !== null) throw new NotFoundError('Student user not found');
    if (user.role !== 'student') throw new ForbiddenError('Academic profiles are available to student accounts only');
    const studentResult = await tx.query<{ id: string; university_id: string | null; identity_version: number; status: string }>(
        `SELECT id, university_id, identity_version, status FROM students WHERE user_id = $1 FOR UPDATE`,
        [userId],
    );
    const student = studentResult.rows[0];
    if (!student || student.status === 'deleted') throw new NotFoundError('Student profile not found');
    if (mode === 'write' && student.status !== 'active') {
        throw new ForbiddenError('Academic profile cannot be updated while the student account is not active');
    }
    let universityName: string | null = null;
    if (student.university_id !== null) {
        const universityResult = await tx.query<{ id: string; name: string }>(
            `SELECT id, name FROM universities WHERE id = $1 FOR UPDATE`,
            [student.university_id],
        );
        const university = universityResult.rows[0];
        if (!university) throw new NotFoundError('Canonical university not found');
        universityName = university.name;
    }
    return {
        userId: user.id,
        studentId: student.id,
        universityId: student.university_id,
        identityVersion: student.identity_version,
        universityName,
    };
}

const PROFILE_COLUMNS = [
    'user_id',
    'student_id',
    'canonical_institution_id',
    'observed_identity_version',
    'revision',
    'claimed_institution_state',
    'claimed_institution_name',
    'claimed_institution_country',
    'programme_state',
    'programme_id',
    'course_label',
    'entry_year_state',
    'entry_year',
    'entry_route_state',
    'entry_route',
    'expected_graduation_year_state',
    'expected_graduation_year',
    'graduation_year_origin',
    'estimate_basis_programme_id',
    'estimate_basis_entry_year',
    'estimate_basis_entry_route',
    'estimate_basis_rule_id',
    'estimate_basis_source_version',
    'estimate_stale',
].join(', ');

const UPSERT_COLUMNS = [
    'user_id',
    'student_id',
    'canonical_institution_id',
    'observed_identity_version',
    'revision',
    'claimed_institution_state',
    'claimed_institution_name',
    'claimed_institution_country',
    'programme_state',
    'programme_id',
    'course_label',
    'entry_year_state',
    'entry_year',
    'entry_route_state',
    'entry_route',
    'expected_graduation_year_state',
    'expected_graduation_year',
    'graduation_year_origin',
    'estimate_basis_programme_id',
    'estimate_basis_entry_year',
    'estimate_basis_entry_route',
    'estimate_basis_rule_id',
    'estimate_basis_source_version',
    'estimate_stale',
];

function upsertParams(
    ctx: AcademicProfileContext,
    revision: number,
    fields: AcademicProfileFields,
): unknown[] {
    return [
        ctx.userId,
        ctx.studentId,
        ctx.universityId,
        ctx.identityVersion,
        revision,
        fields.claimedInstitution.state,
        fields.claimedInstitution.state === 'supplied' ? fields.claimedInstitution.value.name : null,
        fields.claimedInstitution.state === 'supplied' ? fields.claimedInstitution.value.countryCode : null,
        fields.programme.state,
        fields.programme.state === 'supplied' ? fields.programme.value.programmeId : null,
        fields.programme.state === 'supplied' ? fields.programme.value.courseLabel : null,
        fields.entryYear.state,
        fields.entryYear.state === 'supplied' ? fields.entryYear.value : null,
        fields.entryRoute.state,
        fields.entryRoute.state === 'supplied' ? fields.entryRoute.value : null,
        fields.expectedGraduationYear.state,
        fields.expectedGraduationYear.state === 'supplied' ? fields.expectedGraduationYear.value : null,
        fields.graduationYearOrigin,
        fields.estimateBasis?.programmeId ?? null,
        fields.estimateBasis?.entryYear ?? null,
        fields.estimateBasis?.entryRoute ?? null,
        fields.estimateBasis?.ruleId ?? null,
        fields.estimateBasis?.sourceVersion ?? null,
        fields.estimateStale,
    ];
}

const UPSERT_SQL = `INSERT INTO student_academic_profiles (${UPSERT_COLUMNS.join(', ')}, updated_at)
VALUES (${UPSERT_COLUMNS.map((_, index) => `$${index + 1}`).join(', ')}, clock_timestamp())
ON CONFLICT (user_id) DO UPDATE SET
    student_id = EXCLUDED.student_id,
    canonical_institution_id = EXCLUDED.canonical_institution_id,
    observed_identity_version = EXCLUDED.observed_identity_version,
    revision = EXCLUDED.revision,
    claimed_institution_state = EXCLUDED.claimed_institution_state,
    claimed_institution_name = EXCLUDED.claimed_institution_name,
    claimed_institution_country = EXCLUDED.claimed_institution_country,
    programme_state = EXCLUDED.programme_state,
    programme_id = EXCLUDED.programme_id,
    course_label = EXCLUDED.course_label,
    entry_year_state = EXCLUDED.entry_year_state,
    entry_year = EXCLUDED.entry_year,
    entry_route_state = EXCLUDED.entry_route_state,
    entry_route = EXCLUDED.entry_route,
    expected_graduation_year_state = EXCLUDED.expected_graduation_year_state,
    expected_graduation_year = EXCLUDED.expected_graduation_year,
    graduation_year_origin = EXCLUDED.graduation_year_origin,
    estimate_basis_programme_id = EXCLUDED.estimate_basis_programme_id,
    estimate_basis_entry_year = EXCLUDED.estimate_basis_entry_year,
    estimate_basis_entry_route = EXCLUDED.estimate_basis_entry_route,
    estimate_basis_rule_id = EXCLUDED.estimate_basis_rule_id,
    estimate_basis_source_version = EXCLUDED.estimate_basis_source_version,
    estimate_stale = EXCLUDED.estimate_stale,
    updated_at = clock_timestamp()
RETURNING revision`;

const INVALIDATE_SQL = `UPDATE student_academic_profiles
SET canonical_institution_id = $1,
    observed_identity_version = $2,
    claimed_institution_state = 'unanswered',
    claimed_institution_name = NULL,
    claimed_institution_country = NULL,
    programme_state = 'unanswered',
    programme_id = NULL,
    course_label = NULL,
    entry_year_state = 'unanswered',
    entry_year = NULL,
    entry_route_state = 'unanswered',
    entry_route = NULL,
    expected_graduation_year_state = 'unanswered',
    expected_graduation_year = NULL,
    graduation_year_origin = NULL,
    estimate_basis_programme_id = NULL,
    estimate_basis_entry_year = NULL,
    estimate_basis_entry_route = NULL,
    estimate_basis_rule_id = NULL,
    estimate_basis_source_version = NULL,
    estimate_stale = false,
    revision = revision + 1,
    updated_at = clock_timestamp()
WHERE user_id = $3
RETURNING revision`;

async function buildProjection(input: {
    tx: PoolClient;
    userId: string;
    ctx: AcademicProfileContext;
    fields: AcademicProfileFields;
    revision: number;
    reference: AcademicProgrammeReference;
    featureEnabled: boolean;
    readAssurance: (tx: PoolClient, userId: string) => Promise<StudentAssurance>;
    listVerificationMethods: (universityId: string | null) => Promise<VerificationMethodInfo[]>;
}): Promise<AcademicProfileProjection> {
    const { ctx, reference } = input;
    const binding: AcademicProfileInstitution['binding'] = ctx.universityId !== null
        ? 'server_bound'
        : (input.fields.claimedInstitution.state === 'supplied' ? 'student_claimed' : 'unbound');
    const institution: AcademicProfileInstitution = ctx.universityId !== null
        ? { displayName: ctx.universityName, countryCode: null, binding: 'server_bound' }
        : input.fields.claimedInstitution.state === 'supplied'
            ? {
                displayName: input.fields.claimedInstitution.value.name,
                countryCode: input.fields.claimedInstitution.value.countryCode,
                binding: 'student_claimed',
            }
            : { displayName: null, countryCode: null, binding: 'unbound' };
    let assurance: StudentAssurance | null = null;
    let assuranceState: 'available' | 'unavailable' = 'unavailable';
    try {
        assurance = await input.readAssurance(input.tx, input.userId);
        assuranceState = 'available';
    } catch {
        assurance = null;
        assuranceState = 'unavailable';
    }
    let verificationContinuationAvailable: boolean;
    let verificationRequirements: VerificationRequirement[];
    try {
        const methods = await input.listVerificationMethods(ctx.universityId);
        const available = methods.filter((method) => method.isAvailable);
        verificationContinuationAvailable = available.length > 0;
        verificationRequirements = [];
        if (available.some((method) => method.methodType === 'registration')) {
            verificationRequirements.push('registration_number');
        }
        if (verificationContinuationAvailable) verificationRequirements.push('processing_consent');
    } catch {
        // Fail closed: an unknown resolver state must not trigger a profile
        // prompt that could overtake a verification continuation.
        verificationContinuationAvailable = true;
        verificationRequirements = [];
    }
    const fields: AcademicProfileFields = { ...input.fields, estimateStale: isEstimateStale(input.fields, reference.sourceVersion) };
    const optionalUnansweredFields = computeOptionalUnansweredFields(fields, binding);
    const attentionFields = computeAttentionFields({ fields, binding, currentSourceVersion: reference.sourceVersion });
    const estimate = input.featureEnabled ? estimateFromFields(fields, reference) : null;
    return {
        revision: input.revision,
        fields,
        institution,
        institutionConfirmedGraduationYear: null,
        entryYearSuggestion: null,
        optionalUnansweredFields,
        attentionFields,
        verificationRequirements,
        verificationContinuationAvailable,
        assuranceState,
        assurance,
        referenceVersion: reference.sourceVersion,
        estimate,
        featureEnabled: input.featureEnabled,
        promptDecision: computePromptDecision({
            featureEnabled: input.featureEnabled,
            assuranceState,
            assurance,
            attentionFields,
            verificationContinuationAvailable,
        }),
    };
}

export async function readAcademicProfile(
    pool: Pick<Pool, 'connect'>,
    userId: string,
    deps: AcademicProfileDeps = {},
): Promise<AcademicProfileProjection> {
    const resolved = resolveDeps(deps);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const ctx = await lockAcademicProfileContext(client, userId, 'read');
        const rowResult = await client.query<AcademicProfileRow>(
            `SELECT ${PROFILE_COLUMNS} FROM student_academic_profiles WHERE user_id = $1`,
            [userId],
        );
        const row = rowResult.rows[0] ?? null;
        const stored = storedOrEmpty(row);
        const drifted = row !== null && stored.canonicalInstitutionId !== ctx.universityId;
        const fields = drifted ? scopedUnanswered(stored.fields) : stored.fields;
        const projection = await buildProjection({
            tx: client,
            userId,
            ctx,
            fields,
            revision: stored.revision,
            reference: resolved.reference,
            featureEnabled: resolved.featureEnabled,
            readAssurance: resolved.readAssurance,
            listVerificationMethods: resolved.listVerificationMethods,
        });
        await client.query('COMMIT');
        return projection;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

export async function saveAcademicProfile(
    pool: Pick<Pool, 'connect'>,
    userId: string,
    rawInput: unknown,
    deps: AcademicProfileDeps = {},
): Promise<AcademicProfileProjection> {
    const resolved = resolveDeps(deps);
    if (!resolved.featureEnabled) {
        throw new ForbiddenError('Academic profile collection is not currently available');
    }
    const patch = academicProfileInputSchema.parse(rawInput);
    const currentYear = (deps.now ?? new Date()).getUTCFullYear();
    const client = await pool.connect();
    let committed = false;
    try {
        await client.query('BEGIN');
        const ctx = await lockAcademicProfileContext(client, userId, 'write');
        const rowResult = await client.query<AcademicProfileRow>(
            `SELECT ${PROFILE_COLUMNS} FROM student_academic_profiles WHERE user_id = $1 FOR UPDATE`,
            [userId],
        );
        const row = rowResult.rows[0] ?? null;
        const stored = storedOrEmpty(row);
        if (patch.expectedRevision !== stored.revision) {
            throw new ConflictError('Academic profile changed since it was read; reload and retry', {
                code: ACADEMIC_PROFILE_REVISION_CONFLICT,
                revision: stored.revision,
            });
        }
        if (row !== null && stored.canonicalInstitutionId !== ctx.universityId) {
            // The binding moved under this save (or an earlier save raced the
            // institution switch). Commit only the server-driven invalidation
            // so obsolete school data can never persist, then report the
            // reconfirmation conflict with the revision to reload.
            const invalidated = await client.query<{ revision: number }>(
                INVALIDATE_SQL,
                [ctx.universityId, ctx.identityVersion, userId],
            );
            const revision = invalidated.rows[0]?.revision ?? stored.revision + 1;
            await client.query('COMMIT');
            committed = true;
            throw new ConflictError('Institution changed since this profile was saved; reload to reconfirm academic details', {
                code: ACADEMIC_PROFILE_INSTITUTION_CHANGED,
                revision,
            });
        }
        const merged = validateAndMergePatch({
            stored,
            patch,
            serverBound: ctx.universityId !== null,
            reference: resolved.reference,
            currentYear,
        });
        const revision = stored.revision + 1;
        await client.query(UPSERT_SQL, upsertParams(ctx, revision, merged));
        const projection = await buildProjection({
            tx: client,
            userId,
            ctx,
            fields: merged,
            revision,
            reference: resolved.reference,
            featureEnabled: resolved.featureEnabled,
            readAssurance: resolved.readAssurance,
            listVerificationMethods: resolved.listVerificationMethods,
        });
        await client.query('COMMIT');
        committed = true;
        return projection;
    } catch (error) {
        if (!committed) await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Narrow academic-data purge for the authorized erasure path. Available
 * regardless of the collection gate; records only whether a row was removed,
 * never the deleted values.
 */
export async function purgeAcademicProfileForUser(tx: PoolClient, userId: string): Promise<PurgeResult> {
    const deleted = await tx.query(`DELETE FROM student_academic_profiles WHERE user_id = $1`, [userId]);
    return { deleted: (deleted.rowCount ?? 0) > 0 };
}

