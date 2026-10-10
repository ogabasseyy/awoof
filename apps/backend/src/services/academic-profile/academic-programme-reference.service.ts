/**
 * Academic Programme Reference Service
 *
 * Bounded catalogue search and graduation-year estimates over the Task 1
 * reviewed programme-duration reference. Estimates consume only route rules
 * explicitly marked reviewed, applicable, and estimable; imported labels and
 * bare numbers are never approval. Country is resolved from the
 * server-owned reference — the client cannot override it to apply one
 * national system's rules to another country's programme.
 *
 * Catalogue scope always derives from the locked server-side student
 * context: bound students see their server-bound institution and its
 * national reference slice, while unbound students may search the general
 * approved reference. Responses carry display fields only.
 */

import { readFileSync } from 'node:fs';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { BadRequestError } from '../../common/errors/AppError.js';
import {
    ENTRY_YEAR_MIN,
    GRADUATION_HORIZON_YEARS,
    type EntryRoute,
} from './academic-profile.types.js';
import { lockAcademicProfileContext } from './academic-profile.service.js';

export const CATALOGUE_DEFAULT_LIMIT = 20;
export const CATALOGUE_MAX_LIMIT = 50;
export const CATALOGUE_MAX_QUERY_LENGTH = 128;
export const CATALOGUE_MAX_CURSOR_LENGTH = 512;
const CATALOGUE_MAX_OFFSET = 100_000;

/** National systems whose reviewed rules may currently produce estimates. */
export const ESTIMATE_SUPPORTED_COUNTRY_CODES: readonly string[] = ['NG'];

/** The Task 1 artifact is the Nigerian NUC register; see the loader below. */
const NUC_ARTIFACT_DEFAULT_COUNTRY_CODE = 'NG';

export type CataloguePage<T> = { items: T[]; nextCursor: string | null };

export type InstitutionCatalogueItem = { name: string; countryCode: string | null };

export type ProgrammeCatalogueItem = { programmeId: string; label: string; award: string | null };

export type EstimateInput = {
    programmeId: string | null;
    entryYear: number | null;
    entryRoute: EntryRoute | null;
};

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

const ENTRY_ROUTES: readonly EntryRoute[] = ['utme', 'de_200', 'de_300', 'transfer_other'];

/**
 * Route-boundary contract. Shape and key allowlist only; semantic range
 * checks belong to `estimateGraduationYear` so direct and HTTP callers share
 * one reasoned outcome. No country override, rule pick, or cross-user key.
 */
export const estimateInputSchema = z.object({
    programmeId: z.string().trim().min(1).max(128).nullable(),
    entryYear: z.number().int().nullable(),
    entryRoute: z.enum(['utme', 'de_200', 'de_300', 'transfer_other']).nullable(),
}).strict();

export type ReferenceRouteRule = {
    durationYears: number | null;
    reviewed: boolean;
    applicable: boolean;
    estimable: boolean;
    conflicting?: boolean;
};

export type ReferenceProgramme = {
    programmeId: string;
    label: string;
    award: string | null;
    aliases: readonly string[];
    countryCode: string;
    routes: Partial<Record<EntryRoute, ReferenceRouteRule>>;
};

export type ProgrammeReference = {
    sourceVersion: string | null;
    calculationsEnabled: boolean;
    programmes: readonly ReferenceProgramme[];
};

function closedReference(): ProgrammeReference {
    return { sourceVersion: null, calculationsEnabled: false, programmes: [] };
}

type ArtifactRoute = {
    durationYears: unknown;
    reviewed: unknown;
    applicable: unknown;
    estimable: unknown;
    conflicting?: unknown;
};

function parseArtifactRoute(value: unknown): ReferenceRouteRule | null {
    if (typeof value !== 'object' || value === null) return null;
    const route = value as ArtifactRoute;
    const durationYears = route.durationYears;
    if (durationYears !== null && (typeof durationYears !== 'number' || !Number.isInteger(durationYears))) return null;
    if (typeof route.reviewed !== 'boolean' || typeof route.applicable !== 'boolean' || typeof route.estimable !== 'boolean') {
        return null;
    }
    const rule: ReferenceRouteRule = {
        durationYears,
        reviewed: route.reviewed,
        applicable: route.applicable,
        estimable: route.estimable,
    };
    if (route.conflicting === true) rule.conflicting = true;
    return rule;
}

