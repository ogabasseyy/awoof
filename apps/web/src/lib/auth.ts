/**
 * Browser session storage and small authentication helpers.
 *
 * The envelope is deliberately browser-local. Its sessionId fences late
 * browser work; it is never a server session identifier or merchant value.
 */

export interface TokenPair {
    accessToken: string;
    refreshToken: string;
}

export interface User {
    id: string;
    email: string;
    role: 'student' | 'vendor' | 'admin';
    verificationStatus?: 'unverified' | 'verified' | 'expired';
}

export interface SessionSnapshot {
    generation: number;
    accessToken: string | null;
    refreshToken: string | null;
}

type ActiveEnvelope = {
    v: 1;
    state: 'active';
    sessionId: string;
    accessToken: string;
    refreshToken: string;
};

type SignedOutEnvelope = {
    v: 1;
    state: 'signed_out';
    actionId?: string;
};

type SessionEnvelope = ActiveEnvelope | SignedOutEnvelope;
type ObservedSession = ActiveEnvelope | SignedOutEnvelope;

const SESSION_KEY = 'awoof.session.v1';
const LEGACY_ACCESS_KEY = 'accessToken';
const LEGACY_REFRESH_KEY = 'refreshToken';
const STORAGE_ERROR_MESSAGE = 'Session storage is unavailable. Please try again.';

let generation = 0;
let observed: ObservedSession = { v: 1, state: 'signed_out' };
let quarantined = false;
const listeners = new Set<() => void>();
let storageListenerAttached = false;

