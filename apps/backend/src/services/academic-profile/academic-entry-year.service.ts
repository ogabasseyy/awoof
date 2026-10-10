/**
 * Academic Entry-Year Suggestion Service
 *
 * Optional school-format-specific matric-number suggestions. Only a
 * source-reviewed, institution-specific parser documented in
 * `docs/research/student-registration-number-formats.md` may return a
 * suggested year. There is intentionally no universal or substring-only
 * parser: unknown formats, unsupported institutions, and ambiguous centuries
 * return `unavailable`, never a guessed year.
 *
 * Suggestions are never persisted and never carry the registration number:
 * the student confirms or edits the year before it becomes `entryYear`.
 */

import type { EntryYearSuggestion, ProfileFieldState } from './academic-profile.types.js';

export type TwoDigitYearResolution =
    | { state: 'resolved'; year: number }
    | { state: 'ambiguous' }
    | { state: 'unrecognized' };

/**
 * Resolve a two-digit admission year to the single plausible century. Both
 * the 1900s and 2000s candidates are tested against the parser-defined
 * window `[currentYear - maxAgeYears, currentYear]`; two plausible
 * candidates are ambiguous and zero are unrecognized.
 */
export function resolveTwoDigitYear(input: { twoDigitYear: number; currentYear: number; maxAgeYears: number }): TwoDigitYearResolution {
    const { twoDigitYear, currentYear, maxAgeYears } = input;
    if (!Number.isInteger(twoDigitYear) || twoDigitYear < 0 || twoDigitYear > 99) {
        throw new RangeError('Two-digit year must be an integer between 0 and 99');
    }
    if (!Number.isInteger(currentYear)) {
        throw new RangeError('Current year must be an integer');
    }
    if (!Number.isInteger(maxAgeYears) || maxAgeYears <= 0) {
        throw new RangeError('Parser century window must be a positive integer of years');
    }
    const earliest = currentYear - maxAgeYears;
    const candidates = [1900 + twoDigitYear, 2000 + twoDigitYear].filter((year) => year >= earliest && year <= currentYear);
    if (candidates.length === 2) return { state: 'ambiguous' };
    const [year] = candidates;
    if (year === undefined) return { state: 'unrecognized' };
    return { state: 'resolved', year };
}

export type MatricParseResult = { year: number } | { ambiguous: true } | null;

export type MatricParser = {
    /** Stable parser id, recorded in the research note alongside its evidence. */
    parserId: string;
    /** Parser version; format changes ship as a new version with new evidence. */
    parserVersion: string;
    /** Uppercase institution key resolved server-side from the bound university record. */
    institutionKey: string;
    /** Confidence set by the parser's documented evidence; never upgraded by the service. */
    confidence: 'high' | 'medium' | 'low';
    /**
     * Exact full-string match only. Returns the parsed year, an ambiguity
     * marker when two centuries are plausible, or null when the value does
     * not match this institution's reviewed format.
     */
    parse: (registrationNumber: string, currentYear: number) => MatricParseResult;
};

/**
 * Production parser registry. Intentionally empty: no institution format has
 * completed the review checklist in
 * `docs/research/student-registration-number-formats.md` yet, so every
 * production suggestion resolves to "parser not enabled". Parsers are added
 * here only together with their recorded evidence and tests.
 */
export const REVIEWED_MATRIC_PARSERS: readonly MatricParser[] = [];

export function normalizeInstitutionKey(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toUpperCase();
    return normalized === '' ? null : normalized;
}

/**
 * Internal service only. The institution key and registration number come
 * from the locked server-side student context; the endpoint never accepts,
 * returns, logs, or URLs the registration number.
 */
export function suggestEntryYearFromMatric(
    input: { institutionKey: string | null; registrationNumber: string | null; currentYear: number },
    parsers: readonly MatricParser[] = REVIEWED_MATRIC_PARSERS,
): EntryYearSuggestion {
    const key = normalizeInstitutionKey(input.institutionKey);
    const parser = key === null ? undefined : parsers.find((candidate) => candidate.institutionKey === key);
    if (!parser) {
        return { state: 'unavailable', reason: 'unsupported_institution' };
    }
    if (typeof input.registrationNumber !== 'string' || input.registrationNumber.trim() === '') {
        return { state: 'unavailable', reason: 'no_registration_number' };
    }
    const parsed = parser.parse(input.registrationNumber, input.currentYear);
    if (parsed === null) {
        return { state: 'unavailable', reason: 'unrecognized_format' };
    }
    if ('ambiguous' in parsed) {
        return { state: 'unavailable', reason: 'ambiguous_format' };
    }
    return {
        state: 'suggested',
        year: parsed.year,
        parserId: parser.parserId,
        parserVersion: parser.parserVersion,
        confidence: parser.confidence,
    };
}

/**
 * Projection gate. Returns null (parser not enabled for this context) unless
 * collection is enabled, the entry year is still unanswered, and a reviewed
 * parser covers the server-bound institution. Stored answers — supplied,
 * unknown, or skipped — are never re-suggested over.
 */
export function resolveEntryYearSuggestionForProjection(
    input: {
        featureEnabled: boolean;
        entryYearState: ProfileFieldState;
        institutionKey: string | null;
        registrationNumber: string | null;
        currentYear: number;
    },
    parsers: readonly MatricParser[] = REVIEWED_MATRIC_PARSERS,
): EntryYearSuggestion | null {
    if (!input.featureEnabled) return null;
    if (input.entryYearState !== 'unanswered') return null;
    const key = normalizeInstitutionKey(input.institutionKey);
    if (key === null || !parsers.some((candidate) => candidate.institutionKey === key)) return null;
    return suggestEntryYearFromMatric(
        { institutionKey: key, registrationNumber: input.registrationNumber, currentYear: input.currentYear },
        parsers,
    );
}
