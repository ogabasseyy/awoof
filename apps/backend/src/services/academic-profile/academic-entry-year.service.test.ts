import assert from 'node:assert/strict';
import test from 'node:test';
import { readAcademicProfile } from './academic-profile.service.js';
import type { EntryYearSuggestion, ProfileFieldState } from './academic-profile.types.js';
import {
    REVIEWED_MATRIC_PARSERS,
    normalizeInstitutionKey,
    resolveEntryYearSuggestionForProjection,
    resolveTwoDigitYear,
    suggestEntryYearFromMatric,
    type MatricParser,
} from './academic-entry-year.service.js';

const CURRENT_YEAR = 2026;

test('two-digit years resolve to the single plausible century within the parser window', () => {
    assert.deepEqual(
        resolveTwoDigitYear({ twoDigitYear: 14, currentYear: CURRENT_YEAR, maxAgeYears: 60 }),
        { state: 'resolved', year: 2014 },
    );
    assert.deepEqual(
        resolveTwoDigitYear({ twoDigitYear: 99, currentYear: CURRENT_YEAR, maxAgeYears: 60 }),
        { state: 'resolved', year: 1999 },
    );
    assert.deepEqual(
        resolveTwoDigitYear({ twoDigitYear: 66, currentYear: CURRENT_YEAR, maxAgeYears: 60 }),
        { state: 'resolved', year: 1966 },
    );
    assert.deepEqual(
        resolveTwoDigitYear({ twoDigitYear: 26, currentYear: CURRENT_YEAR, maxAgeYears: 60 }),
        { state: 'resolved', year: 2026 },
    );
});

test('two-digit years outside every plausible century are unrecognized, never guessed', () => {
    assert.deepEqual(
        resolveTwoDigitYear({ twoDigitYear: 65, currentYear: CURRENT_YEAR, maxAgeYears: 60 }),
        { state: 'unrecognized' },
    );
    assert.deepEqual(
        resolveTwoDigitYear({ twoDigitYear: 27, currentYear: CURRENT_YEAR, maxAgeYears: 60 }),
        { state: 'unrecognized' },
    );
});

test('two-digit years plausible in both centuries are ambiguous', () => {
    assert.deepEqual(
        resolveTwoDigitYear({ twoDigitYear: 26, currentYear: CURRENT_YEAR, maxAgeYears: 100 }),
        { state: 'ambiguous' },
    );
    assert.deepEqual(
        resolveTwoDigitYear({ twoDigitYear: 0, currentYear: CURRENT_YEAR, maxAgeYears: 100 }),
        { state: 'resolved', year: 2000 },
    );
});

test('two-digit resolution rejects invalid windows instead of widening them silently', () => {
    assert.throws(() => resolveTwoDigitYear({ twoDigitYear: -1, currentYear: CURRENT_YEAR, maxAgeYears: 60 }), RangeError);
    assert.throws(() => resolveTwoDigitYear({ twoDigitYear: 100, currentYear: CURRENT_YEAR, maxAgeYears: 60 }), RangeError);
    assert.throws(() => resolveTwoDigitYear({ twoDigitYear: 14.5, currentYear: CURRENT_YEAR, maxAgeYears: 60 }), RangeError);
    assert.throws(() => resolveTwoDigitYear({ twoDigitYear: 14, currentYear: CURRENT_YEAR, maxAgeYears: 0 }), RangeError);
    assert.throws(() => resolveTwoDigitYear({ twoDigitYear: 14, currentYear: CURRENT_YEAR, maxAgeYears: -5 }), RangeError);
});

function syntheticParser(overrides: Partial<MatricParser> = {}): MatricParser {
    return {
        parserId: 'synthetic-test-parser',
        parserVersion: '1',
        institutionKey: 'TEST-UNI',
        confidence: 'high',
        parse: (registrationNumber: string, currentYear: number) => {
            const match = /^TST\/(\d{2})\/\d{4}$/.exec(registrationNumber.trim());
            if (!match?.[1]) return null;
            const resolved = resolveTwoDigitYear({ twoDigitYear: Number(match[1]), currentYear, maxAgeYears: 60 });
            if (resolved.state === 'resolved') return { year: resolved.year };
            if (resolved.state === 'ambiguous') return { ambiguous: true };
            return null;
        },
        ...overrides,
    };
}

