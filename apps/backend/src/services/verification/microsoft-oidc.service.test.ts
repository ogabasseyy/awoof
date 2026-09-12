import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { readMicrosoftOidcConfiguration } from './microsoft-oidc.config.js';
import { MicrosoftOidcOperationalError, MicrosoftOidcService } from './microsoft-oidc.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';
const issuer = new URL(`https://login.microsoftonline.com/${tenantId}/v2.0`);
const callback = new URL('https://api.awoof.example/api/verification/microsoft/callback');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });

function encoded(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function token(overrides: Record<string, unknown> = {}, key = privateKey, kid = 'key-1'): string {
    const header = encoded({ alg: 'RS256', kid, typ: 'JWT' });
    const payload = encoded({ iss: issuer.href, aud: clientId, sub: 'subject-1', tid: tenantId, oid: '33333333-3333-4333-8333-333333333333', nonce: 'nonce-1', iat: 1_700_000_000, exp: 4_000_000_000, ...overrides });
    const signer = createSign('RSA-SHA256'); signer.update(`${header}.${payload}`); signer.end();
    return `${header}.${payload}.${signer.sign(key).toString('base64url')}`;
}

function syntheticTransport(current: () => string, keys: () => unknown, metadataOverride: Record<string, unknown> = {}, redirect = false, oversized = false): import('openid-client').CustomFetch {
    return async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (redirect) return new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/' } });
        if (url.pathname.endsWith('/.well-known/openid-configuration')) {
            if (oversized) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(200_000)); controller.enqueue(new Uint8Array(100_000)); controller.close(); } }));
            return Response.json({ issuer: issuer.href, authorization_endpoint: new URL('/authorize', issuer).href, token_endpoint: new URL('/token', issuer).href, jwks_uri: new URL('/keys', issuer).href, response_types_supported: ['code'], subject_types_supported: ['pairwise'], id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'], ...metadataOverride });
        }
        if (url.pathname === '/keys') return Response.json({ keys: keys() });
        if (url.pathname === '/token') return Response.json({ token_type: 'Bearer', access_token: 'never-returned', id_token: current() });
        throw new Error('unexpected synthetic endpoint');
    };
}

function service(current: () => string, keys: () => unknown, metadataOverride: Record<string, unknown> = {}, redirect = false, oversized = false): MicrosoftOidcService {
    const configuration = readMicrosoftOidcConfiguration({ enabled: true, tenantId, clientId, clientSecret: 'test-secret', callbackUrl: callback.href, frontendCompletionUrl: 'https://app.awoof.example/student/verification/microsoft/complete' });
    return MicrosoftOidcService.forConfiguration(configuration, { issuer, fetch: syntheticTransport(current, keys, metadataOverride, redirect, oversized) });
}

async function redeem(oidc: MicrosoftOidcService): Promise<unknown> {
    return oidc.redeem({ tenantId, callback: new URL(`${callback.href}?code=synthetic&state=state-1`), state: 'state-1', nonce: 'nonce-1', verifier: 'A'.repeat(64) });
}

function payloadFree(category: 'invalid_identity' | 'cancelled_or_permission' | 'upstream_unavailable') {
    return (error: unknown): boolean => {
        assert.ok(error instanceof MicrosoftOidcOperationalError);
        assert.equal(error.category, category);
        assert.doesNotMatch(error.message, /synthetic|access_token|id_token|code=|verifier|secret|error_description/i);
        return true;
    };
}

test('validates a signed Microsoft identity and does not expose the access token', async () => {
    const result = await redeem(service(() => token(), () => [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }]));
    assert.deepEqual(result, { identity: { tenantId, objectId: '33333333-3333-4333-8333-333333333333' } });
});

for (const [name, changes] of [
    ['wrong issuer', { iss: 'https://login.microsoftonline.com/other/v2.0' }],
    ['wrong audience', { aud: 'other-client' }],
    ['wrong nonce', { nonce: 'other-nonce' }],
    ['wrong tenant', { tid: '44444444-4444-4444-8444-444444444444' }],
    ['expired token', { exp: 1 }],
    ['missing oid', { oid: undefined }],
    ['invalid oid', { oid: 'not-a-uuid' }],
] as const) {
    test(`rejects ${name} without leaking provider data`, async () => {
        await assert.rejects(() => redeem(service(() => token(changes), () => [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }])), payloadFree('invalid_identity'));
    });
}

test('reuses one transport instance across trusted JWKS rotation', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let keySet: unknown = [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }];
    const oidc = service(() => token({}, other.privateKey, 'other'), () => keySet);
    await assert.rejects(() => redeem(oidc), payloadFree('invalid_identity'));
    const rotated = other.publicKey.export({ format: 'jwk' });
    keySet = [{ ...rotated, kid: 'other', use: 'sig', alg: 'RS256' }];
    const result = await redeem(oidc);
    assert.equal((result as { identity: { objectId: string } }).identity.objectId, '33333333-3333-4333-8333-333333333333');
});

