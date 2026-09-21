import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { StudentOidcOperationalError } from './student-google-oidc.js';
import { MICROSOFT_LOGIN_SCOPES, StudentMicrosoftOidc } from './student-microsoft-oidc.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const objectId = '33333333-3333-4333-8333-333333333333';
const clientId = '22222222-2222-4222-8222-222222222222';
const issuer = new URL(`https://login.microsoftonline.com/${tenantId}/v2.0`);
const callback = new URL('https://api.awoof.example/api/auth/student/sso/microsoft/callback');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });

function encoded(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function token(overrides: Record<string, unknown> = {}, key = privateKey, kid = 'key-1'): string {
    const header = encoded({ alg: 'RS256', kid, typ: 'JWT' });
    const payload = encoded({
        iss: issuer.href,
        aud: clientId,
        sub: 'microsoft-subject-1',
        tid: tenantId,
        oid: objectId,
        email: 'ada@students.school.example',
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
};

function syntheticTransport(
    current: () => string,
    keys: () => unknown,
    options: TransportOptions = {},
    tenant: string = tenantId,
): import('openid-client').CustomFetch {
    const expectedIssuer = new URL(`https://login.microsoftonline.com/${tenant}/v2.0`);
    return async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (options.redirect) return new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/' } });
        if (url.pathname.endsWith('/.well-known/openid-configuration')) {
            return Response.json({
                issuer: expectedIssuer.href,
                authorization_endpoint: new URL('/authorize', expectedIssuer).href,
                token_endpoint: new URL('/token', expectedIssuer).href,
                jwks_uri: new URL('/keys', expectedIssuer).href,
                response_types_supported: ['code'],
                subject_types_supported: ['pairwise'],
                id_token_signing_alg_values_supported: ['RS256'],
                code_challenge_methods_supported: ['S256'],
                ...options.metadataOverride,
            });
        }
        if (url.pathname === '/keys') return Response.json({ keys: keys() });
        if (url.pathname === '/token') {
            return Response.json({ token_type: 'Bearer', access_token: 'fixture-token-never-exposed', id_token: current() });
        }
        throw new Error('unexpected synthetic endpoint');
    };
}

function adapter(
    current: () => string,
    keys: () => unknown,
    options: TransportOptions = {},
    tenant: string = tenantId,
): StudentMicrosoftOidc {
    return StudentMicrosoftOidc.forApprovedTenant(
        { enabled: true, clientId, clientSecret: 'test-secret', callbackUrl: callback },
        tenant,
        { fetch: syntheticTransport(current, keys, options, tenant) },
    );
}

function redeem(oidc: StudentMicrosoftOidc): Promise<unknown> {
    return oidc.redeem({
        callback: new URL(`${callback.href}?code=synthetic&state=state-1`),
        state: 'state-1',
        nonce: 'nonce-1',
        verifier: 'A'.repeat(64),
    });
}

function payloadFree(category: 'invalid_identity' | 'cancelled_or_permission' | 'upstream_unavailable') {
    return (error: unknown): boolean => {
        assert.ok(error instanceof StudentOidcOperationalError);
        assert.equal(error.category, category);
        assert.doesNotMatch(error.message, /synthetic|id_token|code=|verifier|secret|microsoft-subject/i);
        return true;
    };
}

test('login requests only openid profile email', () => {
    assert.equal(MICROSOFT_LOGIN_SCOPES, 'openid profile email');
});

test('authorize builds a PKCE S256 code URL with login hint and server-approved scopes', async () => {
    const keys = () => [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }];
    const url = await adapter(() => token(), keys).authorize({
        state: 'state-1',
        nonce: 'nonce-1',
        verifier: 'A'.repeat(64),
        loginHint: 'ada@students.school.example',
    });
    assert.equal(url.origin, issuer.origin);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('response_mode'), 'query');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('scope'), 'openid profile email');
    assert.equal(url.searchParams.get('login_hint'), 'ada@students.school.example');
});

