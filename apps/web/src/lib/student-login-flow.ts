/**
 * Email-first student login flow: discovery, tab-bound SSO attempts, and safe
 * failure routing.
 *
 * The browser never authorizes anything here. It resolves the approved login
 * methods for a typed email domain, keeps one SSO attempt's finish secret in
 * tab (session) storage only, and routes every failure back to the password
 * login with a fixed error taxonomy — never an upstream message, secret, or
 * email address in an Awoof URL. Provider bearer tokens are never stored.
 */

import { resolveStudentReturn } from './student-return';
import { parseAuthenticatedAssurance, type StudentAssurance } from './student-assurance';

export type SsoLoginProvider = 'google' | 'microsoft';

export type LoginStep = 'email' | 'loading_methods' | 'methods' | 'password'
    | 'redirecting' | 'link_required' | 'complete' | 'error';

export type LoginState = {
    step: LoginStep;
    email: string;
    requestId: number;
    providers: readonly SsoLoginProvider[];
    error: string | null;
};

export const initialLoginState: LoginState = {
    step: 'email',
    email: '',
    requestId: 0,
    providers: [],
    error: null,
};

export function submitEmail(state: LoginState, email: string): LoginState {
    return { step: 'loading_methods', email, requestId: state.requestId + 1, providers: [], error: null };
}

/** A stale discovery response never overwrites a newer request; same state back. */
export function methodsResolved(state: LoginState, requestId: number, providers: readonly SsoLoginProvider[]): LoginState {
    if (state.step !== 'loading_methods' || requestId !== state.requestId) return state;
    if (providers.length === 0) {
        return { ...state, step: 'password', providers: [], error: null };
    }
    return { ...state, step: 'methods', providers: [...providers], error: null };
}

export function methodsFailed(state: LoginState, requestId: number, error: string): LoginState {
    if (state.step !== 'loading_methods' || requestId !== state.requestId) return state;
    return { ...state, step: 'error', providers: [], error };
}

export function backToEmail(state: LoginState): LoginState {
    if (state.step !== 'methods' && state.step !== 'password') return state;
    return { ...state, step: 'email', providers: [], error: null };
}

/** Password remains available without re-running discovery or changing the email. */
export function choosePassword(state: LoginState): LoginState {
    if (state.step !== 'methods' && state.step !== 'error') return state;
    return { ...state, step: 'password', error: null };
}

export function chooseProvider(state: LoginState, provider: SsoLoginProvider): LoginState {
    if (state.step !== 'methods' || !state.providers.includes(provider)) return state;
    return { ...state, step: 'redirecting', error: null };
}

export function startFailed(state: LoginState, error: string): LoginState {
    if (state.step !== 'redirecting') return state;
    return { ...state, step: 'methods', error };
}

export function linkRequired(state: LoginState): LoginState {
    if (state.step !== 'redirecting') return state;
    return { ...state, step: 'link_required', error: null };
}

export function completeLogin(state: LoginState): LoginState {
    if (state.step !== 'redirecting') return state;
    return { ...state, step: 'complete', error: null };
}

export function failLogin(state: LoginState, error: string): LoginState {
    if (state.step !== 'redirecting' && state.step !== 'methods' && state.step !== 'loading_methods') return state;
    return { ...state, step: 'error', error };
}

