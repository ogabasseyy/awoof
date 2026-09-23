import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import {
    GOOGLE_JWKS_URI,
    GOOGLE_LOGIN_SCOPES,
    GOOGLE_TOKEN_ENDPOINT,
    StudentGoogleOidc,
    StudentOidcOperationalError,
} from './student-google-oidc.js';

const clientId = 'google-client-id.apps.googleusercontent.com';
const hostedDomain = 'students.school.example';
const callback = new URL('https://api.awoof.example/api/auth/student/sso/google/callback');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });

function encoded(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function token(overrides: Record<string, unknown> = {}, key = privateKey, kid = 'key-1'): string {
    const header = encoded({ alg: 'RS256', kid, typ: 'JWT' });
    const payload = encoded({
        iss: 'https://accounts.google.com',
        aud: clientId,
        sub: 'google-subject-1',
        email: 'ada@students.school.example',
        email_verified: true,
        hd: hostedDomain,
        nonce: 'nonce-1',
        iat: 1_700_000_000,
        exp: 4_000_000_000,
        ...overrides,
    });
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    signer.end();
    return `${header}.${payload}.${signer.sign(key).toString('base64url')}`;
}

type TransportOptions = {
    metadataOverride?: Record<string, unknown>;
    redirect?: boolean;
    oversized?: boolean;
};

function syntheticTransport(
    current: () => string,
    keys: () => unknown,
    requested: string[],
    options: TransportOptions = {},
): import('openid-client').CustomFetch {
    return async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        requested.push(url.href);
        if (options.redirect) return new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/' } });
        if (url.href === 'https://accounts.google.com/.well-known/openid-configuration') {
            if (options.oversized) {
                return new Response(new ReadableStream({
                    start(controller) {
                        controller.enqueue(new Uint8Array(200_000));
                        controller.enqueue(new Uint8Array(100_000));
                        controller.close();
                    },
                }));
            }
            return Response.json({
                issuer: 'https://accounts.google.com',
                authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
                token_endpoint: GOOGLE_TOKEN_ENDPOINT,
                jwks_uri: GOOGLE_JWKS_URI,
                response_types_supported: ['code'],
                subject_types_supported: ['public'],
                id_token_signing_alg_values_supported: ['RS256'],
                code_challenge_methods_supported: ['S256'],
                ...options.metadataOverride,
            });
        }
        if (url.href === GOOGLE_JWKS_URI) return Response.json({ keys: keys() });
        if (url.href === GOOGLE_TOKEN_ENDPOINT) {
            return Response.json({ token_type: 'Bearer', access_token: 'fixture-token-never-exposed', id_token: current() });
        }
        throw new Error(`unexpected synthetic endpoint: ${url.href}`);
    };
}

function adapter(
    current: () => string,
    keys: () => unknown,
    requested: string[] = [],
    options: TransportOptions = {},
    domain: string = hostedDomain,
): { oidc: StudentGoogleOidc; requested: string[] } {
    const oidc = StudentGoogleOidc.forApprovedDomain(
        { enabled: true, clientId, clientSecret: 'test-secret', callbackUrl: callback },
        domain,
        { fetch: syntheticTransport(current, keys, requested, options) },
    );
    return { oidc, requested };
}

function redeem(oidc: StudentGoogleOidc, overrides: { state?: string; nonce?: string; verifier?: string } = {}): Promise<unknown> {
    const state = overrides.state ?? 'state-1';
    return oidc.redeem({
        callback: new URL(`${callback.href}?code=synthetic&state=${state}`),
        state,
        nonce: overrides.nonce ?? 'nonce-1',
        verifier: overrides.verifier ?? 'A'.repeat(64),
    });
}

function payloadFree(category: 'invalid_identity' | 'cancelled_or_permission' | 'upstream_unavailable') {
    return (error: unknown): boolean => {
        assert.ok(error instanceof StudentOidcOperationalError);
        assert.equal(error.category, category);
        assert.doesNotMatch(error.message, /synthetic|id_token|code=|verifier|secret|google-subject/i);
        return true;
    };
}

test('login requests only the identity scopes', () => {
    assert.equal(GOOGLE_LOGIN_SCOPES, 'openid email profile');
});

test('authorize builds a PKCE S256 code URL with login hint, state, and nonce', async () => {
    const keys = () => [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }];
    const { oidc } = adapter(() => token(), keys);
    const url = await oidc.authorize({ state: 'state-1', nonce: 'nonce-1', verifier: 'A'.repeat(64), loginHint: 'Ada@Students.School.Example' });
    assert.equal(url.origin, 'https://accounts.google.com');
    assert.equal(url.pathname, '/o/oauth2/v2/auth');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('response_mode'), 'query');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('state'), 'state-1');
    assert.equal(url.searchParams.get('nonce'), 'nonce-1');
    assert.equal(url.searchParams.get('scope'), 'openid email profile');
    assert.equal(url.searchParams.get('login_hint'), 'Ada@Students.School.Example');
    assert.equal(url.searchParams.get('client_id'), clientId);
});

