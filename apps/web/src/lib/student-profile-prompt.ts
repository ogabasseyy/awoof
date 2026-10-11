/**
 * Post-login profile-prompt routing and session-namespaced cross-tab deferral.
 *
 * The server owns eligibility: `promptDecision` arrives in the academic
 * projection and already encodes feature state, current assurance, attention
 * fields, and verification-continuation availability. The browser adds only
 * safe-destination, explicit-continuation, and session-deferral gates, and
 * never recomputes or elevates an ineligible server decision.
 *
 * Deferral markers live in localStorage, namespaced by the active
 * `browserSessionId`, and contain the account ID only. Cleanup removes a
 * single namespaced key; it never clears by prefix, so a delayed event from
 * an older tab cannot erase a newer session's choice.
 */

import { getSessionSnapshot, type SessionSnapshot } from './auth';
import {
    isStudentProfileCompletionDestination,
    resolveStudentPostAuthDestination,
} from './student-return';
import type { AcademicProfileView } from './student-academic-profile';

export type { SessionSnapshot };

/** Automatic prompts fire only before this ordinary browse destination. */
const MARKETPLACE_BROWSE_PATH = '/marketplace';

export const PROFILE_DEFERRAL_KEY_PREFIX = 'awoof.profile.defer-prompt.v1.';

/** Session-namespaced deferral marker key for one browser session. */
export function deferKey(browserSessionId: string): string {
    return `${PROFILE_DEFERRAL_KEY_PREFIX}${browserSessionId}`;
}

export type ProfilePromptDecision = 'complete_profile' | 'continue';

export type ProfilePromptInput = {
    /** Server-projected eligibility from the academic projection. */
    promptDecision: ProfilePromptDecision;
    /** Already-validated same-origin destination. */
    destination: string;
    /** Whether the destination came from an explicit `redirect` continuation. */
    explicitContinuation: boolean;
    /** Whether this session already deferred for this account. */
    deferred: boolean;
};

/**
 * Narrow the server's prompt eligibility with browser-only gates. Only an
 * eligible server decision for exact marketplace browse in a non-deferred
 * session prompts; every other input continues to its destination.
 */
export function profilePromptDecision(input: ProfilePromptInput): ProfilePromptDecision {
    if (input.promptDecision !== 'complete_profile') return 'continue';
    if (input.deferred) return 'continue';
    // Self-targets never prompt, so completion routing cannot loop.
    if (isStudentProfileCompletionDestination(input.destination)) return 'continue';
    // An explicit continuation to anything but marketplace takes priority.
    if (input.explicitContinuation && input.destination !== MARKETPLACE_BROWSE_PATH) return 'continue';
    if (input.destination !== MARKETPLACE_BROWSE_PATH) return 'continue';
    return 'complete_profile';
}

export type DeferralStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserWindow(): Window | null {
    const candidate = (globalThis as { window?: unknown }).window;
    return candidate && typeof (candidate as Window).addEventListener === 'function'
        ? candidate as Window
        : null;
}

/** Local deferral storage, or null when persistence is unavailable. */
export function deferralStorage(): DeferralStorage | null {
    const browser = browserWindow();
    if (!browser) return null;
    try {
        return browser.localStorage;
    } catch {
        return null;
    }
}

/**
 * Tab-scoped fallback when storage is unavailable. Keyed by browser session
 * ID; it never crosses tabs and never outlives the page.
 */
const memoryDeferrals = new Map<string, string>();

function readActiveSessionId(readActiveSnapshot: () => SessionSnapshot): string | null {
    try {
        return readActiveSnapshot().browserSessionId;
    } catch {
        return null;
    }
}

function removeStoredDeferral(storage: DeferralStorage | null, key: string): void {
    if (!storage) return;
    try {
        storage.removeItem(key);
    } catch {
        // A stale binding that cannot be removed is ignored; reads fail
        // closed on mismatch and the namespaced key cannot collide.
    }
}

/**
 * Record a deferral for the captured session and account. The active auth
 * snapshot is rechecked before and after the write; when the session
 * changed, only the just-written obsolete key is removed, never another
 * session's marker.
 */
export function writeDeferral(
    storage: DeferralStorage | null,
    sessionSnapshot: SessionSnapshot,
    accountId: string | null,
    readActiveSnapshot: () => SessionSnapshot = getSessionSnapshot,
): void {
    const sessionId = sessionSnapshot.browserSessionId;
    if (!sessionId || !accountId) return;
    if (readActiveSessionId(readActiveSnapshot) !== sessionId) return;
    const key = deferKey(sessionId);
    if (storage) {
        try {
            storage.setItem(key, accountId);
        } catch {
            memoryDeferrals.set(sessionId, accountId);
        }
    } else {
        memoryDeferrals.set(sessionId, accountId);
    }
    if (readActiveSessionId(readActiveSnapshot) !== sessionId) {
        removeStoredDeferral(storage, key);
        memoryDeferrals.delete(sessionId);
    }
}

/**
 * True only when the active session's namespaced marker binds to this
 * account. A mismatched binding is cleared and never suppresses another
 * account; unknown storage falls back to the tab-scoped marker.
 */