function parseArtifactProgramme(value: unknown, countryCode: string): ReferenceProgramme | null {
    if (typeof value !== 'object' || value === null) return null;
    const entry = value as Record<string, unknown>;
    if (typeof entry['programmeId'] !== 'string' || entry['programmeId'].trim() === '') return null;
    if (typeof entry['label'] !== 'string' || entry['label'].trim() === '') return null;
    const award = entry['award'];
    if (award !== null && award !== undefined && typeof award !== 'string') return null;
    const aliases = entry['aliases'];
    if (!Array.isArray(aliases) || aliases.some((alias) => typeof alias !== 'string')) return null;
    const routes: Partial<Record<EntryRoute, ReferenceRouteRule>> = {};
    if (typeof entry['routes'] === 'object' && entry['routes'] !== null) {
        const raw = entry['routes'] as Record<string, unknown>;
        for (const route of ENTRY_ROUTES) {
            if (raw[route] === undefined) continue;
            const parsed = parseArtifactRoute(raw[route]);
            if (parsed) routes[route] = parsed;
        }
    }
    return {
        programmeId: (entry['programmeId'] as string).trim(),
        label: (entry['label'] as string).trim(),
        award: typeof award === 'string' && award.trim() !== '' ? award.trim() : null,
        aliases: (aliases as string[]).map((alias) => alias.trim()).filter((alias) => alias !== ''),
        countryCode,
        routes,
    };
}

/**
 * Parse a Task 1 reference artifact value. Malformed artifacts fail closed
 * to "no estimable rule". The artifact carries no per-programme country, so
 * programmes inherit the artifact's explicit `countryCode` top-level field
 * when present, else the documented Nigerian default for the NUC register.
 * An explicit but invalid country invalidates the artifact rather than
 * assuming Nigeria, so foreign rules can never borrow the NUC default.
 */
export function parseProgrammeReferenceArtifact(artifact: unknown): ProgrammeReference {
    if (typeof artifact !== 'object' || artifact === null || Array.isArray(artifact)) return closedReference();
    const root = artifact as Record<string, unknown>;
    if (typeof root['sourceVersion'] !== 'string' || (root['sourceVersion'] as string).trim() === '') {
        return closedReference();
    }
    const sourceVersion = (root['sourceVersion'] as string).trim();
    const rawCountry = root['countryCode'];
    if (rawCountry !== undefined && (typeof rawCountry !== 'string' || !/^[A-Z]{2}$/.test(rawCountry))) {
        return { sourceVersion, calculationsEnabled: false, programmes: [] };
    }
    const countryCode = typeof rawCountry === 'string' ? rawCountry : NUC_ARTIFACT_DEFAULT_COUNTRY_CODE;
    if (!Array.isArray(root['programmes'])) return { sourceVersion, calculationsEnabled: false, programmes: [] };
    const programmes: ReferenceProgramme[] = [];
    for (const entry of root['programmes'] as unknown[]) {
        const parsed = parseArtifactProgramme(entry, countryCode);
        if (parsed) programmes.push(parsed);
    }
    return {
        sourceVersion,
        calculationsEnabled: root['calculationsEnabled'] === true,
        programmes,
    };
}

/**
 * Load the checked-in Task 1 normalized artifact. Any load or shape problem
 * fails closed to "no estimable rule" while still reporting the artifact's
 * source version when it can be read.
 */
export function loadProgrammeReference(...args: [] | [unknown]): ProgrammeReference {
    if (args.length === 0) {
        try {
            const raw = readFileSync(
                new URL('../../data/academic-programmes/nuc-v2.normalized.json', import.meta.url),
                'utf8',
            );
            return parseProgrammeReferenceArtifact(JSON.parse(raw) as unknown);
        } catch {
            return closedReference();
        }
    }
    return parseProgrammeReferenceArtifact(args[0]);
}

/**
 * Pure graduation-year estimate. Never persists: an available estimate
 * becomes a stored expected year only after the student confirms it through
 * the profile save, which recomputes independently. Direct entry consumes
 * the reviewed *remaining* route duration, so the entry year is always the
 * year the student entered at their actual level.
 */
