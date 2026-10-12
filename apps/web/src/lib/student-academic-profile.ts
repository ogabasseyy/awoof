/**
 * Browser contract for the isolated student academic profile.
 *
 * The server owns canonical bindings, graduation origin, estimate basis, rule
 * references, assurance, and prompting. The browser only submits the narrow
 * `AcademicProfileInput` patch and renders the validated projection. Unknown
 * or malformed data fails safely to null; eligibility-bearing responses are
 * rejected outright because profile answers are never eligibility evidence.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import apiClient from './api-client';
import { getSessionSnapshot, isCurrentSession, subscribeSessionChanges, type SessionSnapshot, type User } from './auth';
import { parseStudentAssurance, type StudentAssurance } from './student-assurance';
import { resolveStudentReturn } from './student-return';

export type AcademicField = 'claimedInstitution' | 'programme' | 'entryYear' | 'entryRoute' | 'expectedGraduationYear';

export const ACADEMIC_FIELDS: readonly AcademicField[] = [
    'claimedInstitution',
    'programme',
    'entryYear',
    'entryRoute',
    'expectedGraduationYear',
];

export type ProfileFieldState = 'unanswered' | 'supplied' | 'unknown' | 'skipped';

export type ProfileField<T> =
    | { state: 'supplied'; value: T }
    | { state: 'unanswered' | 'unknown' | 'skipped' };

export type ClaimedInstitutionValue = { name: string; countryCode: string };

export type ProgrammeSelection =
    | { programmeId: string; courseLabel: null }
    | { programmeId: null; courseLabel: string };

export type EntryRoute = 'utme' | 'de_200' | 'de_300' | 'transfer_other';

export type GraduationYearChoice =
    | { kind: 'accept_estimate'; year: number }
    | { kind: 'self_reported'; year: number };

export type ExpectedReadInstitution = Pick<AcademicProfileInstitution, 'binding' | 'displayName'>;

export type AcademicProfileInput = {
    expectedRevision: number;
    expectedInstitution?: ExpectedReadInstitution;
    claimedInstitution?: ProfileField<ClaimedInstitutionValue>;
    programme?: ProfileField<ProgrammeSelection>;
    entryYear?: ProfileField<number>;
    entryRoute?: ProfileField<EntryRoute>;
    expectedGraduationYear?: ProfileField<GraduationYearChoice>;
};

export type EstimateBasis = {
    programmeId: string;
    entryYear: number;
    entryRoute: EntryRoute;
    ruleId: string;
    sourceVersion: string;
};

export type AcademicProfileFields = {
    claimedInstitution: ProfileField<ClaimedInstitutionValue>;
    programme: ProfileField<ProgrammeSelection>;
    entryYear: ProfileField<number>;
    entryRoute: ProfileField<EntryRoute>;
    expectedGraduationYear: ProfileField<number>;
    graduationYearOrigin: 'calculated' | 'self_reported' | null;
    estimateBasis: EstimateBasis | null;
    estimateStale: boolean;
};

export type AcademicProfileInstitution = {
    displayName: string | null;
    countryCode: string | null;
    binding: 'server_bound' | 'student_claimed' | 'unbound';
};

export type EntryYearSuggestion =
    | { state: 'suggested'; year: number; parserId: string; parserVersion: string; confidence: 'high' | 'medium' | 'low' }
    | { state: 'unavailable'; reason: 'no_registration_number' | 'unsupported_institution' | 'unrecognized_format' | 'ambiguous_format' };

export type VerificationRequirement = 'registration_number' | 'processing_consent';

export type AcademicProfileView = {
    revision: number;
    fields: AcademicProfileFields;
    institution: AcademicProfileInstitution;
    institutionConfirmedGraduationYear: { year: number; observedAt: string } | null;
    entryYearSuggestion: EntryYearSuggestion | null;
    optionalUnansweredFields: AcademicField[];
    attentionFields: AcademicField[];
    verificationRequirements: VerificationRequirement[];
    verificationContinuationAvailable: boolean;
    assuranceState: 'available' | 'unavailable';
    assurance: StudentAssurance | null;
    referenceVersion: string | null;
    estimate: { year: number; ruleId: string; sourceVersion: string } | null;
    programmeLabel: string | null;
    featureEnabled: boolean;
    writeAvailable: boolean;
    promptDecision: 'complete_profile' | 'continue';
};

export type InstitutionCatalogueItem = { name: string; countryCode: string | null };

export type ProgrammeCatalogueItem = { programmeId: string; label: string; award: string | null };

export type CataloguePage<T> = { items: T[]; nextCursor: string | null };

export type CatalogueSearchStatus = 'idle' | 'loading' | 'ready' | 'error';

export type CatalogueSearchSnapshot<T> = {
    items: T[];
    status: CatalogueSearchStatus;
};

/**
 * Pure resolver for key-bound catalogue search settlement: maps a settled
 * fetch outcome to the snapshot to commit (success page to `ready`, a null
 * page to the `error` snapshot), or null when the settling key is
 * superseded — so a stale key can never rewrite the results OR their
 * loading status.
 */
