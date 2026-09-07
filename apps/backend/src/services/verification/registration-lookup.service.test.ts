import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import https from 'node:https';
import test from 'node:test';
import * as enrollmentLookup from './registration-lookup.service.js';
import {
    ENROLLMENT_SCHEMA_VERSION,
    createPinnedEnrollmentLookup,
    isPublicEnrollmentAddress,
    parseConfiguredEnrollmentAdapter,
    verifyConfiguredEnrollment,
    type EnrollmentTransport,
    type EnrollmentTransportResponse,
} from './registration-lookup.service.js';

const testTlsPrivateKey = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDIedopQ+zbdD77
rylu1lVdtI5/RwfprCvIRi4X+8WAbzyXHtpg4r+WQj1RkXCGfHgsYleBn5b8fSi3
W/l5MDc/NDlQxFiQWa1gkDazvlj38FhHiMaKoMCarvYWVVE8pkry76yH7no0ImK2
XYeplU3D+li46onsei6nMYwPYsY/NBJw/4/RsuOi/1qXna1h0PbIn6UEy0vBADy6
JTcF+TA6uUnkWvbya65398CQJ86zYDLdj8UAhh3uiHFq/w/xe1DoFyqMTdHWIExX
L9xv+7fX/1LPZBtqBI32l80Ta/s61g6Gt+k73bGyEUQ1I+h/XiRy0DTP75WpUnPt
BSrPcLtzAgMBAAECggEATAcaG0gtTVSahix5lBUorq7I07AGajHnML6cwG+1CO4m
llEXFGMpsTxRsNttRzNxB7QL55a0VfDJPjBdPf5xFUEi82RjCetYeyR1+liXuP+n
Gwnd8bjhEkiD/xhABLYz+km2rp5cLeVUdkCmMEP1B/urJgWcZNg5VSLPMQ6OjGzw
zP/hYN8k2wUR79Y3kxuvVy/iofoDgzK+LZP3LKjwxPCFCMK33s/fYTHXoFGpJlYU
3kbKBtfJiDo6QASch8WkOpQcHW/4dDpmtaNY4Dv7FSW12e3hhcOvCA5t0MWGytuK
7RkZVS7bDdCVl24tXXGPyUA/8bP7DJ1xNS8weGA3gQKBgQDyrTE3DgRwjSqLck8G
MSRvyXrJ8YEtOww2LJOYh6D8PvxiDdmFCVbTf820v0jaM8BLXJIE8blXSqTzIcSq
3IgZO1Y2oiDbxrRG3daiHyUgVnEeyFxEGZmuhmsUvU/au9jMg2X1Cx1+2F6hf/lM
URYxmWZ57+cYFCeHYI8WV9QooQKBgQDTe4h8uYpsJCt8QuiF2F44j/OU6YFlJjNL
qenSZl1WomGQaumtDwzsGQzjZX0meZN4TLtU616KMuC6WqBhnfX/nn6sqbdldvNF
+SG0ZcJj1DIcDWtjLFrBUr4OeXd+aKz7DxUobg4rGQbgV/kZbz6vuaBZhMEFNX6q
hKuVHuEHkwKBgQCu8XXSN5Oxw8KQ5mXbk9+tirSvEh/KiI/EGhyIz/WZApsU4OEX
i+UA8VhM3bzaOIZ+jYxibhPrvs7sy0Io3nRqpCEBn51KcpORpujM1OEBz+8aftws
57unWhWlzNfdWp/uxybgIRQxVi/aAxSoFKiINwruCqkw7Y6VhGGCfOxgIQKBgQCy
EwMKgvEbvhkfuPcyPM6ZshzY9wYNtezbeWd50tglavXcNSouns2ywCUqFPscuqKC
WZokF0yz8cNpJ4aErA3IAB2KJh5XQaH2+aB31neot7S6ClKyX1bMEnAWoBEOT/XY
MQsP0Bv+DkTMA0etMw8FyLhMqIwfZrwRuUUBe87gIQKBgCmMNBD4Cx7NEnVOfEiU
bCFl0DkVKp05pFCcthFil3FHWRGF9+kCNhwbhYZrSDNu80dFGj7ILuIYz28P1kGU
w2bnDXxZ2wjCphukgBe8Vg8VqWe20Nqy65xF1Iw3qvdpxs1RhzE5S2MVDtRBiG1/
CRi2xzEzvYJrFab5+j7kIilm
-----END PRIVATE KEY-----`;

const testTlsCertificate = `-----BEGIN CERTIFICATE-----
MIICujCCAaICCQDhWAGHbPVQPDANBgkqhkiG9w0BAQsFADAfMR0wGwYDVQQDDBRw
cm92aWRlci5zY2hvb2wudGVzdDAeFw0yNjA5MDYwNzI0MjNaFw0zNjA5MDMwNzI0
MjNaMB8xHTAbBgNVBAMMFHByb3ZpZGVyLnNjaG9vbC50ZXN0MIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyHnaKUPs23Q++68pbtZVXbSOf0cH6awryEYu
F/vFgG88lx7aYOK/lkI9UZFwhnx4LGJXgZ+W/H0ot1v5eTA3PzQ5UMRYkFmtYJA2
s75Y9/BYR4jGiqDAmq72FlVRPKZK8u+sh+56NCJitl2HqZVNw/pYuOqJ7HoupzGM
D2LGPzQScP+P0bLjov9al52tYdD2yJ+lBMtLwQA8uiU3BfkwOrlJ5Fr28muud/fA
kCfOs2Ay3Y/FAIYd7ohxav8P8XtQ6BcqjE3R1iBMVy/cb/u31/9Sz2QbagSN9pfN
E2v7OtYOhrfpO92xshFENSPof14kctA0z++VqVJz7QUqz3C7cwIDAQABMA0GCSqG
SIb3DQEBCwUAA4IBAQCyUhOhQOqJzWdE/5j8KTPvQQicPpeImWWBAhhejHyl/zdA
68EaKB9Gymh+jfsMlqViCI+O+k/E6KhEpy6R6SxPUAHrj5OeLlDxGDY0fNWQsUgc
lCPX1mIL4rlOd7Y7zi6LlD/Ga6Jmkvq0tn0r/uu+xz73YfufHQBa9ka3eMBobiE5
dJO7mk1dXyknHsbndjKUqLdGd7XReTEhq9DS13U/yUIEbedDfCLVLMNGg/3En2oo
80gJBQpsFLIW964Z2k8yLdBbesM9AanB8JbVu+7nHjBHyOQH+5SYe/Imv17aQdsW
K3g5EwM0kQmVaK5KzU/fnSt488WDhMmT2jDtBJWI
-----END CERTIFICATE-----`;

type StrictTransportFactory = (options: {
    timeoutMs?: number;
    resolveAddresses?: (endpoint: URL) => Promise<Array<{ address: string; family: 4 | 6 }>>;
    certificateAuthority?: string;
}) => EnrollmentTransport;

function strictTransportFactory(): StrictTransportFactory {
    return (enrollmentLookup as unknown as { createEnrollmentTransport: StrictTransportFactory }).createEnrollmentTransport;
}

async function startEnrollmentFixture(respond: (path: string, response: import('node:http').ServerResponse) => void): Promise<{
    endpoint: URL;
    close: () => Promise<void>;
}> {
    const server = https.createServer({ key: testTlsPrivateKey, cert: testTlsCertificate }, (request, response) => {
        respond(request.url ?? '/', response);
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    return {
        endpoint: new URL(`https://provider.school.test:${port}/v1/enrollment`),
        close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
}

