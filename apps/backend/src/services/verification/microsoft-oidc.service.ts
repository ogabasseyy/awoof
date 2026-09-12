import * as client from 'openid-client';
import type { MicrosoftOidcConfiguration } from './microsoft-oidc.config.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTITY_SCOPES = ['openid', 'profile'] as const;
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export type MicrosoftIdentity = { tenantId: string; objectId: string };
export interface MicrosoftOidc {
    authorize(input: { tenantId: string; state: string; nonce: string; verifier: string; scopes: readonly string[] }): Promise<string>;
    redeem(input: { tenantId: string; callback: URL; state: string; nonce: string; verifier: string }): Promise<{ identity: MicrosoftIdentity; graphAccessToken?: string }>;
}

export type MicrosoftOidcFailureCategory = 'invalid_identity' | 'cancelled_or_permission' | 'upstream_unavailable';
export class MicrosoftOidcOperationalError extends Error {
    readonly category: MicrosoftOidcFailureCategory;
    constructor(category: MicrosoftOidcFailureCategory) {
        super(category === 'invalid_identity' ? 'Microsoft identity validation failed' : category === 'cancelled_or_permission' ? 'Microsoft authorization was not completed' : 'Microsoft provider is unavailable');
        this.name = 'MicrosoftOidcOperationalError';
        this.category = category;
    }
}

type Dependencies = { fetch?: client.CustomFetch; issuer?: URL };

function matchesIdentityScopes(scopes: readonly string[]): boolean {
    return scopes.length === IDENTITY_SCOPES.length && scopes.every((scope, index) => scope === IDENTITY_SCOPES[index]);
}

function failureCategory(error: unknown): MicrosoftOidcFailureCategory {
    if (error instanceof client.AuthorizationResponseError || error instanceof client.ResponseBodyError) return 'cancelled_or_permission';
    if (error instanceof client.ClientError) return 'invalid_identity';
    return 'upstream_unavailable';
}

function trustedUrl(issuer: URL, value: string | URL | undefined): void {
    if (!value) throw new TypeError('OIDC metadata endpoint is missing');
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== issuer.origin) throw new TypeError('OIDC endpoint is not trusted');
}

async function readBeforeDeadline(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>> {
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
    // Cleanup is deliberately non-blocking: a malicious stream must not extend
    // the request deadline after it has already been rejected.
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
        discardResponseBody(response);
        throw error;
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
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
    trustedUrl(issuer, metadata.authorization_endpoint);
    trustedUrl(issuer, metadata.token_endpoint);
    trustedUrl(issuer, metadata.jwks_uri);
}

function validOpaque(value: string, label: string): void {
    if (typeof value !== 'string' || value.length === 0 || value.length > 1024) throw new MicrosoftOidcOperationalError('invalid_identity');
    if (label === 'verifier' && !/^[A-Za-z0-9._~-]{43,128}$/.test(value)) throw new MicrosoftOidcOperationalError('invalid_identity');
}

export class MicrosoftOidcService implements MicrosoftOidc {
    private constructor(private readonly configuration: MicrosoftOidcConfiguration & { enabled: true }, private readonly dependency: Dependencies) {}

    static forConfiguration(configuration: MicrosoftOidcConfiguration, dependency: Dependencies = {}): MicrosoftOidcService {
        if (!configuration.enabled) throw new TypeError('Microsoft OIDC is disabled');
        if (dependency.issuer && process.env.NODE_ENV !== 'test') throw new TypeError('Synthetic Microsoft issuer is test-only');
        return new MicrosoftOidcService(configuration, dependency);
    }

    private async discovered(): Promise<client.Configuration> {
        const issuer = this.dependency.issuer ?? this.configuration.issuer;
        const delegate: client.CustomFetch = this.dependency.fetch ?? ((url, options) => {
            const init: RequestInit = { method: options.method, headers: options.headers, redirect: options.redirect };
            if (options.body !== undefined) init.body = options.body;
            if (options.duplex !== undefined) init.duplex = options.duplex;
            if (options.signal !== undefined) init.signal = options.signal;
            return globalThis.fetch(url, init);
        });
        const fetch = boundedTrustedFetch(issuer, delegate);
        const configuration = await client.discovery(issuer, this.configuration.clientId, { client_secret: this.configuration.clientSecret, redirect_uris: [this.configuration.callbackUrl.href], response_types: ['code'] }, undefined, {
            [client.customFetch]: fetch,
            timeout: REQUEST_TIMEOUT_MS / 1_000,
            execute: [client.enableNonRepudiationChecks],
        });
        assertTrustedMetadata(issuer, configuration);
        return configuration;
    }

    async authorize(input: Parameters<MicrosoftOidc['authorize']>[0]): Promise<string> {
        if (input.tenantId !== this.configuration.tenantId || !matchesIdentityScopes(input.scopes)) throw new MicrosoftOidcOperationalError('invalid_identity');
        validOpaque(input.state, 'state'); validOpaque(input.nonce, 'nonce'); validOpaque(input.verifier, 'verifier');
        try {
            const configuration = await this.discovered();
            const challenge = await client.calculatePKCECodeChallenge(input.verifier);
            return client.buildAuthorizationUrl(configuration, {
                redirect_uri: this.configuration.callbackUrl.href,
                response_mode: 'query', response_type: 'code', scope: IDENTITY_SCOPES.join(' '),
                state: input.state, nonce: input.nonce, code_challenge: challenge, code_challenge_method: 'S256',
            }).href;
        } catch (error) { throw new MicrosoftOidcOperationalError(failureCategory(error)); }
    }

    async redeem(input: Parameters<MicrosoftOidc['redeem']>[0]): Promise<{ identity: MicrosoftIdentity; graphAccessToken?: string }> {
        if (input.tenantId !== this.configuration.tenantId || input.callback.origin !== this.configuration.callbackUrl.origin || input.callback.pathname !== this.configuration.callbackUrl.pathname) {
            throw new MicrosoftOidcOperationalError('invalid_identity');
        }
        validOpaque(input.state, 'state'); validOpaque(input.nonce, 'nonce'); validOpaque(input.verifier, 'verifier');
        try {
            const configuration = await this.discovered();
            const response = await client.authorizationCodeGrant(configuration, input.callback, {
                expectedState: input.state, expectedNonce: input.nonce, pkceCodeVerifier: input.verifier, idTokenExpected: true,
            });
            const claims = response.claims();
            const tenantId = typeof claims?.tid === 'string' ? claims.tid : '';
            const objectId = typeof claims?.oid === 'string' ? claims.oid : '';
            const subject = typeof claims?.sub === 'string' ? claims.sub : '';
            if (tenantId !== this.configuration.tenantId || !UUID.test(tenantId) || !UUID.test(objectId) || !subject) throw new MicrosoftOidcOperationalError('invalid_identity');
            return { identity: { tenantId, objectId } };
        } catch (error) {
            if (error instanceof MicrosoftOidcOperationalError) throw error;
            throw new MicrosoftOidcOperationalError(failureCategory(error));
        }
    }
}
