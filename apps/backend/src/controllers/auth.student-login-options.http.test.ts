import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { AuthController } from './auth.controller.js';
import { errorHandler } from '../common/middleware/errorHandler.js';
import { RateLimitError, ServiceUnavailableError } from '../common/errors/AppError.js';
import { createAuthRouter, type StudentLoginOptionsDependencies } from '../routes/auth.routes.js';
import type { LoginOptions } from '../services/auth/student-sso.types.js';
import { swaggerSpec } from '../config/swagger.js';

const PASSWORD_ONLY: LoginOptions = { password: true, providers: [], registration: true, recovery: true };

function dependencies(overrides: Partial<StudentLoginOptionsDependencies> = {}): StudentLoginOptionsDependencies {
    return {
        resolveLoginOptions: async () => PASSWORD_ONLY,
        checkQuota: async () => undefined,
        ...overrides,
    };
}

async function withServer(
    loginOptions: StudentLoginOptionsDependencies,
    operation: (baseUrl: string) => Promise<void>,
): Promise<void> {
    const app = express();
    app.use(express.json());
    app.use('/auth', createAuthRouter(new AuthController({
        studentEmailPreflight: async () => ({ supported: false, reason: 'not approved' }),
        readStudentAssurance: async () => null,
    }), loginOptions));
    app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture did not expose a loopback port');
    try {
        await operation(`http://127.0.0.1:${address.port}/auth`);
    } finally {
        server.close();
        await once(server, 'close');
    }
}

async function postLoginOptions(baseUrl: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/student/login-options`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

test('returns login options with a no-store response', async () => {
    const seen: unknown[] = [];
    await withServer(dependencies({
        resolveLoginOptions: async (email) => {
            seen.push(email);
            return { password: true, providers: ['google'], registration: true, recovery: true };
        },
    }), async (baseUrl) => {
        const response = await postLoginOptions(baseUrl, { email: 'ada@students.school.example' });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await response.json(), {
            success: true,
            data: { password: true, providers: ['google'], registration: true, recovery: true },
        });
        assert.deepEqual(seen, ['ada@students.school.example']);
    });
});

test('unknown valid domains return the password-only shape', async () => {
    await withServer(dependencies(), async (baseUrl) => {
        const response = await postLoginOptions(baseUrl, { email: 'ada@unknown.example' });
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).data, PASSWORD_ONLY);
    });
});

for (const body of [
    { email: 'not-an-email' },
    { email: '' },
    { email: 'https://ada@school.example' },
    { email: 42 },
    { email: null },
    {},
    { email: 'ada@school.example', extra: true },
    { wrong: 'ada@school.example' },
]) {
    test(`malformed body ${JSON.stringify(body)} is a 400 with no-store`, async () => {
        let resolved = 0;
        let quotaChecked = 0;
        await withServer(dependencies({
            resolveLoginOptions: async () => {
                resolved += 1;
                return PASSWORD_ONLY;
            },
            checkQuota: async () => {
                quotaChecked += 1;
            },
        }), async (baseUrl) => {
            const response = await postLoginOptions(baseUrl, body);
            assert.equal(response.status, 400);
            assert.equal(response.headers.get('cache-control'), 'no-store');
            assert.equal(resolved, 0);
            assert.equal(quotaChecked, 0);
        });
    });
}

test('overlong email is a 400', async () => {
    await withServer(dependencies(), async (baseUrl) => {
        const response = await postLoginOptions(baseUrl, { email: `${'a'.repeat(250)}@x.io` });
        assert.equal(response.status, 400);
    });
});

test('quota exhaustion surfaces a 429 with no-store', async () => {
    await withServer(dependencies({
        checkQuota: async () => {
            throw new RateLimitError('Too many login discovery requests. Please try again later.');
        },
    }), async (baseUrl) => {
        const response = await postLoginOptions(baseUrl, { email: 'ada@school.example' });
        assert.equal(response.status, 429);
        assert.equal(response.headers.get('cache-control'), 'no-store');
    });
});

test('quota outage surfaces a retryable 503 with no-store', async () => {
    let resolved = 0;
    await withServer(dependencies({
        checkQuota: async () => {
            throw new ServiceUnavailableError('Student login is temporarily unavailable. Please try again.');
        },
        resolveLoginOptions: async () => {
            resolved += 1;
            return PASSWORD_ONLY;
        },
    }), async (baseUrl) => {
        const response = await postLoginOptions(baseUrl, { email: 'ada@school.example' });
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(resolved, 0);
    });
});

test('malformed input stays a 400 even during a quota outage', async () => {
    await withServer(dependencies({
        checkQuota: async () => {
            throw new ServiceUnavailableError('Student login is temporarily unavailable. Please try again.');
        },
    }), async (baseUrl) => {
        const response = await postLoginOptions(baseUrl, { email: 'not-an-email' });
        assert.equal(response.status, 400);
    });
});

test('OpenAPI documents the strict login-options contract', () => {
    const spec = swaggerSpec as {
        paths: Record<string, Record<string, {
            requestBody?: { content: Record<string, { schema: Record<string, unknown> }> };
            responses?: Record<string, unknown>;
        }>>;
    };
    const post = spec.paths['/api/auth/student/login-options']?.post;
    assert.ok(post, 'login-options must be documented');
    const schema = post.requestBody?.content['application/json']?.schema as {
        required: string[];
        additionalProperties: boolean;
        properties: { email: { type: string; maxLength: number } };
    };
    assert.deepEqual(schema.required, ['email']);
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.email.type, 'string');
    assert.equal(schema.properties.email.maxLength, 254);
    assert.ok(post.responses?.['200']);
    assert.ok(post.responses?.['400']);
    assert.ok(post.responses?.['429']);
    assert.ok(post.responses?.['503']);
});
