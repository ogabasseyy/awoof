import { lookup as dnsLookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import axios from 'axios';
import { z } from 'zod';
import { ENROLLMENT_SOURCE, type EnrollmentDecision } from './eligibility.types.js';

export const ENROLLMENT_SCHEMA_VERSION = 'awoof.enrollment.v1';

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_BYTES = 2_048;
const MAX_RESPONSE_BYTES = 16 * 1024;

const adapterConfigSchema = z.object({
    schemaVersion: z.literal(ENROLLMENT_SCHEMA_VERSION),
}).strict();

const mailboxSchema = z.string().min(3).max(320).refine((value) => {
    const [local, domain, ...rest] = value.trim().toLowerCase().split('@');
    return rest.length === 0
        && Boolean(local)
        && Boolean(domain)
        && !/[\s:/]/.test(local ?? '')
        && /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain ?? '');
});

const registrationSchema = z.string().min(1).max(100).refine((value) => value.trim().length > 0);
const timestampSchema = z.string().min(20).max(64).datetime({ offset: true });

const unknownResponseSchema = z.object({
    schemaVersion: z.literal(ENROLLMENT_SCHEMA_VERSION),
    outcome: z.literal('unknown'),
}).strict();

const deniedResponseSchema = z.object({
    schemaVersion: z.literal(ENROLLMENT_SCHEMA_VERSION),
    outcome: z.literal('denied'),
    email: mailboxSchema,
}).strict();

const verifiedResponseSchema = z.object({
    schemaVersion: z.literal(ENROLLMENT_SCHEMA_VERSION),
    outcome: z.literal('verified'),
    email: mailboxSchema,
    registrationNumber: registrationSchema,
    validUntil: timestampSchema,
}).strict();

export type RegistrationNormalization = 'exact' | 'trim_upper';

export type ConfiguredEnrollmentAdapter = {
    endpoint: URL;
    schemaVersion: typeof ENROLLMENT_SCHEMA_VERSION;
};

export type EnrollmentMethodConfiguration = {
    isActive: unknown;
    apiEndpoint: unknown;
    apiConfig: unknown;
};

export type EnrollmentTransportRequest = {
    endpoint: URL;
    email: string;
    registrationNumber: string;
};

export type EnrollmentTransportResponse = {
    status: number;
    data: unknown;
};

export type EnrollmentTransport = (request: EnrollmentTransportRequest) => Promise<EnrollmentTransportResponse>;

export type EnrollmentLookupResult = {
    decision: EnrollmentDecision;
    reason?: 'provider_unknown' | 'provider_unavailable';
};

export type PinnedEnrollmentDestination = { address: string; family: 4 | 6 };

function normalizeMailbox(value: string): string {
    return value.trim().toLowerCase();
}

function normalizeRegistration(value: string, policy: RegistrationNormalization): string {
    return policy === 'trim_upper' ? value.trim().toUpperCase() : value;
}

function parseHttpsEndpoint(value: unknown): URL | null {
    if (typeof value !== 'string' || value.length === 0 || value.length > 500) return null;
    try {
        const endpoint = new URL(value);
        const hostname = endpoint.hostname.replace(/^\[|\]$/g, '');
        if (endpoint.protocol !== 'https:' || !hostname || endpoint.username || endpoint.password || endpoint.hash || isIP(hostname)) {
            return null;
        }
        return endpoint;
    } catch {
        return null;
    }
}

/**
 * This parser deliberately accepts only the documented v1 shape. In
 * particular, `database_api_url`, arbitrary method seeds, and arbitrary Axios
 * options cannot make enrollment verification configured.
 */
export function parseConfiguredEnrollmentAdapter(
    configuration: EnrollmentMethodConfiguration,
): ConfiguredEnrollmentAdapter | null {
    if (configuration.isActive !== true) return null;
    const parsedConfig = adapterConfigSchema.safeParse(configuration.apiConfig);
    const endpoint = parseHttpsEndpoint(configuration.apiEndpoint);
    if (!parsedConfig.success || !endpoint) return null;
    return { endpoint, schemaVersion: parsedConfig.data.schemaVersion };
}

