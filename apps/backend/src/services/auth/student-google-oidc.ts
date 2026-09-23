import * as client from 'openid-client';
import { normalizeMailbox, normalizeStudentDomain } from '../verification/eligibility-policy.service.js';
import type { StudentOidcAdapter } from './student-sso.types.js';
import type { ProviderObservation } from './student-sso.types.js';
import type { StudentSsoProviderConfiguration } from './student-oidc.config.js';

// Reverified against the official Google discovery document on 2026-09-21:
// issuer https://accounts.google.com, authorization
// https://accounts.google.com/o/oauth2/v2/auth, token
// https://oauth2.googleapis.com/token, JWKS
// https://www.googleapis.com/oauth2/v3/certs. Any change requires a
// deliberate reviewed allowlist update here and in the adapter tests.
export const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE_DISCOVERY_URL = 'https://accounts.google.com/.well-known/openid-configuration';
const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_LOGIN_SCOPES = 'openid email profile';

const CANCELLATION_OR_PERMISSION_CODES = new Set(['access_denied', 'interaction_required', 'login_required', 'consent_required']);
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export type StudentOidcFailureCategory = 'invalid_identity' | 'cancelled_or_permission' | 'upstream_unavailable';

export class StudentOidcOperationalError extends Error {
    readonly category: StudentOidcFailureCategory;
    constructor(category: StudentOidcFailureCategory) {
        super(
            category === 'invalid_identity'
                ? 'Student identity validation failed'
                : category === 'cancelled_or_permission'
                    ? 'Provider authorization was not completed'
                    : 'Login provider is unavailable',
        );
        this.name = 'StudentOidcOperationalError';
        this.category = category;
    }
}

type Dependencies = { fetch?: client.CustomFetch };

function failureCategory(error: unknown): StudentOidcFailureCategory {
    if (
        (error instanceof client.AuthorizationResponseError || error instanceof client.ResponseBodyError)
        && CANCELLATION_OR_PERMISSION_CODES.has(error.error)
    ) {
        return 'cancelled_or_permission';
    }
    if (error instanceof client.ClientError) return 'invalid_identity';
    return 'upstream_unavailable';
}

async function readBeforeDeadline(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>> {
    if (signal.aborted) throw new DOMException('OIDC provider timed out', 'TimeoutError');
    let onAbort: (() => void) | undefined;
    const deadline = new Promise<never>((_, reject) => {
        onAbort = () => reject(new DOMException('OIDC provider timed out', 'TimeoutError'));
        signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        return await Promise.race([reader.read(), deadline]);
    } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
    }
}

function discardResponseBody(response: Response): void {
    void response.body?.cancel().catch(() => undefined);
}

async function boundedBody(response: Response, signal: AbortSignal): Promise<Response> {
    const reader = response.body?.getReader();
    if (!reader) return response;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        while (true) {
            const next = await readBeforeDeadline(reader, signal);
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > MAX_PROVIDER_RESPONSE_BYTES) throw new RangeError('OIDC provider response exceeded the limit');
            chunks.push(next.value);
        }
    } catch (error) {
        void reader.cancel().catch(() => undefined);
        throw error;
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

const GOOGLE_ALLOWLIST = new Set([
    GOOGLE_DISCOVERY_URL,
    GOOGLE_AUTHORIZATION_ENDPOINT,
    GOOGLE_TOKEN_ENDPOINT,
    GOOGLE_JWKS_URI,
]);

function googleTrustedFetch(delegate: client.CustomFetch): client.CustomFetch {
    return async (input, options) => {
        const url = new URL(input);
        // Exact allowlist: Google spreads its endpoints across three
        // origins, so same-origin checks cannot apply. Credentials,
        // fragments, and redirects are rejected with the URL itself.
        if (!GOOGLE_ALLOWLIST.has(url.href)) throw new TypeError('OIDC endpoint is not trusted');
        const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const response = await delegate(url.href, { ...options, redirect: 'manual', signal });
        if (response.status >= 300 && response.status < 400) {
            discardResponseBody(response);
            throw new TypeError('OIDC provider redirects are not allowed');
        }
        const contentLength = response.headers.get('content-length');
        if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_PROVIDER_RESPONSE_BYTES)) {
            discardResponseBody(response);
            throw new RangeError('OIDC provider response exceeded the limit');
        }
        return boundedBody(response, signal);
    };
}

function assertTrustedMetadata(configuration: client.Configuration): void {
    const metadata = configuration.serverMetadata();
    if (metadata.issuer !== GOOGLE_ISSUER
        || metadata.authorization_endpoint !== GOOGLE_AUTHORIZATION_ENDPOINT
        || metadata.token_endpoint !== GOOGLE_TOKEN_ENDPOINT
        || metadata.jwks_uri !== GOOGLE_JWKS_URI) {
        throw new TypeError('OIDC metadata is not trusted');
    }
}

function validOpaque(value: string, label: string): void {
    if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
        throw new StudentOidcOperationalError('invalid_identity');
    }
    if (label === 'verifier' && !/^[A-Za-z0-9._~-]{43,128}$/.test(value)) {
        throw new StudentOidcOperationalError('invalid_identity');
    }
}

