import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    ARTIFACT_VERSION,
    KNOWN_EVIDENCE,
    KNOWN_ROUTES,
    MAX_ESTIMABLE_PROGRAMME_ID_LENGTH,
    MAX_ESTIMATE_SOURCE_VERSION_LENGTH,
    buildReference,
    classifyRow,
    computeArtifactChecksum,
    getEstimableRouteRule,
    parseArgs,
    stableStringify,
    writeArtifact,
} from './build-academic-programme-reference.mjs';

const CHECKSUM = 'a'.repeat(64);
const OTHER_CHECKSUM = 'b'.repeat(64);

function baseRow(overrides = {}) {
    return {
        sourceId: 'SYN-001',
        programmeLabel: 'Synthetic Crop Science',
        award: 'B.Sc.',
        aliases: ['Syn Crop Sci'],
        discipline: 'Synthetic Discipline',
        locator: { sheet: 'Synthetic Register', row: 2, sourceRef: 'SYN-SRC', pages: 'p. 1' },
        evidence: 'G',
        routes: {
            utme: { durationYears: 4, reviewed: true, applicable: true },
            de_200: { durationYears: 3, reviewed: true, applicable: true },
            de_300: { durationYears: null, reviewed: false, applicable: false },
        },
        flags: { legacy: false, derived: false, awardCaveat: false, numericConflict: false },
        exceptionNotes: null,
        ...overrides,
    };
}

function baseExtract(rows, overrides = {}) {
    return {
        sourceVersion: 'synthetic-v1',
        sourceChecksumSha256: CHECKSUM,
        rows,
        ...overrides,
    };
}

function build(rows, options = {}) {
    return buildReference({
        extract: baseExtract(rows),
        expectedChecksum: CHECKSUM,
        redistribution: 'allowed',
        ...options,
    });
}

function dispositions(artifact) {
    return {
        included: artifact.programmes.map((entry) => entry.sourceId),
        excluded: artifact.excluded.map((entry) => entry.sourceId),
        blocked: artifact.blocked.map((entry) => entry.sourceId),
    };
}

test('every source id is classified exactly once as included, excluded, or blocked', () => {
    const included = baseRow({ sourceId: 'SYN-001', aliases: ['Alpha'] });
    const excluded = baseRow({
        sourceId: 'SYN-002',
        programmeLabel: 'Synthetic Variant Study',
        aliases: ['Beta'],
        locator: { sheet: 'Synthetic Register', row: 3 },
        evidence: 'V',
        routes: { utme: { durationYears: null, reviewed: false, applicable: false } },
    });
    const blocked = { sourceId: 'SYN-003', withheld: true, locator: { sheet: 'Synthetic Register', row: 4 } };
    const artifact = build([included, excluded, blocked]);
    const seen = dispositions(artifact);
    assert.deepEqual(seen, { included: ['SYN-001'], excluded: ['SYN-002'], blocked: ['SYN-003'] });
    assert.deepEqual(artifact.counts, { total: 3, included: 1, excluded: 1, blocked: 1 });
    const all = [...seen.included, ...seen.excluded, ...seen.blocked].sort();
    assert.deepEqual(all, ['SYN-001', 'SYN-002', 'SYN-003']);
});

test('duplicate source ids fail generation', () => {
    const first = baseRow({ sourceId: 'SYN-001', aliases: ['Alpha'] });
    const second = baseRow({ sourceId: 'SYN-001', programmeLabel: 'Other Label', aliases: ['Beta'] });
    assert.throws(() => build([first, second]), /duplicate source id/i);
});

test('duplicate normalized programme ids fail generation', () => {
    const first = baseRow({ sourceId: 'SYN-001', aliases: ['Alpha'] });
    const second = baseRow({ sourceId: 'syn-001', programmeLabel: 'Other Label', aliases: ['Beta'] });
    assert.throws(() => build([first, second]), /duplicate/i);
});

test('duplicate aliases fail generation, matched case-insensitively', () => {
    const first = baseRow({ sourceId: 'SYN-001', aliases: ['Evening Crop'] });
    const second = baseRow({ sourceId: 'SYN-002', programmeLabel: 'Other Label', aliases: ['evening crop'] });
    assert.throws(() => build([first, second]), /duplicate alias/i);
});