export function resolveCatalogueSearch<T>(input: {
    stale: boolean;
    page: CataloguePage<T> | null;
}): CatalogueSearchSnapshot<T> | null {
    if (input.stale) return null;
    if (input.page === null) return { items: [], status: 'error' };
    return { items: input.page.items, status: 'ready' };
}

export type EstimateInput = {
    programmeId: string | null;
    entryYear: number | null;
    entryRoute: EntryRoute | null;
    claimedCountryCode?: string | null;
};

/**
 * Draft-claim scope for estimate previews: the claimed country when the
 * draft asserts a school, explicit null when the draft removed or marked
 * the claim (previews stop using the stored school, matching the save),
 * undefined when the claim is untouched (the server falls back to the
 * stored claim).
 */
export function draftClaimScopeForEstimate(input: {
    dirty: boolean;
    marked: 'unknown' | 'skipped' | null;
    name: string;
    country: string;
}): string | null | undefined {
    if (!input.dirty) return undefined;
    if (input.marked !== null) return null;
    if (input.name.trim() === '' || !/^[A-Za-z]{2}$/.test(input.country.trim())) return null;
    return input.country.trim().toUpperCase();
}

export type EstimateUnavailableReason =
    | 'missing_input'
    | 'unsupported_country'
    | 'unsupported_route'
    | 'unknown_programme'
    | 'unreviewed_rule'
    | 'conflicting_rule'
    | 'out_of_range';

export type EstimateResult =
    | { state: 'available'; year: number; ruleId: string; sourceVersion: string }
    | { state: 'unavailable'; reason: EstimateUnavailableReason };

/** Draft state for one optional field; `unchanged` omits it from the patch. */
export type FormField<T> = { state: 'unchanged' } | ProfileField<T>;

export type AcademicProfileForm = {
    claimedInstitution: FormField<ClaimedInstitutionValue>;
    programme: FormField<ProgrammeSelection>;
    entryYear: FormField<number>;
    entryRoute: FormField<EntryRoute>;
    expectedGraduationYear: FormField<GraduationYearChoice>;
};

const ENTRY_ROUTES: readonly EntryRoute[] = ['utme', 'de_200', 'de_300', 'transfer_other'];

const ESTIMATE_UNAVAILABLE_REASONS: readonly EstimateUnavailableReason[] = [
    'missing_input',
    'unsupported_country',
    'unsupported_route',
    'unknown_programme',
    'unreviewed_rule',
    'conflicting_rule',
    'out_of_range',
];

/**
 * Keys that must never appear in a student-facing academic projection. Their
 * presence means the response smuggles eligibility or cross-user evidence, so
 * the whole projection is rejected instead of rendered.
 */