const REVIEWED_FIXTURES: readonly MatricParser[] = [syntheticParser()];

test('an exact reviewed institution format returns a suggested entry year with provenance', () => {
    const result = suggestEntryYearFromMatric(
        { institutionKey: 'TEST-UNI', registrationNumber: 'TST/14/0001', currentYear: CURRENT_YEAR },
        REVIEWED_FIXTURES,
    );
    assert.deepEqual(result, {
        state: 'suggested',
        year: 2014,
        parserId: 'synthetic-test-parser',
        parserVersion: '1',
        confidence: 'high',
    } satisfies EntryYearSuggestion);
});

test('suggestion carries the parser-documented confidence without upgrading it', () => {
    const low = suggestEntryYearFromMatric(
        { institutionKey: 'TEST-UNI', registrationNumber: 'TST/14/0001', currentYear: CURRENT_YEAR },
        [syntheticParser({ confidence: 'low' })],
    );
    assert.deepEqual(low, {
        state: 'suggested',
        year: 2014,
        parserId: 'synthetic-test-parser',
        parserVersion: '1',
        confidence: 'low',
    } satisfies EntryYearSuggestion);
});

test('parsers never match substrings, wrong cases, or unrecognized formats', () => {
    for (const registrationNumber of [
        'XXTST/14/0001',
        'TST/14/0001YY',
        'prefix TST/14/0001 suffix',
        'tst/14/0001',
        'TST/140/0001',
        'TST/AB/0001',
        '14',
        'TST/27/0001',
    ]) {
        assert.deepEqual(
            suggestEntryYearFromMatric({ institutionKey: 'TEST-UNI', registrationNumber, currentYear: CURRENT_YEAR }, REVIEWED_FIXTURES),
            { state: 'unavailable', reason: 'unrecognized_format' },
            registrationNumber,
        );
    }
});

test('surrounding whitespace is trimmed but the format stays exact', () => {
    const result = suggestEntryYearFromMatric(
        { institutionKey: 'TEST-UNI', registrationNumber: '  TST/14/0001  ', currentYear: CURRENT_YEAR },
        REVIEWED_FIXTURES,
    );
    assert.equal(result.state, 'suggested');
});

test('ambiguous century windows return ambiguous_format instead of picking a century', () => {
    const wide = syntheticParser({
        parse: (registrationNumber: string, currentYear: number) => {
            const match = /^TST\/(\d{2})\/\d{4}$/.exec(registrationNumber.trim());
            if (!match?.[1]) return null;
            const resolved = resolveTwoDigitYear({ twoDigitYear: Number(match[1]), currentYear, maxAgeYears: 100 });
            if (resolved.state === 'resolved') return { year: resolved.year };
            if (resolved.state === 'ambiguous') return { ambiguous: true };
            return null;
        },
    });
    assert.deepEqual(
        suggestEntryYearFromMatric({ institutionKey: 'TEST-UNI', registrationNumber: 'TST/26/0001', currentYear: CURRENT_YEAR }, [wide]),
        { state: 'unavailable', reason: 'ambiguous_format' },
    );
});

test('missing registration numbers and unsupported institutions stay unavailable', () => {
    for (const registrationNumber of [null, '', '   ']) {
        assert.deepEqual(
            suggestEntryYearFromMatric({ institutionKey: 'TEST-UNI', registrationNumber, currentYear: CURRENT_YEAR }, REVIEWED_FIXTURES),
            { state: 'unavailable', reason: 'no_registration_number' },
            JSON.stringify(registrationNumber),
        );
    }
    for (const institutionKey of [null, '', 'UNKNOWN-UNI']) {
        assert.deepEqual(
            suggestEntryYearFromMatric({ institutionKey, registrationNumber: 'TST/14/0001', currentYear: CURRENT_YEAR }, REVIEWED_FIXTURES),
            { state: 'unavailable', reason: 'unsupported_institution' },
            JSON.stringify(institutionKey),
        );
    }
});