export class StudentGoogleOidc implements StudentOidcAdapter {
    private constructor(
        private readonly configuration: Extract<StudentSsoProviderConfiguration, { enabled: true }>,
        private readonly hostedDomain: string,
        private readonly dependency: Dependencies,
    ) {}

    /** Builds a login adapter only for a hosted domain already approved by server-held policy. */
    static forApprovedDomain(
        configuration: StudentSsoProviderConfiguration,
        hostedDomain: string,
        dependency: Dependencies = {},
    ): StudentGoogleOidc {
        if (!configuration.enabled) throw new TypeError('Google login is not enabled');
        let approved: string;
        try {
            approved = normalizeStudentDomain(hostedDomain);
        } catch {
            throw new TypeError('Google login requires an approved hosted domain');
        }
        return new StudentGoogleOidc(configuration, approved, dependency);
    }

    private async discovered(): Promise<client.Configuration> {
        const delegate: client.CustomFetch = this.dependency.fetch ?? ((url, options) => {
            const init: RequestInit = { method: options.method, headers: options.headers, redirect: options.redirect };
            if (options.body !== undefined) init.body = options.body;
            if (options.duplex !== undefined) init.duplex = options.duplex;
            if (options.signal !== undefined) init.signal = options.signal;
            return globalThis.fetch(url, init);
        });
        const fetch = googleTrustedFetch(delegate);
        const configuration = await client.discovery(
            new URL(GOOGLE_ISSUER),
            this.configuration.clientId,
            {
                client_secret: this.configuration.clientSecret,
                redirect_uris: [this.configuration.callbackUrl.href],
                response_types: ['code'],
            },
            undefined,
            {
                [client.customFetch]: fetch,
                timeout: REQUEST_TIMEOUT_MS / 1_000,
                execute: [client.enableNonRepudiationChecks],
            },
        );
        assertTrustedMetadata(configuration);
        return configuration;
    }

    async authorize(input: { state: string; nonce: string; verifier: string; loginHint: string }): Promise<URL> {
        validOpaque(input.state, 'state');
        validOpaque(input.nonce, 'nonce');
        validOpaque(input.verifier, 'verifier');
        try {
            normalizeMailbox(input.loginHint);
        } catch {
            throw new StudentOidcOperationalError('invalid_identity');
        }
        try {
            const configuration = await this.discovered();
            const challenge = await client.calculatePKCECodeChallenge(input.verifier);
            return client.buildAuthorizationUrl(configuration, {
                redirect_uri: this.configuration.callbackUrl.href,
                response_mode: 'query',
                response_type: 'code',
                scope: GOOGLE_LOGIN_SCOPES,
                state: input.state,
                nonce: input.nonce,
                code_challenge: challenge,
                code_challenge_method: 'S256',
                login_hint: input.loginHint,
            });
        } catch (error) {
            throw new StudentOidcOperationalError(failureCategory(error));
        }
    }

    async redeem(input: { callback: URL; state: string; nonce: string; verifier: string }): Promise<ProviderObservation> {
        if (input.callback.origin !== this.configuration.callbackUrl.origin
            || input.callback.pathname !== this.configuration.callbackUrl.pathname) {
            throw new StudentOidcOperationalError('invalid_identity');
        }
        validOpaque(input.state, 'state');
        validOpaque(input.nonce, 'nonce');
        validOpaque(input.verifier, 'verifier');
        try {
            const configuration = await this.discovered();
            const response = await client.authorizationCodeGrant(configuration, input.callback, {
                expectedState: input.state,
                expectedNonce: input.nonce,
                pkceCodeVerifier: input.verifier,
                idTokenExpected: true,
            });
            const claims = response.claims();
            const issuer = typeof claims?.iss === 'string' ? claims.iss : '';
            const audience = claims?.aud;
            const authorizedParty = claims?.azp;
            const subject = typeof claims?.sub === 'string' ? claims.sub : '';
            const email = typeof claims?.email === 'string' ? claims.email : '';
            const emailVerified = claims?.email_verified;
            if (issuer !== GOOGLE_ISSUER || audience !== this.configuration.clientId || subject === '' || email === '' || emailVerified !== true) {
                throw new StudentOidcOperationalError('invalid_identity');
            }
            if (authorizedParty !== undefined && authorizedParty !== this.configuration.clientId) {
                throw new StudentOidcOperationalError('invalid_identity');
            }
            // Workspace membership comes only from the approved hosted-domain
            // mapping, never from the email suffix. Personal Gmail (no hd)
            // authenticates but stays unattested for school assurance.
            const hostedDomain = typeof claims?.hd === 'string' ? claims.hd : null;
            return {
                provider: 'google',
                issuer: GOOGLE_ISSUER,
                subject,
                email,
                mailboxVerified: true,
                realm: hostedDomain ?? '',
                schoolMembershipAttested: hostedDomain !== null && hostedDomain.toLowerCase() === this.hostedDomain,
                objectId: null,
            };
        } catch (error) {
            if (error instanceof StudentOidcOperationalError) throw error;
            throw new StudentOidcOperationalError(failureCategory(error));
        }
    }
}