const FORBIDDEN_PROJECTION_KEYS: readonly string[] = [
    'eligible',
    'eligibility',
    'studentStatus',
    'verificationStatus',
    'studentId',
    'userId',
    'canonicalInstitutionId',
];

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isInstant(value: unknown): value is string {
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** Unwrap one API `{ success, data }` envelope level when present. */
function unwrapData(value: unknown): unknown {
    const record = asRecord(value);
    if (record && 'data' in record) return record.data;
    return value;
}

function parseField<T>(value: unknown, parseValue: (candidate: unknown) => T | null): ProfileField<T> | null {
    const field = asRecord(value);
    if (!field) return null;
    if (field.state === 'supplied') {
        const parsed = parseValue(field.value);
        return parsed === null ? null : { state: 'supplied', value: parsed };
    }
    if (field.state === 'unanswered' || field.state === 'unknown' || field.state === 'skipped') {
        return { state: field.state };
    }
    return null;
}

function parseClaimedInstitutionValue(value: unknown): ClaimedInstitutionValue | null {
    const candidate = asRecord(value);
    if (!candidate || typeof candidate.name !== 'string' || candidate.name.trim().length === 0) return null;
    if (typeof candidate.countryCode !== 'string' || !/^[A-Za-z]{2}$/.test(candidate.countryCode.trim())) return null;
    return { name: candidate.name, countryCode: candidate.countryCode.trim().toUpperCase() };
}

function parseProgrammeSelection(value: unknown): ProgrammeSelection | null {
    const candidate = asRecord(value);
    if (!candidate) return null;
    if (isNonEmptyString(candidate.programmeId) && candidate.courseLabel === null) {
        return { programmeId: candidate.programmeId, courseLabel: null };
    }
    if (candidate.programmeId === null && typeof candidate.courseLabel === 'string' && candidate.courseLabel.trim().length > 0) {
        return { programmeId: null, courseLabel: candidate.courseLabel };
    }
    return null;
}

function parseYear(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function parseEntryRoute(value: unknown): EntryRoute | null {
    return ENTRY_ROUTES.includes(value as EntryRoute) ? value as EntryRoute : null;
}

function parseEstimateBasis(value: unknown): EstimateBasis | null {
    const candidate = asRecord(value);
    if (!candidate) return null;
    const entryYear = parseYear(candidate.entryYear);
    const entryRoute = parseEntryRoute(candidate.entryRoute);
    if (!isNonEmptyString(candidate.programmeId)
        || entryYear === null
        || entryRoute === null
        || !isNonEmptyString(candidate.ruleId)
        || !isNonEmptyString(candidate.sourceVersion)) return null;
    return {
        programmeId: candidate.programmeId,
        entryYear,
        entryRoute,
        ruleId: candidate.ruleId,
        sourceVersion: candidate.sourceVersion,
    };
}

function parseFields(value: unknown): AcademicProfileFields | null {
    const fields = asRecord(value);
    if (!fields) return null;
    const claimedInstitution = parseField(fields.claimedInstitution, parseClaimedInstitutionValue);
    const programme = parseField(fields.programme, parseProgrammeSelection);
    const entryYear = parseField(fields.entryYear, parseYear);
    const entryRoute = parseField(fields.entryRoute, parseEntryRoute);
    const expectedGraduationYear = parseField(fields.expectedGraduationYear, parseYear);
    if (!claimedInstitution || !programme || !entryYear || !entryRoute || !expectedGraduationYear) return null;
    if (fields.graduationYearOrigin !== null
        && fields.graduationYearOrigin !== 'calculated'
        && fields.graduationYearOrigin !== 'self_reported') return null;
    if (typeof fields.estimateStale !== 'boolean') return null;
    let estimateBasis: EstimateBasis | null = null;
    if (fields.estimateBasis !== null) {
        estimateBasis = parseEstimateBasis(fields.estimateBasis);
        if (!estimateBasis) return null;
    }
    return {
        claimedInstitution,
        programme,
        entryYear,
        entryRoute,
        expectedGraduationYear,
        graduationYearOrigin: fields.graduationYearOrigin,
        estimateBasis,
        estimateStale: fields.estimateStale,
    };
}

function parseInstitution(value: unknown): AcademicProfileInstitution | null {
    const candidate = asRecord(value);
    if (!candidate) return null;
    if (candidate.displayName !== null && typeof candidate.displayName !== 'string') return null;
    if (candidate.countryCode !== null
        && (typeof candidate.countryCode !== 'string' || !/^[A-Za-z]{2}$/.test(candidate.countryCode.trim()))) return null;
    if (candidate.binding !== 'server_bound' && candidate.binding !== 'student_claimed' && candidate.binding !== 'unbound') return null;
    return {
        displayName: candidate.displayName,
        countryCode: typeof candidate.countryCode === 'string' ? candidate.countryCode.trim().toUpperCase() : null,
        binding: candidate.binding,
    };
}

function parseEntryYearSuggestion(value: unknown): EntryYearSuggestion | null {
    if (value === null) return null;
    const candidate = asRecord(value);
    if (!candidate) return null;
    if (candidate.state === 'suggested') {
        const year = parseYear(candidate.year);
        if (year === null
            || !isNonEmptyString(candidate.parserId)
            || !isNonEmptyString(candidate.parserVersion)
            || (candidate.confidence !== 'high' && candidate.confidence !== 'medium' && candidate.confidence !== 'low')) {
            return null;
        }
        return { state: 'suggested', year, parserId: candidate.parserId, parserVersion: candidate.parserVersion, confidence: candidate.confidence };
    }
    if (candidate.state === 'unavailable') {
        if (candidate.reason !== 'no_registration_number'
            && candidate.reason !== 'unsupported_institution'
            && candidate.reason !== 'unrecognized_format'
            && candidate.reason !== 'ambiguous_format') return null;
        return { state: 'unavailable', reason: candidate.reason };
    }
    return null;
}

function parseAcademicFields(value: unknown): AcademicField[] | null {
    if (!Array.isArray(value)) return null;
    const fields: AcademicField[] = [];
    for (const entry of value) {
        if (!ACADEMIC_FIELDS.includes(entry as AcademicField)) return null;
        fields.push(entry as AcademicField);
    }
    return fields;
}

function parseVerificationRequirements(value: unknown): VerificationRequirement[] | null {
    if (!Array.isArray(value)) return null;
    const requirements: VerificationRequirement[] = [];
    for (const entry of value) {
        if (entry !== 'registration_number' && entry !== 'processing_consent') return null;
        requirements.push(entry);
    }
    return requirements;
}

function parseConfirmedGraduationYear(value: unknown): { year: number; observedAt: string } | null {
    if (value === null) return null;
    const candidate = asRecord(value);
    if (!candidate) return null;
    const year = parseYear(candidate.year);
    if (year === null || !isInstant(candidate.observedAt)) return null;
    return { year, observedAt: candidate.observedAt };
}

function parseEstimate(value: unknown): { year: number; ruleId: string; sourceVersion: string } | null {
    if (value === null) return null;
    const candidate = asRecord(value);
    if (!candidate) return null;
    const year = parseYear(candidate.year);
    if (year === null || !isNonEmptyString(candidate.ruleId) || !isNonEmptyString(candidate.sourceVersion)) return null;
    return { year, ruleId: candidate.ruleId, sourceVersion: candidate.sourceVersion };
}

/**
 * Validate the academic-profile projection, accepting either the API `{ data }`
 * envelope or the bare projection. Returns null for unknown, malformed, or
 * eligibility-bearing payloads.
 */
export function parseAcademicProfileResponse(value: unknown): AcademicProfileView | null {
    const projection = asRecord(unwrapData(value));
    if (!projection) return null;
    for (const key of FORBIDDEN_PROJECTION_KEYS) {
        if (key in projection) return null;
    }
    if (typeof projection.revision !== 'number' || !Number.isInteger(projection.revision) || projection.revision < 0) return null;
    const fields = parseFields(projection.fields);
    const institution = parseInstitution(projection.institution);
    const confirmed = projection.institutionConfirmedGraduationYear === undefined
        ? null
        : parseConfirmedGraduationYear(projection.institutionConfirmedGraduationYear);
    if (projection.institutionConfirmedGraduationYear !== undefined && projection.institutionConfirmedGraduationYear !== null && !confirmed) return null;
    let suggestion: EntryYearSuggestion | null = null;
    if (projection.entryYearSuggestion !== undefined && projection.entryYearSuggestion !== null) {
        suggestion = parseEntryYearSuggestion(projection.entryYearSuggestion);
        if (!suggestion) return null;
    }
    const optionalUnansweredFields = parseAcademicFields(projection.optionalUnansweredFields);
    const attentionFields = parseAcademicFields(projection.attentionFields);
    const verificationRequirements = parseVerificationRequirements(projection.verificationRequirements);
    if (!fields || !institution || !optionalUnansweredFields || !attentionFields || !verificationRequirements) return null;
    if (typeof projection.verificationContinuationAvailable !== 'boolean') return null;
    if (projection.assuranceState !== 'available' && projection.assuranceState !== 'unavailable') return null;
    if (projection.assuranceState === 'available') {
        if (projection.assurance === null || projection.assurance === undefined) return null;
    } else if (projection.assurance !== null) {
        return null;
    }
    const assurance = projection.assurance === null || projection.assurance === undefined
        ? null
        : parseStudentAssurance(projection.assurance);
    if (projection.assuranceState === 'available' && !assurance) return null;
    if (projection.referenceVersion !== null && typeof projection.referenceVersion !== 'string') return null;
    const estimate = projection.estimate === undefined ? null : parseEstimate(projection.estimate);
    if (projection.estimate !== undefined && projection.estimate !== null && !estimate) return null;
    if (projection.programmeLabel !== undefined && projection.programmeLabel !== null && typeof projection.programmeLabel !== 'string') return null;
    if (typeof projection.featureEnabled !== 'boolean') return null;
    if (typeof projection.writeAvailable !== 'boolean') return null;
    if (projection.promptDecision !== 'complete_profile' && projection.promptDecision !== 'continue') return null;
    return {
        revision: projection.revision,
        fields,
        institution,
        institutionConfirmedGraduationYear: confirmed,
        entryYearSuggestion: suggestion,
        optionalUnansweredFields,
        attentionFields,
        verificationRequirements,
        verificationContinuationAvailable: projection.verificationContinuationAvailable,
        assuranceState: projection.assuranceState,
        assurance,
        referenceVersion: projection.referenceVersion,
        estimate,
        programmeLabel: typeof projection.programmeLabel === 'string' ? projection.programmeLabel : null,
        featureEnabled: projection.featureEnabled,
        writeAvailable: projection.writeAvailable,
        promptDecision: projection.promptDecision,
    };
}

function parseCatalogueItems<T>(
    value: unknown,
    parseItem: (candidate: unknown) => T | null,
): CataloguePage<T> | null {
    const page = asRecord(unwrapData(value));
    if (!page || !Array.isArray(page.items)) return null;
    if (page.nextCursor !== null && page.nextCursor !== undefined && typeof page.nextCursor !== 'string') return null;
    const items: T[] = [];
    for (const entry of page.items) {
        const parsed = parseItem(entry);
        if (!parsed) return null;
        items.push(parsed);
    }
    return { items, nextCursor: typeof page.nextCursor === 'string' ? page.nextCursor : null };
}

/** Validate an institution catalogue page; display fields only. */
export function parseInstitutionCataloguePage(value: unknown): CataloguePage<InstitutionCatalogueItem> | null {
    return parseCatalogueItems(value, (entry) => {
        const candidate = asRecord(entry);
        if (!candidate || typeof candidate.name !== 'string' || candidate.name.trim().length === 0) return null;
        if (candidate.countryCode !== null
            && candidate.countryCode !== undefined
            && (typeof candidate.countryCode !== 'string' || !/^[A-Za-z]{2}$/.test(candidate.countryCode.trim()))) {
            return null;
        }
        return {
            name: candidate.name,
            countryCode: typeof candidate.countryCode === 'string' ? candidate.countryCode.trim().toUpperCase() : null,
        };
    });
}

/** Validate a programme catalogue page; display fields only. */
export function parseProgrammeCataloguePage(value: unknown): CataloguePage<ProgrammeCatalogueItem> | null {
    return parseCatalogueItems(value, (entry) => {
        const candidate = asRecord(entry);
        if (!candidate
            || !isNonEmptyString(candidate.programmeId)
            || typeof candidate.label !== 'string'
            || candidate.label.trim().length === 0) return null;
        if (candidate.award !== null && candidate.award !== undefined && typeof candidate.award !== 'string') return null;
        return {
            programmeId: candidate.programmeId,
            label: candidate.label,
            award: typeof candidate.award === 'string' ? candidate.award : null,
        };
    });
}

/** Validate a graduation estimate outcome; never persisted until confirmed. */
export function parseEstimateResult(value: unknown): EstimateResult | null {
    const result = asRecord(unwrapData(value));
    if (!result) return null;
    if (result.state === 'available') {
        const year = parseYear(result.year);
        if (year === null || !isNonEmptyString(result.ruleId) || !isNonEmptyString(result.sourceVersion)) return null;
        return { state: 'available', year, ruleId: result.ruleId, sourceVersion: result.sourceVersion };
    }
    if (result.state === 'unavailable') {
        if (!ESTIMATE_UNAVAILABLE_REASONS.includes(result.reason as EstimateUnavailableReason)) return null;
        return { state: 'unavailable', reason: result.reason as EstimateUnavailableReason };
    }
    return null;
}

/** Honest, non-technical explanation for an unavailable estimate. */
export function estimateUnavailableMessage(reason: EstimateUnavailableReason): string {
    switch (reason) {
        case 'missing_input':
            return 'Add a programme, entry year, and entry route to see an estimate.';
        case 'unsupported_country':
            return 'Estimates are not available for this country yet. You can still enter your expected year.';
        case 'unsupported_route':
            return 'Estimates are not available for this entry route. You can still enter your expected year.';
        case 'unknown_programme':
            return 'We do not recognize this programme for estimates. You can still enter your expected year.';
        case 'unreviewed_rule':
            return 'This programme duration has not been reviewed yet, so there is no estimate. You can still enter your expected year.';
        case 'conflicting_rule':
            return 'This programme has conflicting duration records, so there is no estimate. You can still enter your expected year.';
        case 'out_of_range':
            return 'This combination is outside the supported year range. You can still enter your expected year.';
    }
}

export function entryRouteLabel(route: EntryRoute): string {
    switch (route) {
        case 'utme': return 'UTME / first-year entry';
        case 'de_200': return 'Direct Entry (200 level)';
        case 'de_300': return 'Direct Entry (300 level)';
        case 'transfer_other': return 'Other entry route';
    }
}

/**
 * Greeting derived only from the validated stored profile name. Blank or
 * missing names use a generic greeting; the email address is never a name.
 */
export function academicProfileGreeting(user: User | null): string {
    const name = user?.profile?.name;
    if (typeof name === 'string') {
        const first = name.trim().split(/\s+/)[0];
        if (first) return `Hi, ${first}`;
    }
    return 'Hi there';
}

const COMPLETION_PATH = '/student/profile/complete';

/**
 * Resolve the completion exit destination: one validated same-origin path that
 * never targets the completion screen itself, falling back to browse.
 */
export function resolveCompletionExit(candidate: string | null, origin: string): string {
    const destination = resolveStudentReturn(candidate, origin, '/marketplace');
    if (destination === COMPLETION_PATH
        || destination.startsWith(`${COMPLETION_PATH}/`)
        || destination.startsWith(`${COMPLETION_PATH}?`)
        || destination.startsWith(`${COMPLETION_PATH}#`)) {
        return '/marketplace';
    }
    return destination;
}

/**
 * Build the narrow save patch: the expected revision, the read institution
 * token, plus only touched fields. Untouched fields are omitted so partial
 * saves never clear them. The token echoes the institution the GET showed
 * so first saves conflict when the binding moved; the server never uses it
 * to set the binding.
 */
export function buildAcademicProfilePatch(form: AcademicProfileForm, revision: number, institution?: ExpectedReadInstitution): AcademicProfileInput {
    const patch: AcademicProfileInput = { expectedRevision: revision };
    if (institution !== undefined) patch.expectedInstitution = { binding: institution.binding, displayName: institution.displayName };
    if (form.claimedInstitution.state !== 'unchanged') patch.claimedInstitution = form.claimedInstitution;
    if (form.programme.state !== 'unchanged') patch.programme = form.programme;
    if (form.entryYear.state !== 'unchanged') patch.entryYear = form.entryYear;
    if (form.entryRoute.state !== 'unchanged') patch.entryRoute = form.entryRoute;
    if (form.expectedGraduationYear.state !== 'unchanged') patch.expectedGraduationYear = form.expectedGraduationYear;
    return patch;
}

export const ACADEMIC_PROFILE_INSTITUTION_CHANGED = 'ACADEMIC_PROFILE_INSTITUTION_CHANGED';

/**
 * Parse an institution-change save conflict: the server committed the
 * invalidation and reports the revision to retry against. Strict shape —
 * any other conflict (or malformed body) returns null for the generic
 * reload path.
 */
export function parseInstitutionChangedConflict(error: unknown): { revision: number } | null {
    const response = asRecord(asRecord(error)?.['response']);
    if (!response || response['status'] !== 409) return null;
    const details = asRecord(asRecord(asRecord(response['data'])?.['error'])?.['details']);
    if (!details || details['code'] !== ACADEMIC_PROFILE_INSTITUTION_CHANGED) return null;
    const revision = details['revision'];
    if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) return null;
    return { revision };
}

export const ACADEMIC_PROFILE_CLAIM_CHANGED = 'ACADEMIC_PROFILE_CLAIM_CHANGED';

/**
 * Parse a claimed-school reconfirmation conflict: the server wrote nothing
 * and reports the unchanged revision. Unlike institution drift this must
 * not be retried blindly — the caller offers to resubmit the saved scoped
 * answers under the new school. Strict shape, mirroring the drift parser.
 */
export function parseClaimChangedConflict(error: unknown): { revision: number } | null {
    const response = asRecord(asRecord(error)?.['response']);
    if (!response || response['status'] !== 409) return null;
    const details = asRecord(asRecord(asRecord(response['data'])?.['error'])?.['details']);
    if (!details || details['code'] !== ACADEMIC_PROFILE_CLAIM_CHANGED) return null;
    const revision = details['revision'];
    if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) return null;
    return { revision };
}

