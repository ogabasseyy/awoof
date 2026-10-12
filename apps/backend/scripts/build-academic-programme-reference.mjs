#!/usr/bin/env node
/**
 * Deterministic programme-duration reference builder.
 *
 * Reads a controlled source extract (JSON) from an explicit --source path and
 * writes a normalized, checksummed reference artifact. Every source row is
 * classified exactly once as included, excluded with a reason, or blocked.
 * Only included rows whose route rules are explicitly reviewed and applicable
 * can ever produce a runtime estimate; imported labels and numeric values
 * alone are never approval.
 *
 * The builder never assumes a fixed input location: the caller always passes
 * --source and --output explicitly.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ARTIFACT_VERSION = 1;
export const KNOWN_ROUTES = ['utme', 'de_200', 'de_300'];
export const KNOWN_EVIDENCE = ['G', 'P', 'P/G', 'P/R', 'V', 'C', 'L', 'P/U', 'U'];
/**
 * Evidence classes the importer can include in `programmes`. Mirrors
 * classifyRow: C (conflicting text), L (legacy pathway), P/R (derived
 * value), V (variant unresolved), and U (unresolved pending) are always
 * excluded, so a staged programme carrying one is a hand edit.
 */
export const INCLUDED_EVIDENCE = ['G', 'P', 'P/G', 'P/U'];
export const REDISTRIBUTION_FLAGS = ['allowed', 'blocked'];

const KNOWN_EXTRACT_FIELDS = ['sourceVersion', 'sourceChecksumSha256', 'rows'];
const KNOWN_ROW_FIELDS = [
    'sourceId',
    'programmeLabel',
    'award',
    'aliases',
    'discipline',
    'locator',
    'evidence',
    'routes',
    'flags',
    'exceptionNotes',
    'withheld',
];
const KNOWN_LOCATOR_FIELDS = ['sheet', 'row', 'sourceRef', 'pages'];
const KNOWN_ROUTE_FIELDS = ['durationYears', 'reviewed', 'applicable'];
const KNOWN_FLAG_FIELDS = ['legacy', 'derived', 'awardCaveat', 'numericConflict'];
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/i;
const PROGRAMME_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ISO_COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;
const MAX_DURATION_YEARS = 20;
const KNOWN_ARTIFACT_FIELDS = [
    'artifactVersion',
    'sourceVersion',
    'sourceChecksumSha256',
    'redistributionAllowed',
    'calculationsEnabled',
    'countryCode',
    'programmes',
    'excluded',
    'blocked',
    'counts',
    'checksum',
];
const KNOWN_ARTIFACT_PROGRAMME_FIELDS = [
    'programmeId',
    'sourceId',
    'label',
    'award',
    'aliases',
    'discipline',
    'locator',
    'evidence',
    'routes',
    'exceptionNotes',
];
const KNOWN_ARTIFACT_ROUTE_FIELDS = ['durationYears', 'reviewed', 'applicable', 'pending', 'estimable'];
const KNOWN_ARTIFACT_DISPOSITION_FIELDS = ['sourceId', 'reason', 'locator'];
const KNOWN_ARTIFACT_COUNTS_FIELDS = ['total', 'included', 'excluded', 'blocked'];
// Storage mirror of migration 085 `estimate_basis_rule_id VARCHAR(128)`:
// every `${programmeId}:${route}` rule id must fit. The route list covers
// every suffix any rule builder accepts (the runtime HTTP path also builds
// transfer_other rule ids), mirroring MAX_ESTIMABLE_PROGRAMME_ID_LENGTH.
const RULE_ID_STORAGE_MAX_LENGTH = 128;
const RULE_ID_ROUTE_IDS = ['utme', 'de_200', 'de_300', 'transfer_other'];
export const MAX_ESTIMABLE_PROGRAMME_ID_LENGTH = RULE_ID_STORAGE_MAX_LENGTH - 1
    - Math.max(...RULE_ID_ROUTE_IDS.map((route) => route.length));
// Storage mirror of migration 085 `estimate_basis_source_version
// VARCHAR(128)`: longer versions would fail the later accept write.
export const MAX_ESTIMATE_SOURCE_VERSION_LENGTH = 128;

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function assertKnownFields(value, known, label) {
    for (const key of Object.keys(value)) {
        if (!known.includes(key)) throw new Error(`unknown ${label} field '${key}'`);
    }
}

