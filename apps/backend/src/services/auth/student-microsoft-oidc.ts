import * as client from 'openid-client';
import { normalizeMailbox } from '../verification/eligibility-policy.service.js';
import type { StudentOidcAdapter } from './student-sso.types.js';
import type { ProviderObservation } from './student-sso.types.js';
import type { StudentSsoProviderConfiguration } from './student-oidc.config.js';
import { StudentOidcOperationalError, type StudentOidcFailureCategory } from './student-google-oidc.js';

export const MICROSOFT_LOGIN_SCOPES = 'openid profile email';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANCELLATION_OR_PERMISSION_CODES = new Set(['access_denied', 'interaction_required', 'login_required', 'consent_required']);
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

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

function trustedUrl(issuer: URL, value: string | URL | undefined): void {
    if (!value) throw new TypeError('OIDC metadata endpoint is missing');
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== issuer.origin) throw new TypeError('OIDC endpoint is not trusted');
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

function boundedTrustedFetch(issuer: URL, delegate: client.CustomFetch): client.CustomFetch {
    return async (input, options) => {
        const url = new URL(input);
        if (url.protocol !== 'https:' || url.origin !== issuer.origin) throw new TypeError('OIDC endpoint is not trusted');
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

function assertTrustedMetadata(issuer: URL, configuration: client.Configuration): void {
    const metadata = configuration.serverMetadata();
    if (metadata.issuer !== issuer.href) throw new TypeError('OIDC issuer is not trusted');
    trustedUrl(issuer, metadata.authorization_endpoint);
    trustedUrl(issuer, metadata.token_endpoint);
    trustedUrl(issuer, metadata.jwks_uri);
}

function validOpaque(value: string, label: string): void {
    if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
        throw new StudentOidcOperationalError('invalid_identity');
    }
    if (label === 'verifier' && !/^[A-Za-z0-9._~-]{43,128}$/.test(value)) {
        throw new StudentOidcOperationalError('invalid_identity');
    }
}

export class StudentMicrosoftOidc implements StudentOidcAdapter {
    private constructor(
        private readonly configuration: Extract<StudentSsoProviderConfiguration, { enabled: true }>,
        private readonly tenantId: string,
        private readonly issuer: URL,
        private readonly dependency: Dependencies,
    ) {}

    /** Builds a login adapter only for a tenant already approved by server-held policy. */
    static forApprovedTenant(
        configuration: StudentSsoProviderConfiguration,
        tenantId: string,
        dependency: Dependencies = {},
    ): StudentMicrosoftOidc {
        if (!configuration.enabled) throw new TypeError('Microsoft login is not enabled');
        if (!UUID.test(tenantId)) throw new TypeError('Microsoft login requires an approved tenant');
        return new StudentMicrosoftOidc(
            configuration,
            tenantId,
            new URL(`https://login.microsoftonline.com/${tenantId}/v2.0`),
            dependency,
        );
    }

    private async discovered(): Promise<client.Configuration> {
        const delegate: client.CustomFetch = this.dependency.fetch ?? ((url, options) => {
            const init: RequestInit = { method: options.method, headers: options.headers, redirect: options.redirect };
            if (options.body !== undefined) init.body = options.body;
            if (options.duplex !== undefined) init.duplex = options.duplex;
            if (options.signal !== undefined) init.signal = options.signal;
            return globalThis.fetch(url, init);
        });
        const fetch = boundedTrustedFetch(this.issuer, delegate);
        const configuration = await client.discovery(
            this.issuer,
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
        assertTrustedMetadata(this.issuer, configuration);
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
                scope: MICROSOFT_LOGIN_SCOPES,
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
            const subject = typeof claims?.sub === 'string' ? claims.sub : '';
            const tenantId = typeof claims?.tid === 'string' ? claims.tid : '';
            const objectId = typeof claims?.oid === 'string' ? claims.oid : '';
            // The login client asserts audience and issuer on every token,
            // then binds the approved tenant, object, and subject. Email and
            // preferred_username never authorize linking; a missing email
            // claim stays null for the B4 mailbox proof to resolve.
            if (issuer !== this.issuer.href || audience !== this.configuration.clientId || subject === '') {
                throw new StudentOidcOperationalError('invalid_identity');
            }
            if (tenantId !== this.tenantId || !UUID.test(tenantId) || !UUID.test(objectId)) {
                throw new StudentOidcOperationalError('invalid_identity');
            }
            const email = typeof claims?.email === 'string' && claims.email !== '' ? claims.email : null;
            // A login ID token carries no trusted tenant member/guest
            // evidence, so it never attests school membership by itself. An
            // approved-mailbox OTP remains the fallback school proof.
            return {
                provider: 'microsoft',
                issuer: this.issuer.href,
                subject,
                email,
                mailboxVerified: false,
                realm: tenantId,
                schoolMembershipAttested: false,
                objectId,
            };
        } catch (error) {
            if (error instanceof StudentOidcOperationalError) throw error;
            throw new StudentOidcOperationalError(failureCategory(error));
        }
    }
}
