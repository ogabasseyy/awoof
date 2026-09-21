import assert from 'node:assert/strict';
import test from 'node:test';

import { BadRequestError, RateLimitError, ServiceUnavailableError } from '../../common/errors/AppError.js';
import type { LoginProvider } from './student-sso.types.js';
import {
    STUDENT_DISCOVERY_QUOTA,
    STUDENT_LOGIN_OPTIONS_MAX_EMAIL_LENGTH,
    STUDENT_LOGIN_OPTIONS_QUERY,
    STUDENT_SSO_START_IP_QUOTA,
    STUDENT_SSO_START_MAILBOX_QUOTA,
    checkDiscoveryQuota,
    checkSsoStartQuota,
    createRedisQuotaStore,
    hmacStudentMailbox,
    normalizeStudentLoginEmail,
    resolveStudentLoginOptions,
    type LoginOptionsQuery,
    type QuotaStore,
} from './student-login-options.service.js';

const ATTEMPT_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

function stubQuery(rows: Array<{ provider: string }>, seen: Array<{ text: string; params: unknown[] }> = []): LoginOptionsQuery {
    return async (text, params) => {
        seen.push({ text, params });
        return { rows };
    };
}

function memoryStore(counts: Map<string, number> = new Map()): QuotaStore {
    return {
        increment: async (key) => {
            const next = (counts.get(key) ?? 0) + 1;
            counts.set(key, next);
            return next;
        },
    };
}

test('email length is capped at 254 characters', () => {
    assert.equal(STUDENT_LOGIN_OPTIONS_MAX_EMAIL_LENGTH, 254);
});

test('normalization trims and lowercases like mailbox proof', () => {
    assert.equal(normalizeStudentLoginEmail('  Ada@Students.School.Example  '), 'ada@students.school.example');
});

test('normalization preserves plus suffixes and never strips dots', () => {
    assert.equal(
        normalizeStudentLoginEmail('Ada.Osei+club@Students.School.Example'),
        'ada.osei+club@students.school.example',
    );
});

test('overlong input is rejected without a database lookup', async () => {
    const seen: Array<{ text: string; params: unknown[] }> = [];
    await assert.rejects(
        resolveStudentLoginOptions(stubQuery([], seen), {
            email: `${'a'.repeat(250)}@x.io`,
            enabledProviders: ['google'],
        }),
        BadRequestError,
    );
    assert.equal(seen.length, 0);
});

for (const email of ['', 'no-at-sign', 'two@@school.example', 'space @school.example', 'https://ada@school.example', '@school.example', 'ada@']) {
    test(`malformed input ${JSON.stringify(email)} is a 400 with no lookup`, async () => {
        const seen: Array<{ text: string; params: unknown[] }> = [];
        await assert.rejects(
            resolveStudentLoginOptions(stubQuery([], seen), { email, enabledProviders: ['google', 'microsoft'] }),
            (error: unknown) => {
                assert.ok(error instanceof BadRequestError);
                assert.equal(error.statusCode, 400);
                return true;
            },
        );
        assert.equal(seen.length, 0);
    });
}

test('unknown valid domains return password-only without providers', async () => {
    const seen: Array<{ text: string; params: unknown[] }> = [];
    const options = await resolveStudentLoginOptions(stubQuery([], seen), {
        email: 'ada@unknown.example',
        enabledProviders: ['google', 'microsoft'],
    });
    assert.deepEqual(options, { password: true, providers: [], registration: true, recovery: true });
    assert.equal(seen.length, 1);
});

test('discovery binds the exact normalized domain and enabled providers', async () => {
    const seen: Array<{ text: string; params: unknown[] }> = [];
    await resolveStudentLoginOptions(stubQuery([{ provider: 'google' }], seen), {
        email: ' Ada.Osei+club@Students.School.Example ',
        enabledProviders: ['google', 'microsoft'],
    });
    assert.deepEqual(seen[0]?.params, ['students.school.example', ['google', 'microsoft']]);
});

test('multiple approved methods resolve in a stable order', async () => {
    const options = await resolveStudentLoginOptions(
        stubQuery([{ provider: 'microsoft' }, { provider: 'google' }]),
        { email: 'ada@school.example', enabledProviders: ['google', 'microsoft'] },
    );
    assert.deepEqual(options.providers, ['google', 'microsoft']);
});

test('rows outside deployment readiness are filtered, deduped, and unknown values dropped', async () => {
    const options = await resolveStudentLoginOptions(
        stubQuery([
            { provider: 'microsoft' },
            { provider: 'google' },
            { provider: 'google' },
            { provider: 'github' },
        ]),
        { email: 'ada@school.example', enabledProviders: ['google'] },
    );
    assert.deepEqual(options.providers, ['google']);
});

test('disabled deployments short-circuit with no database lookup', async () => {
    const seen: Array<{ text: string; params: unknown[] }> = [];
    const options = await resolveStudentLoginOptions(stubQuery([{ provider: 'google' }], seen), {
        email: 'ada@school.example',
        enabledProviders: [],
    });
    assert.deepEqual(options, { password: true, providers: [], registration: true, recovery: true });
    assert.equal(seen.length, 0);
});

test('discovery SQL is a single read-only SELECT statement', () => {
    const normalized = STUDENT_LOGIN_OPTIONS_QUERY.trim().toUpperCase();
    assert.ok(STUDENT_LOGIN_OPTIONS_QUERY.trimStart().toLowerCase().startsWith('select'));
    assert.ok(!STUDENT_LOGIN_OPTIONS_QUERY.includes(';'));
    for (const write of ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT']) {
        assert.ok(!normalized.includes(write), `discovery must never ${write}`);
    }
});

