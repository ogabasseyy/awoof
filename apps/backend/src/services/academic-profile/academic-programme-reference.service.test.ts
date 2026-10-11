import assert from 'node:assert/strict';
import test from 'node:test';
import { ZodError } from 'zod';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../common/errors/AppError.js';
import {
    CATALOGUE_DEFAULT_LIMIT,
    CATALOGUE_MAX_LIMIT,
    countryNameToCode,
    decodeCatalogueCursor,
    encodeCatalogueCursor,
    estimateGraduationYear,
    estimateGraduationYearForStudent,
    estimateInputSchema,
    loadProgrammeReference,
    parseCatalogueQuery,
    searchInstitutionsForStudent,
    searchProgrammes,
    searchProgrammesForStudent,
    type EstimateInput,
    type ProgrammeReference,
    type ReferenceProgramme,
    type ReferenceRouteRule,
} from './academic-programme-reference.service.js';

const CURRENT_YEAR = 2026;
const SOURCE_VERSION = 'SYNTHETIC-REF-v1';

function rule(overrides: Partial<ReferenceRouteRule> = {}): ReferenceRouteRule {
    return { durationYears: 4, reviewed: true, applicable: true, estimable: true, ...overrides };
}

function programme(overrides: Partial<ReferenceProgramme> & { programmeId: string }): ReferenceProgramme {
    const { programmeId, ...rest } = overrides;
    return {
        programmeId,
        label: `Synthetic ${programmeId}`,
        award: 'B.Sc',
        aliases: [],
        countryCode: 'NG',
        routes: { utme: rule() },
        ...rest,
    };
}

function syntheticReference(overrides: Partial<ProgrammeReference> = {}): ProgrammeReference {
    return {
        sourceVersion: SOURCE_VERSION,
        calculationsEnabled: true,
        programmes: [
            programme({
                programmeId: 'SYN-ENG',
                label: 'Synthetic Engineering',
                award: 'B.Eng',
                aliases: ['engineers-pick'],
                routes: { utme: rule({ durationYears: 4 }), de_200: rule({ durationYears: 3 }), de_300: rule({ durationYears: 2 }) },
            }),
            programme({
                programmeId: 'SYN-MED',
                label: 'Synthetic Medicine',
                award: 'MBBS',
                routes: { utme: rule({ durationYears: 6 }), de_200: rule({ durationYears: 5, reviewed: false, estimable: false }) },
            }),
            programme({
                programmeId: 'SYN-GH',
                label: 'Synthetic Ghana Programme',
                countryCode: 'GH',
                routes: { utme: rule({ durationYears: 4 }) },
            }),
            programme({
                programmeId: 'SYN-CONF',
                label: 'Synthetic Conflicted Programme',
                routes: { utme: rule({ durationYears: 4, conflicting: true }) },
            }),
            programme({
                programmeId: 'SYN-PEND',
                label: 'Synthetic Pending Programme',
                routes: { utme: rule({ durationYears: null, reviewed: false, applicable: false, estimable: false }) },
            }),
        ],
        ...overrides,
    };
}

function input(overrides: Partial<EstimateInput> = {}): EstimateInput {
    return { programmeId: 'SYN-ENG', entryYear: 2022, entryRoute: 'utme', ...overrides };
}

test('estimate adds the reviewed UTME duration to the confirmed entry year', () => {
    const result = estimateGraduationYear(input(), syntheticReference(), { currentYear: CURRENT_YEAR });
    assert.deepEqual(result, { state: 'available', year: 2026, ruleId: 'SYN-ENG:utme', sourceVersion: SOURCE_VERSION });
});

test('direct-entry estimates use the reviewed remaining route duration', () => {
    const reference = syntheticReference();
    assert.deepEqual(
        estimateGraduationYear(input({ entryYear: 2023, entryRoute: 'de_200' }), reference, { currentYear: CURRENT_YEAR }),
        { state: 'available', year: 2026, ruleId: 'SYN-ENG:de_200', sourceVersion: SOURCE_VERSION },
    );
    assert.deepEqual(
        estimateGraduationYear(input({ entryYear: 2024, entryRoute: 'de_300' }), reference, { currentYear: CURRENT_YEAR }),
        { state: 'available', year: 2026, ruleId: 'SYN-ENG:de_300', sourceVersion: SOURCE_VERSION },
    );
});

