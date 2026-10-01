/**
 * Widget disclosure-origin resolution for the vendor dashboard.
 *
 * The backend preserves stored custom origins (for example a non-standard
 * port) when an update omits allowedOrigins, and only derives the default
 * https form for newly uncovered hostnames. The dashboard promises that
 * saving authorizes the standard-port HTTPS origin for every listed
 * hostname, so it must submit that intent explicitly: keep the stored
 * origins that still belong to a submitted domain, and always add the
 * standard https origin for each submitted domain.
 */
export function resolveDisclosureOrigins(
    domains: readonly string[],
    storedOrigins: readonly unknown[] | undefined,
): string[] {
    const wanted = new Set(domains.map((domain) => domain.toLowerCase()));
    const resolved: string[] = [];
    for (const origin of storedOrigins ?? []) {
        if (typeof origin !== 'string') continue;
        let hostname: string;
        try {
            hostname = new URL(origin).hostname.toLowerCase();
        } catch {
            continue;
        }
        if (wanted.has(hostname)) resolved.push(origin);
    }
    for (const domain of domains) {
        const standard = `https://${domain.toLowerCase()}`;
        if (!resolved.includes(standard)) resolved.push(standard);
    }
    return [...new Set(resolved)];
}