test('institution keys normalize case and whitespace before parser lookup', () => {
    assert.equal(normalizeInstitutionKey('  test-uni '), 'TEST-UNI');
    assert.equal(normalizeInstitutionKey(''), null);
    assert.equal(normalizeInstitutionKey(null), null);
    assert.equal(normalizeInstitutionKey(undefined), null);
    const result = suggestEntryYearFromMatric(
        { institutionKey: '  test-uni ', registrationNumber: 'TST/14/0001', currentYear: CURRENT_YEAR },
        REVIEWED_FIXTURES,
    );
    assert.equal(result.state, 'suggested');
});

test('no production parser is enabled without recorded independent evidence', () => {
    assert.deepEqual(REVIEWED_MATRIC_PARSERS, []);
    assert.deepEqual(
        suggestEntryYearFromMatric({ institutionKey: 'UNILAG', registrationNumber: 'TST/14/0001', currentYear: CURRENT_YEAR }),
        { state: 'unavailable', reason: 'unsupported_institution' },
    );
    assert.deepEqual(
        suggestEntryYearFromMatric({ institutionKey: 'TEST-UNI', registrationNumber: 'TST/14/0001', currentYear: CURRENT_YEAR }),
        { state: 'unavailable', reason: 'unsupported_institution' },
    );
});

function projectionInput(overrides: {
    featureEnabled?: boolean;
    entryYearState?: ProfileFieldState;
    institutionKey?: string | null;
    registrationNumber?: string | null;
}): { featureEnabled: boolean; entryYearState: ProfileFieldState; institutionKey: string | null; registrationNumber: string | null; currentYear: number } {
    return {
        featureEnabled: true,
        entryYearState: 'unanswered',
        institutionKey: 'TEST-UNI',
        registrationNumber: 'TST/14/0001',
        currentYear: CURRENT_YEAR,
        ...overrides,
    };
}

test('projection suggestions appear only while the feature is on and no parser is skipped', () => {
    const suggested = resolveEntryYearSuggestionForProjection(projectionInput(), REVIEWED_FIXTURES);
    assert.equal(suggested?.state, 'suggested');
    assert.equal(resolveEntryYearSuggestionForProjection(projectionInput({ featureEnabled: false }), REVIEWED_FIXTURES), null);
    assert.equal(resolveEntryYearSuggestionForProjection(projectionInput({ institutionKey: 'UNKNOWN-UNI' }), REVIEWED_FIXTURES), null);
    assert.equal(resolveEntryYearSuggestionForProjection(projectionInput({ institutionKey: null }), REVIEWED_FIXTURES), null);
});

test('projection never re-suggests over a stored entry-year answer', () => {
    for (const entryYearState of ['supplied', 'unknown', 'skipped'] as const) {
        assert.equal(
            resolveEntryYearSuggestionForProjection(projectionInput({ entryYearState }), REVIEWED_FIXTURES),
            null,
            entryYearState,
        );
    }
});

test('projection reports an enabled parser with no registration number as unavailable', () => {
    assert.deepEqual(
        resolveEntryYearSuggestionForProjection(projectionInput({ registrationNumber: null }), REVIEWED_FIXTURES),
        { state: 'unavailable', reason: 'no_registration_number' },
    );
    assert.deepEqual(
        resolveEntryYearSuggestionForProjection(projectionInput({ registrationNumber: 'bad format' }), REVIEWED_FIXTURES),
        { state: 'unavailable', reason: 'unrecognized_format' },
    );
});

const USER_ID = '11111111-1111-4111-8111-111111111111';
const STUDENT_ID = '22222222-2222-4222-8222-222222222222';
const UNIVERSITY_ID = '33333333-3333-4333-8333-333333333333';
const REGISTRATION_NUMBER = 'TST/14/0001';