test('estimate permits a past expected year without implying present enrollment', () => {
    const result = estimateGraduationYear(input({ entryYear: 2010 }), syntheticReference(), { currentYear: CURRENT_YEAR });
    assert.deepEqual(result, { state: 'available', year: 2014, ruleId: 'SYN-ENG:utme', sourceVersion: SOURCE_VERSION });
});

test('estimate reports missing input when any entry is null', () => {
    const reference = syntheticReference();
    assert.deepEqual(
        estimateGraduationYear(input({ programmeId: null }), reference, { currentYear: CURRENT_YEAR }),
        { state: 'unavailable', reason: 'missing_input' },
    );
    assert.deepEqual(
        estimateGraduationYear(input({ entryYear: null }), reference, { currentYear: CURRENT_YEAR }),
        { state: 'unavailable', reason: 'missing_input' },
    );
    assert.deepEqual(
        estimateGraduationYear(input({ entryRoute: null }), reference, { currentYear: CURRENT_YEAR }),
        { state: 'unavailable', reason: 'missing_input' },
    );
});

test('estimate reports an unknown programme id', () => {
    const result = estimateGraduationYear(input({ programmeId: 'NO-SUCH-PROGRAMME' }), syntheticReference(), { currentYear: CURRENT_YEAR });
    assert.deepEqual(result, { state: 'unavailable', reason: 'unknown_programme' });
});

test('estimate never applies a rule from another national system', () => {
    const result = estimateGraduationYear(input({ programmeId: 'SYN-GH' }), syntheticReference(), { currentYear: CURRENT_YEAR });
    assert.deepEqual(result, { state: 'unavailable', reason: 'unsupported_country' });
});

test('estimate rejects a programme from outside the bound institution country', () => {
    const reference = syntheticReference();
    assert.deepEqual(
        estimateGraduationYear(input({ programmeId: 'SYN-ENG' }), reference, { currentYear: CURRENT_YEAR, expectedCountryCode: 'GH' }),
        { state: 'unavailable', reason: 'unsupported_country' },
    );
    assert.deepEqual(
        estimateGraduationYear(input({ programmeId: 'SYN-ENG' }), reference, { currentYear: CURRENT_YEAR, expectedCountryCode: 'NG' }),
        { state: 'available', year: 2026, ruleId: 'SYN-ENG:utme', sourceVersion: SOURCE_VERSION },
    );
    assert.deepEqual(
        estimateGraduationYear(input({ programmeId: 'SYN-ENG' }), reference, { currentYear: CURRENT_YEAR, expectedCountryCode: null }),
        { state: 'available', year: 2026, ruleId: 'SYN-ENG:utme', sourceVersion: SOURCE_VERSION },
    );
});

test('transfer route is unavailable without an explicit reviewed rule', () => {
    const reference = syntheticReference();
    assert.deepEqual(
        estimateGraduationYear(input({ entryRoute: 'transfer_other' }), reference, { currentYear: CURRENT_YEAR }),
        { state: 'unavailable', reason: 'unsupported_route' },
    );
    const withTransfer = syntheticReference({
        programmes: [programme({ programmeId: 'SYN-ENG', routes: { transfer_other: rule({ durationYears: 2 }) } })],
    });
    assert.deepEqual(
        estimateGraduationYear(input({ entryYear: 2024, entryRoute: 'transfer_other' }), withTransfer, { currentYear: CURRENT_YEAR }),
        { state: 'available', year: 2026, ruleId: 'SYN-ENG:transfer_other', sourceVersion: SOURCE_VERSION },
    );
});

test('estimate reports unreviewed, pending, and conflicting rules without guessing', () => {
    const reference = syntheticReference();
    assert.deepEqual(
        estimateGraduationYear(input({ programmeId: 'SYN-MED', entryRoute: 'de_200' }), reference, { currentYear: CURRENT_YEAR }),
        { state: 'unavailable', reason: 'unreviewed_rule' },
    );
    assert.deepEqual(
        estimateGraduationYear(input({ programmeId: 'SYN-PEND' }), reference, { currentYear: CURRENT_YEAR }),
        { state: 'unavailable', reason: 'unreviewed_rule' },
    );
    assert.deepEqual(
        estimateGraduationYear(input({ programmeId: 'SYN-CONF' }), reference, { currentYear: CURRENT_YEAR }),
        { state: 'unavailable', reason: 'conflicting_rule' },
    );
    assert.deepEqual(
        estimateGraduationYear(input(), syntheticReference({ calculationsEnabled: false }), { currentYear: CURRENT_YEAR }),
        { state: 'unavailable', reason: 'unreviewed_rule' },
    );
});