const mailbox = 'ada@students.school.example';
const adapter = parseConfiguredEnrollmentAdapter({
    isActive: true,
    apiEndpoint: 'https://provider.school.example/v1/enrollment',
    apiConfig: { schemaVersion: ENROLLMENT_SCHEMA_VERSION },
});

if (!adapter) throw new Error('Synthetic v1 adapter did not parse');

test('requires an explicit active v1 adapter instead of legacy URL or arbitrary Axios configuration', () => {
    const cases: Array<{ name: string; config: Parameters<typeof parseConfiguredEnrollmentAdapter>[0] }> = [
        { name: 'inactive', config: { isActive: false, apiEndpoint: 'https://provider.school.example', apiConfig: { schemaVersion: ENROLLMENT_SCHEMA_VERSION } } },
        { name: 'legacy seed', config: { isActive: true, apiEndpoint: 'https://provider.school.example', apiConfig: {} } },
        { name: 'wrong version', config: { isActive: true, apiEndpoint: 'https://provider.school.example', apiConfig: { schemaVersion: 'awoof.enrollment.v0' } } },
        { name: 'spreadable configuration', config: { isActive: true, apiEndpoint: 'https://provider.school.example', apiConfig: { schemaVersion: ENROLLMENT_SCHEMA_VERSION, timeout: 1 } } },
        { name: 'HTTP', config: { isActive: true, apiEndpoint: 'http://provider.school.example', apiConfig: { schemaVersion: ENROLLMENT_SCHEMA_VERSION } } },
        { name: 'userinfo', config: { isActive: true, apiEndpoint: 'https://token@provider.school.example', apiConfig: { schemaVersion: ENROLLMENT_SCHEMA_VERSION } } },
        { name: 'literal IP', config: { isActive: true, apiEndpoint: 'https://8.8.8.8', apiConfig: { schemaVersion: ENROLLMENT_SCHEMA_VERSION } } },
    ];
    for (const scenario of cases) {
        assert.equal(parseConfiguredEnrollmentAdapter(scenario.config), null, scenario.name);
    }
});

