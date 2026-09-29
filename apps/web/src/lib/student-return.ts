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