test('estimate reports out-of-range years instead of fabricating a value', () => {
    const reference = syntheticReference();
    assert.deepEqual(
        estimateGraduationYear(input({ entryYear: 1899 }), reference, { currentYear: CURRENT_YEAR }),
        { state: 'unavailable', reason: 'out_of_range' },
    );
    assert.deepEqual(
        estimateGraduationYear(input({ entryYear: 2027 }), reference, { currentYear: CURRENT_YEAR }),
        { state: 'unavailable', reason: 'out_of_range' },
    );
    assert.deepEqual(
        estimateGraduationYear(input({ entryYear: 2022.5 }), reference, { currentYear: CURRENT_YEAR }),
        { state: 'unavailable', reason: 'out_of_range' },
    );
    const longDuration = syntheticReference({
        programmes: [programme({ programmeId: 'SYN-ENG', routes: { utme: rule({ durationYears: 25 }) } })],
    });
    assert.deepEqual(
        estimateGraduationYear(input(), longDuration, { currentYear: CURRENT_YEAR }),
        { state: 'unavailable', reason: 'out_of_range' },
    );
});

test('estimate accepts the graduation-horizon boundary and rejects non-positive durations', () => {
    const boundary = syntheticReference({
        programmes: [programme({ programmeId: 'SYN-ENG', routes: { utme: rule({ durationYears: 20 }) } })],
    });
    assert.deepEqual(
        estimateGraduationYear(input({ entryYear: 2026 }), boundary, { currentYear: CURRENT_YEAR }),
        { state: 'available', year: 2046, ruleId: 'SYN-ENG:utme', sourceVersion: SOURCE_VERSION },
    );
    const invalid = syntheticReference({
        programmes: [programme({ programmeId: 'SYN-ENG', routes: { utme: rule({ durationYears: 0 }) } })],
    });
    assert.deepEqual(
        estimateGraduationYear(input(), invalid, { currentYear: CURRENT_YEAR }),
        { state: 'unavailable', reason: 'unreviewed_rule' },
    );
});

test('estimate never mutates the reference and never persists an available estimate', () => {
    const reference = syntheticReference();
    const snapshot = JSON.parse(JSON.stringify(reference)) as ProgrammeReference;
    const first = estimateGraduationYear(input(), reference, { currentYear: CURRENT_YEAR });
    const second = estimateGraduationYear(input(), reference, { currentYear: CURRENT_YEAR });
    assert.deepEqual(reference, snapshot);
    assert.deepEqual(first, second);
    assert.notEqual(first, second);
});

test('estimate input schema rejects country overrides, rule picks, and cross-user keys', () => {
    const forbidden: unknown[] = [
        { programmeId: 'SYN-ENG', entryYear: 2022, entryRoute: 'utme', countryCode: 'GH' },
        { programmeId: 'SYN-ENG', entryYear: 2022, entryRoute: 'utme', ruleId: 'SYN-ENG:utme' },
        { programmeId: 'SYN-ENG', entryYear: 2022, entryRoute: 'utme', sourceVersion: SOURCE_VERSION },
        { programmeId: 'SYN-ENG', entryYear: 2022, entryRoute: 'utme', userId: '11111111-1111-4111-8111-111111111111' },
        { programmeId: 'SYN-ENG', entryYear: 2022, entryRoute: 'utme', institutionId: '33333333-3333-4333-8333-333333333333' },
        { programmeId: 'SYN-ENG', entryYear: 2022, entryRoute: 'utme', revision: 1 },
    ];
    for (const body of forbidden) {
        assert.throws(() => estimateInputSchema.parse(body), ZodError, JSON.stringify(body));
    }
});

