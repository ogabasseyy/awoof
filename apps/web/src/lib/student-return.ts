function hasMalformedEscape(value: string): boolean {
    return /%(?![\dA-Fa-f]{2})/.test(value);
}

function resolveCandidate(candidate: string | null, origin: string): string | null {
    if (!candidate || hasMalformedEscape(candidate) || candidate.includes('\\')) return null;
    try {
        const resolved = new URL(candidate, origin);
        if (
            (resolved.protocol !== 'http:' && resolved.protocol !== 'https:')
            || resolved.origin !== origin
            || resolved.username
            || resolved.password
            || resolved.pathname === '/auth'
            || resolved.pathname.startsWith('/auth/')
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
