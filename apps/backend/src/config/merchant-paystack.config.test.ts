import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// Absolute module paths keep the probe independent of the caller's cwd.
const tsxHook = require.resolve('tsx');
const envModule = join(dirname(fileURLToPath(import.meta.url)), 'env.ts');
// An isolated empty cwd keeps dotenv (and tsx env injection) from loading a
// developer's local .env into the disabled-case assertion.
const isolatedCwd = mkdtempSync(join(tmpdir(), 'awoof-merchant-config-'));

function probe(mapping?: string) {
    const environment = {
        ...process.env, NODE_ENV: 'test',
        JWT_SECRET: 'test-jwt-secret-at-least-32-characters',
        JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
    };
    delete environment.PAYSTACK_MERCHANT_SECRET_KEYS;
    if (mapping !== undefined) environment.PAYSTACK_MERCHANT_SECRET_KEYS = mapping;
    return spawnSync(process.execPath, ['--import', tsxHook, '--input-type=module', '--eval',
        `import { config } from ${JSON.stringify(envModule)}; process.stdout.write(JSON.stringify(Object.keys(config.paystack.merchantSecretKeys)));`],
        { env: environment, encoding: 'utf8', timeout: 15_000, cwd: isolatedCwd });
}

test('merchant credentials are opt-in and keyed by exact vendor UUIDs', () => {
    const disabled = probe();
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.ok(disabled.stdout.endsWith('[]'));
    const configured = probe('{"00000000-0000-4000-8000-000000000001":{"secret":"synthetic-secret","domain":"test"}}');
    assert.equal(configured.status, 0, configured.stderr);
    assert.ok(configured.stdout.endsWith('["00000000-0000-4000-8000-000000000001"]'));
    assert.doesNotMatch(configured.stdout, /synthetic-secret/);
});

test('merchant credential keys normalize to lowercase and reject case collisions', () => {
    const upper = probe('{"00000000-0000-4000-8000-00000000000A":{"secret":"synthetic-secret","domain":"live"}}');
    assert.equal(upper.status, 0, upper.stderr);
    assert.ok(upper.stdout.endsWith('["00000000-0000-4000-8000-00000000000a"]'));
    const collision = probe('{"00000000-0000-4000-8000-00000000000a":{"secret":"one","domain":"test"},"00000000-0000-4000-8000-00000000000A":{"secret":"two","domain":"test"}}');
    assert.equal(collision.status, 1);
    assert.match(collision.stderr, /Merchant Paystack keys must be a JSON object/);
});

test('malformed merchant credential maps fail startup without exposing secret values', () => {
    for (const mapping of ['synthetic-secret', '[]', '{"not-a-vendor":{"secret":"synthetic-secret","domain":"test"}}',
        '{"00000000-0000-4000-8000-000000000001":{"secret":" ","domain":"test"}}',
        '{"00000000-0000-4000-8000-000000000001":"synthetic-secret"}',
        '{"00000000-0000-4000-8000-000000000001":{"secret":"synthetic-secret"}}',
        '{"00000000-0000-4000-8000-000000000001":{"secret":"synthetic-secret","domain":"sandbox"}}']) {
        const result = probe(mapping);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Merchant Paystack keys must be a JSON object/);
        assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret/);
    }
});