test('aliases colliding with another source id fail generation', () => {
    const first = baseRow({ sourceId: 'SYN-001', aliases: ['SYN-002'] });
    const second = baseRow({ sourceId: 'SYN-002', programmeLabel: 'Other Label', aliases: ['Beta'] });
    assert.throws(() => build([first, second]), /alias .* collides|duplicate/i);
});

test('empty aliases fail generation', () => {
    assert.throws(() => build([baseRow({ aliases: ['  '] })]), /alias/i);
});

test('over-long source ids fail generation before they can overflow rule-id storage', () => {
    const longest = `syn-${'0'.repeat(MAX_ESTIMABLE_PROGRAMME_ID_LENGTH - 4)}`;
    assert.equal(longest.length, MAX_ESTIMABLE_PROGRAMME_ID_LENGTH);
    const artifact = build([baseRow({ sourceId: longest })]);
    assert.equal(artifact.programmes[0].programmeId, longest.toLowerCase());
    assert.throws(() => build([baseRow({ sourceId: `${longest}0` })]), /cannot form a storable rule id/i);
});

test('over-long source versions fail generation before they can overflow estimate storage', () => {
    const longest = `v${'0'.repeat(MAX_ESTIMATE_SOURCE_VERSION_LENGTH - 1)}`;
    assert.equal(longest.length, MAX_ESTIMATE_SOURCE_VERSION_LENGTH);
    const artifact = build([baseRow()], { extract: baseExtract([baseRow()], { sourceVersion: longest }) });
    assert.equal(artifact.sourceVersion, longest);
    assert.throws(
        () => build([baseRow()], { extract: baseExtract([baseRow()], { sourceVersion: `${longest}0` }) }),
        /cannot be stored on accept/i,
    );
});

test('missing source locators fail generation', () => {
    const missing = baseRow({ sourceId: 'SYN-001' });
    delete missing.locator;
    assert.throws(() => build([missing]), /locator/i);
    assert.throws(() => build([baseRow({ locator: { sheet: '', row: 2 } })]), /locator/i);
    assert.throws(() => build([baseRow({ locator: { sheet: 'Synthetic Register', row: 0 } })]), /locator/i);
});

test('unknown evidence statuses fail generation', () => {
    assert.ok(KNOWN_EVIDENCE.includes('G'));
    assert.ok(KNOWN_EVIDENCE.includes('P/U'));
    for (const evidence of ['X', 'G/P', '', 'g']) {
        assert.throws(() => build([baseRow({ evidence })]), /unknown evidence/i, `evidence ${evidence}`);
    }
});

test('exact pending marker U excludes the row without estimates', () => {
    const row = baseRow({
        evidence: 'U',
        routes: {
            utme: { durationYears: 4, reviewed: true, applicable: true },
            de_200: { durationYears: 3, reviewed: true, applicable: true },
        },
    });
    assert.deepEqual(classifyRow(row, { redistribution: 'allowed' }), {
        disposition: 'excluded',
        reason: 'unresolved_pending',
    });
    const artifact = build([row]);
    assert.deepEqual(dispositions(artifact).excluded, ['SYN-001']);
    for (const route of KNOWN_ROUTES) {
        assert.equal(getEstimableRouteRule(artifact, 'syn-001', route), null, route);
    }
});

test('compound pending marker P/U keeps UTME reviewable but never approves DE routes', () => {
    const row = baseRow({
        evidence: 'P/U',
        aliases: [],
        routes: {
            utme: { durationYears: 4, reviewed: true, applicable: true },
            de_200: { durationYears: 3, reviewed: false, applicable: true },
            de_300: { durationYears: null, reviewed: true, applicable: false },
        },
    });
    const artifact = build([row]);
    assert.deepEqual(dispositions(artifact).included, ['SYN-001']);
    assert.deepEqual(getEstimableRouteRule(artifact, 'syn-001', 'utme'), {
        durationYears: 4,
        ruleId: 'syn-001:utme',
        sourceVersion: 'synthetic-v1',
    });
    // An exact match on 'U' alone would miss 'P/U'; both DE routes must stay unavailable.
    assert.equal(getEstimableRouteRule(artifact, 'syn-001', 'de_200'), null);
    assert.equal(getEstimableRouteRule(artifact, 'syn-001', 'de_300'), null);
    assert.equal(artifact.programmes[0].routes.de_200.pending, true);
    assert.equal(artifact.programmes[0].routes.de_300.pending, true);
    assert.equal(artifact.programmes[0].routes.utme.pending, false);
});