export type ClaimReconfirmRequest =
    | { kind: 'supplied'; schoolName: string }
    | { kind: 'cleared' }
    | { kind: 'marked'; marker: 'unknown' | 'skipped' };

/**
 * Classify the claim update behind a reconfirmation conflict so the prompt
 * describes what the student actually did: replacing the school differs
 * from removing it or marking it Not sure/Skipped, and resubmitting
 * answers without a school must say so explicitly.
 */
export function claimReconfirmRequest(patch: AcademicProfileInput): ClaimReconfirmRequest | null {
    const update = patch.claimedInstitution;
    if (update === undefined) return null;
    if (update.state === 'supplied') return { kind: 'supplied', schoolName: update.value.name };
    if (update.state === 'unanswered') return { kind: 'cleared' };
    return { kind: 'marked', marker: update.state };
}

/**
 * Extend a claim-change patch with the saved supplied scoped answers it
 * omitted, so one explicit reconfirmation resubmits everything the new
 * school requires. Dirty fields in the patch win; a saved calculated year
 * re-submits as an estimate acceptance the server revalidates under the
 * new school, and may be rejected with a clear message when the new
 * school's reference has no matching rule.
 */
export function buildClaimReconfirmPatch(patch: AcademicProfileInput, view: AcademicProfileView): AcademicProfileInput {
    const next: AcademicProfileInput = { ...patch };
    if (next.programme === undefined && view.fields.programme.state === 'supplied') {
        next.programme = { state: 'supplied', value: view.fields.programme.value };
    }
    if (next.entryYear === undefined && view.fields.entryYear.state === 'supplied') {
        next.entryYear = { state: 'supplied', value: view.fields.entryYear.value };
    }
    if (next.entryRoute === undefined && view.fields.entryRoute.state === 'supplied') {
        next.entryRoute = { state: 'supplied', value: view.fields.entryRoute.value };
    }
    if (next.expectedGraduationYear === undefined && view.fields.expectedGraduationYear.state === 'supplied') {
        const year = view.fields.expectedGraduationYear.value;
        next.expectedGraduationYear = view.fields.graduationYearOrigin === 'calculated'
            ? { state: 'supplied', value: { kind: 'accept_estimate', year } }
            : { state: 'supplied', value: { kind: 'self_reported', year } };
    }
    return next;
}