test('the login client asserts audience and issuer on every token', async () => {
    const keys = () => [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }];
    const observation = (await redeem(adapter(() => token(), keys))) as { issuer: string };
    assert.equal(observation.issuer, issuer.href);
    await assert.rejects(() => redeem(adapter(() => token({ aud: 'other-client' }), keys)), payloadFree('invalid_identity'));
    await assert.rejects(
        () => redeem(adapter(() => token({ iss: 'https://login.microsoftonline.com/other/v2.0' }), keys)),
        payloadFree('invalid_identity'),
    );
});

test('redeem binds tenant, object, and subject without asserting school membership', async () => {
    const keys = () => [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }];
    const observation = await redeem(adapter(() => token(), keys));
    assert.deepEqual(observation, {
        provider: 'microsoft',
        issuer: issuer.href,
        subject: 'microsoft-subject-1',
        email: 'ada@students.school.example',
        mailboxVerified: false,
        realm: tenantId,
        schoolMembershipAttested: false,
    });
});

test('email may be null and preferred_username never becomes the observed email', async () => {
    const keys = () => [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }];
    const withoutEmail = (await redeem(adapter(() => token({ email: undefined }), keys))) as { email: unknown };
    assert.equal(withoutEmail.email, null);
    const withUpn = (await redeem(
        adapter(() => token({ email: undefined, preferred_username: 'ada@students.school.example' }), keys),
    )) as { email: unknown };
    assert.equal(withUpn.email, null);
});

test('an unapproved tenant is rejected before token exchange completes', async () => {
    const keys = () => [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }];
    const otherTenant = '44444444-4444-4444-8444-444444444444';
    const oidc = adapter(() => token(), keys, {}, otherTenant);
    await assert.rejects(() => redeem(oidc), payloadFree('invalid_identity'));
});

for (const [name, changes] of [
    ['wrong tenant', { tid: '44444444-4444-4444-8444-444444444444' }],
    ['invalid tenant', { tid: 'not-a-uuid' }],
    ['missing oid', { oid: undefined }],
    ['invalid oid', { oid: 'not-a-uuid' }],
    ['missing subject', { sub: undefined }],
    ['wrong nonce', { nonce: 'other-nonce' }],
    ['expired token', { exp: 1 }],
] as const) {
    test(`rejects ${name} without leaking provider data`, async () => {
        const keys = () => [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }];
        await assert.rejects(() => redeem(adapter(() => token(changes), keys)), payloadFree('invalid_identity'));
    });
}

test('rejects state, PKCE, and callback mismatches', async () => {
    const keys = () => [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }];
    const oidc = adapter(() => token(), keys);
    await assert.rejects(
        () => oidc.redeem({
            callback: new URL(`${callback.href}?code=synthetic&state=tampered-state`),
            state: 'state-1',
            nonce: 'nonce-1',
            verifier: 'A'.repeat(64),
        }),
        payloadFree('invalid_identity'),
    );
    await assert.rejects(
        () => oidc.redeem({
            callback: new URL('https://api.awoof.example/api/auth/student/sso/google/callback?code=synthetic&state=state-1'),
            state: 'state-1',
            nonce: 'nonce-1',
            verifier: 'A'.repeat(64),
        }),
        payloadFree('invalid_identity'),
    );
    await assert.rejects(
        () => oidc.redeem({
            callback: new URL(`${callback.href}?code=synthetic&state=state-1`),
            state: 'state-1',
            nonce: 'nonce-1',
            verifier: 'short',
        }),
        payloadFree('invalid_identity'),
    );
});

test('rejects hostile discovery endpoints and provider redirects', async () => {
    const keys = () => [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }];
    await assert.rejects(
        () => redeem(adapter(() => token(), keys, { metadataOverride: { token_endpoint: 'https://attacker.invalid/token' } })),
        StudentOidcOperationalError,
    );
    await assert.rejects(() => redeem(adapter(() => token(), keys, { redirect: true })), StudentOidcOperationalError);
});

test('construction requires an enabled deployment and an approved tenant UUID', () => {
    assert.throws(
        () => StudentMicrosoftOidc.forApprovedTenant({ enabled: false }, tenantId),
        /Microsoft login is not enabled/,
    );
    assert.throws(
        () => StudentMicrosoftOidc.forApprovedTenant(
            { enabled: true, clientId, clientSecret: 'test-secret', callbackUrl: callback },
            'not-a-uuid',
        ),
        /approved tenant/,
    );
});