test('approving an unresolved P/U DE route fails as inconsistent', () => {
    const row = baseRow({
        evidence: 'P/U',
        routes: {
            utme: { durationYears: 4, reviewed: true, applicable: true },
            de_200: { durationYears: 3, reviewed: true, applicable: true },
        },
    });
    assert.throws(() => build([row]), /inconsistent route values/i);
});

test('numeric conflicts are excluded with a reason and cannot estimate', () => {
    const flagged = baseRow({ sourceId: 'SYN-001', aliases: ['Alpha'], flags: { legacy: false, derived: false, awardCaveat: false, numericConflict: true } });
    const conflictingText = baseRow({
        sourceId: 'SYN-002',
        programmeLabel: 'Other Label',
        aliases: ['Beta'],
        locator: { sheet: 'Synthetic Register', row: 3 },
        evidence: 'C',
    });
    assert.deepEqual(classifyRow(flagged, { redistribution: 'allowed' }).reason, 'numeric_conflict');
    assert.deepEqual(classifyRow(conflictingText, { redistribution: 'allowed' }).reason, 'conflicting_text');
    const artifact = build([flagged, conflictingText]);
    assert.deepEqual(artifact.excluded.map((entry) => entry.reason).sort(), ['conflicting_text', 'numeric_conflict']);
    for (const programmeId of ['syn-001', 'syn-002']) {
        for (const route of KNOWN_ROUTES) {
            assert.equal(getEstimableRouteRule(artifact, programmeId, route), null, `${programmeId}:${route}`);
        }
    }
});

test('legacy and derived rows are excluded with a reason', () => {
    const cases = [
        [baseRow({ flags: { legacy: true, derived: false, awardCaveat: false, numericConflict: false } }), 'legacy_pathway'],
        [baseRow({ evidence: 'L', routes: { utme: { durationYears: null, reviewed: false, applicable: false } } }), 'legacy_pathway'],
        [baseRow({ flags: { legacy: false, derived: true, awardCaveat: false, numericConflict: false } }), 'derived_value'],
        [baseRow({ evidence: 'P/R', routes: { utme: { durationYears: null, reviewed: false, applicable: false } } }), 'derived_value'],
        [baseRow({ evidence: 'V', routes: { utme: { durationYears: null, reviewed: false, applicable: false } } }), 'variant_unresolved'],
    ];
    for (const [row, reason] of cases) {
        assert.deepEqual(classifyRow(row, { redistribution: 'allowed' }), { disposition: 'excluded', reason });
        const artifact = build([row]);
        assert.equal(getEstimableRouteRule(artifact, 'syn-001', 'utme'), null, reason);
    }
});

test('award caveats are excluded pending review', () => {
    const row = baseRow({ flags: { legacy: false, derived: false, awardCaveat: true, numericConflict: false } });
    assert.deepEqual(classifyRow(row, { redistribution: 'allowed' }), { disposition: 'excluded', reason: 'award_caveat' });
    const artifact = build([row]);
    assert.equal(getEstimableRouteRule(artifact, 'syn-001', 'utme'), null);
});

test('imported G/P labels and numeric values alone never approve an estimate', () => {
    for (const evidence of ['G', 'P', 'P/G']) {
        const row = baseRow({
            evidence,
            routes: {
                utme: { durationYears: 4, reviewed: false, applicable: true },
                de_200: { durationYears: 3, reviewed: false, applicable: true },
            },
        });
        const artifact = build([row]);
        assert.deepEqual(dispositions(artifact).included, ['SYN-001'], evidence);
        assert.equal(getEstimableRouteRule(artifact, 'syn-001', 'utme'), null, evidence);
        assert.equal(getEstimableRouteRule(artifact, 'syn-001', 'de_200'), null, evidence);
    }
});

test('route-specific review enables only the reviewed applicable route', () => {
    const row = baseRow({
        aliases: [],
        routes: {
            utme: { durationYears: 4, reviewed: true, applicable: true },
            de_200: { durationYears: 3, reviewed: true, applicable: false },
            de_300: { durationYears: 2, reviewed: false, applicable: true },
        },
    });
    const artifact = build([row]);
    assert.deepEqual(getEstimableRouteRule(artifact, 'syn-001', 'utme'), {
        durationYears: 4,
        ruleId: 'syn-001:utme',
        sourceVersion: 'synthetic-v1',
    });
    assert.equal(getEstimableRouteRule(artifact, 'syn-001', 'de_200'), null);
    assert.equal(getEstimableRouteRule(artifact, 'syn-001', 'de_300'), null);
});