export function readDeferral(
    storage: DeferralStorage | null,
    sessionSnapshot: SessionSnapshot,
    accountId: string | null,
): boolean {
    const sessionId = sessionSnapshot.browserSessionId;
    if (!sessionId || !accountId) return false;
    if (storage) {
        try {
            const value = storage.getItem(deferKey(sessionId));
            if (value !== null) {
                if (value === accountId) return true;
                removeStoredDeferral(storage, deferKey(sessionId));
            }
        } catch {
            // Unreadable storage falls through to the memory marker below.
        }
    }
    const fallback = memoryDeferrals.get(sessionId);
    if (fallback === undefined) return false;
    if (fallback === accountId) return true;
    memoryDeferrals.delete(sessionId);
    return false;
}

/**
 * Remove only the invalidated session's marker. Never clears by prefix, so
 * a delayed logout from an older session cannot remove a newer one.
 */
export function clearDeferral(
    storage: DeferralStorage | null,
    invalidatedSessionSnapshot: SessionSnapshot,
): void {
    const sessionId = invalidatedSessionSnapshot.browserSessionId;
    if (!sessionId) return;
    removeStoredDeferral(storage, deferKey(sessionId));
    memoryDeferrals.delete(sessionId);
}

export type ProfileDeferralChange = {
    sessionId: string;
    /** True when the marker was written, false when it was removed. */
    deferred: boolean;
};

export type ProfileDeferralListener = (change: ProfileDeferralChange) => void;

/**
 * Dedicated deferral storage-event subscription, separate from auth-session
 * events. Only the active session's namespaced key notifies; auth keys,
 * other sessions' keys, and unrelated events are ignored.
 */
export function subscribeProfileDeferralChanges(
    listener: ProfileDeferralListener,
    readActiveSnapshot: () => SessionSnapshot = getSessionSnapshot,
): () => void {
    const browser = browserWindow();
    if (!browser) return () => undefined;
    const handler = (event: Event): void => {
        const key = (event as StorageEvent).key;
        if (typeof key !== 'string' || !key.startsWith(PROFILE_DEFERRAL_KEY_PREFIX)) return;
        const sessionId = key.slice(PROFILE_DEFERRAL_KEY_PREFIX.length);
        if (!sessionId) return;
        if (readActiveSessionId(readActiveSnapshot) !== sessionId) return;
        listener({ sessionId, deferred: (event as StorageEvent).newValue !== null });
    };
    browser.addEventListener('storage', handler);
    return () => browser.removeEventListener('storage', handler);
}

/** The only projection field post-auth routing consumes. */
export type PostAuthProjection = Pick<AcademicProfileView, 'promptDecision'>;

/** Upper bound for the post-auth projection read before failing open. */
export const POST_AUTH_PROJECTION_TIMEOUT_MS = 3_000;

export type PostAuthNavigationInput = {
    /** Null when the account is unknown; no deferral can bind, so no suppression. */
    accountId: string | null;
    /** Session snapshot captured immediately after the session commit. */
    sessionSnapshot: SessionSnapshot;
    /** Already-validated same-origin destination. */
    safeDestination: string;
    /** Whether the destination came from an explicit continuation. */
    explicitContinuation: boolean;
    storage: DeferralStorage | null;
    readProjection: () => Promise<PostAuthProjection>;
    readActiveSnapshot?: () => SessionSnapshot;
    /** Override for the projection-read timeout; defaults to POST_AUTH_PROJECTION_TIMEOUT_MS. */
    projectionTimeoutMs?: number;
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Post-auth projection read timed out')), ms);
        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error: unknown) => { clearTimeout(timer); reject(error); },
        );
    });
}

/**
 * Resolve one post-auth navigation. Non-marketplace destinations return
 * without a projection read; marketplace browse reads the projection once
 * and prompts only for an eligible, non-deferred session. Read failures,
 * read timeouts, malformed decisions, and session replacement all fail open
 * to the safe destination without blocking login or clearing the session.
 */
export async function resolveStudentPostAuthNavigation(
    input: PostAuthNavigationInput,
): Promise<string> {
    if (input.safeDestination !== MARKETPLACE_BROWSE_PATH) return input.safeDestination;
    const committedSessionId = input.sessionSnapshot.browserSessionId;
    if (!committedSessionId) return input.safeDestination;
    let promptDecision: ProfilePromptDecision;
    try {
        promptDecision = (await withTimeout(input.readProjection(), input.projectionTimeoutMs ?? POST_AUTH_PROJECTION_TIMEOUT_MS)).promptDecision;
    } catch {
        return input.safeDestination;
    }
    if (promptDecision !== 'complete_profile' && promptDecision !== 'continue') {
        return input.safeDestination;
    }
    const readActiveSnapshot = input.readActiveSnapshot ?? getSessionSnapshot;
    let active: SessionSnapshot | null = null;
    try {
        active = readActiveSnapshot();
    } catch {
        return input.safeDestination;
    }
    if (!active || active.browserSessionId !== committedSessionId) return input.safeDestination;
    const deferred = readDeferral(input.storage, active, input.accountId);
    const decision = profilePromptDecision({
        promptDecision,
        destination: input.safeDestination,
        explicitContinuation: input.explicitContinuation,
        deferred,
    });
    return resolveStudentPostAuthDestination({ decision, safeDestination: input.safeDestination });
}