test('discovery joins only policy, domain-provider, domain, and university tables', () => {
    for (const table of [
        'institution_login_policies',
        'institution_login_domain_providers',
        'institution_login_domains',
        'universities',
    ]) {
        assert.ok(STUDENT_LOGIN_OPTIONS_QUERY.includes(table), `discovery must join ${table}`);
    }
    for (const forbidden of [
        'users',
        'students',
        'approved_student_email_domains',
        'eligibility_evidence',
        'student_auth_identities',
        'verification_tokens',
    ]) {
        assert.ok(!STUDENT_LOGIN_OPTIONS_QUERY.includes(forbidden), `discovery must never read ${forbidden}`);
    }
});

test('discovery requires enabled policies, live approvals, and active universities and domains', () => {
    assert.ok(STUDENT_LOGIN_OPTIONS_QUERY.includes('p.enabled'));
    assert.ok(STUDENT_LOGIN_OPTIONS_QUERY.includes('p.approved_until IS NOT NULL'));
    assert.ok(STUDENT_LOGIN_OPTIONS_QUERY.includes('p.approved_until > clock_timestamp()'));
    assert.ok(STUDENT_LOGIN_OPTIONS_QUERY.includes('u.is_active'));
    assert.ok(STUDENT_LOGIN_OPTIONS_QUERY.includes('d.is_active'));
});

test('discovery quota allows 60 requests per IP per 10 minutes, then rejects', async () => {
    assert.deepEqual(STUDENT_DISCOVERY_QUOTA, { max: 60, windowMs: 10 * 60 * 1000 });
    const store = memoryStore();
    for (let attempt = 1; attempt <= 60; attempt += 1) {
        await checkDiscoveryQuota(store, '203.0.113.7');
    }
    await assert.rejects(checkDiscoveryQuota(store, '203.0.113.7'), RateLimitError);
    await checkDiscoveryQuota(store, '203.0.113.8');
});

test('quota outages fail closed with a retryable 503, never unlimited access', async () => {
    const failing: QuotaStore = {
        increment: async () => {
            throw new Error('redis unavailable');
        },
    };
    await assert.rejects(
        checkDiscoveryQuota(failing, '203.0.113.7'),
        (error: unknown) => {
            assert.ok(error instanceof ServiceUnavailableError);
            assert.equal(error.statusCode, 503);
            return true;
        },
    );
});

test('SSO start quotas bind 10 per IP and 5 per mailbox HMAC', async () => {
    assert.deepEqual(STUDENT_SSO_START_IP_QUOTA, { max: 10, windowMs: 10 * 60 * 1000 });
    assert.deepEqual(STUDENT_SSO_START_MAILBOX_QUOTA, { max: 5, windowMs: 10 * 60 * 1000 });
    const counts = new Map<string, number>();
    const store = memoryStore(counts);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
        await checkSsoStartQuota(store, '203.0.113.7', 'ada@school.example', ATTEMPT_KEY);
    }
    await assert.rejects(checkSsoStartQuota(store, '203.0.113.7', 'ada@school.example', ATTEMPT_KEY), RateLimitError);
    // Same device, different mailbox: the mailbox budget is independent.
    await checkSsoStartQuota(store, '203.0.113.7', 'ben@school.example', ATTEMPT_KEY);
    const keys = [...counts.keys()];
    assert.ok(keys.some((key) => key.includes('203.0.113.7')));
    assert.ok(keys.every((key) => !key.includes('ada@school.example') && !key.includes('ben@school.example')));
});

test('mailbox HMAC is stable, keyed, and rejects invalid key material', () => {
    const first = hmacStudentMailbox('ada@school.example', ATTEMPT_KEY);
    assert.equal(hmacStudentMailbox('ada@school.example', ATTEMPT_KEY), first);
    assert.notEqual(hmacStudentMailbox('ben@school.example', ATTEMPT_KEY), first);
    assert.notEqual(
        hmacStudentMailbox('ada@school.example', 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA'),
        first,
    );
    assert.throws(() => hmacStudentMailbox('ada@school.example', 'short'), TypeError);
});

test('Redis quota storage increments atomically with an expiring window', async () => {
    const calls: Array<{ script: string; keys: number; args: unknown[] }> = [];
    const store = createRedisQuotaStore({
        eval: async (script, keys, ...args) => {
            calls.push({ script, keys, args });
            return 3;
        },
    });
    assert.equal(await store.increment('student-sso:discovery:v1:203.0.113.7', 600_000), 3);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.keys, 1);
    assert.ok(calls[0]?.script.includes('INCR'));
    assert.ok(calls[0]?.script.includes('PEXPIRE'));
    assert.deepEqual(calls[0]?.args, ['student-sso:discovery:v1:203.0.113.7', '600000']);
});

test('non-integer quota replies fail closed', async () => {
    const store = createRedisQuotaStore({
        eval: async () => 'three',
    });
    await assert.rejects(
        checkDiscoveryQuota(store, '203.0.113.7'),
        (error: unknown) => {
            assert.ok(error instanceof ServiceUnavailableError);
            return true;
        },
    );
});

test('provider ordering uses the shared transport union', () => {
    const providers: LoginProvider[] = ['google', 'microsoft'];
    assert.deepEqual([...providers].sort(), ['google', 'microsoft']);
});