/** True when the draft stages at least one change. */
export function isFormDirty(form: AcademicProfileForm): boolean {
    return ACADEMIC_FIELDS.some((field) => form[field].state !== 'unchanged');
}

function claimedInstitutionEquals(left: ClaimedInstitutionValue, right: ClaimedInstitutionValue): boolean {
    return left.name === right.name && left.countryCode.toUpperCase() === right.countryCode.toUpperCase();
}

function programmeEquals(left: ProgrammeSelection, right: ProgrammeSelection): boolean {
    return left.programmeId === right.programmeId && left.courseLabel === right.courseLabel;
}

/**
 * Compare an unacknowledged save patch against the freshly read projection so
 * a lost response reconciles without blindly resubmitting an old revision.
 */
export function patchMatchesProjection(patch: AcademicProfileInput, view: AcademicProfileView): boolean {
    if (patch.claimedInstitution) {
        const current = view.fields.claimedInstitution;
        if (patch.claimedInstitution.state === 'supplied') {
            if (current.state !== 'supplied' || !claimedInstitutionEquals(patch.claimedInstitution.value, current.value)) return false;
        } else if (current.state !== patch.claimedInstitution.state) {
            return false;
        }
    }
    if (patch.programme) {
        const current = view.fields.programme;
        if (patch.programme.state === 'supplied') {
            if (current.state !== 'supplied' || !programmeEquals(patch.programme.value, current.value)) return false;
        } else if (current.state !== patch.programme.state) {
            return false;
        }
    }
    if (patch.entryYear) {
        const current = view.fields.entryYear;
        if (patch.entryYear.state === 'supplied') {
            if (current.state !== 'supplied' || current.value !== patch.entryYear.value) return false;
        } else if (current.state !== patch.entryYear.state) {
            return false;
        }
    }
    if (patch.entryRoute) {
        const current = view.fields.entryRoute;
        if (patch.entryRoute.state === 'supplied') {
            if (current.state !== 'supplied' || current.value !== patch.entryRoute.value) return false;
        } else if (current.state !== patch.entryRoute.state) {
            return false;
        }
    }
    if (patch.expectedGraduationYear) {
        const current = view.fields.expectedGraduationYear;
        if (patch.expectedGraduationYear.state === 'supplied') {
            const choice = patch.expectedGraduationYear.value;
            const expectedOrigin = choice.kind === 'accept_estimate' ? 'calculated' : 'self_reported';
            if (current.state !== 'supplied' || current.value !== choice.year || view.fields.graduationYearOrigin !== expectedOrigin) {
                return false;
            }
            // An accepted estimate reconciles only against a non-stale
            // calculated projection: when the reference changed under a
            // stale year, the same numeric year with a calculated origin
            // would otherwise report a failed save as successful.
            if (choice.kind === 'accept_estimate' && view.fields.estimateStale) return false;
        } else if (current.state !== patch.expectedGraduationYear.state) {
            return false;
        }
    }
    return true;
}