test('estimate input schema bounds identifiers and requires integer years', () => {
    assert.throws(() => estimateInputSchema.parse({ programmeId: '   ', entryYear: 2022, entryRoute: 'utme' }), ZodError);
    assert.throws(() => estimateInputSchema.parse({ programmeId: 'x'.repeat(129), entryYear: 2022, entryRoute: 'utme' }), ZodError);
    assert.throws(() => estimateInputSchema.parse({ programmeId: 'SYN-ENG', entryYear: 2022.5, entryRoute: 'utme' }), ZodError);
    assert.throws(() => estimateInputSchema.parse({ programmeId: 'SYN-ENG', entryYear: 2022, entryRoute: 'other' }), ZodError);
    assert.deepEqual(
        estimateInputSchema.parse({ programmeId: null, entryYear: null, entryRoute: null }),
        { programmeId: null, entryYear: null, entryRoute: null },
    );
});

test('catalogue query parsing bounds page size, query length, and keys', () => {
    assert.deepEqual(parseCatalogueQuery({}), { q: '', cursor: null, limit: CATALOGUE_DEFAULT_LIMIT });
    assert.deepEqual(
        parseCatalogueQuery({ q: '  eng ', limit: '5', cursor: encodeCatalogueCursor(5) }),
        { q: 'eng', cursor: encodeCatalogueCursor(5), limit: 5 },
    );
    assert.throws(() => parseCatalogueQuery({ limit: 0 }), ZodError);
    assert.throws(() => parseCatalogueQuery({ limit: CATALOGUE_MAX_LIMIT + 1 }), ZodError);
    assert.throws(() => parseCatalogueQuery({ limit: 2.5 }), ZodError);
    assert.throws(() => parseCatalogueQuery({ q: 'x'.repeat(129) }), ZodError);
    assert.throws(() => parseCatalogueQuery({ cursor: 'x'.repeat(513) }), ZodError);
    assert.throws(() => parseCatalogueQuery({ q: '', institutionId: 'intruder' }), ZodError);
    assert.throws(() => parseCatalogueQuery({ q: '', countryCode: 'GH' }), ZodError);
});

test('catalogue cursors are opaque, bounded, and validated', () => {
    const cursor = encodeCatalogueCursor(40);
    assert.match(cursor, /^[A-Za-z0-9_-]+$/);
    assert.equal(decodeCatalogueCursor(cursor), 40);
    assert.equal(decodeCatalogueCursor(null), 0);
    assert.equal(decodeCatalogueCursor(undefined), 0);
    for (const bad of ['not-a-cursor!!!', 'e30', encodeCatalogueCursor(1).slice(0, -2), '']) {
        assert.throws(() => decodeCatalogueCursor(bad), BadRequestError, bad || '(empty)');
    }
    const tampered = Buffer.from(JSON.stringify({ v: 2, offset: 3 }), 'utf8').toString('base64url');
    assert.throws(() => decodeCatalogueCursor(tampered), BadRequestError);
    const negative = Buffer.from(JSON.stringify({ v: 1, offset: -1 }), 'utf8').toString('base64url');
    assert.throws(() => decodeCatalogueCursor(negative), BadRequestError);
});

test('programme search returns bounded display-only pages in stable order', () => {
    const first = searchProgrammes(syntheticReference(), { q: '', cursor: null, limit: 2 });
    assert.deepEqual(first.items, [
        { programmeId: 'SYN-CONF', label: 'Synthetic Conflicted Programme', award: 'B.Sc' },
        { programmeId: 'SYN-ENG', label: 'Synthetic Engineering', award: 'B.Eng' },
    ]);
    assert.ok(first.nextCursor);
    const second = searchProgrammes(syntheticReference(), { q: '', cursor: first.nextCursor, limit: 2 });
    assert.deepEqual(second.items.map((item) => item.programmeId), ['SYN-GH', 'SYN-MED']);
    assert.ok(second.nextCursor);
    const third = searchProgrammes(syntheticReference(), { q: '', cursor: second.nextCursor, limit: 2 });
    assert.deepEqual(third.items.map((item) => item.programmeId), ['SYN-PEND']);
    assert.equal(third.nextCursor, null);
    for (const item of [...first.items, ...second.items, ...third.items]) {
        assert.deepEqual(Object.keys(item).sort(), ['award', 'label', 'programmeId']);
    }
});

