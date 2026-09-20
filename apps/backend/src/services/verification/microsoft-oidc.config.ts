import { getDomain } from 'tldts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CALLBACK_PATH = '/api/verification/microsoft/callback';

export type MicrosoftOidcConfiguration =
    | { enabled: false }
    | {
        enabled: true;
        tenantId?: string;
        clientId: string;
        clientSecret: string;
        callbackUrl: URL;
        frontendCompletionUrl: URL;
        issuer?: URL;
    };

export type ApprovedMicrosoftOidcConfiguration = Extract<MicrosoftOidcConfiguration, { enabled: true }> & { tenantId: string; issuer: URL };

/** Builds a tenant adapter only from a policy tenant already locked by server code. */
export function forApprovedMicrosoftTenant(configuration: MicrosoftOidcConfiguration, tenantId: string): ApprovedMicrosoftOidcConfiguration {
    if (!configuration.enabled || !UUID.test(tenantId)) throw new TypeError('Microsoft tenant adapter is unavailable');
    return { ...configuration, tenantId, issuer: new URL(`https://login.microsoftonline.com/${tenantId}/v2.0`) };
}

type RawMicrosoftOidcConfiguration = {
    enabled?: string | boolean | undefined;
    tenantId?: string | undefined;
    clientId?: string | undefined;
    clientSecret?: string | undefined;
    callbackUrl?: string | undefined;
    frontendCompletionUrl?: string | undefined;
};

function sameSite(left: URL, right: URL): boolean {
    // Private PSL entries are sites too: alice.github.io and bob.github.io must
    // never be considered same-site merely because their registry suffix matches.
    const leftSite = getDomain(left.hostname, { allowPrivateDomains: true });
    const rightSite = getDomain(right.hostname, { allowPrivateDomains: true });
    return leftSite !== null && leftSite === rightSite;
}

function httpsUrl(value: string, label: string): URL {
    let url: URL;
    try { url = new URL(value); } catch { throw new TypeError(`${label} must be an absolute HTTPS URL`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
        throw new TypeError(`${label} must be an absolute HTTPS URL without credentials or fragments`);
    }
    return url;
}

export function readMicrosoftOidcConfiguration(raw: RawMicrosoftOidcConfiguration): MicrosoftOidcConfiguration {
    if (raw.enabled !== true && raw.enabled !== 'true') return { enabled: false };
    if (raw.tenantId !== undefined && !UUID.test(raw.tenantId)) throw new TypeError('Microsoft tenant ID must be a UUID');
    if (!raw.clientId || !raw.clientSecret) throw new TypeError('Microsoft OIDC client configuration is required when enabled');
    if (!raw.callbackUrl || !raw.frontendCompletionUrl) throw new TypeError('Microsoft callback and frontend completion URLs are required when enabled');
    const callbackUrl = httpsUrl(raw.callbackUrl, 'Microsoft callback URL');
    const frontendCompletionUrl = httpsUrl(raw.frontendCompletionUrl, 'Microsoft frontend completion URL');
    if (callbackUrl.pathname !== CALLBACK_PATH || callbackUrl.search) throw new TypeError('Microsoft callback URL must be the fixed API callback');
    if (frontendCompletionUrl.pathname !== '/student/verification/microsoft/complete' || frontendCompletionUrl.search) {
        throw new TypeError('Microsoft frontend completion URL must be the fixed completion route');
    }
    if (!sameSite(callbackUrl, frontendCompletionUrl)) throw new TypeError('Microsoft API callback and frontend completion must be same-site');
    return {
        enabled: true,
        clientId: raw.clientId,
        clientSecret: raw.clientSecret,
        callbackUrl,
        frontendCompletionUrl,
        ...(raw.tenantId === undefined ? {} : { tenantId: raw.tenantId, issuer: new URL(`https://login.microsoftonline.com/${raw.tenantId}/v2.0`) }),
    };
}