function invalidProfileError(): Error {
    return new Error('The academic profile response was not recognized. Please reload this page.');
}

/** Freshly load the authenticated student's academic projection. */
export async function fetchAcademicProfile(): Promise<AcademicProfileView> {
    const response = await apiClient.get('/students/academic-profile');
    const parsed = parseAcademicProfileResponse(response.data);
    if (!parsed) throw invalidProfileError();
    return parsed;
}

let inflightCompletionCtaRead: { generation: number; promise: Promise<AcademicProfileView> } | null = null;

/**
 * One shared in-flight projection read per browser session for the
 * completion CTA gate, so StrictMode double-effects issue a single
 * request. Keyed by session generation: a new session never inherits a
 * request started with another account's token. Cleared on settle when
 * still current, so sequential mounts always re-read, never a stale flag.
 */
function readCompletionCtaProjection(snapshot: SessionSnapshot): Promise<AcademicProfileView> {
    if (!inflightCompletionCtaRead || inflightCompletionCtaRead.generation !== snapshot.generation) {
        const request = fetchAcademicProfile().finally(() => {
            if (inflightCompletionCtaRead?.promise === request) inflightCompletionCtaRead = null;
        });
        inflightCompletionCtaRead = { generation: snapshot.generation, promise: request };
    }
    return inflightCompletionCtaRead.promise;
}