test('reviewed applicable routes without durations fail instead of inferring', () => {
    const row = baseRow({ routes: { utme: { durationYears: null, reviewed: true, applicable: true } } });
    assert.throws(() => build([row]), /inconsistent route values/i);
});

test('unknown route keys and malformed route values fail generation', () => {
    assert.throws(() => build([baseRow({ routes: { de_400: { durationYears: 2, reviewed: true, applicable: true } } })]), /unknown route/i);
    for (const durationYears of [0, -1, 2.5, '4', Number.NaN]) {
        const row = baseRow({ routes: { utme: { durationYears, reviewed: false, applicable: true } } });
        assert.throws(() => build([row]), /duration/i, `duration ${String(durationYears)}`);
    }
    assert.throws(() => build([baseRow({ routes: { utme: { durationYears: 4, reviewed: 'yes', applicable: true } } })]), /reviewed/i);
    assert.throws(() => build([baseRow({ routes: { utme: { durationYears: 4, reviewed: true } } })]), /applicable/i);
});

test('checksum mismatch fails generation', () => {
    assert.throws(
        () => build([baseRow()], { expectedChecksum: OTHER_CHECKSUM }),
        /checksum mismatch/i,
    );
});

test('malformed extract shapes fail generation', () => {
    assert.throws(() => buildReference({ extract: null, expectedChecksum: CHECKSUM, redistribution: 'allowed' }), /extract/i);
    assert.throws(
        () => buildReference({ extract: baseExtract('rows'), expectedChecksum: CHECKSUM, redistribution: 'allowed' }),
        /rows.*array/i,
    );
    assert.throws(
        () => buildReference({
            extract: baseExtract([baseRow()], { sourceVersion: ' ' }),
            expectedChecksum: CHECKSUM,
            redistribution: 'allowed',
        }),
        /source version/i,
    );
    assert.throws(
        () => buildReference({
            extract: baseExtract([baseRow()], { sourceChecksumSha256: 'not-a-hash' }),
            expectedChecksum: 'not-a-hash',
            redistribution: 'allowed',
        }),
        /checksum/i,
    );
    assert.throws(
        () => buildReference({ extract: baseExtract([baseRow()]), expectedChecksum: CHECKSUM, redistribution: 'maybe' }),
        /redistribution/i,
    );
});