test('accepts only the exact attested v1 response union and never falls back to caller data', async () => {
    const future = '2099-01-02T03:04:05.000Z';
    const cases: Array<{
        name: string;
        response?: EnrollmentTransportResponse;
        throws?: boolean;
        expected: 'verified' | 'denied' | 'unknown';
        reason?: 'provider_unknown' | 'provider_unavailable';
    }> = [
        { name: 'valid verified', response: { status: 200, data: { schemaVersion: ENROLLMENT_SCHEMA_VERSION, outcome: 'verified', email: mailbox, registrationNumber: 'REG-1', validUntil: future } }, expected: 'verified' },
        { name: 'valid denied', response: { status: 200, data: { schemaVersion: ENROLLMENT_SCHEMA_VERSION, outcome: 'denied', email: mailbox } }, expected: 'denied' },
        { name: 'explicit unknown', response: { status: 200, data: { schemaVersion: ENROLLMENT_SCHEMA_VERSION, outcome: 'unknown' } }, expected: 'unknown', reason: 'provider_unknown' },
        { name: 'mismatched positive mailbox', response: { status: 200, data: { schemaVersion: ENROLLMENT_SCHEMA_VERSION, outcome: 'verified', email: 'victim@students.school.example', registrationNumber: 'REG-1', validUntil: future } }, expected: 'unknown', reason: 'provider_unknown' },
        { name: 'mismatched denial mailbox', response: { status: 200, data: { schemaVersion: ENROLLMENT_SCHEMA_VERSION, outcome: 'denied', email: 'victim@students.school.example' } }, expected: 'unknown', reason: 'provider_unknown' },
        { name: 'truthy legacy flag', response: { status: 200, data: { verified: 'true', email: mailbox, registrationNumber: 'REG-1' } }, expected: 'unknown', reason: 'provider_unknown' },
        { name: 'bare name', response: { status: 200, data: { name: 'Ada Student', email: mailbox } }, expected: 'unknown', reason: 'provider_unknown' },
        { name: 'student data', response: { status: 200, data: { studentData: { name: 'Ada Student', email: mailbox } } }, expected: 'unknown', reason: 'provider_unknown' },
        { name: 'missing email', response: { status: 200, data: { schemaVersion: ENROLLMENT_SCHEMA_VERSION, outcome: 'denied' } }, expected: 'unknown', reason: 'provider_unknown' },
        { name: 'missing date', response: { status: 200, data: { schemaVersion: ENROLLMENT_SCHEMA_VERSION, outcome: 'verified', email: mailbox, registrationNumber: 'REG-1' } }, expected: 'unknown', reason: 'provider_unknown' },
        { name: 'expired date', response: { status: 200, data: { schemaVersion: ENROLLMENT_SCHEMA_VERSION, outcome: 'verified', email: mailbox, registrationNumber: 'REG-1', validUntil: '2020-01-02T03:04:05.000Z' } }, expected: 'unknown', reason: 'provider_unknown' },
        { name: 'invalid date', response: { status: 200, data: { schemaVersion: ENROLLMENT_SCHEMA_VERSION, outcome: 'verified', email: mailbox, registrationNumber: 'REG-1', validUntil: 'not-a-date' } }, expected: 'unknown', reason: 'provider_unknown' },
        { name: 'wrong response version', response: { status: 200, data: { schemaVersion: 'awoof.enrollment.v0', outcome: 'denied', email: mailbox } }, expected: 'unknown', reason: 'provider_unknown' },
        { name: 'raw provider source', response: { status: 200, data: { schemaVersion: ENROLLMENT_SCHEMA_VERSION, outcome: 'denied', email: mailbox, source: 'provider-controlled' } }, expected: 'unknown', reason: 'provider_unknown' },
        { name: 'provider 404', response: { status: 404, data: {} }, expected: 'unknown', reason: 'provider_unknown' },
        { name: 'provider 401', response: { status: 401, data: {} }, expected: 'unknown', reason: 'provider_unknown' },
        { name: 'malformed JSON', response: { status: 200, data: '{not-json' }, expected: 'unknown', reason: 'provider_unknown' },
        { name: 'timeout', throws: true, expected: 'unknown', reason: 'provider_unavailable' },
    ];

    for (const scenario of cases) {
        const result = await verifyConfiguredEnrollment(adapter, {
            email: mailbox,
            registrationNumber: 'REG-1',
            normalization: 'exact',
        }, async (request) => {
            assert.equal(request.email, mailbox);
            assert.equal(request.registrationNumber, 'REG-1');
            if (scenario.throws) throw new Error('synthetic timeout');
            return scenario.response!;
        });
        assert.equal(result.decision.outcome, scenario.expected, scenario.name);
        assert.equal(result.reason, scenario.reason, scenario.name);
        if (result.decision.outcome !== 'unknown') assert.equal(result.decision.source, 'institution-registration:v1');
    }
});

