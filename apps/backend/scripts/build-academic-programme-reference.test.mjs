import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    ARTIFACT_VERSION,
    INCLUDED_EVIDENCE,
    KNOWN_EVIDENCE,
    KNOWN_ROUTES,
    MAX_ESTIMABLE_PROGRAMME_ID_LENGTH,
    MAX_ESTIMATE_SOURCE_VERSION_LENGTH,
    buildReference,
    verifyProgrammeReferenceArtifact,
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

test('reference verification rejects staged programmes when redistribution is blocked', () => {
    const honest = build([baseRow()], { redistribution: 'blocked' });
    withTempArtifact(honest, (file) => {
        assert.deepEqual(verifyProgrammeReferenceArtifact(file), honest);
    });
    const smuggled = build([baseRow()]);
    smuggled.redistributionAllowed = false;
    smuggled.calculationsEnabled = false;
    for (const entry of smuggled.programmes) {
        for (const route of Object.values(entry.routes)) route.estimable = false;
    }
    reseal(smuggled);
    withTempArtifact(smuggled, (file) => {
        assert.throws(() => verifyProgrammeReferenceArtifact(file), /must not stage programmes/);
    });
});

test('reference verification anchors production filenames to trusted digests', () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const production = join(scriptsDir, '..', 'src', 'data', 'academic-programmes', 'nuc-v2.normalized.json');
    assert.equal(
        verifyProgrammeReferenceArtifact(production).checksum,
        '68df62beff526d4c6218d78c4d9ba5c790b53926ce8fd342d055b0a100518732',
    );
    const edited = build([baseRow()]);
    edited.programmes[0].routes.utme.durationYears += 1;
    reseal(edited);
    // Self-consistent and shape-valid, yet rejected under the production
    // name: only the reviewed generated bytes may stage there.
    withTempNamedArtifact(edited, 'nuc-v2.normalized.json', (file) => {
        assert.throws(() => verifyProgrammeReferenceArtifact(file), /trusted generated artifact/);
    });
    withTempArtifact(edited, (file) => {
        assert.deepEqual(verifyProgrammeReferenceArtifact(file), edited);
    });
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

function writeTempArtifact(artifact) {
    const directory = mkdtempSync(join(tmpdir(), 'awoof-ref-verify-'));
    const file = join(directory, 'ref.json');
    writeFileSync(file, JSON.stringify(artifact, null, 2));
    return { directory, file };
}

function withTempArtifact(artifact, run) {
    const { directory, file } = writeTempArtifact(artifact);
    try {
        return run(file);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

function withTempNamedArtifact(artifact, name, run) {
    const directory = mkdtempSync(join(tmpdir(), 'awoof-ref-verify-'));
    const file = join(directory, name);
    writeFileSync(file, JSON.stringify(artifact, null, 2));
    try {
        return run(file);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

test('reference verification accepts deterministic builder output', () => {
    const artifact = build([baseRow()]);
    withTempArtifact(artifact, (file) => {
        assert.deepEqual(verifyProgrammeReferenceArtifact(file), artifact);
    });
});

test('reference verification rejects edits that bypass the importer', () => {
    const blocked = build([baseRow()], { redistribution: 'blocked' });
    assert.equal(blocked.calculationsEnabled, false);
    blocked.calculationsEnabled = true;
    withTempArtifact(blocked, (file) => {
        assert.throws(() => verifyProgrammeReferenceArtifact(file), /only be enabled with redistribution/);
    });
    const cases = [
        ['altered disposition content', (artifact) => { artifact.blocked.push({ sourceId: 'SYN-X', reason: 'synthetic', locator: { sheet: 'S', row: 1 } }); }, /counts do not match/],
        ['altered programme label', (artifact) => { artifact.programmes.push({ programmeId: 'x', sourceId: 'y', label: 'z', award: null, aliases: [], discipline: null, locator: { sheet: 'S', row: 1 }, evidence: 'G', routes: {}, exceptionNotes: null }); }, /counts do not match/],
        ['wrong artifact version', (artifact) => { artifact.artifactVersion = 2; }, /unsupported artifact version/],
        ['unknown top-level field', (artifact) => { artifact.surprise = true; }, /unknown artifact field/],
        ['over-long source version', (artifact) => { artifact.sourceVersion = 'v'.repeat(MAX_ESTIMATE_SOURCE_VERSION_LENGTH + 1); }, /exceeds the storable limit/],
    ];
    for (const [label, mutate, pattern] of cases) {
        const artifact = build([baseRow()]);
        mutate(artifact);
        withTempArtifact(artifact, (file) => {
            assert.throws(() => verifyProgrammeReferenceArtifact(file), pattern, label);
        });
    }
});

test('reference verification rejects checksum mismatches on semantically valid edits', () => {
    const artifact = build([baseRow()]);
    artifact.blocked.push({ sourceId: 'SYN-X', reason: 'synthetic', locator: { sheet: 'S', row: 1 } });
    artifact.counts.blocked += 1;
    artifact.counts.total += 1;
    withTempArtifact(artifact, (file) => {
        assert.throws(() => verifyProgrammeReferenceArtifact(file), /checksum mismatch/);
    });
});

function pendingEvidenceRow() {
    return baseRow({
        evidence: 'P/U',
        aliases: [],
        routes: {
            utme: { durationYears: 4, reviewed: true, applicable: true },
            de_200: { durationYears: 3, reviewed: false, applicable: true },
            de_300: { durationYears: null, reviewed: false, applicable: false },
        },
    });
}

function reseal(artifact) {
    const { checksum: _ignored, ...payload } = artifact;
    artifact.checksum = computeArtifactChecksum(payload);
    return artifact;
}

test('reference verification rechecks pending routes and the estimable invariant', () => {
    const honest = build([pendingEvidenceRow()]);
    withTempArtifact(honest, (file) => {
        assert.deepEqual(verifyProgrammeReferenceArtifact(file), honest);
    });
    const cases = [
        ['pending flipped on an evidence-pending route', (route) => { route.pending = false; }, /pending flag does not match evidence/],
        ['pending set on an evidence-settled route', (route) => { route.pending = true; }, /pending flag does not match evidence/],
        ['estimable flipped on a pending route', (route) => { route.estimable = true; }, /importer invariant/],
        ['estimable flipped on an unreviewed route', (route) => { route.estimable = true; }, /importer invariant/],
        ['estimable cleared on an estimable route', (route) => { route.estimable = false; }, /importer invariant/],
    ];
    const targets = ['de_200', 'utme', 'de_200', 'de_300', 'utme'];
    cases.forEach(([label, mutate, pattern], index) => {
        const artifact = build([pendingEvidenceRow()]);
        mutate(artifact.programmes[0].routes[targets[index]]);
        reseal(artifact);
        withTempArtifact(artifact, (file) => {
            assert.throws(() => verifyProgrammeReferenceArtifact(file), pattern, label);
        });
    });
});

test('runtime lookups refuse pending routes even when estimable is hand-set', () => {
    const artifact = build([pendingEvidenceRow()]);
    const rule = artifact.programmes[0].routes.de_200;
    rule.reviewed = true;
    rule.applicable = true;
    rule.estimable = true;
    assert.equal(rule.pending, true);
    assert.equal(getEstimableRouteRule(artifact, 'syn-001', 'de_200'), null);
});

test('included evidence matches the importer classification exactly', () => {
    for (const evidence of KNOWN_EVIDENCE) {
        const { disposition } = classifyRow(baseRow({ evidence }), { redistribution: 'allowed' });
        assert.equal(disposition === 'included', INCLUDED_EVIDENCE.includes(evidence), `evidence ${evidence}`);
    }
    assert.deepEqual([...INCLUDED_EVIDENCE].sort(), ['G', 'P', 'P/G', 'P/U']);
});

test('reference verification rejects duplicated staged identities', () => {
    const second = () => baseRow({ sourceId: 'SYN-002', aliases: ['Second Crop Sci'] });
    const honest = build([baseRow(), second()]);
    withTempArtifact(honest, (file) => {
        assert.deepEqual(verifyProgrammeReferenceArtifact(file), honest);
    });
    const duplicateProgramme = build([baseRow(), second()]);
    const forged = structuredClone(duplicateProgramme.programmes[1]);
    forged.sourceId = 'Syn-001';
    forged.programmeId = 'syn-001';
    forged.routes.utme.durationYears = 6;
    duplicateProgramme.programmes.unshift(forged);
    duplicateProgramme.counts.included += 1;
    duplicateProgramme.counts.total += 1;
    reseal(duplicateProgramme);
    withTempArtifact(duplicateProgramme, (file) => {
        assert.throws(() => verifyProgrammeReferenceArtifact(file), /duplicate programme id/);
    });
    const duplicateSource = build([baseRow(), second()]);
    duplicateSource.programmes[1].sourceId = duplicateSource.programmes[0].sourceId;
    duplicateSource.programmes[1].programmeId = duplicateSource.programmes[0].programmeId;
    reseal(duplicateSource);
    withTempArtifact(duplicateSource, (file) => {
        assert.throws(() => verifyProgrammeReferenceArtifact(file), /duplicate source id/);
    });
    const duplicateAlias = build([baseRow({ aliases: ['shared-alias'] }), second()]);
    duplicateAlias.programmes[1].aliases.push('Shared-Alias');
    reseal(duplicateAlias);
    withTempArtifact(duplicateAlias, (file) => {
        assert.throws(() => verifyProgrammeReferenceArtifact(file), /duplicate alias/);
    });
    const collidingAlias = build([baseRow(), second()]);
    collidingAlias.programmes[1].aliases.push(collidingAlias.programmes[0].programmeId.toUpperCase());
    reseal(collidingAlias);
    withTempArtifact(collidingAlias, (file) => {
        assert.throws(() => verifyProgrammeReferenceArtifact(file), /collides with a programme id/);
    });
    const swapped = build([baseRow(), second()]);
    const [first, other] = swapped.programmes;
    const held = first.programmeId;
    first.programmeId = other.programmeId;
    other.programmeId = held;
    reseal(swapped);
    withTempArtifact(swapped, (file) => {
        assert.throws(() => verifyProgrammeReferenceArtifact(file), /does not derive from source id/);
    });
});

test('reference verification rejects importer-excluded evidence in programmes', () => {
    for (const evidence of ['G', 'P', 'P/G']) {
        const honest = build([baseRow({ evidence })]);
        withTempArtifact(honest, (file) => {
            assert.deepEqual(verifyProgrammeReferenceArtifact(file), honest, `evidence ${evidence}`);
        });
    }
    const honestPending = build([pendingEvidenceRow()]);
    withTempArtifact(honestPending, (file) => {
        assert.deepEqual(verifyProgrammeReferenceArtifact(file), honestPending, 'evidence P/U');
    });
    for (const evidence of ['C', 'L', 'P/R', 'V', 'U']) {
        const artifact = build([baseRow()]);
        artifact.programmes[0].evidence = evidence;
        reseal(artifact);
        withTempArtifact(artifact, (file) => {
            assert.throws(() => verifyProgrammeReferenceArtifact(file), /always excluded by the importer/, `evidence ${evidence}`);
        });
    }
});