export function estimateGraduationYear(
    input: EstimateInput,
    reference: ProgrammeReference,
    options?: { currentYear?: number },
): EstimateResult {
    const currentYear = options?.currentYear ?? new Date().getUTCFullYear();
    if (input.programmeId === null || input.entryYear === null || input.entryRoute === null) {
        return { state: 'unavailable', reason: 'missing_input' };
    }
    if (!reference.calculationsEnabled) {
        return { state: 'unavailable', reason: 'unreviewed_rule' };
    }
    const programme = reference.programmes.find((candidate) => candidate.programmeId === input.programmeId);
    if (!programme) {
        return { state: 'unavailable', reason: 'unknown_programme' };
    }
    if (!ESTIMATE_SUPPORTED_COUNTRY_CODES.includes(programme.countryCode)) {
        return { state: 'unavailable', reason: 'unsupported_country' };
    }
    const rule = programme.routes[input.entryRoute];
    if (!rule) {
        return { state: 'unavailable', reason: 'unsupported_route' };
    }
    if (rule.conflicting === true) {
        return { state: 'unavailable', reason: 'conflicting_rule' };
    }
    if (rule.estimable !== true || rule.reviewed !== true || rule.applicable !== true
        || typeof rule.durationYears !== 'number' || !Number.isInteger(rule.durationYears) || rule.durationYears < 1) {
        return { state: 'unavailable', reason: 'unreviewed_rule' };
    }
    if (!Number.isInteger(input.entryYear) || input.entryYear < ENTRY_YEAR_MIN || input.entryYear > currentYear) {
        return { state: 'unavailable', reason: 'out_of_range' };
    }
    const year = input.entryYear + rule.durationYears;
    if (year > currentYear + GRADUATION_HORIZON_YEARS) {
        return { state: 'unavailable', reason: 'out_of_range' };
    }
    const sourceVersion = reference.sourceVersion;
    if (sourceVersion === null) {
        return { state: 'unavailable', reason: 'unreviewed_rule' };
    }
    return { state: 'available', year, ruleId: `${programme.programmeId}:${input.entryRoute}`, sourceVersion };
}

export function encodeCatalogueCursor(offset: number): string {
    return Buffer.from(JSON.stringify({ v: 1, offset }), 'utf8').toString('base64url');
}

/** Decode an opaque catalogue cursor. Missing means the first page; malformed is rejected. */
export function decodeCatalogueCursor(cursor: string | null | undefined): number {
    if (cursor === null || cursor === undefined) return 0;
    try {
        const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null) throw new Error('not a cursor');
        const { v, offset } = parsed as { v?: unknown; offset?: unknown };
        if (v !== 1 || typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > CATALOGUE_MAX_OFFSET) {
            throw new Error('not a cursor');
        }
        return offset;
    } catch {
        throw new BadRequestError('Invalid catalogue cursor');
    }
}

const catalogueQuerySchema = z.object({
    q: z.string().max(CATALOGUE_MAX_QUERY_LENGTH).optional().default(''),
    cursor: z.string().max(CATALOGUE_MAX_CURSOR_LENGTH).optional(),
    limit: z.coerce.number().int().min(1).max(CATALOGUE_MAX_LIMIT).optional().default(CATALOGUE_DEFAULT_LIMIT),
}).strict();

export type CatalogueQuery = { q: string; cursor: string | null; limit: number };

/** Route-boundary catalogue contract: bounded page size, query, cursor, and keys. */
export function parseCatalogueQuery(raw: unknown): CatalogueQuery {
    const parsed = catalogueQuerySchema.parse(raw);
    return { q: parsed.q.trim(), cursor: parsed.cursor ?? null, limit: parsed.limit };
}

const COUNTRY_NAME_TO_CODE: Readonly<Record<string, string>> = {
    NIGERIA: 'NG',
    GHANA: 'GH',
};

/** Explicit catalogue country mapping. Unmapped countries resolve to null, never a guess. */
export function countryNameToCode(country: string | null | undefined): string | null {
    if (typeof country !== 'string') return null;
    return COUNTRY_NAME_TO_CODE[country.trim().toUpperCase()] ?? null;
}

export type ProgrammeSearchQuery = CatalogueQuery & { countryCode?: string | null };

/** Pure bounded programme search over display fields only. No catalogue entry is a supported-school claim. */
export function searchProgrammes(reference: ProgrammeReference, query: ProgrammeSearchQuery): CataloguePage<ProgrammeCatalogueItem> {
    const offset = decodeCatalogueCursor(query.cursor);
    const needle = query.q.trim().toLowerCase();
    const scoped = reference.programmes.filter((programme) => query.countryCode === null || query.countryCode === undefined || programme.countryCode === query.countryCode);
    const matched = needle === ''
        ? [...scoped]
        : scoped.filter((programme) =>
            programme.programmeId.toLowerCase().includes(needle)
            || programme.label.toLowerCase().includes(needle)
            || programme.aliases.some((alias) => alias.toLowerCase().includes(needle)));
    matched.sort((a, b) => (a.programmeId < b.programmeId ? -1 : a.programmeId > b.programmeId ? 1 : 0));
    const items = matched.slice(offset, offset + query.limit).map((programme) => ({
        programmeId: programme.programmeId,
        label: programme.label,
        award: programme.award,
    }));
    return { items, nextCursor: offset + query.limit < matched.length ? encodeCatalogueCursor(offset + query.limit) : null };
}

