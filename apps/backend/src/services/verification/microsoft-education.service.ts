const GRAPH_EDUCATION_ME_URL = 'https://graph.microsoft.com/v1.0/education/me?$select=id,primaryRole,userType,accountEnabled';
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export type EducationObservation =
    | { outcome: 'student'; objectId: string; observedAt: Date }
    | { outcome: 'unknown'; reason: 'unavailable' | 'role_not_confirmed' | 'permission_required' | 'identity_mismatch' | 'account_not_eligible'; httpStatus?: number };

export function classifyEducation(body: { id?: string; primaryRole?: string; userType?: string; accountEnabled?: boolean }, expectedOid: string, now: Date): EducationObservation {
    if (!isEducationBody(body) || typeof expectedOid !== 'string' || expectedOid.length === 0) return unavailable();
    if (body.id !== expectedOid) return { outcome: 'unknown', reason: 'identity_mismatch' };
    if (body.userType !== 'Member' || body.accountEnabled !== true) return { outcome: 'unknown', reason: 'account_not_eligible' };
    if (body.primaryRole === 'student') {
        if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return unavailable();
        return { outcome: 'student', objectId: expectedOid, observedAt: now };
    }
    return { outcome: 'unknown', reason: 'role_not_confirmed' };
}

type Dependencies = {
    fetch?: typeof globalThis.fetch;
    now?: () => Date;
    /** Only injectable in tests so the production deadline remains fixed. */
    timeoutMs?: number;
};

function unavailable(): EducationObservation { return { outcome: 'unknown', reason: 'unavailable' }; }

function discard(response: Response): void {
    // Never await cancellation: a hostile stream must not prolong this request.
    void response.body?.cancel().catch(() => undefined);
}

async function readWithDeadline(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>> {
    if (signal.aborted) throw new DOMException('Graph request timed out', 'TimeoutError');
    let onAbort: (() => void) | undefined;
    const deadline = new Promise<never>((_, reject) => {
        onAbort = () => reject(new DOMException('Graph request timed out', 'TimeoutError'));
        signal.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([reader.read(), deadline]); }
    finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw new TypeError('Graph response body is missing');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const next = await readWithDeadline(reader, signal);
            if (next.done) break;
            size += next.value.byteLength;
            if (size > MAX_RESPONSE_BYTES) throw new RangeError('Graph response exceeds byte limit');
            chunks.push(next.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
        void reader.cancel().catch(() => undefined);
        throw error;
    }
}

function isEducationBody(value: unknown): value is { id?: string; primaryRole?: string; userType?: string; accountEnabled?: boolean } {
    try {
        // Graph's collection wrapper is never valid for the fixed `/education/me`
        // resource, even if it happens to contain an otherwise plausible user.
        if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.hasOwn(value, 'value')) return false;
        const body = value as Record<string, unknown>;
        return (!Object.hasOwn(body, 'id') || typeof body.id === 'string')
            && (!Object.hasOwn(body, 'primaryRole') || typeof body.primaryRole === 'string')
            && (!Object.hasOwn(body, 'userType') || typeof body.userType === 'string')
            && (!Object.hasOwn(body, 'accountEnabled') || typeof body.accountEnabled === 'boolean');
    } catch { return false; }
}

export class MicrosoftEducationService {
    private readonly fetch: typeof globalThis.fetch;
    private readonly now: () => Date;
    private readonly timeoutMs: number;

    constructor(dependencies: Dependencies = {}) {
        if (dependencies.timeoutMs !== undefined && process.env.NODE_ENV !== 'test') throw new TypeError('Graph deadline is fixed');
        this.fetch = dependencies.fetch ?? globalThis.fetch;
        this.now = dependencies.now ?? (() => new Date());
        this.timeoutMs = dependencies.timeoutMs ?? REQUEST_TIMEOUT_MS;
    }

    async observe(input: { accessToken: string; expectedOid: string }): Promise<EducationObservation> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let responsePromise: Promise<Response> | undefined;
        try {
            responsePromise = this.fetch(GRAPH_EDUCATION_ME_URL, {
                method: 'GET', redirect: 'manual', signal: controller.signal,
                headers: { authorization: `Bearer ${input.accessToken}`, accept: 'application/json' },
            });
            // If a non-cooperative fetch resolves after the deadline, ensure its
            // body is still discarded rather than left readable in the process.
            void responsePromise.then((response) => { if (controller.signal.aborted) discard(response); }).catch(() => undefined);
            const response = await Promise.race([
                responsePromise,
                new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new DOMException('Graph request timed out', 'TimeoutError')), { once: true })),
            ]);
            if (response.status >= 300 && response.status < 400) { discard(response); return unavailable(); }
            if (response.status === 401 || response.status === 403) { discard(response); return { outcome: 'unknown', reason: 'permission_required', httpStatus: response.status }; }
            if (!response.ok) { discard(response); return unavailable(); }
            const contentLength = response.headers.get('content-length');
            if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)) { discard(response); return unavailable(); }
            const body = await boundedJson(response, controller.signal);
            return classifyEducation(body as { id?: string; primaryRole?: string; userType?: string; accountEnabled?: boolean }, input.expectedOid, this.now());
        } catch {
            return unavailable();
        } finally {
            clearTimeout(timer);
            controller.abort();
        }
    }
}
