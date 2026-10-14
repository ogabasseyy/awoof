function hasMalformedEscape(value: string): boolean {
    return /%(?![\dA-Fa-f]{2})/.test(value);
}

/**
 * The one auth route that may be a return target. The SSO onboarding page
 * is a terminal link/signup continuation, not a login page: landing there
 * renders a link state or a terminal outcome, never an automatic bounce
 * back into authentication, so it cannot form an auth loop on its own.
 * The match is the exact pathname; deeper paths stay rejected.
 */
export const STUDENT_SSO_ONBOARDING_RETURN_PATH = '/auth/student/sso/onboarding';

/**
 * The full-screen student profile completion route. It is never a prompt
 * source or an automatic-prompt target of itself: completion exits reject
 * this pathname family so routing cannot wrap or loop.
 */
export const STUDENT_PROFILE_COMPLETION_PATH = '/student/profile/complete';

/**
 * True for the completion pathname, its trailing-slash equivalent, any
 * deeper completion path, and any query/hash variant. Operates on an
 * already-resolved same-origin path; it never validates a raw candidate.
 */
export function isStudentProfileCompletionDestination(path: string): boolean {
    return path === STUDENT_PROFILE_COMPLETION_PATH
        || path.startsWith(`${STUDENT_PROFILE_COMPLETION_PATH}/`)
        || path.startsWith(`${STUDENT_PROFILE_COMPLETION_PATH}?`)
        || path.startsWith(`${STUDENT_PROFILE_COMPLETION_PATH}#`);
}

export type StudentPostAuthDecision = 'complete_profile' | 'continue';

/**
 * Resolve the post-auth navigation target. Completion routes to the full
 * screen with the single validated continuation preserved; continue passes
 * the safe destination through unchanged, never recursively wrapping a
 * completion URL in another return parameter.
 */
export function resolveStudentPostAuthDestination(input: {
    decision: StudentPostAuthDecision;
    safeDestination: string;
}): string {
    if (input.decision !== 'complete_profile') return input.safeDestination;
    const query = new URLSearchParams({ redirect: input.safeDestination }).toString();
    return `${STUDENT_PROFILE_COMPLETION_PATH}?${query}`;
}

// Encoded separators or controls can be decoded by a downstream router,
// proxy, or server into a different route than the one validated here
// (an auth-route lookalike today, an open redirect after a stack change).
// No legitimate student return path needs them, so fail closed.
const ENCODED_SEPARATOR_OR_CONTROL = /%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i;

function hasUnsafePathname(pathname: string): boolean {
    return ENCODED_SEPARATOR_OR_CONTROL.test(pathname) || pathname.includes(';');
}

function isAuthPathname(pathname: string): boolean {
    const lower = pathname.toLowerCase();
    return lower === '/auth' || lower.startsWith('/auth/');
}

function resolveCandidate(candidate: string | null, origin: string): string | null {
    if (!candidate || hasMalformedEscape(candidate) || candidate.includes('\\')) return null;
    try {
        const resolved = new URL(candidate, origin);
        if (hasUnsafePathname(resolved.pathname)) return null;
        // Judge the auth boundary on the decoded pathname as well: a value
        // that only becomes an auth route (or gains a separator) after one
        // downstream decode must not pass as an ordinary return path.
        let decodedPathname: string;
        try {
            decodedPathname = decodeURIComponent(resolved.pathname);
        } catch {
            return null;
        }
        if (
            hasUnsafePathname(decodedPathname)
            || decodedPathname.includes('\\')
            || decodedPathname.startsWith('//')
        ) {
            return null;
        }
        const isAuthRoute = isAuthPathname(resolved.pathname) || isAuthPathname(decodedPathname);
        if (
            (resolved.protocol !== 'http:' && resolved.protocol !== 'https:')
            || resolved.origin !== origin
            || resolved.username
            || resolved.password
            || (isAuthRoute && resolved.pathname !== STUDENT_SSO_ONBOARDING_RETURN_PATH)
        ) {
            return null;
        }
        return `${resolved.pathname}${resolved.search}${resolved.hash}`;
    } catch {
        return null;
    }
}

/** Resolve a same-origin student return path without permitting auth loops. */
export function resolveStudentReturn(
    candidate: string | null,
    origin: string,
    fallback = '/marketplace',
): string {
    const safeFallback = resolveCandidate(fallback, origin) ?? '/marketplace';
    return resolveCandidate(candidate, origin) ?? safeFallback;
}
