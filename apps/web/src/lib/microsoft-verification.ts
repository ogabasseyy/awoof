/**
 * Browser-only continuity state for the Microsoft redirect. The server owns
 * authorization; this small tab-scoped record only prevents a callback from
 * being completed in a different Awoof browser session.
 */

export const microsoftAttemptStorageKey = 'awoof.microsoft.verification.attempt.v1';
const maximumAttemptLifetimeMs = 10 * 60 * 1000;

export type MicrosoftAttemptState = Readonly<{
    attemptId: string;
    finishSecret: string;
    browserSessionId: string;
    expiresAt: number;
}>;

function nonEmpty(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function valid(value: unknown): value is MicrosoftAttemptState {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const state = value as Partial<MicrosoftAttemptState>;
    return nonEmpty(state.attemptId)
        && nonEmpty(state.finishSecret)
        && nonEmpty(state.browserSessionId)
        && typeof state.expiresAt === 'number'
        && Number.isFinite(state.expiresAt);
}

/**
 * A 4xx finish response is terminal unless the server asks for a paced
 * retry. 429 keeps the tab attempt so the student can retry after the
 * rate-limit window instead of restarting the whole Microsoft flow.
 */
export function isTerminalFinishStatus(status: number): boolean {
    return status >= 400 && status < 500 && status !== 429;
}

/** The only authorization host a browser may navigate to from this flow. */
export function isMicrosoftAuthorizationUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'https:'
            && url.hostname === 'login.microsoftonline.com'
            && url.username === ''
            && url.password === ''
            && (url.port === '' || url.port === '443');
    } catch {
        return false;
    }
}

export function writeMicrosoftAttempt(storage: Storage, state: MicrosoftAttemptState): void {
    if (!valid(state) || state.expiresAt <= Date.now() || state.expiresAt > Date.now() + maximumAttemptLifetimeMs) {
        throw new Error('Microsoft verification attempt is invalid.');
    }
    // Do not serialize caller-owned response objects: start responses may grow
    // without expanding the browser's secret-bearing tab record.
    storage.setItem(microsoftAttemptStorageKey, JSON.stringify({
        attemptId: state.attemptId,
        finishSecret: state.finishSecret,
        browserSessionId: state.browserSessionId,
        expiresAt: state.expiresAt,
    } satisfies MicrosoftAttemptState));
}

export function clearMicrosoftAttempt(storage: Storage): void {
    storage.removeItem(microsoftAttemptStorageKey);
}

export function readMicrosoftAttempt(storage: Storage, now = Date.now()): MicrosoftAttemptState | null {
    try {
        const raw = storage.getItem(microsoftAttemptStorageKey);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (!valid(parsed) || parsed.expiresAt <= now || parsed.expiresAt > now + maximumAttemptLifetimeMs) {
            clearMicrosoftAttempt(storage);
            return null;
        }
        return parsed;
    } catch {
        try { clearMicrosoftAttempt(storage); } catch { /* Safe restart is the only recovery. */ }
        return null;
    }
}