function completionCtaSessionGeneration(): number {
    return getSessionSnapshot().generation;
}

function completionCtaServerGeneration(): number {
    return -1;
}

/**
 * Whether the profile-completion call to action renders on the profile hub
 * and verification pages. Null while the server projection loads; the
 * actor-level write gate afterwards, so students who cannot save (for
 * example suspended accounts) are never invited to a read-only form.
 * Session-scoped: an account change resets to loading and re-reads with
 * the new session, and results from a superseded session are rejected.
 * Read failures fail closed: an unreadable gate must not advertise a
 * journey the server may have disabled for this actor.
 */
export function useAcademicProfileCompletionCta(): boolean | null {
    const [settled, setSettled] = useState<{ generation: number; visible: boolean } | null>(null);
    const generation = useSyncExternalStore(subscribeSessionChanges, completionCtaSessionGeneration, completionCtaServerGeneration);
    useEffect(() => {
        let cancelled = false;
        const snapshot = getSessionSnapshot();
        readCompletionCtaProjection(snapshot)
            .then((view) => {
                if (!cancelled && isCurrentSession(snapshot)) setSettled({ generation: snapshot.generation, visible: view.writeAvailable });
            })
            .catch(() => {
                if (!cancelled && isCurrentSession(snapshot)) setSettled({ generation: snapshot.generation, visible: false });
            });
        return () => { cancelled = true; };
    }, [generation]);
    // A result committed for a superseded session never renders: only the
    // current generation's gate is shown, loading otherwise.
    return settled && settled.generation === generation ? settled.visible : null;
}