test('requires an institution-selected registration normalization and matching identifier', async () => {
    const response = { status: 200, data: {
        schemaVersion: ENROLLMENT_SCHEMA_VERSION,
        outcome: 'verified',
        email: mailbox,
        registrationNumber: ' reg-1 ',
        validUntil: '2099-01-02T03:04:05.000Z',
    } };
    const exact = await verifyConfiguredEnrollment(adapter, {
        email: mailbox, registrationNumber: 'REG-1', normalization: 'exact',
    }, async () => response);
    assert.equal(exact.decision.outcome, 'unknown');
    const trimUpper = await verifyConfiguredEnrollment(adapter, {
        email: mailbox, registrationNumber: 'REG-1', normalization: 'trim_upper',
    }, async () => response);
    assert.equal(trimUpper.decision.outcome, 'verified');
});

test('blocks loopback, private, link-local, documentation, multicast, and local IPv6 destinations', () => {
    for (const address of [
        '127.0.0.1', '10.0.0.1', '169.254.1.1', '192.168.1.1', '192.0.2.1', '224.0.0.1',
        '::1', '0:0:0:0:0:0:0:1', 'fe80::1', 'fd00::1', 'ff00::1', '2001:db8::1',
        '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a00:1',
    ]) {
        assert.equal(isPublicEnrollmentAddress(address), false, address);
    }
    assert.equal(isPublicEnrollmentAddress('8.8.8.8'), true);
    assert.equal(isPublicEnrollmentAddress('2606:4700:4700::1111'), true);
});