/** Canonical JSON encoding with sorted object keys for stable checksums. */
export function stableStringify(value) {
    if (value === null) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableStringify(entry) ?? 'null').join(',')}]`;
    }
    if (isPlainObject(value)) {
        const body = Object.keys(value)
            .sort()
            .map((key) => {
                const encoded = stableStringify(value[key]);
                return encoded === undefined ? null : `${JSON.stringify(key)}:${encoded}`;
            })
            .filter((entry) => entry !== null)
            .join(',');
        return `{${body}}`;
    }
    return undefined;
}

/** SHA-256 checksum (hex) of the canonical encoding of an artifact payload. */
export function computeArtifactChecksum(payload) {
    const encoded = stableStringify(payload);
    if (encoded === undefined) throw new Error('cannot checksum an empty artifact payload');
    return createHash('sha256').update(encoded, 'utf8').digest('hex');
}

function normalizeProgrammeId(sourceId) {
    return sourceId.trim().toLowerCase();
}

function normalizeAlias(alias) {
    return alias.trim().toLowerCase();
}

function pendingRoutesForEvidence(evidence) {
    // P/U is compound: UTME verified, Direct Entry unresolved. A bare exact
    // match on an unresolved marker would miss it, so pending routes are
    // derived explicitly per evidence code.
    if (evidence === 'P/U') return new Set(['de_200', 'de_300']);
    return new Set();
}

function normalizeLocator(locator, sourceId) {
    if (!isPlainObject(locator)) throw new Error(`invalid locator for source '${sourceId}': expected an object`);
    assertKnownFields(locator, KNOWN_LOCATOR_FIELDS, 'locator');
    if (typeof locator.sheet !== 'string' || locator.sheet.trim() === '') {
        throw new Error(`invalid locator for source '${sourceId}': sheet must be a non-empty string`);
    }
    if (!Number.isInteger(locator.row) || locator.row <= 0) {
        throw new Error(`invalid locator for source '${sourceId}': row must be a positive integer`);
    }
    for (const key of ['sourceRef', 'pages']) {
        if (locator[key] !== undefined && locator[key] !== null && typeof locator[key] !== 'string') {
            throw new Error(`invalid locator for source '${sourceId}': ${key} must be a string or null`);
        }
    }
    return {
        sheet: locator.sheet.trim(),
        row: locator.row,
        sourceRef: locator.sourceRef ?? null,
        pages: locator.pages ?? null,
    };
}

function normalizeRoute(route, sourceId, routeName) {
    if (!isPlainObject(route)) throw new Error(`invalid route '${routeName}' for source '${sourceId}': expected an object`);
    assertKnownFields(route, KNOWN_ROUTE_FIELDS, 'route');
    const { durationYears, reviewed, applicable } = route;
    if (durationYears !== null && (!Number.isInteger(durationYears) || durationYears < 1 || durationYears > MAX_DURATION_YEARS)) {
        throw new Error(
            `invalid durationYears for source '${sourceId}' route '${routeName}': expected null or an integer 1-${MAX_DURATION_YEARS}`,
        );
    }
    if (typeof reviewed !== 'boolean') {
        throw new Error(`invalid reviewed flag for source '${sourceId}' route '${routeName}': expected a boolean`);
    }
    if (typeof applicable !== 'boolean') {
        throw new Error(`invalid applicable flag for source '${sourceId}' route '${routeName}': expected a boolean`);
    }
    if (reviewed && applicable && durationYears === null) {
        throw new Error(
            `inconsistent route values for source '${sourceId}' route '${routeName}': a reviewed applicable route must carry a duration; missing durations are never inferred`,
        );
    }
    return { durationYears, reviewed, applicable };
}

function normalizeFlags(flags, sourceId) {
    if (flags === undefined) return { legacy: false, derived: false, awardCaveat: false, numericConflict: false };
    if (!isPlainObject(flags)) throw new Error(`invalid flags for source '${sourceId}': expected an object`);
    assertKnownFields(flags, KNOWN_FLAG_FIELDS, 'flag');
    const normalized = {};
    for (const key of KNOWN_FLAG_FIELDS) {
        const value = flags[key] ?? false;
        if (typeof value !== 'boolean') throw new Error(`invalid flag '${key}' for source '${sourceId}': expected a boolean`);
        normalized[key] = value;
    }
    return normalized;
}

function validateRowShape(row, index) {
    if (!isPlainObject(row)) throw new Error(`invalid extract row at index ${index}: expected an object`);
    assertKnownFields(row, KNOWN_ROW_FIELDS, 'row');
    const label = typeof row.sourceId === 'string' && row.sourceId.trim() !== '' ? row.sourceId.trim() : `index ${index}`;
    if (typeof row.sourceId !== 'string' || row.sourceId.trim() === '') {
        throw new Error(`invalid source id at index ${index}: expected a non-empty string`);
    }
    const programmeId = normalizeProgrammeId(row.sourceId);
    if (!PROGRAMME_ID_PATTERN.test(programmeId)) {
        throw new Error(`invalid source id '${label}': cannot form a stable programme id`);
    }
    if (programmeId.length > MAX_ESTIMABLE_PROGRAMME_ID_LENGTH) {
        throw new Error(`invalid source id '${label}': programme id exceeds ${MAX_ESTIMABLE_PROGRAMME_ID_LENGTH} characters and cannot form a storable rule id`);
    }
    const locator = normalizeLocator(row.locator, label);
    if (row.withheld === true) {
        for (const key of Object.keys(row)) {
            if (!['sourceId', 'withheld', 'locator'].includes(key)) {
                throw new Error(`invalid withheld row '${label}': withheld rows must not carry source content ('${key}')`);
            }
        }
        return { sourceId: row.sourceId.trim(), programmeId, withheld: true, locator };
    }
    if (row.withheld !== undefined && row.withheld !== false) {
        throw new Error(`invalid withheld flag for source '${label}': expected a boolean`);
    }
    if (typeof row.programmeLabel !== 'string' || row.programmeLabel.trim() === '') {
        throw new Error(`invalid programme label for source '${label}': expected a non-empty string`);
    }
    if (row.award !== undefined && row.award !== null && typeof row.award !== 'string') {
        throw new Error(`invalid award for source '${label}': expected a string or null`);
    }
    if (row.discipline !== undefined && row.discipline !== null && typeof row.discipline !== 'string') {
        throw new Error(`invalid discipline for source '${label}': expected a string or null`);
    }
    if (row.aliases !== undefined && !Array.isArray(row.aliases)) {
        throw new Error(`invalid aliases for source '${label}': expected an array`);
    }
    const aliases = [];
    for (const alias of row.aliases ?? []) {
        if (typeof alias !== 'string' || alias.trim() === '') {
            throw new Error(`invalid alias for source '${label}': aliases must be non-empty strings`);
        }
        aliases.push(alias.trim());
    }
    if (typeof row.evidence !== 'string' || !KNOWN_EVIDENCE.includes(row.evidence)) {
        throw new Error(`unknown evidence code '${row.evidence}' for source '${label}'`);
    }
    if (row.routes !== undefined && !isPlainObject(row.routes)) {
        throw new Error(`invalid routes for source '${label}': expected an object`);
    }
    const routes = {};
    for (const [routeName, route] of Object.entries(row.routes ?? {})) {
        if (!KNOWN_ROUTES.includes(routeName)) throw new Error(`unknown route '${routeName}' for source '${label}'`);
        routes[routeName] = normalizeRoute(route, label, routeName);
    }
    const pending = pendingRoutesForEvidence(row.evidence);
    for (const routeName of pending) {
        const route = routes[routeName];
        if (route && route.reviewed && route.applicable && route.durationYears !== null) {
            throw new Error(
                `inconsistent route values for source '${label}' route '${routeName}': evidence '${row.evidence}' marks this route unresolved, so it cannot be approved`,
            );
        }
    }
    const flags = normalizeFlags(row.flags, label);
    if (row.exceptionNotes !== undefined && row.exceptionNotes !== null && typeof row.exceptionNotes !== 'string') {
        throw new Error(`invalid exception notes for source '${label}': expected a string or null`);
    }
    return {
        sourceId: row.sourceId.trim(),
        programmeId,
        withheld: false,
        locator,
        programmeLabel: row.programmeLabel.trim(),
        award: row.award?.trim() ? row.award.trim() : null,
        aliases,
        discipline: row.discipline?.trim() ? row.discipline.trim() : null,
        evidence: row.evidence,
        routes,
        flags,
        exceptionNotes: row.exceptionNotes ?? null,
    };
}

/**
 * Classify one validated row. Returns { disposition, reason } where reason is
 * null for included rows. Withheld and redistribution-blocked rows carry no
 * source content into the artifact.
 */
export function classifyRow(row, { redistribution }) {
    if (row.withheld === true) return { disposition: 'blocked', reason: 'content_withheld_pending_licence' };
    if (redistribution === 'blocked') return { disposition: 'blocked', reason: 'redistribution_not_permitted' };
    const flags = row.flags ?? {};
    if (flags.numericConflict === true) return { disposition: 'excluded', reason: 'numeric_conflict' };
    if (row.evidence === 'C') return { disposition: 'excluded', reason: 'conflicting_text' };
    if (flags.legacy === true || row.evidence === 'L') return { disposition: 'excluded', reason: 'legacy_pathway' };
    if (flags.derived === true || row.evidence === 'P/R') return { disposition: 'excluded', reason: 'derived_value' };
    if (row.evidence === 'V') return { disposition: 'excluded', reason: 'variant_unresolved' };
    if (flags.awardCaveat === true) return { disposition: 'excluded', reason: 'award_caveat' };
    if (row.evidence === 'U') return { disposition: 'excluded', reason: 'unresolved_pending' };
    return { disposition: 'included', reason: null };
}

function dispositionEntry(validated) {
    return {
        sourceId: validated.sourceId,
        reason: null,
        locator: { sheet: validated.locator.sheet, row: validated.locator.row },
    };
}

/** Build a deterministic reference artifact from a validated extract object. */
export function buildReference({ extract, expectedChecksum, redistribution }) {
    if (!REDISTRIBUTION_FLAGS.includes(redistribution)) {
        throw new Error(`invalid redistribution flag '${redistribution}': expected 'allowed' or 'blocked'`);
    }
    if (!isPlainObject(extract)) throw new Error('invalid extract: expected an object');
    assertKnownFields(extract, KNOWN_EXTRACT_FIELDS, 'extract');
    if (typeof extract.sourceVersion !== 'string' || extract.sourceVersion.trim() === '') {
        throw new Error('invalid source version: expected a non-empty string');
    }
    if (extract.sourceVersion.trim().length > MAX_ESTIMATE_SOURCE_VERSION_LENGTH) {
        throw new Error(`invalid source version: exceeds ${MAX_ESTIMATE_SOURCE_VERSION_LENGTH} characters and cannot be stored on accept`);
    }
    if (typeof extract.sourceChecksumSha256 !== 'string' || !CHECKSUM_PATTERN.test(extract.sourceChecksumSha256)) {
        throw new Error('invalid source checksum: expected 64 hex characters');
    }
    if (!Array.isArray(extract.rows)) throw new Error('invalid extract rows: expected an array');
    if (typeof expectedChecksum !== 'string' || extract.sourceChecksumSha256.toLowerCase() !== expectedChecksum.toLowerCase()) {
        throw new Error('checksum mismatch: the extract does not match the expected source checksum');
    }

    const validated = extract.rows.map((row, index) => validateRowShape(row, index));

    const seenSourceIds = new Map();
    const seenProgrammeIds = new Map();
    for (const row of validated) {
        if (seenSourceIds.has(row.sourceId)) throw new Error(`duplicate source id '${row.sourceId}'`);
        seenSourceIds.set(row.sourceId, true);
        const previous = seenProgrammeIds.get(row.programmeId);
        if (previous !== undefined) {
            throw new Error(`duplicate programme id '${row.programmeId}' from sources '${previous}' and '${row.sourceId}'`);
        }
        seenProgrammeIds.set(row.programmeId, row.sourceId);
    }
    const seenAliases = new Map();
    for (const row of validated) {
        if (row.withheld) continue;
        for (const alias of row.aliases) {
            const normalized = normalizeAlias(alias);
            const owner = seenAliases.get(normalized);
            if (owner !== undefined) {
                throw new Error(`duplicate alias '${alias}' from sources '${owner}' and '${row.sourceId}'`);
            }
            const colliding = seenProgrammeIds.get(normalized);
            if (colliding !== undefined) {
                throw new Error(`alias '${alias}' collides with source id '${colliding}'`);
            }
            seenAliases.set(normalized, row.sourceId);
        }
    }

    const calculationsEnabled = redistribution === 'allowed';
    const programmes = [];
    const excluded = [];
    const blocked = [];
    for (const row of validated) {
        const { disposition, reason } = classifyRow(row, { redistribution });
        if (disposition === 'included') {
            const pending = pendingRoutesForEvidence(row.evidence);
            const routes = {};
            for (const routeName of KNOWN_ROUTES) {
                const route = row.routes[routeName] ?? { durationYears: null, reviewed: false, applicable: false };
                const isPending = pending.has(routeName);
                routes[routeName] = {
                    durationYears: route.durationYears,
                    reviewed: route.reviewed,
                    applicable: route.applicable,
                    pending: isPending,
                    estimable: calculationsEnabled && !isPending && route.reviewed && route.applicable && route.durationYears !== null,
                };
            }
            programmes.push({
                programmeId: row.programmeId,
                sourceId: row.sourceId,
                label: row.programmeLabel,
                award: row.award,
                aliases: [...row.aliases].sort(),
                discipline: row.discipline,
                locator: row.locator,
                evidence: row.evidence,
                routes,
                exceptionNotes: row.exceptionNotes,
            });
        } else if (disposition === 'excluded') {
            const entry = dispositionEntry(row);
            entry.reason = reason;
            excluded.push(entry);
        } else {
            const entry = dispositionEntry(row);
            entry.reason = reason;
            blocked.push(entry);
        }
    }
    programmes.sort((a, b) => (a.programmeId < b.programmeId ? -1 : a.programmeId > b.programmeId ? 1 : 0));
    excluded.sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
    blocked.sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));

    const payload = {
        artifactVersion: ARTIFACT_VERSION,
        sourceVersion: extract.sourceVersion.trim(),
        sourceChecksumSha256: extract.sourceChecksumSha256.toLowerCase(),
        redistributionAllowed: redistribution === 'allowed',
        calculationsEnabled,
        programmes,
        excluded,
        blocked,
        counts: { total: validated.length, included: programmes.length, excluded: excluded.length, blocked: blocked.length },
    };
    return { ...payload, checksum: computeArtifactChecksum(payload) };
}

function verifyArtifactLocator(locator, label) {
    if (!isPlainObject(locator)) throw new Error(`invalid programme reference '${label}': locator must be an object`);
    assertKnownFields(locator, KNOWN_LOCATOR_FIELDS, 'artifact locator');
    if (typeof locator.sheet !== 'string' || locator.sheet.trim() === '') {
        throw new Error(`invalid programme reference '${label}': locator sheet must be a non-empty string`);
    }
    if (!Number.isInteger(locator.row) || locator.row <= 0) {
        throw new Error(`invalid programme reference '${label}': locator row must be a positive integer`);
    }
}

function verifyArtifactProgramme(entry, label, calculationsEnabled) {
    if (!isPlainObject(entry)) throw new Error(`invalid programme reference '${label}': programme entries must be objects`);
    assertKnownFields(entry, KNOWN_ARTIFACT_PROGRAMME_FIELDS, 'artifact programme');
    if (typeof entry.programmeId !== 'string' || !PROGRAMME_ID_PATTERN.test(entry.programmeId)) {
        throw new Error(`invalid programme reference '${label}': programme id is malformed`);
    }
    if (entry.programmeId.length > MAX_ESTIMABLE_PROGRAMME_ID_LENGTH) {
        throw new Error(`invalid programme reference '${label}': programme id exceeds the storable rule-id limit`);
    }
    if (typeof entry.sourceId !== 'string' || entry.sourceId.trim() === '') {
        throw new Error(`invalid programme reference '${label}': source id must be a non-empty string`);
    }
    if (typeof entry.label !== 'string' || entry.label.trim() === '') {
        throw new Error(`invalid programme reference '${label}': label must be a non-empty string`);
    }
    if (entry.award !== null && typeof entry.award !== 'string') {
        throw new Error(`invalid programme reference '${label}': award must be a string or null`);
    }
    if (!Array.isArray(entry.aliases) || entry.aliases.some((alias) => typeof alias !== 'string')) {
        throw new Error(`invalid programme reference '${label}': aliases must be an array of strings`);
    }
    if (entry.discipline !== null && typeof entry.discipline !== 'string') {
        throw new Error(`invalid programme reference '${label}': discipline must be a string or null`);
    }
    verifyArtifactLocator(entry.locator, label);
    if (typeof entry.evidence !== 'string' || !KNOWN_EVIDENCE.includes(entry.evidence)) {
        throw new Error(`invalid programme reference '${label}': unknown evidence code`);
    }
    if (!INCLUDED_EVIDENCE.includes(entry.evidence)) {
        throw new Error(`invalid programme reference '${label}': evidence '${entry.evidence}' is always excluded by the importer`);
    }
    if (entry.exceptionNotes !== null && typeof entry.exceptionNotes !== 'string') {
        throw new Error(`invalid programme reference '${label}': exception notes must be a string or null`);
    }
    if (!isPlainObject(entry.routes)) throw new Error(`invalid programme reference '${label}': routes must be an object`);
    // Flag types alone cannot catch a hand edit that keeps the booleans but
    // breaks their importer-defined relationships, so pending is rederived
    // from the programme's evidence code and estimable must equal the exact
    // equation the builder writes.
    const expectedPendingRoutes = pendingRoutesForEvidence(entry.evidence);
    for (const [routeName, route] of Object.entries(entry.routes)) {
        if (!KNOWN_ROUTES.includes(routeName)) {
            throw new Error(`invalid programme reference '${label}': unknown route '${routeName}'`);
        }
        if (!isPlainObject(route)) throw new Error(`invalid programme reference '${label}': route '${routeName}' must be an object`);
        assertKnownFields(route, KNOWN_ARTIFACT_ROUTE_FIELDS, 'artifact route');
        const { durationYears, reviewed, applicable, pending, estimable } = route;
        if (durationYears !== null && (!Number.isInteger(durationYears) || durationYears < 1 || durationYears > MAX_DURATION_YEARS)) {
            throw new Error(`invalid programme reference '${label}': route '${routeName}' duration is out of range`);
        }
        for (const [flag, value] of [['reviewed', reviewed], ['applicable', applicable], ['pending', pending], ['estimable', estimable]]) {
            if (typeof value !== 'boolean') {
                throw new Error(`invalid programme reference '${label}': route '${routeName}' flag '${flag}' must be a boolean`);
            }
        }
        const expectedPending = expectedPendingRoutes.has(routeName);
        if (pending !== expectedPending) {
            throw new Error(`invalid programme reference '${label}': route '${routeName}' pending flag does not match evidence '${entry.evidence}'`);
        }
        const expectedEstimable = calculationsEnabled && !expectedPending && reviewed && applicable && durationYears !== null;
        if (estimable !== expectedEstimable) {
            throw new Error(`invalid programme reference '${label}': route '${routeName}' estimable flag does not match the importer invariant`);
        }
    }
}

function verifyArtifactDisposition(entry, label) {
    if (!isPlainObject(entry)) throw new Error(`invalid programme reference '${label}': disposition entries must be objects`);
    assertKnownFields(entry, KNOWN_ARTIFACT_DISPOSITION_FIELDS, 'artifact disposition');
    if (typeof entry.sourceId !== 'string' || entry.sourceId.trim() === '') {
        throw new Error(`invalid programme reference '${label}': disposition source id must be a non-empty string`);
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
        throw new Error(`invalid programme reference '${label}': disposition reason must be a non-empty string`);
    }
    verifyArtifactLocator(entry.locator, label);
}

/**
 * Reapply the builder's identity-uniqueness checks to the staged arrays.
 * Runtime lookup consumes the first programme-id match, so a duplicated
 * id with internally consistent flags would otherwise serve a fabricated
 * rule. Source ids span every disposition array; programme ids and
 * aliases span programmes because excluded/blocked entries stage neither.
 */
function verifyArtifactUniqueness(artifact, label) {
    // Programme IDs are derived, not independent: the builder always sets
    // programmeId to sourceId.trim().toLowerCase(), so a staged id that
    // breaks the derivation is a hand edit serving reviewed durations
    // under a fabricated programme identity.
    for (const entry of artifact.programmes) {
        if (entry.programmeId !== normalizeProgrammeId(entry.sourceId)) {
            throw new Error(`invalid programme reference '${label}': programme id '${entry.programmeId}' does not derive from source id '${entry.sourceId}'`);
        }
    }
    const seenSourceIds = new Set();
    for (const entry of [...artifact.programmes, ...artifact.excluded, ...artifact.blocked]) {
        if (seenSourceIds.has(entry.sourceId)) {
            throw new Error(`invalid programme reference '${label}': duplicate source id '${entry.sourceId}'`);
        }
        seenSourceIds.add(entry.sourceId);
    }
    const seenProgrammeIds = new Map();
    for (const entry of artifact.programmes) {
        const previous = seenProgrammeIds.get(entry.programmeId);
        if (previous !== undefined) {
            throw new Error(`invalid programme reference '${label}': duplicate programme id '${entry.programmeId}'`);
        }
        seenProgrammeIds.set(entry.programmeId, entry.sourceId);
    }
    const seenAliases = new Map();
    for (const entry of artifact.programmes) {
        for (const alias of entry.aliases) {
            const normalized = normalizeAlias(alias);
            const owner = seenAliases.get(normalized);
            if (owner !== undefined) {
                throw new Error(`invalid programme reference '${label}': duplicate alias '${alias}'`);
            }
            const colliding = seenProgrammeIds.get(normalized);
            if (colliding !== undefined) {
                throw new Error(`invalid programme reference '${label}': alias '${alias}' collides with a programme id`);
            }
            seenAliases.set(normalized, entry.sourceId);
        }
    }
}

/**
 * Verify a checked-in reference artifact before staging: version, checksum,
 * counts, and the semantic invariants the builder guarantees. Any manual
 * edit that bypasses the deterministic importer fails the build here
 * instead of silently altering graduation rules. Returns the parsed
 * artifact.
 */
export function verifyProgrammeReferenceArtifact(filePath) {
    const label = basename(filePath);
    let artifact;
    try {
        artifact = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
        throw new Error(`invalid programme reference '${label}': expected valid JSON`);
    }
    if (!isPlainObject(artifact)) throw new Error(`invalid programme reference '${label}': expected an object`);
    assertKnownFields(artifact, KNOWN_ARTIFACT_FIELDS, 'artifact');
    if (artifact.artifactVersion !== ARTIFACT_VERSION) {
        throw new Error(`invalid programme reference '${label}': unsupported artifact version`);
    }
    if (typeof artifact.sourceVersion !== 'string' || artifact.sourceVersion.trim() === ''
        || artifact.sourceVersion.trim().length > MAX_ESTIMATE_SOURCE_VERSION_LENGTH) {
        throw new Error(`invalid programme reference '${label}': source version is missing or exceeds the storable limit`);
    }
    if (typeof artifact.sourceChecksumSha256 !== 'string' || !CHECKSUM_PATTERN.test(artifact.sourceChecksumSha256)) {
        throw new Error(`invalid programme reference '${label}': source checksum must be 64 hex characters`);
    }
    if (typeof artifact.redistributionAllowed !== 'boolean' || typeof artifact.calculationsEnabled !== 'boolean') {
        throw new Error(`invalid programme reference '${label}': redistribution and calculation flags must be booleans`);
    }
    if (artifact.calculationsEnabled !== artifact.redistributionAllowed) {
        throw new Error(`invalid programme reference '${label}': calculations can only be enabled with redistribution allowed`);
    }
    if (artifact.countryCode !== undefined
        && (typeof artifact.countryCode !== 'string' || !ISO_COUNTRY_CODE_PATTERN.test(artifact.countryCode))) {
        throw new Error(`invalid programme reference '${label}': country code must be an ISO alpha-2 code`);
    }
    for (const key of ['programmes', 'excluded', 'blocked']) {
        if (!Array.isArray(artifact[key])) throw new Error(`invalid programme reference '${label}': '${key}' must be an array`);
    }
    if (!isPlainObject(artifact.counts)) throw new Error(`invalid programme reference '${label}': counts must be an object`);
    assertKnownFields(artifact.counts, KNOWN_ARTIFACT_COUNTS_FIELDS, 'artifact counts');
    if (artifact.counts.included !== artifact.programmes.length
        || artifact.counts.excluded !== artifact.excluded.length
        || artifact.counts.blocked !== artifact.blocked.length
        || artifact.counts.total !== artifact.programmes.length + artifact.excluded.length + artifact.blocked.length) {
        throw new Error(`invalid programme reference '${label}': counts do not match the disposition arrays`);
    }
    for (const entry of artifact.programmes) verifyArtifactProgramme(entry, label, artifact.calculationsEnabled);
    for (const entry of artifact.excluded) verifyArtifactDisposition(entry, label);
    for (const entry of artifact.blocked) verifyArtifactDisposition(entry, label);
    verifyArtifactUniqueness(artifact, label);
    const { checksum, ...payload } = artifact;
    if (typeof checksum !== 'string' || computeArtifactChecksum(payload) !== checksum) {
        throw new Error(`invalid programme reference '${label}': checksum mismatch — rebuild with the deterministic importer`);
    }
    return artifact;
}

/**
 * Fail-closed runtime lookup. Returns the estimable route rule, or null when
 * the programme, route, review state, or artifact itself cannot support an
 * estimate. Excluded and blocked rows are absent from programmes, so they can
 * never estimate.
 */
export function getEstimableRouteRule(artifact, programmeId, route) {
    try {
        if (!isPlainObject(artifact) || artifact.calculationsEnabled !== true) return null;
        if (!Array.isArray(artifact.programmes) || typeof artifact.sourceVersion !== 'string') return null;
        const programme = artifact.programmes.find((entry) => isPlainObject(entry) && entry.programmeId === programmeId);
        if (!programme || !isPlainObject(programme.routes)) return null;
        const rule = programme.routes[route];
        if (!isPlainObject(rule) || rule.estimable !== true || rule.pending === true || typeof rule.durationYears !== 'number') return null;
        return { durationYears: rule.durationYears, ruleId: `${programme.programmeId}:${route}`, sourceVersion: artifact.sourceVersion };
    } catch {
        return null;
    }
}

/** Read and JSON-parse an extract file. */
export function loadExtract(sourcePath) {
    let raw;
    try {
        raw = readFileSync(sourcePath, 'utf8');
    } catch (error) {
        throw new Error(`cannot read source extract '${sourcePath}': ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
        return JSON.parse(raw);
    } catch (error) {
        throw new Error(`invalid extract JSON in '${sourcePath}': ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** Write an artifact deterministically (pretty-printed JSON with trailing newline). */
export function writeArtifact(artifact, outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    return outputPath;
}

export function usage() {
    return [
        'Usage: node scripts/build-academic-programme-reference.mjs --source <extract.json> --output <reference.json> --expected-checksum <sha256> --redistribution <allowed|blocked>',
        '',
        'Build a deterministic programme-duration reference artifact from a controlled',
        'extract file. Every source row is classified exactly once as included,',
        'excluded with a reason, or blocked. Use --redistribution blocked unless',
        'redistribution of the source content is expressly permitted.',
    ].join('\n');
}

/** Parse CLI arguments; all inputs are explicit, none are assumed. */
export function parseArgs(argv) {
    if (argv.includes('--help') || argv.includes('-h')) return { help: true };
    const parsed = {};
    const flags = new Map([
        ['--source', 'source'],
        ['--output', 'output'],
        ['--expected-checksum', 'expectedChecksum'],
        ['--redistribution', 'redistribution'],
    ]);
    for (let index = 0; index < argv.length; index += 1) {
        const name = flags.get(argv[index]);
        if (!name) throw new Error(`unknown argument '${argv[index]}'. ${usage()}`);
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) throw new Error(`missing value for '${argv[index]}'. ${usage()}`);
        parsed[name] = value;
        index += 1;
    }
    for (const [flag, name] of flags) {
        if (parsed[name] === undefined) throw new Error(`missing required ${flag} <value>. ${usage()}`);
    }
    if (!REDISTRIBUTION_FLAGS.includes(parsed.redistribution)) {
        throw new Error(`invalid --redistribution '${parsed.redistribution}': expected 'allowed' or 'blocked'. ${usage()}`);
    }
    return parsed;
}

function main(argv) {
    const parsed = parseArgs(argv);
    if (parsed.help) {
        process.stdout.write(`${usage()}\n`);
        return;
    }
    const artifact = buildReference({
        extract: loadExtract(parsed.source),
        expectedChecksum: parsed.expectedChecksum,
        redistribution: parsed.redistribution,
    });
    writeArtifact(artifact, parsed.output);
    process.stdout.write(
        `reference built: included=${artifact.counts.included} excluded=${artifact.counts.excluded} blocked=${artifact.counts.blocked} checksum=${artifact.checksum} -> ${parsed.output}\n`,
    );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