test('output is deterministic with a verifiable checksum', () => {
    const first = baseRow({ sourceId: 'SYN-001', aliases: ['Alpha'] });
    const second = baseRow({
        sourceId: 'SYN-002',
        programmeLabel: 'Synthetic Soil Study',
        aliases: ['Beta'],
        locator: { sheet: 'Synthetic Register', row: 3 },
        routes: { utme: { durationYears: 5, reviewed: true, applicable: true } },
    });
    const forward = build([first, second]);
    const reversed = build([second, first]);
    assert.equal(stableStringify(forward), stableStringify(reversed));
    assert.equal(forward.artifactVersion, ARTIFACT_VERSION);
    assert.deepEqual(
        forward.programmes.map((entry) => entry.programmeId),
        ['syn-001', 'syn-002'],
    );
    const { checksum, ...rest } = forward;
    assert.equal(checksum, computeArtifactChecksum(rest));
    assert.match(checksum, /^[0-9a-f]{64}$/);

    const directory = mkdtempSync(join(tmpdir(), 'awoof-programme-reference-'));
    try {
        const firstPath = join(directory, 'first.json');
        const secondPath = join(directory, 'second.json');
        writeArtifact(forward, firstPath);
        writeArtifact(reversed, secondPath);
        assert.equal(readFileSync(firstPath, 'utf8'), readFileSync(secondPath, 'utf8'));
        const roundTripped = JSON.parse(readFileSync(firstPath, 'utf8'));
        const { checksum: fileChecksum, ...fileRest } = roundTripped;
        assert.equal(fileChecksum, computeArtifactChecksum(fileRest));
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('excluded and blocked rows carry only disposition metadata and cannot estimate', () => {
    const excluded = baseRow({ sourceId: 'SYN-001', aliases: ['Alpha'], evidence: 'C' });
    const blocked = { sourceId: 'SYN-002', withheld: true, locator: { sheet: 'Synthetic Register', row: 3 } };
    const artifact = build([excluded, blocked]);
    assert.deepEqual(Object.keys(artifact.excluded[0]).sort(), ['locator', 'reason', 'sourceId']);
    assert.deepEqual(Object.keys(artifact.blocked[0]).sort(), ['locator', 'reason', 'sourceId']);
    assert.equal(getEstimableRouteRule(artifact, 'syn-001', 'utme'), null);
    assert.equal(getEstimableRouteRule(artifact, 'syn-002', 'utme'), null);
    assert.equal(getEstimableRouteRule(artifact, 'syn-999', 'utme'), null);
    assert.equal(getEstimableRouteRule(artifact, 'syn-001', 'transfer_other'), null);
});

test('blocked redistribution withholds every row and disables calculations', () => {
    const artifact = build([baseRow()], { redistribution: 'blocked' });
    assert.equal(artifact.redistributionAllowed, false);
    assert.equal(artifact.calculationsEnabled, false);
    assert.deepEqual(artifact.programmes, []);
    assert.deepEqual(artifact.blocked, [
        { sourceId: 'SYN-001', reason: 'redistribution_not_permitted', locator: { sheet: 'Synthetic Register', row: 2 } },
    ]);
    assert.deepEqual(artifact.counts, { total: 1, included: 0, excluded: 0, blocked: 1 });
    assert.equal(getEstimableRouteRule(artifact, 'syn-001', 'utme'), null);
    assert.ok(!stableStringify(artifact).includes('Synthetic Crop Science'));
});

test('withheld rows are blocked without carrying source content', () => {
    const row = { sourceId: 'SYN-009', withheld: true, locator: { sheet: 'Synthetic Register', row: 10 } };
    assert.deepEqual(classifyRow(row, { redistribution: 'allowed' }), {
        disposition: 'blocked',
        reason: 'content_withheld_pending_licence',
    });
    const artifact = build([row]);
    assert.deepEqual(artifact.blocked, [
        { sourceId: 'SYN-009', reason: 'content_withheld_pending_licence', locator: { sheet: 'Synthetic Register', row: 10 } },
    ]);
});

test('argument parsing requires an explicit source, output, checksum, and redistribution flag', () => {
    const parsed = parseArgs([
        '--source',
        '/tmp/extract.json',
        '--output',
        '/tmp/reference.json',
        '--expected-checksum',
        CHECKSUM,
        '--redistribution',
        'blocked',
    ]);
    assert.deepEqual(parsed, {
        source: '/tmp/extract.json',
        output: '/tmp/reference.json',
        expectedChecksum: CHECKSUM,
        redistribution: 'blocked',
    });
    assert.throws(() => parseArgs(['--output', '/tmp/reference.json', '--expected-checksum', CHECKSUM, '--redistribution', 'blocked']), /--source/i);
    assert.throws(() => parseArgs(['--source', '/tmp/extract.json', '--expected-checksum', CHECKSUM, '--redistribution', 'blocked']), /--output/i);
    assert.throws(
        () => parseArgs(['--source', '/tmp/extract.json', '--output', '/tmp/reference.json', '--expected-checksum', CHECKSUM]),
        /--redistribution/i,
    );
    assert.throws(
        () => parseArgs(['--source', '/tmp/extract.json', '--output', '/tmp/reference.json', '--expected-checksum', CHECKSUM, '--redistribution', 'sometimes']),
        /redistribution/i,
    );
    assert.throws(
        () => parseArgs(['--source', '/tmp/extract.json', '--output', '/tmp/reference.json', '--expected-checksum', CHECKSUM, '--redistribution', 'blocked', '--unknown']),
        /unknown argument/i,
    );
});

test('importer accepts an explicit source path and hard-codes no developer path', () => {
    const importerPath = join(dirname(fileURLToPath(import.meta.url)), 'build-academic-programme-reference.mjs');
    const source = readFileSync(importerPath, 'utf8');
    assert.ok(!source.includes('Downloads'), 'importer must not reference a Downloads folder');
    assert.ok(!source.includes('/Users/'), 'importer must not hard-code a developer home path');
    assert.ok(!source.includes('.xlsx'), 'importer must not assume the original workbook path');
});