test('pins the actual socket lookup to a validated address and rejects hostname changes', async () => {
    const lookup = createPinnedEnrollmentLookup('provider.school.example', { address: '8.8.8.8', family: 4 });
    const resolved = await new Promise<{ address: string; family: number }>((resolve, reject) => {
        lookup('provider.school.example', {}, (error, address, family) => {
            if (error) reject(error);
            else resolve({ address, family });
        });
    });
    assert.deepEqual(resolved, { address: '8.8.8.8', family: 4 });
    const allResolved = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
        const allLookup = lookup as unknown as (
            hostname: string,
            options: { all: true },
            callback: (error: Error | null, addresses: Array<{ address: string; family: number }>) => void,
        ) => void;
        allLookup('provider.school.example', { all: true }, (error, addresses) => {
            if (error) reject(error);
            else resolve(addresses);
        });
    });
    assert.deepEqual(allResolved, [{ address: '8.8.8.8', family: 4 }]);
    await assert.rejects(new Promise<void>((resolve, reject) => {
        lookup('changed.school.example', {}, (error) => error ? reject(error) : resolve());
    }), /hostname changed/);
});

test('uses a pinned Node TLS socket while preserving the configured TLS hostname', async (t) => {
    const requestedPaths: string[] = [];
    const fixture = await startEnrollmentFixture((path, response) => {
        requestedPaths.push(path);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ schemaVersion: ENROLLMENT_SCHEMA_VERSION, outcome: 'unknown' }));
    });
    t.after(fixture.close);

    const transport = strictTransportFactory()({
        resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }],
        certificateAuthority: testTlsCertificate,
    });
    const successful = await transport({ endpoint: fixture.endpoint, email: mailbox, registrationNumber: 'REG-1' });
    assert.equal(successful.status, 200);
    assert.deepEqual(requestedPaths, ['/v1/enrollment']);

    const changedHost = new URL(fixture.endpoint);
    changedHost.hostname = 'changed.school.test';
    await assert.rejects(
        transport({ endpoint: changedHost, email: mailbox, registrationNumber: 'REG-1' }),
        /ERR_TLS_CERT_ALTNAME_INVALID|Hostname\/IP does not match certificate's altnames/,
    );
    assert.deepEqual(requestedPaths, ['/v1/enrollment']);
});

test('does not follow redirects and enforces the enrollment response size bound', async (t) => {
    const requestedPaths: string[] = [];
    const fixture = await startEnrollmentFixture((path, response) => {
        requestedPaths.push(path);
        if (path === '/redirect') {
            response.writeHead(302, { location: '/second-hop' });
            response.end();
            return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ payload: 'x'.repeat(16 * 1024) }));
    });
    t.after(fixture.close);
    const transport = strictTransportFactory()({
        resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }],
        certificateAuthority: testTlsCertificate,
    });

    const redirectEndpoint = new URL(fixture.endpoint);
    redirectEndpoint.pathname = '/redirect';
    const redirect = await transport({ endpoint: redirectEndpoint, email: mailbox, registrationNumber: 'REG-1' });
    assert.equal(redirect.status, 302);
    assert.deepEqual(requestedPaths, ['/redirect']);

    const oversizedEndpoint = new URL(fixture.endpoint);
    oversizedEndpoint.pathname = '/oversized';
    await assert.rejects(transport({ endpoint: oversizedEndpoint, email: mailbox, registrationNumber: 'REG-1' }), /maxContentLength size/);
});

test('starts the enrollment deadline before resolution and never opens a socket after it expires', async () => {
    let resolverStarted = false;
    let connectionAttempts = 0;
    const transport = strictTransportFactory()({
        timeoutMs: 20,
        resolveAddresses: async () => {
            resolverStarted = true;
            await new Promise<void>(() => {});
            connectionAttempts += 1;
            return [{ address: '127.0.0.1', family: 4 }];
        },
        certificateAuthority: testTlsCertificate,
    });
    const startedAt = Date.now();
    await assert.rejects(
        transport({ endpoint: new URL('https://provider.school.test/v1/enrollment'), email: mailbox, registrationNumber: 'REG-1' }),
        /deadline/i,
    );
    assert.equal(resolverStarted, true);
    assert.ok(Date.now() - startedAt < 500);
    assert.equal(connectionAttempts, 0);
});
