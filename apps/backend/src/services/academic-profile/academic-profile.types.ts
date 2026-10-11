/**
 * Academic Profile Contract
 *
 * Student-owned optional academic details. The browser may only submit the
 * narrow `AcademicProfileInput` below: every other value (canonical binding,
 * graduation origin, estimate basis, rule references, assurance, prompting)
 * is computed or bound by the server. Unknown keys are rejected.
 */

import { z } from 'zod';
import type { StudentAssurance } from '../verification/student-assurance.types.js';

export type AcademicField = 'claimedInstitution' | 'programme' | 'entryYear' | 'entryRoute' | 'expectedGraduationYear';

export const ACADEMIC_FIELDS: readonly AcademicField[] = [
    'claimedInstitution',
    'programme',
    'entryYear',
    'entryRoute',
    'expectedGraduationYear',
];

export const ENTRY_YEAR_MIN = 1900;
export const GRADUATION_HORIZON_YEARS = 20;

export type ProfileFieldState = 'unanswered' | 'supplied' | 'unknown' | 'skipped';

export type ProfileField<T> =
    | { state: 'supplied'; value: T }
    | { state: 'unanswered' | 'unknown' | 'skipped' };

export type FieldUpdate<T> = ProfileField<T>;

export type ClaimedInstitutionValue = { name: string; countryCode: string };

export type ProgrammeSelection =
    | { programmeId: string; courseLabel: null }
    | { programmeId: null; courseLabel: string };

export type EntryRoute = 'utme' | 'de_200' | 'de_300' | 'transfer_other';

export type GraduationYearChoice =
    | { kind: 'accept_estimate'; year: number }
    | { kind: 'self_reported'; year: number };

export type AcademicProfileInput = {
    expectedRevision: number;
    claimedInstitution?: FieldUpdate<ClaimedInstitutionValue>;
    programme?: FieldUpdate<ProgrammeSelection>;
    entryYear?: FieldUpdate<number>;
    entryRoute?: FieldUpdate<EntryRoute>;
    expectedGraduationYear?: FieldUpdate<GraduationYearChoice>;
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

export type AcademicProfileProjection = {
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
    /** Display label for a saved catalogue programme selection; null for free text or unresolvable ids. */
    programmeLabel: string | null;
    featureEnabled: boolean;
    promptDecision: 'complete_profile' | 'continue';
};

export type PurgeResult = { deleted: boolean };

function fieldUpdateSchema<T extends z.ZodTypeAny>(valueSchema: T): z.ZodUnion<
    [z.ZodObject<{ state: z.ZodLiteral<'supplied'>; value: T }, 'strict'>,
     z.ZodObject<{ state: z.ZodEnum<['unanswered', 'unknown', 'skipped']> }, 'strict'>]
> {
    return z.union([
        z.object({ state: z.literal('supplied'), value: valueSchema }).strict(),
        z.object({ state: z.enum(['unanswered', 'unknown', 'skipped']) }).strict(),
    ]);
}

const claimedInstitutionValueSchema = z.object({
    name: z.string().trim().min(1).max(255),
    countryCode: z.string().trim().length(2).regex(/^[A-Za-z]{2}$/).toUpperCase(),
}).strict();

const programmeSelectionSchema = z.union([
    z.object({ programmeId: z.string().trim().min(1).max(128), courseLabel: z.null() }).strict(),
    z.object({ programmeId: z.null(), courseLabel: z.string().trim().min(1).max(255) }).strict(),
]);

const graduationYearChoiceSchema = z.union([
    z.object({ kind: z.literal('accept_estimate'), year: z.number().int() }).strict(),
    z.object({ kind: z.literal('self_reported'), year: z.number().int() }).strict(),
]);

/**
 * Strict request-body contract. Cross-field rules (year bounds against the
 * server clock, estimate recomputation, binding read-only fields) are enforced
 * by the service after parsing; this schema owns shape and key allowlist.
 *
 * Parser output carries explicit `| undefined` on optional keys (zod
 * inference under exactOptionalPropertyTypes); the manual contract above is
 * the narrower caller-facing shape. The assertion below keeps them aligned.
 */
export const academicProfileInputSchema = z.object({
    expectedRevision: z.number().int().min(0),
    claimedInstitution: fieldUpdateSchema(claimedInstitutionValueSchema).optional(),
    programme: fieldUpdateSchema(programmeSelectionSchema).optional(),
    entryYear: fieldUpdateSchema(z.number().int()).optional(),
    entryRoute: fieldUpdateSchema(z.enum(['utme', 'de_200', 'de_300', 'transfer_other'])).optional(),
    expectedGraduationYear: fieldUpdateSchema(graduationYearChoiceSchema).optional(),
}).strict();

export type ParsedAcademicProfileInput = z.output<typeof academicProfileInputSchema>;

type AssertTrue<T extends true> = T;
// Compile-time only: fails the build if the manual contract drifts from the parser.
export type _ManualContractFitsParser = AssertTrue<AcademicProfileInput extends ParsedAcademicProfileInput ? true : false>;

/** Explicit institution-country mapping shared by search and estimate paths. Unmapped countries resolve to null, never a guess. */
const COUNTRY_NAME_TO_CODE: Readonly<Record<string, string>> = {
    NIGERIA: 'NG',
    GHANA: 'GH',
};

export function countryNameToCode(country: string | null | undefined): string | null {
    if (typeof country !== 'string') return null;
    return COUNTRY_NAME_TO_CODE[country.trim().toUpperCase()] ?? null;
}

/** Server-bound institution country for estimate scoping: null when unbound or unmapped (no constraint). */
export function boundInstitutionCountryCode(universityId: string | null, institutionCountry: string | null): string | null {
    if (universityId === null) return null;
    return countryNameToCode(institutionCountry);
}

/** Default national system for programme artifacts whose root omits a country. */
export const NUC_ARTIFACT_DEFAULT_COUNTRY_CODE = 'NG';

/**
 * Normalize an artifact root country identically for every consumer: omitted
 * means the default national system; a present value must be an ISO code.
 * Returns null when the root country is malformed (fail closed).
 */
export function normalizeArtifactCountryCode(rawCountry: unknown): string | null {
    if (rawCountry === undefined) return NUC_ARTIFACT_DEFAULT_COUNTRY_CODE;
    if (typeof rawCountry !== 'string' || !/^[A-Z]{2}$/.test(rawCountry)) return null;
    return rawCountry;
}