test('programme search matches labels, aliases, and ids case-insensitively', () => {
    const reference = syntheticReference();
    assert.deepEqual(
        searchProgrammes(reference, { q: 'medicine', cursor: null, limit: 20 }).items.map((item) => item.programmeId),
        ['SYN-MED'],
    );
    assert.deepEqual(
        searchProgrammes(reference, { q: 'ENGINEERS-pick', cursor: null, limit: 20 }).items.map((item) => item.programmeId),
        ['SYN-ENG'],
    );
    assert.deepEqual(
        searchProgrammes(reference, { q: 'syn-med', cursor: null, limit: 20 }).items.map((item) => item.programmeId),
        ['SYN-MED'],
    );
    const empty = searchProgrammes(reference, { q: 'no such course', cursor: null, limit: 20 });
    assert.deepEqual(empty, { items: [], nextCursor: null });
});

test('programme search treats query punctuation literally and rejects bad cursors', () => {
    const reference = syntheticReference();
    const literal = searchProgrammes(reference, { q: 'SYN_%', cursor: null, limit: 20 });
    assert.deepEqual(literal, { items: [], nextCursor: null });
    assert.throws(() => searchProgrammes(reference, { q: '', cursor: 'bogus', limit: 20 }), BadRequestError);
    const beyond = searchProgrammes(reference, { q: '', cursor: encodeCatalogueCursor(500), limit: 20 });
    assert.deepEqual(beyond, { items: [], nextCursor: null });
});

test('programme search scopes bound students to their national reference', () => {
    const reference = syntheticReference();
    const scoped = searchProgrammes(reference, { q: '', cursor: null, limit: 20, countryCode: 'NG' });
    assert.deepEqual(scoped.items.map((item) => item.programmeId), ['SYN-CONF', 'SYN-ENG', 'SYN-MED', 'SYN-PEND']);
    assert.equal(scoped.nextCursor, null);
    const general = searchProgrammes(reference, { q: '', cursor: null, limit: 20, countryCode: null });
    assert.equal(general.items.length, 5);
});

test('programme search over the blocked production reference advertises nothing', () => {
    const reference = loadProgrammeReference();
    assert.equal(reference.calculationsEnabled, false);
    assert.deepEqual(searchProgrammes(reference, { q: '', cursor: null, limit: 20 }), { items: [], nextCursor: null });
    assert.deepEqual(
        estimateGraduationYear(input(), reference, { currentYear: CURRENT_YEAR }),
        { state: 'unavailable', reason: 'unreviewed_rule' },
    );
});

function syntheticArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        artifactVersion: 1,
        sourceVersion: SOURCE_VERSION,
        sourceChecksumSha256: '0'.repeat(64),
        redistributionAllowed: true,
        calculationsEnabled: true,
        programmes: [
            {
                programmeId: 'SYN-ENG',
                sourceId: 'SYN-ENG',
                label: 'Synthetic Engineering',
                award: 'B.Eng',
                aliases: ['engineers-pick'],
                discipline: 'Synthetic Discipline',
                locator: { sheet: 'Synthetic', row: 2 },
                evidence: 'G',
                routes: {
                    utme: { durationYears: 4, reviewed: true, applicable: true, pending: false, estimable: true },
                    de_200: { durationYears: 3, reviewed: true, applicable: true, pending: false, estimable: true },
                    de_300: { durationYears: null, reviewed: false, applicable: false, pending: true, estimable: false },
                },
                exceptionNotes: null,
            },
        ],
        excluded: [],
        blocked: [],
        counts: { total: 1, included: 1, excluded: 0, blocked: 0 },
        ...overrides,
    };
}

test('reference loader maps the Task 1 artifact and defaults it to the Nigerian register', () => {
    const reference = loadProgrammeReference(syntheticArtifact());
    assert.equal(reference.sourceVersion, SOURCE_VERSION);
    assert.equal(reference.calculationsEnabled, true);
    assert.equal(reference.programmes.length, 1);
    const [entry] = reference.programmes;
    assert.equal(entry?.programmeId, 'SYN-ENG');
    assert.equal(entry?.countryCode, 'NG');
    assert.deepEqual(entry?.routes['utme'], { durationYears: 4, reviewed: true, applicable: true, estimable: true });
    assert.deepEqual(
        estimateGraduationYear(input(), reference, { currentYear: CURRENT_YEAR }),
        { state: 'available', year: 2026, ruleId: 'SYN-ENG:utme', sourceVersion: SOURCE_VERSION },
    );
});