function ipv4ToInteger(value: string): number | null {
    const parts = value.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    return (((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 + parts[3]!);
}

function isInIpv4Range(value: number, network: string, prefix: number): boolean {
    const networkValue = ipv4ToInteger(network);
    if (networkValue === null) return true;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) === (networkValue & mask);
}

function ipv6ToInteger(value: string): bigint | null {
    const parts = value.split('::');
    if (parts.length > 2) return null;
    const expand = (side: string): string[] | null => {
        if (!side) return [];
        const segments = side.split(':');
        const expanded: string[] = [];
        for (const [index, segment] of segments.entries()) {
            if (segment.includes('.')) {
                if (index !== segments.length - 1) return null;
                const ipv4 = ipv4ToInteger(segment);
                if (ipv4 === null) return null;
                expanded.push(((ipv4 >>> 16) & 0xffff).toString(16), (ipv4 & 0xffff).toString(16));
                continue;
            }
            if (!/^[0-9a-f]{1,4}$/i.test(segment)) return null;
            expanded.push(segment);
        }
        return expanded;
    };
    const leading = expand(parts[0]!);
    const trailing = expand(parts[1] ?? '');
    if (!leading || !trailing) return null;
    const missing = 8 - leading.length - trailing.length;
    if (missing < 0 || (parts.length === 1 && missing !== 0)) return null;
    const hextets = [...leading, ...Array(missing).fill('0'), ...trailing];
    return hextets.reduce((result, hextet) => (result << 16n) | BigInt(`0x${hextet}`), 0n);
}

function isInIpv6Range(value: bigint, network: string, prefix: number): boolean {
    const networkValue = ipv6ToInteger(network);
    if (networkValue === null) return true;
    const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
    return (value & mask) === (networkValue & mask);
}

export function isPublicEnrollmentAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 4) {
        const value = ipv4ToInteger(address);
        if (value === null) return false;
        const blockedRanges: Array<[string, number]> = [
            ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
            ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
            ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
            ['224.0.0.0', 4],
        ];
        return !blockedRanges.some(([network, prefix]) => isInIpv4Range(value, network, prefix));
    }
    if (family === 6) {
        const value = ipv6ToInteger(address);
        if (value === null) return false;
        const embeddedIpv4 = value & 0xffffffffn;
        if (value >> 32n === 0n || value >> 32n === 0xffffn) {
            return isPublicEnrollmentAddress([
                Number((embeddedIpv4 >> 24n) & 0xffn),
                Number((embeddedIpv4 >> 16n) & 0xffn),
                Number((embeddedIpv4 >> 8n) & 0xffn),
                Number(embeddedIpv4 & 0xffn),
            ].join('.'));
        }
        const blockedRanges: Array<[string, number]> = [
            ['::', 128], ['::1', 128], ['ff00::', 8], ['fe80::', 10], ['fc00::', 7], ['2001:db8::', 32],
        ];
        return !blockedRanges.some(([network, prefix]) => isInIpv6Range(value, network, prefix));
    }
    return false;
}

async function resolvePublicAddresses(endpoint: URL): Promise<PinnedEnrollmentDestination[]> {
    const records = await dnsLookup(endpoint.hostname, { all: true, verbatim: true });
    return records
        .filter((record): record is PinnedEnrollmentDestination => (record.family === 4 || record.family === 6)
            && isPublicEnrollmentAddress(record.address))
        .sort((left, right) => left.family - right.family || left.address.localeCompare(right.address));
}

type EnrollmentTransportOptions = {
    timeoutMs?: number;
    resolveAddresses?: (endpoint: URL) => Promise<PinnedEnrollmentDestination[]>;
    certificateAuthority?: https.AgentOptions['ca'];
};

type PinnedLookup = {
    (hostname: string, options: { all: true }, callback: (error: Error | null, addresses: PinnedEnrollmentDestination[]) => void): void;
    (hostname: string, options: { all?: false } | undefined, callback: (error: Error | null, address: string, family: number) => void): void;
};
type PinnedLookupCallback =
    | ((error: Error | null, addresses: PinnedEnrollmentDestination[]) => void)
    | ((error: Error | null, address: string, family: number) => void);

export function createPinnedEnrollmentLookup(configuredHostname: string, destination: PinnedEnrollmentDestination): PinnedLookup {
    const expectedHost = configuredHostname.toLowerCase();
    return ((hostname: string, options: { all?: boolean } | undefined, callback: PinnedLookupCallback): void => {
        if (hostname.toLowerCase() !== expectedHost) {
            (callback as (error: Error) => void)(new Error('Enrollment destination hostname changed'));
            return;
        }
        if (options?.all) {
            (callback as (error: Error | null, addresses: PinnedEnrollmentDestination[]) => void)(null, [destination]);
            return;
        }
        (callback as (error: Error | null, address: string, family: number) => void)(null, destination.address, destination.family);
    }) as PinnedLookup;
}

/**
 * Axios receives a new HTTPS agent for each request. Its only DNS lookup is
 * pinned to a public address validated immediately before this call, while the
 * original hostname remains the TLS SNI/certificate verification name.
 */