test('authorization always uses code PKCE S256, query response mode, state, nonce, and identity-only scopes', async () => {
    const oidc = service(() => token(), () => [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }]);
    const url = new URL(await oidc.authorize({ tenantId, state: 'state-1', nonce: 'nonce-1', verifier: 'A'.repeat(64), scopes: ['openid', 'profile'] }));
    assert.equal(url.searchParams.get('response_mode'), 'query'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('state'), 'state-1'); assert.equal(url.searchParams.get('nonce'), 'nonce-1'); assert.equal(url.searchParams.get('scope'), 'openid profile');
    await assert.rejects(() => oidc.authorize({ tenantId, state: 'state-1', nonce: 'nonce-1', verifier: 'A'.repeat(64), scopes: ['openid', 'profile', 'email'] }), MicrosoftOidcOperationalError);
});

test('rejects hostile discovery endpoints and provider redirects before token exchange', async () => {
    await assert.rejects(() => redeem(service(() => token(), () => [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }], { token_endpoint: 'https://attacker.invalid/token' })), MicrosoftOidcOperationalError);
    await assert.rejects(() => redeem(service(() => token(), () => [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }], {}, true)), MicrosoftOidcOperationalError);
});

test('rejects a chunked provider response larger than the transport limit', async () => {
    await assert.rejects(() => redeem(service(() => token(), () => [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }], {}, false, true)), MicrosoftOidcOperationalError);
});

test('cancels the locked stream when chunked provider data exceeds the limit', async () => {
    let cancellations = 0;
    const fetch: import('openid-client').CustomFetch = async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(262_145)); },
        cancel() { cancellations += 1; },
    }));
    await assert.rejects(() => serviceWithFetch(fetch).authorize({ tenantId, state: 'state-1', nonce: 'nonce-1', verifier: 'A'.repeat(64), scopes: ['openid', 'profile'] }), MicrosoftOidcOperationalError);
    assert.equal(cancellations, 1);
});

function cancellationProbe(status: number, headers: HeadersInit = {}): { fetch: import('openid-client').CustomFetch; cancelled: () => number } {
    let cancellations = 0;
    const fetch: import('openid-client').CustomFetch = async () => new Response(new ReadableStream({ cancel() { cancellations += 1; } }), { status, headers });
    return { fetch, cancelled: () => cancellations };
}

function serviceWithFetch(fetch: import('openid-client').CustomFetch): MicrosoftOidcService {
    const configuration = readMicrosoftOidcConfiguration({ enabled: true, tenantId, clientId, clientSecret: 'test-secret', callbackUrl: callback.href, frontendCompletionUrl: 'https://app.awoof.example/student/verification/microsoft/complete' });
    return MicrosoftOidcService.forConfiguration(configuration, { issuer, fetch });
}

test('cancels response bodies rejected by redirect and Content-Length checks', async () => {
    for (const probe of [cancellationProbe(302, { location: 'https://attacker.invalid/' }), cancellationProbe(200, { 'content-length': '262145' })]) {
        await assert.rejects(() => serviceWithFetch(probe.fetch).authorize({ tenantId, state: 'state-1', nonce: 'nonce-1', verifier: 'A'.repeat(64), scopes: ['openid', 'profile'] }), MicrosoftOidcOperationalError);
        assert.equal(probe.cancelled(), 1);
    }
});

test('removes deadline listeners after many small response chunks', async () => {
    const metadata = JSON.stringify({ issuer: issuer.href, authorization_endpoint: new URL('/authorize', issuer).href, token_endpoint: new URL('/token', issuer).href, jwks_uri: new URL('/keys', issuer).href, response_types_supported: ['code'], subject_types_supported: ['pairwise'], id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'] });
    let added = 0;
    let removed = 0;
    const fetch: import('openid-client').CustomFetch = async (_url, options) => {
        const signal = options.signal;
        assert.ok(signal);
        const originalAdd = signal.addEventListener.bind(signal);
        const originalRemove = signal.removeEventListener.bind(signal);
        Object.assign(signal, {
            addEventListener(...args: Parameters<AbortSignal['addEventListener']>) { added += 1; return originalAdd(...args); },
            removeEventListener(...args: Parameters<AbortSignal['removeEventListener']>) { removed += 1; return originalRemove(...args); },
        });
        return new Response(new ReadableStream({ start(controller) { for (const character of metadata) controller.enqueue(new TextEncoder().encode(character)); controller.close(); } }));
    };
    await serviceWithFetch(fetch).authorize({ tenantId, state: 'state-1', nonce: 'nonce-1', verifier: 'A'.repeat(64), scopes: ['openid', 'profile'] });
    assert.ok(added > 100);
    assert.equal(removed, added);
});