test('authorize rejects a non-mailbox login hint without contacting the provider', async () => {
    const requested: string[] = [];
    const keys = () => [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }];
    const { oidc } = adapter(() => token(), keys, requested);
    await assert.rejects(
        oidc.authorize({ state: 'state-1', nonce: 'nonce-1', verifier: 'A'.repeat(64), loginHint: 'not-an-email' }),
        payloadFree('invalid_identity'),
    );
    assert.deepEqual(requested, []);
});

test('redeem returns an attested school-membership observation for the approved hosted domain', async () => {
    const keys = () => [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }];
    const { oidc, requested } = adapter(() => token(), keys);
    const observation = await redeem(oidc);
    assert.deepEqual(observation, {
        provider: 'google',
        issuer: 'https://accounts.google.com',
        subject: 'google-subject-1',
        email: 'ada@students.school.example',
        mailboxVerified: true,
        realm: hostedDomain,
        schoolMembershipAttested: true,
        objectId: null,
    });
    assert.ok(requested.every((href) => !href.includes('tokeninfo')), 'login must never call tokeninfo');
});

test('an explicit approved mapping attests even when the email domain differs from hd', async () => {
    const keys = () => [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }];
    const { oidc } = adapter(() => token({ email: 'ada@custom.example' }), keys);
    const observation = (await redeem(oidc)) as { schoolMembershipAttested: boolean; email: string };
    assert.equal(observation.schoolMembershipAttested, true);
    assert.equal(observation.email, 'ada@custom.example');
});

test('personal Gmail logs in without school assurance', async () => {
    const keys = () => [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }];
    const { oidc } = adapter(() => token({ email: 'ada@gmail.com', hd: undefined }), keys);
    const observation = (await redeem(oidc)) as { schoolMembershipAttested: boolean; realm: string; mailboxVerified: boolean };
    assert.equal(observation.schoolMembershipAttested, false);
    assert.equal(observation.realm, '');
    assert.equal(observation.mailboxVerified, true);
});

test('an unapproved hosted domain logs in without school assurance', async () => {
    const keys = () => [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }];
    const { oidc } = adapter(() => token({ hd: 'other.example' }), keys);
    const observation = (await redeem(oidc)) as { schoolMembershipAttested: boolean; realm: string };
    assert.equal(observation.schoolMembershipAttested, false);
    assert.equal(observation.realm, 'other.example');
});

for (const [name, changes] of [
    ['wrong issuer', { iss: 'https://attacker.invalid' }],
    ['wrong audience', { aud: 'other-client' }],
    ['wrong azp', { azp: 'other-client' }],
    ['wrong nonce', { nonce: 'other-nonce' }],
    ['expired token', { exp: 1 }],
    ['unverified email', { email_verified: false }],
    ['missing email', { email: undefined }],
    ['missing subject', { sub: undefined }],
] as const) {
    test(`rejects ${name} without leaking provider data`, async () => {
        const keys = () => [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }];
        const { oidc } = adapter(() => token(changes), keys);
        await assert.rejects(() => redeem(oidc), payloadFree('invalid_identity'));
    });
}

test('rejects a token signed by an unknown key', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keys = () => [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }];
    const { oidc } = adapter(() => token({}, other.privateKey, 'other'), keys);
    await assert.rejects(() => redeem(oidc), payloadFree('invalid_identity'));
});

test('rejects state and PKCE mismatches', async () => {
    const keys = () => [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }];
    const { oidc } = adapter(() => token(), keys);
    await assert.rejects(
        () => oidc.redeem({
            callback: new URL(`${callback.href}?code=synthetic&state=tampered-state`),
            state: 'state-1',
            nonce: 'nonce-1',
            verifier: 'A'.repeat(64),
        }),
        payloadFree('invalid_identity'),
    );
    await assert.rejects(() => redeem(oidc, { verifier: 'short' }), payloadFree('invalid_identity'));
});

test('rejects hostile discovery endpoints before token exchange', async () => {
    const keys = () => [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }];
    for (const metadataOverride of [
        { token_endpoint: 'https://attacker.invalid/token' },
        { jwks_uri: 'https://attacker.invalid/certs' },
        { authorization_endpoint: 'https://attacker.invalid/auth' },
        { issuer: 'https://attacker.invalid' },
    ]) {
        const { oidc } = adapter(() => token(), keys, [], { metadataOverride });
        await assert.rejects(() => redeem(oidc), StudentOidcOperationalError);
    }
});

test('rejects provider redirects and oversized responses', async () => {
    const keys = () => [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }];
    await assert.rejects(() => redeem(adapter(() => token(), keys, [], { redirect: true }).oidc), StudentOidcOperationalError);
    await assert.rejects(() => redeem(adapter(() => token(), keys, [], { oversized: true }).oidc), StudentOidcOperationalError);
});

test('construction requires an enabled deployment and an approved hosted domain', () => {
    assert.throws(
        () => StudentGoogleOidc.forApprovedDomain({ enabled: false }, hostedDomain),
        /Google login is not enabled/,
    );
    assert.throws(
        () => StudentGoogleOidc.forApprovedDomain(
            { enabled: true, clientId, clientSecret: 'test-secret', callbackUrl: callback },
            'not a domain',
        ),
        /approved hosted domain/,
    );
});