test('reference loader honors an explicit artifact country instead of assuming Nigeria', () => {
    const reference = loadProgrammeReference(syntheticArtifact({ countryCode: 'GH' }));
    assert.equal(reference.programmes[0]?.countryCode, 'GH');
    assert.deepEqual(
        estimateGraduationYear(input(), reference, { currentYear: CURRENT_YEAR }),
        { state: 'unavailable', reason: 'unsupported_country' },
    );
});

test('reference loader fails closed on malformed or withheld artifacts', () => {
    for (const artifact of [null, 42, 'nope', []]) {
        const reference = loadProgrammeReference(artifact);
        assert.equal(reference.sourceVersion, null);
        assert.equal(reference.calculationsEnabled, false);
        assert.deepEqual(reference.programmes, []);
        assert.deepEqual(
            estimateGraduationYear(input(), reference, { currentYear: CURRENT_YEAR }),
            { state: 'unavailable', reason: 'unreviewed_rule' },
        );
    }
    const versionOnly = loadProgrammeReference({ sourceVersion: SOURCE_VERSION });
    assert.equal(versionOnly.sourceVersion, SOURCE_VERSION);
    assert.equal(versionOnly.calculationsEnabled, false);
    assert.deepEqual(versionOnly.programmes, []);
    assert.deepEqual(
        estimateGraduationYear(input(), versionOnly, { currentYear: CURRENT_YEAR }),
        { state: 'unavailable', reason: 'unreviewed_rule' },
    );
    const withheld = loadProgrammeReference(syntheticArtifact({ calculationsEnabled: false, programmes: [] }));
    assert.equal(withheld.calculationsEnabled, false);
    assert.deepEqual(withheld.programmes, []);
});

test('country names map to ISO codes explicitly and never by guessing', () => {
    assert.equal(countryNameToCode('Nigeria'), 'NG');
    assert.equal(countryNameToCode('  nigeria  '), 'NG');
    assert.equal(countryNameToCode('Ghana'), 'GH');
    assert.equal(countryNameToCode('Unknown Country'), null);
    assert.equal(countryNameToCode(''), null);
    assert.equal(countryNameToCode(null), null);
    assert.equal(countryNameToCode(undefined), null);
});

const USER_ID = '11111111-1111-4111-8111-111111111111';
const STUDENT_ID = '22222222-2222-4222-8222-222222222222';
const UNIVERSITY_ID = '33333333-3333-4333-8333-333333333333';

type CatalogueFixture = {
    user: { id: string; role: string; deleted_at: Date | null };
    student: { id: string; university_id: string | null; identity_version: number; status: string; registration_number: string | null };
    university: { id: string; name: string; country: string | null; shortcode: string | null } | null;
    catalogue: Array<{ name: string; country: string | null }>;
};

function catalogueFixture(overrides: Partial<CatalogueFixture> = {}): CatalogueFixture {
    return {
        user: { id: USER_ID, role: 'student', deleted_at: null },
        student: { id: STUDENT_ID, university_id: null, identity_version: 1, status: 'active', registration_number: null },
        university: null,
        catalogue: [
            { name: 'Fixture University Alpha', country: 'Nigeria' },
            { name: 'Fixture University Beta', country: 'Ghana' },
            { name: 'Fixture Unmapped College', country: 'Atlantis' },
        ],
        ...overrides,
    };
}

