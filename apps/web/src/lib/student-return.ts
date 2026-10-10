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

function resolveCandidate(candidate: string | null, origin: string): string | null {
    if (!candidate || hasMalformedEscape(candidate) || candidate.includes('\\')) return null;
    try {
        const resolved = new URL(candidate, origin);
        const isAuthRoute = resolved.pathname === '/auth' || resolved.pathname.startsWith('/auth/');
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
