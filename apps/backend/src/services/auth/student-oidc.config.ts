import { getDomain } from 'tldts';
import type { LoginProvider } from './student-sso.types.js';

export const STUDENT_SSO_GOOGLE_CALLBACK_PATH = '/api/auth/student/sso/google/callback';
export const STUDENT_SSO_MICROSOFT_CALLBACK_PATH = '/api/auth/student/sso/microsoft/callback';
export const STUDENT_SSO_COMPLETION_PATH = '/auth/student/sso/complete';

export type StudentSsoProviderConfiguration =
    | { enabled: false }
    | {
        enabled: true;
        clientId: string;
        clientSecret: string;
        callbackUrl: URL;
    };

export type StudentSsoConfiguration = {
    google: StudentSsoProviderConfiguration;
    microsoft: StudentSsoProviderConfiguration;
    /** Shared browser completion route; required only while a provider is enabled. */
    completionUrl: URL | null;
    /** Shared base64url attempt-key material; required only while a provider is enabled. */
    attemptKey: string | null;
};

type RawStudentSsoConfiguration = {
    googleEnabled?: string | boolean | undefined;
    googleClientId?: string | undefined;
    googleClientSecret?: string | undefined;
    googleCallbackUrl?: string | undefined;
    microsoftEnabled?: string | boolean | undefined;
    microsoftClientId?: string | undefined;
    microsoftClientSecret?: string | undefined;
    microsoftCallbackUrl?: string | undefined;
    completionUrl?: string | undefined;
    attemptKey?: string | undefined;
};

function sameSite(left: URL, right: URL): boolean {
    // Same rule as the verification OIDC config: private PSL entries are
    // sites too, so alice.github.io and bob.github.io are never same-site.
    const leftSite = getDomain(left.hostname, { allowPrivateDomains: true });
    const rightSite = getDomain(right.hostname, { allowPrivateDomains: true });
    return leftSite !== null && leftSite === rightSite;
}

function httpsUrl(value: string, label: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new TypeError(`${label} must be an absolute HTTPS URL`);
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
        throw new TypeError(`${label} must be an absolute HTTPS URL without credentials, query, or fragments`);
    }
    return url;
}

function readProvider(
    raw: RawStudentSsoConfiguration,
    provider: LoginProvider,
    label: string,
    callbackPath: string,
): StudentSsoProviderConfiguration {
    const enabled = provider === 'google' ? raw.googleEnabled : raw.microsoftEnabled;
    if (enabled !== true && enabled !== 'true') return { enabled: false };
    const clientId = provider === 'google' ? raw.googleClientId : raw.microsoftClientId;
    const clientSecret = provider === 'google' ? raw.googleClientSecret : raw.microsoftClientSecret;
    const callbackUrl = provider === 'google' ? raw.googleCallbackUrl : raw.microsoftCallbackUrl;
    if (!clientId || !clientSecret) throw new TypeError(`${label} login client configuration is required when enabled`);
    if (!callbackUrl) throw new TypeError(`${label} login callback URL is required when enabled`);
    const callback = httpsUrl(callbackUrl, `${label} login callback URL`);
    if (callback.pathname !== callbackPath) throw new TypeError(`${label} login callback URL must be the fixed ${label} callback`);
    return { enabled: true, clientId, clientSecret, callbackUrl: callback };
}

function lenientCompletionUrl(value: string | undefined): URL | null {
    if (!value) return null;
    try {
        const completionUrl = httpsUrl(value, 'Student SSO completion URL');
        if (completionUrl.pathname !== STUDENT_SSO_COMPLETION_PATH) return null;
        return completionUrl;
    } catch {
        return null;
    }
}

function readAttemptKey(value: string | undefined): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new TypeError('Student SSO attempt key must decode from base64url to exactly 32 bytes');
    }
    if (Buffer.from(value, 'base64url').byteLength !== 32) {
        throw new TypeError('Student SSO attempt key must decode from base64url to exactly 32 bytes');
    }
    return value;
}

/**
 * Student SSO deployment configuration. This carries deployment credentials
 * only; per-institution tenants and hosted domains always come from the
 * approved runtime login policy, never from this config.
 */
export function readStudentSsoConfiguration(raw: RawStudentSsoConfiguration): StudentSsoConfiguration {
    const google = readProvider(raw, 'google', 'Google', STUDENT_SSO_GOOGLE_CALLBACK_PATH);
    const microsoft = readProvider(raw, 'microsoft', 'Microsoft', STUDENT_SSO_MICROSOFT_CALLBACK_PATH);
    if (!google.enabled && !microsoft.enabled) {
        // Disabled providers require no credentials: stale values while
        // fully disabled are ignored so boot and tests never fail on them.
        // A valid completion destination is still retained: it is not a
        // secret, and in-flight provider returns need it for their
        // bounded restart redirect instead of a 503.
        return { google, microsoft, completionUrl: lenientCompletionUrl(raw.completionUrl), attemptKey: null };
    }
    if (!raw.completionUrl) throw new TypeError('Student SSO completion URL is required when a provider is enabled');
    const completionUrl = httpsUrl(raw.completionUrl, 'Student SSO completion URL');
    if (completionUrl.pathname !== STUDENT_SSO_COMPLETION_PATH) {
        throw new TypeError('Student SSO completion URL must be the fixed completion route');
    }
    const callbacks = [
        ...(google.enabled ? [google.callbackUrl] : []),
        ...(microsoft.enabled ? [microsoft.callbackUrl] : []),
    ];
    for (const callback of callbacks) {
        if (!sameSite(callback, completionUrl)) {
            throw new TypeError('Student SSO API callbacks and the completion route must be same-site');
        }
    }
    if (!raw.attemptKey) throw new TypeError('Student SSO attempt key is required when a provider is enabled');
    return { google, microsoft, completionUrl, attemptKey: readAttemptKey(raw.attemptKey) };
}

/** Deployment readiness: discovery advertises only these providers. */
export function enabledStudentSsoProviders(configuration: StudentSsoConfiguration): LoginProvider[] {
    return [
        ...(configuration.google.enabled ? ['google' as const] : []),
        ...(configuration.microsoft.enabled ? ['microsoft' as const] : []),
    ];
}