function createCataloguePool(fixture: CatalogueFixture): { connect: () => Promise<unknown>; statements: Array<{ text: string; params: unknown[] }> } {
    const statements: Array<{ text: string; params: unknown[] }> = [];
    const client = {
        query: async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
            const normalized = text.replace(/\s+/g, ' ').trim();
            statements.push({ text: normalized, params });
            if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
                return { rows: [], rowCount: 0 };
            }
            if (normalized.includes('FROM users')) {
                return { rows: [fixture.user], rowCount: 1 };
            }
            if (normalized.includes('FROM students')) {
                return { rows: [fixture.student], rowCount: 1 };
            }
            if (normalized.includes('FROM universities') && normalized.includes('FOR KEY SHARE')) {
                return { rows: fixture.university ? [fixture.university] : [], rowCount: fixture.university ? 1 : 0 };
            }
            if (normalized.includes('FROM universities')) {
                const pattern = params.find((param) => typeof param === 'string' && param.includes('%'));
                const needle = (typeof pattern === 'string' ? pattern : '%%').replace(/^%|%$/g, '').replace(/\\(.)/g, '$1').toLowerCase();
                const limit = typeof params[params.length - 2] === 'number' ? (params[params.length - 2] as number) : 20;
                const offset = typeof params[params.length - 1] === 'number' ? (params[params.length - 1] as number) : 0;
                const scopedId = params.find((param) => param === UNIVERSITY_ID);
                let rows = fixture.catalogue.filter((row) => row.name.toLowerCase().includes(needle));
                if (scopedId !== undefined) {
                    rows = rows.filter((row) => row.name === fixture.university?.name);
                }
                const page = rows.slice(offset, offset + limit);
                return { rows: page, rowCount: page.length };
            }
            throw new Error(`Unexpected query: ${normalized}`);
        },
        release: (): void => undefined,
    };
    return { connect: async () => client, statements };
}

test('unbound students search the general institution catalogue with display fields only', async () => {
    const pool = createCataloguePool(catalogueFixture());
    const page = await searchInstitutionsForStudent(pool, USER_ID, { q: 'fixture', limit: 2 });
    assert.deepEqual(page.items, [
        { name: 'Fixture University Alpha', countryCode: 'NG' },
        { name: 'Fixture University Beta', countryCode: 'GH' },
    ]);
    assert.ok(page.nextCursor);
    const next = await searchInstitutionsForStudent(pool, USER_ID, { q: 'fixture', limit: 2, cursor: page.nextCursor });
    assert.deepEqual(next.items, [{ name: 'Fixture Unmapped College', countryCode: null }]);
    assert.equal(next.nextCursor, null);
    for (const item of [...page.items, ...next.items]) {
        assert.deepEqual(Object.keys(item).sort(), ['countryCode', 'name']);
    }
});

test('institution search uses parameterized SQL and escapes LIKE wildcards', async () => {
    const pool = createCataloguePool(catalogueFixture());
    await searchInstitutionsForStudent(pool, USER_ID, { q: '100%_\\', limit: 5 });
    const catalogue = pool.statements.filter((statement) => statement.text.includes('FROM universities') && !statement.text.includes('FOR KEY SHARE'));
    assert.equal(catalogue.length, 1);
    const statement = catalogue[0];
    assert.ok(statement && !statement.text.includes('100%_\\'), 'query text must stay in bound params');
    assert.ok(statement?.text.includes('ILIKE'), 'search must be case-insensitive');
    assert.ok(statement?.text.includes('$1'), 'search pattern must be a bound param');
    assert.deepEqual(statement?.params[0], '%100\\%\\_\\\\%');
});

test('bound students see only their server-bound institution; scope never comes from the client', async () => {
    const pool = createCataloguePool(catalogueFixture({
        student: { id: STUDENT_ID, university_id: UNIVERSITY_ID, identity_version: 1, status: 'active', registration_number: null },
        university: { id: UNIVERSITY_ID, name: 'Fixture University Alpha', country: 'Nigeria', shortcode: 'alpha' },
    }));
    const page = await searchInstitutionsForStudent(pool, USER_ID, { q: '', limit: 20 });
    assert.deepEqual(page.items, [{ name: 'Fixture University Alpha', countryCode: 'NG' }]);
    assert.equal(page.nextCursor, null);
    const scoped = pool.statements.filter((statement) => statement.text.includes('FROM universities') && !statement.text.includes('FOR KEY SHARE'));
    assert.ok(scoped[0]?.params.includes(UNIVERSITY_ID), 'bound scope must be server-resolved');
    await assert.rejects(searchInstitutionsForStudent(pool, USER_ID, { q: '', institutionId: UNIVERSITY_ID }), ZodError);
});