function escapeLikePattern(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

async function withLockedCatalogueContext<T>(
    pool: Pick<Pool, 'connect'>,
    userId: string,
    work: (tx: PoolClient, ctx: { universityId: string | null; institutionCountry: string | null }) => Promise<T>,
): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const ctx = await lockAcademicProfileContext(client, userId, 'read');
        const result = await work(client, ctx);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

type InstitutionRow = { name: unknown; country: unknown };

function toInstitutionItems(rows: InstitutionRow[]): InstitutionCatalogueItem[] {
    const items: InstitutionCatalogueItem[] = [];
    for (const row of rows) {
        if (typeof row.name !== 'string' || row.name.trim() === '') continue;
        items.push({
            name: row.name,
            countryCode: typeof row.country === 'string' || row.country === null ? countryNameToCode(row.country) : null,
        });
    }
    return items;
}

/**
 * Authenticated institution catalogue search. Bound students see only their
 * server-bound institution; unbound students search the general active
 * catalogue. Parameterized SQL throughout; the query stays in bound params.
 */
export async function searchInstitutionsForStudent(
    pool: Pick<Pool, 'connect'>,
    userId: string,
    rawQuery: unknown,
): Promise<CataloguePage<InstitutionCatalogueItem>> {
    const parsed = parseCatalogueQuery(rawQuery);
    const offset = decodeCatalogueCursor(parsed.cursor);
    const pattern = `%${escapeLikePattern(parsed.q)}%`;
    return withLockedCatalogueContext(pool, userId, async (tx, ctx) => {
        const fetched = ctx.universityId === null
            ? await tx.query<InstitutionRow>(
                `SELECT name, country FROM universities
                 WHERE is_active = true AND name ILIKE $1 ESCAPE '\\'
                 ORDER BY name ASC LIMIT $2 OFFSET $3`,
                [pattern, parsed.limit + 1, offset],
            )
            : await tx.query<InstitutionRow>(
                `SELECT name, country FROM universities
                 WHERE id = $1 AND name ILIKE $2 ESCAPE '\\'
                 ORDER BY name ASC LIMIT $3 OFFSET $4`,
                [ctx.universityId, pattern, parsed.limit + 1, offset],
            );
        const items = toInstitutionItems(fetched.rows);
        return {
            items: items.slice(0, parsed.limit),
            nextCursor: items.length > parsed.limit ? encodeCatalogueCursor(offset + parsed.limit) : null,
        };
    });
}

/**
 * Authenticated programme search. Bound contexts filter to the bound
 * institution's national reference slice when its country resolves; unbound
 * students search the general approved reference.
 */
export async function searchProgrammesForStudent(
    pool: Pick<Pool, 'connect'>,
    userId: string,
    rawQuery: unknown,
    options?: { reference?: ProgrammeReference },
): Promise<CataloguePage<ProgrammeCatalogueItem>> {
    const parsed = parseCatalogueQuery(rawQuery);
    return withLockedCatalogueContext(pool, userId, async (_tx, ctx) => {
        const countryCode = ctx.universityId === null ? null : countryNameToCode(ctx.institutionCountry);
        const reference = options?.reference ?? loadProgrammeReference();
        return searchProgrammes(reference, { ...parsed, countryCode });
    });
}

/**
 * Authenticated estimate. Locks the server context (soft-deleted accounts
 * stay denied) and computes purely; nothing is written and nothing about the
 * reference leaks beyond the reasoned result.
 */
export async function estimateGraduationYearForStudent(
    pool: Pick<Pool, 'connect'>,
    userId: string,
    rawInput: unknown,
    options?: { reference?: ProgrammeReference; currentYear?: number },
): Promise<EstimateResult> {
    const parsed = estimateInputSchema.parse(rawInput);
    return withLockedCatalogueContext(pool, userId, async () => {
        const reference = options?.reference ?? loadProgrammeReference();
        const currentYear = options?.currentYear ?? new Date().getUTCFullYear();
        return estimateGraduationYear(parsed, reference, { currentYear });
    });
}
