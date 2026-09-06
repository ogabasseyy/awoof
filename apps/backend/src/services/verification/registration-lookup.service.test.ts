import assert from 'node:assert/strict';
import test from 'node:test';
import {
    ENROLLMENT_SCHEMA_VERSION,
    createPinnedEnrollmentLookup,
    isPublicEnrollmentAddress,
    parseConfiguredEnrollmentAdapter,
    verifyConfiguredEnrollment,
    type EnrollmentTransportResponse,
} from './registration-lookup.service.js';

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
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.1.1', '192.168.1.1', '192.0.2.1', '224.0.0.1', '::1', 'fe80::1', 'fd00::1', 'ff00::1', '2001:db8::1']) {
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
    await assert.rejects(new Promise<void>((resolve, reject) => {
        lookup('changed.school.example', {}, (error) => error ? reject(error) : resolve());
    }), /hostname changed/);
});
