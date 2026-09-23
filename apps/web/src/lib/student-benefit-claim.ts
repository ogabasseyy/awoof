/** Protected benefit-claim state machine for external (merchant-redeemed) deals.
 *
 * The browser never authorizes a discount: it reviews the server-provided
 * claim summary, records explicit merchant-disclosure consent, and hands an
 * opaque server assertion to the merchant's fixed callback path. Every
 * transition returns an immutable state; verification failures never
 * auto-submit a claim.
 */

export type ClaimStep =
    | 'idle'
    | 'loading'
    | 'ready'
    | 'claiming'
    | 'verify_required'
    | 'redirecting'
    | 'error';

export type ClaimSummary = {
    vendorName: string;
    productName: string;
    studentPrice: string;
};

export type ClaimState = {
    step: ClaimStep;
    sessionId: string | null;
    summary?: ClaimSummary;
    handoffUrl?: string;
    verifyReturnPath: string | null;
    error: string | null;
    attempt: number;
};

export const MERCHANT_CLAIM_CALLBACK_PATH = '/awoof/student-claim';
const ASSERTION_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function beginLoading(state: ClaimState, sessionId: string): ClaimState {
    if (state.step !== 'idle') return state;
    return { ...state, step: 'loading', sessionId, error: null };
}

export function markReady(state: ClaimState, summary: ClaimSummary): ClaimState {
    if (state.step !== 'loading' && state.step !== 'error' && state.step !== 'verify_required') return state;
    return { ...state, step: 'ready', summary, error: null };
}

export function beginClaim(state: ClaimState): ClaimState {
    if (state.step !== 'ready') return state;
    return { ...state, step: 'claiming', attempt: state.attempt + 1, error: null };
}

export function requireEnrollmentVerification(state: ClaimState, verifyReturnPath: string): ClaimState {
    if (state.step !== 'claiming' && state.step !== 'verify_required') return state;
    return { ...state, step: 'verify_required', verifyReturnPath };
}

export function failClaim(state: ClaimState, error: string): ClaimState {
    if (state.step !== 'claiming' && state.step !== 'loading') return state;
    return { ...state, step: 'error', error };
}

export function retryClaim(state: ClaimState): ClaimState {
    if (state.step !== 'error' && state.step !== 'verify_required') return state;
    // Reloading re-enters loading (not ready) so a failed reload stays
    // failure-reportable: failClaim only accepts loading or claiming.
    return { ...state, step: 'loading', error: null };
}

export function startRedirect(state: ClaimState, handoffUrl: string): ClaimState {
    if (state.step !== 'claiming') return state;
    return { ...state, step: 'redirecting', handoffUrl };
}

export function resetClaim(state: ClaimState): ClaimState {
    void state;
    return { step: 'idle', sessionId: null, verifyReturnPath: null, error: null, attempt: 0 };
}

function isLoopbackHttp(url: URL): boolean {
    return url.protocol === 'http:'
        && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1');
}

/** Validate a server-issued merchant handoff destination before navigating.
 * Only the fixed merchant callback path with a single opaque assertion is
 * accepted; any extra parameter, credential, fragment, or non-HTTPS origin
 * (outside loopback development) is rejected. Returns the validated URL. */
export function parseMerchantHandoffUrl(value: string, expectedOrigin?: string): string | null {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' && !isLoopbackHttp(url)) return null;
    if (url.username || url.password || url.hash) return null;
    if (url.pathname !== MERCHANT_CLAIM_CALLBACK_PATH) return null;
    const keys = [...url.searchParams.keys()];
    if (keys.length !== 1 || keys[0] !== 'assertion') return null;
    if (!ASSERTION_PATTERN.test(url.searchParams.get('assertion') ?? '')) return null;
    if (expectedOrigin !== undefined && url.origin !== expectedOrigin) return null;
    return url.href;
}