test('institution search denies soft-deleted accounts and non-students', async () => {
    const deleted = createCataloguePool(catalogueFixture({
        user: { id: USER_ID, role: 'student', deleted_at: new Date('2026-01-02T00:00:00.000Z') },
    }));
    await assert.rejects(searchInstitutionsForStudent(deleted, USER_ID, { q: '' }), NotFoundError);
    const vendor = createCataloguePool(catalogueFixture({
        user: { id: USER_ID, role: 'vendor', deleted_at: null },
    }));
    await assert.rejects(searchInstitutionsForStudent(vendor, USER_ID, { q: '' }), ForbiddenError);
});

test('programme search for students scopes bound contexts without a client country override', async () => {
    const bound = createCataloguePool(catalogueFixture({
        student: { id: STUDENT_ID, university_id: UNIVERSITY_ID, identity_version: 1, status: 'active', registration_number: null },
        university: { id: UNIVERSITY_ID, name: 'Fixture University Alpha', country: 'Nigeria', shortcode: 'alpha' },
    }));
    const scoped = await searchProgrammesForStudent(bound, USER_ID, { q: '' }, { reference: syntheticReference() });
    assert.deepEqual(scoped.items.map((item) => item.programmeId), ['SYN-CONF', 'SYN-ENG', 'SYN-MED', 'SYN-PEND']);
    const unbound = createCataloguePool(catalogueFixture());
    const general = await searchProgrammesForStudent(unbound, USER_ID, { q: '' }, { reference: syntheticReference() });
    assert.equal(general.items.length, 5);
    await assert.rejects(searchProgrammesForStudent(unbound, USER_ID, { q: '', countryCode: 'NG' }), ZodError);
});

test('student estimate locks the server context, computes, and never writes', async () => {
    const pool = createCataloguePool(catalogueFixture());
    const result = await estimateGraduationYearForStudent(
        pool,
        USER_ID,
        { programmeId: 'SYN-ENG', entryYear: 2022, entryRoute: 'utme' },
        { reference: syntheticReference(), currentYear: CURRENT_YEAR },
    );
    assert.deepEqual(result, { state: 'available', year: 2026, ruleId: 'SYN-ENG:utme', sourceVersion: SOURCE_VERSION });
    const writes = pool.statements.filter((statement) => /^(INSERT|UPDATE|DELETE)/.test(statement.text));
    assert.deepEqual(writes, []);
    const deleted = createCataloguePool(catalogueFixture({
        user: { id: USER_ID, role: 'student', deleted_at: new Date('2026-01-02T00:00:00.000Z') },
    }));
    await assert.rejects(
        estimateGraduationYearForStudent(deleted, USER_ID, { programmeId: 'SYN-ENG', entryYear: 2022, entryRoute: 'utme' }),
        NotFoundError,
    );
});

test('student estimate enforces the bound institution country', async () => {
    const ghanaBound = createCataloguePool(catalogueFixture({
        student: { id: STUDENT_ID, university_id: UNIVERSITY_ID, identity_version: 1, status: 'active', registration_number: null },
        university: { id: UNIVERSITY_ID, name: 'Fixture University Accra', country: 'Ghana', shortcode: 'accra' },
    }));
    assert.deepEqual(
        await estimateGraduationYearForStudent(
            ghanaBound,
            USER_ID,
            { programmeId: 'SYN-ENG', entryYear: 2022, entryRoute: 'utme' },
            { reference: syntheticReference(), currentYear: CURRENT_YEAR },
        ),
        { state: 'unavailable', reason: 'unsupported_country' },
    );
    const nigeriaBound = createCataloguePool(catalogueFixture({
        student: { id: STUDENT_ID, university_id: UNIVERSITY_ID, identity_version: 1, status: 'active', registration_number: null },
        university: { id: UNIVERSITY_ID, name: 'Fixture University Alpha', country: 'Nigeria', shortcode: 'alpha' },
    }));
    assert.deepEqual(
        await estimateGraduationYearForStudent(
            nigeriaBound,
            USER_ID,
            { programmeId: 'SYN-ENG', entryYear: 2022, entryRoute: 'utme' },
            { reference: syntheticReference(), currentYear: CURRENT_YEAR },
        ),
        { state: 'available', year: 2026, ruleId: 'SYN-ENG:utme', sourceVersion: SOURCE_VERSION },
    );
});