export function createEnrollmentTransport({
    timeoutMs = REQUEST_TIMEOUT_MS,
    resolveAddresses = resolvePublicAddresses,
    certificateAuthority,
}: EnrollmentTransportOptions = {}): EnrollmentTransport {
    return async (request) => {
        const controller = new AbortController();
        const deadlineAt = Date.now() + timeoutMs;
        let rejectDeadline: (error: Error) => void = () => undefined;
        const deadline = new Promise<never>((_, reject) => {
            rejectDeadline = reject;
        });
        const timeout = setTimeout(() => {
            controller.abort();
            rejectDeadline(new Error('Enrollment provider deadline exceeded'));
        }, timeoutMs);
        let agent: https.Agent | undefined;
        try {
            const destinations = await Promise.race([resolveAddresses(request.endpoint), deadline]);
            if (controller.signal.aborted || Date.now() >= deadlineAt) {
                throw new Error('Enrollment provider deadline exceeded');
            }
            const destination = destinations[0];
            if (!destination) throw new Error('Enrollment destination is not public');
            const remainingTimeoutMs = deadlineAt - Date.now();
            if (remainingTimeoutMs <= 0) throw new Error('Enrollment provider deadline exceeded');
            agent = new https.Agent({
                keepAlive: false,
                maxSockets: 1,
                lookup: createPinnedEnrollmentLookup(request.endpoint.hostname, destination) as unknown as NonNullable<https.AgentOptions['lookup']>,
                servername: request.endpoint.hostname,
                rejectUnauthorized: true,
                ca: certificateAuthority,
            });
            const response = await axios.post(request.endpoint.toString(), {
                email: request.email,
                registrationNumber: request.registrationNumber,
            }, {
                headers: { 'content-type': 'application/json', accept: 'application/json', 'accept-encoding': 'identity' },
                timeout: remainingTimeoutMs,
                signal: controller.signal,
                maxBodyLength: MAX_REQUEST_BYTES,
                maxContentLength: MAX_RESPONSE_BYTES,
                maxRedirects: 0,
                proxy: false,
                httpsAgent: agent,
                adapter: 'http',
                responseType: 'json',
                decompress: false,
                transitional: { silentJSONParsing: false, forcedJSONParsing: true, clarifyTimeoutError: true },
                validateStatus: () => true,
            });
            return { status: response.status, data: response.data };
        } finally {
            clearTimeout(timeout);
            agent?.destroy();
        }
    };
}

export const defaultEnrollmentTransport = createEnrollmentTransport();

function unknown(reason: NonNullable<EnrollmentLookupResult['reason']>): EnrollmentLookupResult {
    return { decision: { outcome: 'unknown' }, reason };
}

function providerDecision(
    response: EnrollmentTransportResponse,
    request: { email: string; registrationNumber: string; normalization: RegistrationNormalization },
): EnrollmentLookupResult {
    if (!Number.isInteger(response.status) || response.status !== 200) return unknown('provider_unknown');
    if (unknownResponseSchema.safeParse(response.data).success) return unknown('provider_unknown');
    const denied = deniedResponseSchema.safeParse(response.data);
    if (denied.success) {
        return normalizeMailbox(denied.data.email) === normalizeMailbox(request.email)
            ? { decision: { outcome: 'denied', email: denied.data.email, source: ENROLLMENT_SOURCE } }
            : unknown('provider_unknown');
    }
    const verified = verifiedResponseSchema.safeParse(response.data);
    if (!verified.success || normalizeMailbox(verified.data.email) !== normalizeMailbox(request.email)) {
        return unknown('provider_unknown');
    }
    const validUntil = new Date(verified.data.validUntil);
    if (!Number.isFinite(validUntil.getTime()) || validUntil <= new Date()
        || normalizeRegistration(verified.data.registrationNumber, request.normalization)
            !== normalizeRegistration(request.registrationNumber, request.normalization)) {
        return unknown('provider_unknown');
    }
    return {
        decision: {
            outcome: 'verified',
            email: verified.data.email,
            registrationNumber: verified.data.registrationNumber,
            validUntil,
            source: ENROLLMENT_SOURCE,
        },
    };
}

export async function verifyConfiguredEnrollment(
    adapter: ConfiguredEnrollmentAdapter,
    request: { email: string; registrationNumber: string; normalization: RegistrationNormalization },
    transport: EnrollmentTransport = defaultEnrollmentTransport,
): Promise<EnrollmentLookupResult> {
    try {
        return providerDecision(await transport({
            endpoint: adapter.endpoint,
            email: request.email,
            registrationNumber: request.registrationNumber,
        }), request);
    } catch {
        return unknown('provider_unavailable');
    }
}