export class SessionStorageError extends Error {
    constructor() {
        super(STORAGE_ERROR_MESSAGE);
        this.name = 'SessionStorageError';
    }
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isActiveEnvelope(value: unknown): value is ActiveEnvelope {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const envelope = value as Partial<ActiveEnvelope>;
    return envelope.v === 1
        && envelope.state === 'active'
        && isNonEmptyString(envelope.sessionId)
        && isNonEmptyString(envelope.accessToken)
        && isNonEmptyString(envelope.refreshToken);
}

function isSignedOutEnvelope(value: unknown): value is SignedOutEnvelope {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const envelope = value as Partial<SignedOutEnvelope>;
    return envelope.v === 1
        && envelope.state === 'signed_out'
        && (envelope.actionId === undefined || isNonEmptyString(envelope.actionId));
}

function parseEnvelope(value: string): SessionEnvelope | null {
    try {
        const parsed: unknown = JSON.parse(value);
        if (isActiveEnvelope(parsed)) return parsed;
        if (isSignedOutEnvelope(parsed)) {
            return parsed.actionId === undefined
                ? { v: 1, state: 'signed_out' }
                : { v: 1, state: 'signed_out', actionId: parsed.actionId };
        }
    } catch {
        // A malformed envelope is authoritative signed-out state, not a cue to
        // revive legacy credentials.
    }
    return null;
}

function currentWindow(): Window | null {
    return typeof window === 'undefined' ? null : window;
}

function emit(): void {
    for (const listener of listeners) listener();
}

function invalidateToSignedOut(
    force = false,
    next: SignedOutEnvelope = { v: 1, state: 'signed_out' },
): void {
    const changed = force || observed.state === 'active' || observed.actionId !== next.actionId;
    observed = next;
    if (changed) {
        generation += 1;
        emit();
    }
}

function observeActive(next: ActiveEnvelope, forceNewSession = false): void {
    const sameSession = !forceNewSession
        && observed.state === 'active'
        && observed.sessionId === next.sessionId;
    observed = next;
    if (!sameSession) {
        generation += 1;
        emit();
    }
}

function quarantineSession(): void {
    if (quarantined) return;
    quarantined = true;
    invalidateToSignedOut(true);
}

function getStorage(): Storage | null {
    const browser = currentWindow();
    if (!browser) return null;
    try {
        return browser.localStorage;
    } catch {
        quarantineSession();
        return null;
    }
}

function serialize(envelope: SessionEnvelope): string {
    return JSON.stringify(envelope);
}

function writeAndReadBack(storage: Storage, envelope: SessionEnvelope): boolean {
    try {
        const persisted = serialize(envelope);
        storage.setItem(SESSION_KEY, persisted);
        return storage.getItem(SESSION_KEY) === persisted;
    } catch {
        return false;
    }
}

function newSessionId(): string {
    try {
        return crypto.randomUUID();
    } catch {
        throw new SessionStorageError();
    }
}

function reconcileStorage(): void {
    const browser = currentWindow();
    if (!browser) return;
    const storage = getStorage();
    if (!storage || quarantined) return;

    let encoded: string | null;
    try {
        encoded = storage.getItem(SESSION_KEY);
    } catch {
        quarantineSession();
        return;
    }

    if (encoded !== null) {
        const envelope = parseEnvelope(encoded);
        if (envelope && envelope.state === 'active') observeActive(envelope);
        else invalidateToSignedOut(false, envelope?.state === 'signed_out' ? envelope : undefined);
        return;
    }

    let accessToken: string | null;
    let refreshToken: string | null;
    try {
        accessToken = storage.getItem(LEGACY_ACCESS_KEY);
        refreshToken = storage.getItem(LEGACY_REFRESH_KEY);
    } catch {
        quarantineSession();
        return;
    }

    if (!isNonEmptyString(accessToken) || !isNonEmptyString(refreshToken)) {
        invalidateToSignedOut();
        return;
    }

    let migrated: ActiveEnvelope;
    try {
        migrated = {
            v: 1,
            state: 'active',
            sessionId: newSessionId(),
            accessToken,
            refreshToken,
        };
    } catch {
        quarantineSession();
        return;
    }
    if (!writeAndReadBack(storage, migrated)) {
        quarantineSession();
        return;
    }
    try {
        storage.removeItem(LEGACY_ACCESS_KEY);
        storage.removeItem(LEGACY_REFRESH_KEY);
    } catch {
        // The checked envelope remains authoritative even when old cleanup is
        // unavailable.
    }
    observeActive(migrated, true);
}

function attachStorageListener(): void {
    const browser = currentWindow();
    if (!browser || storageListenerAttached) return;
    browser.addEventListener('storage', (event) => {
        if (
            event.key === null
            || event.key === SESSION_KEY
            || event.key === LEGACY_ACCESS_KEY
            || event.key === LEGACY_REFRESH_KEY
        ) {
            reconcileStorage();
        }
    });
    storageListenerAttached = true;
}

function snapshot(): SessionSnapshot {
    if (quarantined || observed.state === 'signed_out') {
        return { generation, accessToken: null, refreshToken: null };
    }
    return {
        generation,
        accessToken: observed.accessToken,
        refreshToken: observed.refreshToken,
    };
}

/** Store a complete new browser session or throw a safe persistence error. */
export function storeTokens(tokens: TokenPair): void {
    if (!isNonEmptyString(tokens.accessToken) || !isNonEmptyString(tokens.refreshToken)) {
        quarantineSession();
        throw new SessionStorageError();
    }
    const storage = getStorage();
    if (!storage) throw new SessionStorageError();

    let next: ActiveEnvelope;
    try {
        next = {
            v: 1,
            state: 'active',
            sessionId: newSessionId(),
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
        };
    } catch {
        quarantineSession();
        throw new SessionStorageError();
    }
    if (!writeAndReadBack(storage, next)) {
        quarantineSession();
        throw new SessionStorageError();
    }
    quarantined = false;
    observeActive(next, true);
}

/**
 * Rotate tokens only when the exact session that initiated the refresh still
 * owns local storage. This is intentionally used by the Axios module only.
 */
export function replaceCurrentSessionTokens(snapshotAtStart: SessionSnapshot, tokens: TokenPair): boolean {
    reconcileStorage();
    if (!isExactSession(snapshotAtStart) || observed.state !== 'active') return false;
    if (!isNonEmptyString(tokens.accessToken) || !isNonEmptyString(tokens.refreshToken)) return false;
    const storage = getStorage();
    if (!storage) return false;
    const next: ActiveEnvelope = {
        v: 1,
        state: 'active',
        sessionId: observed.sessionId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
    };
    if (!writeAndReadBack(storage, next)) {
        quarantineSession();
        return false;
    }
    observeActive(next);
    return true;
}

/** Clear local authority immediately and attempt a durable signed-out marker. */
export function clearTokens(): void {
    const storage = getStorage();
    quarantineSession();
    if (!storage) return;

    let marker: SignedOutEnvelope;
    try {
        // This identifies a completed action; it is not cross-tab atomic exclusion.
        marker = { v: 1, state: 'signed_out', actionId: newSessionId() };
    } catch {
        return;
    }
    if (!writeAndReadBack(storage, marker)) return;
    try {
        storage.removeItem(LEGACY_ACCESS_KEY);
        storage.removeItem(LEGACY_REFRESH_KEY);
    } catch {
        // The durable marker still prevents a legacy credential resurrection.
    }
    observed = marker;
    quarantined = false;
    // Listeners already saw the provisional quarantine that immediately
    // invalidated the old account. Announce the durable final state too, so a
    // provider can release its failure UI without reviving that account.
    emit();
}

export function getSessionSnapshot(): SessionSnapshot {
    reconcileStorage();
    return snapshot();
}

/** Same logical browser session; own token rotation keeps this true. */
export function isCurrentSession(candidate: SessionSnapshot): boolean {
    reconcileStorage();
    return !quarantined
        && observed.state === 'active'
        && candidate.generation === generation;
}

/** Exact pair predicate for fenced refresh commits and 401 cleanup. */
export function isExactSession(candidate: SessionSnapshot): boolean {
    reconcileStorage();
    return isCurrentSession(candidate)
        && observed.state === 'active'
        && candidate.accessToken === observed.accessToken
        && candidate.refreshToken === observed.refreshToken;
}

export function subscribeSessionChanges(listener: () => void): () => void {
    attachStorageListener();
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function isSessionStorageQuarantined(): boolean {
    return quarantined;
}

export function getAccessToken(): string | null {
    return getSessionSnapshot().accessToken;
}

export function getRefreshToken(): string | null {
    return getSessionSnapshot().refreshToken;
}

export function isAuthenticated(): boolean {
    return getAccessToken() !== null;
}

export function getUserRole(): User['role'] | null {
    return getUserFromToken()?.role ?? null;
}

/**
 * JWT decoding is retained only for legacy display helpers. It is never
 * current-account or verification authority.
 */
export function getUserFromToken(): User | null {
    const token = getAccessToken();
    if (!token) return null;
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        if (
            !isNonEmptyString(payload.userId ?? payload.id)
            || !isNonEmptyString(payload.email)
            || (payload.role !== 'student' && payload.role !== 'vendor' && payload.role !== 'admin')
        ) {
            return null;
        }
        return {
            id: payload.userId ?? payload.id,
            email: payload.email,
            role: payload.role,
            verificationStatus: payload.verificationStatus,
        };
    } catch {
        return null;
    }
}