export function retryAfterError(state: LoginState): LoginState {
    if (state.step !== 'error') return state;
    return { ...state, step: 'email', providers: [], error: null };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function isUuid(value: unknown): value is string {
    return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isInstant(value: unknown): value is string {
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isOpaqueSecret(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}

function isProvider(value: unknown): value is SsoLoginProvider {
    return value === 'google' || value === 'microsoft';
}

function successData(value: unknown): Record<string, unknown> | null {
    const envelope = asRecord(value);
    if (!envelope || envelope.success !== true) return null;
    return asRecord(envelope.data);
}

export type LoginOptions = {
    providers: readonly SsoLoginProvider[];
};

/** Strictly validate discovery; duplicates or unknown providers reject. */
export function parseLoginOptions(value: unknown): LoginOptions | null {
    const data = successData(value);
    const providers = data?.providers;
    if (!data || data.password !== true || !Array.isArray(providers)) return null;
    if (!providers.every(isProvider) || new Set(providers).size !== providers.length) return null;
    return { providers: [...providers] };
}

export type SsoStart = {
    attemptId: string;
    authorizationUrl: string;
    finishSecret: string;
    expiresAt: string;
    /** Server clock at issuance; null when the backend omits it. */
    serverNow: string | null;
};

function isLoopbackHttp(url: URL): boolean {
    return url.protocol === 'http:'
        && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1');
}

function parseAuthorizationUrl(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' && !isLoopbackHttp(url)) return null;
    if (url.username || url.password || url.hash) return null;
    return url.href;
}

/** Strictly validate the SSO start payload before storing or redirecting. */
export function parseSsoStart(value: unknown): SsoStart | null {
    const data = successData(value);
    if (!data) return null;
    const authorizationUrl = parseAuthorizationUrl(data.authorizationUrl);
    if (!isUuid(data.attemptId) || !authorizationUrl || !isOpaqueSecret(data.finishSecret) || !isInstant(data.expiresAt)) {
        return null;
    }
    return {
        attemptId: data.attemptId,
        authorizationUrl,
        finishSecret: data.finishSecret,
        expiresAt: data.expiresAt,
        serverNow: isInstant(data.serverNow) ? data.serverNow : null,
    };
}

export type SsoFinishAuthenticated = {
    kind: 'authenticated';
    user: { id: string; email: string; role: 'student' };
    tokens: { accessToken: string; refreshToken: string };
    studentAssurance: StudentAssurance | null;
    assuranceStatus: 'available' | 'unavailable';
};

export type SsoFinishLinkRequired = {
    kind: 'link_required';
    handoffId: string;
    handoffSecret: string;
    expiresAt: string;
};

function isStudentUser(value: unknown): value is SsoFinishAuthenticated['user'] {
    const user = asRecord(value);
    return !!user
        && typeof user.id === 'string' && user.id.length > 0
        && typeof user.email === 'string' && user.email.length > 0
        && user.role === 'student';
}

function isTokenPair(value: unknown): value is SsoFinishAuthenticated['tokens'] {
    const tokens = asRecord(value);
    return !!tokens
        && typeof tokens.accessToken === 'string' && tokens.accessToken.length > 0
        && typeof tokens.refreshToken === 'string' && tokens.refreshToken.length > 0;
}

/**
 * Strictly validate the finish union. Restart is a 409 with its own code,
 * never a 200 outcome — see parseSsoRestart.
 */
export function parseSsoFinishResponse(value: unknown): SsoFinishAuthenticated | SsoFinishLinkRequired | null {
    const data = successData(value);
    if (!data) return null;
    if (data.outcome === 'authenticated') {
        if (!isStudentUser(data.user) || !isTokenPair(data.tokens)) return null;
        const assurance = parseAuthenticatedAssurance({
            studentAssurance: data.studentAssurance ?? null,
            assuranceStatus: data.assuranceStatus,
        });
        if (!assurance) return null;
        return {
            kind: 'authenticated',
            user: { id: (data.user as { id: string }).id, email: (data.user as { email: string }).email, role: 'student' },
            tokens: {
                accessToken: (data.tokens as { accessToken: string }).accessToken,
                refreshToken: (data.tokens as { refreshToken: string }).refreshToken,
            },
            studentAssurance: assurance.studentAssurance,
            assuranceStatus: assurance.assuranceStatus,
        };
    }
    if (data.outcome === 'link_required') {
        if (!isUuid(data.handoffId) || !isOpaqueSecret(data.handoffSecret) || !isInstant(data.expiresAt)) return null;
        return {
            kind: 'link_required',
            handoffId: data.handoffId,
            handoffSecret: data.handoffSecret,
            expiresAt: data.expiresAt,
        };
    }
    return null;
}

/** Restart surfaces only as the safe conflict code; nothing else qualifies. */
export function parseSsoRestart(status: number | undefined, body: unknown): boolean {
    if (status !== 409) return false;
    return asRecord(asRecord(body)?.error)?.code === 'SSO_RESTART_REQUIRED';
}

export type SsoReauthGrant = {
    grantId: string;
    grantSecret: string;
    expiresAt: string;
};

/** Strictly validate a reauth grant: uuid id, opaque secret, instant expiry. */
export function parseSsoReauthResponse(value: unknown): SsoReauthGrant | null {
    const data = successData(value);
    if (!data) return null;
    if (!isUuid(data.grantId) || !isOpaqueSecret(data.grantSecret) || !isInstant(data.expiresAt)) return null;
    return { grantId: data.grantId, grantSecret: data.grantSecret, expiresAt: data.expiresAt };
}

export type SsoLinkOutcome =
    | { kind: 'linked'; reactivated: boolean; schoolAssertion: string }
    | { kind: 'mismatch' }
    | { kind: 'restart' };

/**
 * Strictly validate the link union. Linked is 200/201 with its outcome;
 * mismatch and restart are 409s with their own codes — see parseSsoRestart.
 */
export function parseSsoLinkResponse(status: number | undefined, body: unknown): SsoLinkOutcome | null {
    if (status === 200 || status === 201) {
        const data = successData(body);
        if (!data || data.outcome !== 'linked') return null;
        if (typeof data.reactivated !== 'boolean' || typeof data.schoolAssertion !== 'string') return null;
        return { kind: 'linked', reactivated: data.reactivated, schoolAssertion: data.schoolAssertion };
    }
    if (status === 409) {
        const code = asRecord(asRecord(body)?.error)?.code;
        if (code === 'SSO_LINK_MISMATCH') return { kind: 'mismatch' };
        if (code === 'SSO_RESTART_REQUIRED') return { kind: 'restart' };
    }
    return null;
}

export type SsoAttemptRecord = {
    attemptId: string;
    finishSecret: string;
    expiresAt: string;
    /** Browser session generation captured at start; fences late finishes. */
    generation: number;
    /** Validated same-origin return path; the server never echoes it back. */
    returnPath: string;
    /** Server clock minus device clock (ms) at save; expiry is server-authoritative. */
    serverSkewMs: number;
};

export type SsoHandoffRecord = {
    handoffId: string;
    handoffSecret: string;
    expiresAt: string;
    /** Validated same-origin return path carried over from the attempt. */
    returnPath: string;
    /** Server skew inherited from the attempt; handoff expiry is server-authoritative. */
    serverSkewMs: number;
};

const SSO_ATTEMPT_KEY = 'awoof.sso.attempt.v1.tab';
const SSO_HANDOFF_KEY = 'awoof.sso.handoff.v1.tab';

function readJsonRecord(storage: Storage | null | undefined, key: string): Record<string, unknown> | null {
    if (!storage) return null;
    try {
        const raw = storage.getItem(key);
        if (!raw) return null;
        return asRecord(JSON.parse(raw));
    } catch {
        return null;
    }
}

function writeRecord(storage: Storage | null | undefined, key: string, record: unknown): boolean {
    if (!storage) return false;
    try {
        storage.setItem(key, JSON.stringify(record));
        return storage.getItem(key) !== null;
    } catch {
        return false;
    }
}

function clearRecord(storage: Storage | null | undefined, key: string): void {
    if (!storage) return;
    try {
        storage.removeItem(key);
    } catch {
        // Storage is already unusable; nothing retained that we can clear.
    }
}

function isAttemptRecord(value: Record<string, unknown> | null): value is Record<string, unknown> & {
    attemptId: string; finishSecret: string; expiresAt: string; generation: number; returnPath: string;
} {
    return !!value
        && isUuid(value.attemptId)
        && isOpaqueSecret(value.finishSecret)
        && isInstant(value.expiresAt)
        && typeof value.generation === 'number' && Number.isInteger(value.generation) && value.generation >= 0
        && typeof value.returnPath === 'string' && value.returnPath.length > 0;
}

function readSkewMs(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Persist the tab attempt; only id, finish secret, expiry, generation, return path, clock skew. */
export function saveSsoAttempt(storage: Storage | null | undefined, record: SsoAttemptRecord): boolean {
    if (!isUuid(record.attemptId) || !isOpaqueSecret(record.finishSecret) || !isInstant(record.expiresAt)) return false;
    if (!Number.isInteger(record.generation) || record.generation < 0) return false;
    if (typeof record.returnPath !== 'string' || record.returnPath.length === 0) return false;
    if (typeof record.serverSkewMs !== 'number' || !Number.isFinite(record.serverSkewMs)) return false;
    return writeRecord(storage, SSO_ATTEMPT_KEY, {
        attemptId: record.attemptId,
        finishSecret: record.finishSecret,
        expiresAt: record.expiresAt,
        generation: record.generation,
        returnPath: record.returnPath,
        serverSkewMs: record.serverSkewMs,
    });
}

export function readSsoAttempt(storage: Storage | null | undefined): SsoAttemptRecord | null {
    const record = readJsonRecord(storage, SSO_ATTEMPT_KEY);
    if (!isAttemptRecord(record)) return null;
    return {
        attemptId: record.attemptId,
        finishSecret: record.finishSecret,
        expiresAt: record.expiresAt,
        generation: record.generation,
        returnPath: record.returnPath,
        // Tolerate records written before clock-skew tracking shipped.
        serverSkewMs: readSkewMs(record.serverSkewMs),
    };
}

export function clearSsoAttempt(storage: Storage | null | undefined): void {
    clearRecord(storage, SSO_ATTEMPT_KEY);
}

/** Expiry is server-authoritative: the saved skew maps the device clock onto the server clock. */
export function isSsoAttemptLive(record: Pick<SsoAttemptRecord, 'expiresAt' | 'serverSkewMs'>, nowMs: number): boolean {
    return Date.parse(record.expiresAt) > nowMs + record.serverSkewMs;
}

/** Server clock minus device clock (ms) at the moment of the call; 0 when the backend omits its clock. */
export function serverSkewSince(serverNow: string | null): number {
    return serverNow ? Date.parse(serverNow) - Date.now() : 0;
}

/** The stored attempt must match the completion URL and the tab generation. */
export function ssoAttemptMatches(record: SsoAttemptRecord, attemptId: string, generation: number): boolean {
    return record.attemptId.toLowerCase() === attemptId.toLowerCase() && record.generation === generation;
}

/** Persist the unlinked-identity handoff in this tab only; never in a URL. */
export function saveSsoHandoff(storage: Storage | null | undefined, record: SsoHandoffRecord): boolean {
    if (!isUuid(record.handoffId) || !isOpaqueSecret(record.handoffSecret) || !isInstant(record.expiresAt)) return false;
    if (typeof record.returnPath !== 'string' || record.returnPath.length === 0) return false;
    if (typeof record.serverSkewMs !== 'number' || !Number.isFinite(record.serverSkewMs)) return false;
    return writeRecord(storage, SSO_HANDOFF_KEY, {
        handoffId: record.handoffId,
        handoffSecret: record.handoffSecret,
        expiresAt: record.expiresAt,
        returnPath: record.returnPath,
        serverSkewMs: record.serverSkewMs,
    });
}

export function readSsoHandoff(storage: Storage | null | undefined): SsoHandoffRecord | null {
    const record = readJsonRecord(storage, SSO_HANDOFF_KEY);
    if (!record || !isUuid(record.handoffId) || !isOpaqueSecret(record.handoffSecret) || !isInstant(record.expiresAt)) {
        return null;
    }
    if (typeof record.returnPath !== 'string' || record.returnPath.length === 0) return null;
    return {
        handoffId: record.handoffId,
        handoffSecret: record.handoffSecret,
        expiresAt: record.expiresAt,
        returnPath: record.returnPath,
        // Tolerate records written before clock-skew tracking shipped.
        serverSkewMs: readSkewMs(record.serverSkewMs),
    };
}

export function clearSsoHandoff(storage: Storage | null | undefined): void {
    clearRecord(storage, SSO_HANDOFF_KEY);
}

export const LOGIN_ERROR_CODES = ['session_expired', 'sso_not_completed', 'sso_expired', 'sso_unavailable'] as const;

export type LoginErrorCode = (typeof LOGIN_ERROR_CODES)[number];

/** Only the fixed taxonomy is ever honored from a login URL. */
export function parseLoginErrorCode(value: unknown): LoginErrorCode | null {
    return typeof value === 'string' && (LOGIN_ERROR_CODES as readonly string[]).includes(value)
        ? value as LoginErrorCode
        : null;
}

/**
 * Fixed user-facing copy per code. School-account assurance and enrollment
 * eligibility stay separate; no code promises membership or discounts.
 */
export function loginErrorMessage(code: LoginErrorCode): string {
    switch (code) {
        case 'session_expired':
            return 'Your session expired. Sign in again with your password to continue.';
        case 'sso_not_completed':
            return 'The school sign-in did not complete. Try again, or use your password — your account is unchanged.';
        case 'sso_expired':
            return 'Your school sign-in attempt expired. Start again, or use your password.';
        case 'sso_unavailable':
            return 'School sign-in is temporarily unavailable. Use your password; your account is unchanged.';
    }
}

/** Failed logins redirect with the safe taxonomy plus a validated return path. */
export function ssoFailureLoginPath(code: LoginErrorCode, returnPath: string | null, origin: string): string {
    const query = new URLSearchParams({
        error: code,
        redirect: resolveStudentReturn(returnPath, origin),
    }).toString();
    return `/auth/student/login?${query}`;
}

export type SsoDestinationInput = {
    studentAssurance: StudentAssurance | null;
    assuranceStatus: 'available' | 'unavailable';
    returnPath: string | null;
    origin: string;
};

/**
 * Enrolled students continue to the validated requested page; anything else
 * with readable assurance continues to enrollment verification. Unavailable
 * assurance stays signed in — benefits fail closed server-side.
 */
export function ssoPostLoginDestination(input: SsoDestinationInput): string {
    if (input.assuranceStatus === 'available'
        && input.studentAssurance
        && input.studentAssurance.studentStatus !== 'verified') {
        return '/student/verification';
    }
    return resolveStudentReturn(input.returnPath, input.origin);
}