/** Save a partial patch and return the recalculated projection. */
export async function saveAcademicProfile(input: AcademicProfileInput): Promise<AcademicProfileView> {
    const response = await apiClient.put('/students/academic-profile', input);
    const parsed = parseAcademicProfileResponse(response.data);
    if (!parsed) throw invalidProfileError();
    return parsed;
}

/** Bounded institution catalogue search scoped by the server. */
export async function searchAcademicInstitutions(query: string, cursor: string | null = null): Promise<CataloguePage<InstitutionCatalogueItem>> {
    const response = await apiClient.get('/students/academic-profile/institutions', {
        params: { q: query, limit: 20, ...(cursor ? { cursor } : {}) },
    });
    const parsed = parseInstitutionCataloguePage(response.data);
    if (!parsed) throw new Error('The institution search response was not recognized. Please try again.');
    return parsed;
}

/** Bounded programme catalogue search scoped by the server. */
export async function searchAcademicProgrammes(query: string, cursor: string | null = null): Promise<CataloguePage<ProgrammeCatalogueItem>> {
    const response = await apiClient.get('/students/academic-profile/programmes', {
        params: { q: query, limit: 20, ...(cursor ? { cursor } : {}) },
    });
    const parsed = parseProgrammeCataloguePage(response.data);
    if (!parsed) throw new Error('The programme search response was not recognized. Please try again.');
    return parsed;
}

/** Compute an advisory estimate without persisting it. */
export async function requestGraduationEstimate(input: EstimateInput): Promise<EstimateResult> {
    const response = await apiClient.post('/students/academic-profile/estimate', input);
    const parsed = parseEstimateResult(response.data);
    if (!parsed) throw new Error('The estimate response was not recognized. Please try again.');
    return parsed;
}