function createSuggestionPool(profile: Record<string, unknown> | null): { connect: () => Promise<unknown>; writes: string[] } {
    const writes: string[] = [];
    const client = {
        query: async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
            const normalized = text.replace(/\s+/g, ' ').trim();
            if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
                return { rows: [], rowCount: 0 };
            }
            if (normalized === 'SAVEPOINT academic_profile_assurance'
                || normalized === 'RELEASE SAVEPOINT academic_profile_assurance'
                || normalized === 'ROLLBACK TO SAVEPOINT academic_profile_assurance') {
                return { rows: [], rowCount: 0 };
            }
            if (normalized.startsWith('INSERT INTO student_academic_profiles') || normalized.startsWith('UPDATE student_academic_profiles')) {
                writes.push(normalized);
                return { rows: [{ revision: 1 }], rowCount: 1 };
            }
            if (normalized.includes('FROM student_academic_profiles')) {
                return { rows: profile ? [profile] : [], rowCount: profile ? 1 : 0 };
            }
            if (normalized.includes('FROM users')) {
                return { rows: [{ id: USER_ID, role: 'student', deleted_at: null }], rowCount: 1 };
            }
            if (normalized.includes('FROM students')) {
                assert.deepEqual(params[0], USER_ID);
                return {
                    rows: [{
                        id: STUDENT_ID,
                        university_id: UNIVERSITY_ID,
                        identity_version: 1,
                        status: 'active',
                        registration_number: REGISTRATION_NUMBER,
                    }],
                    rowCount: 1,
                };
            }
            if (normalized.includes('FROM universities')) {
                return { rows: [{ id: UNIVERSITY_ID, name: 'Fixture University', shortcode: 'test-uni' }], rowCount: 1 };
            }
            throw new Error(`Unexpected query: ${normalized}`);
        },
        release: (): void => undefined,
    };
    return { connect: async () => client, writes };
}

function suggestionDeps(): Parameters<typeof readAcademicProfile>[2] {
    return {
        featureEnabled: true,
        reference: { sourceVersion: 'TEST-REF-v1', findReviewedRule: () => null, findProgrammeLabel: () => null },
        now: new Date('2026-06-15T12:00:00.000Z'),
        readAssurance: async () => ({
            schoolAccountStatus: 'unverified',
            schoolAccountMethod: null,
            schoolAccountValidUntil: null,
            studentStatus: 'pending',
            enrollmentMethod: null,
            studentValidUntil: null,
            reason: 'awaiting_enrollment',
        }),
        listVerificationMethods: async () => [],
        matricParsers: REVIEWED_FIXTURES,
    };
}

test('reading a profile surfaces a suggestion without persisting it', async () => {
    const pool = createSuggestionPool(null);
    const projection = await readAcademicProfile(pool, USER_ID, suggestionDeps());
    assert.deepEqual(projection.entryYearSuggestion, {
        state: 'suggested',
        year: 2014,
        parserId: 'synthetic-test-parser',
        parserVersion: '1',
        confidence: 'high',
    } satisfies EntryYearSuggestion);
    assert.equal(projection.revision, 0);
    assert.deepEqual(projection.fields.entryYear, { state: 'unanswered' });
    assert.deepEqual(pool.writes, []);
    assert.equal(projection.institutionConfirmedGraduationYear, null);
});

test('reading a profile never places the registration number in the projection', async () => {
    const pool = createSuggestionPool(null);
    const projection = await readAcademicProfile(pool, USER_ID, suggestionDeps());
    assert.ok(!JSON.stringify(projection).includes(REGISTRATION_NUMBER));
});

test('a confirmed entry year stops the suggestion without touching the stored value', async () => {
    const pool = createSuggestionPool({
        user_id: USER_ID,
        student_id: STUDENT_ID,
        canonical_institution_id: UNIVERSITY_ID,
        observed_identity_version: 1,
        revision: 2,
        claimed_institution_state: 'unanswered',
        claimed_institution_name: null,
        claimed_institution_country: null,
        programme_state: 'unanswered',
        programme_id: null,
        course_label: null,
        entry_year_state: 'supplied',
        entry_year: 2013,
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
    });
    const projection = await readAcademicProfile(pool, USER_ID, suggestionDeps());
    assert.equal(projection.entryYearSuggestion, null);
    assert.deepEqual(projection.fields.entryYear, { state: 'supplied', value: 2013 });
});
