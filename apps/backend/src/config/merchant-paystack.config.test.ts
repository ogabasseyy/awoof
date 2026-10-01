import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function probe(mapping?: string) {
    const environment = {
        ...process.env, NODE_ENV: 'test',
        JWT_SECRET: 'test-jwt-secret-at-least-32-characters',
        JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
    };
    delete environment.PAYSTACK_MERCHANT_SECRET_KEYS;
    if (mapping !== undefined) environment.PAYSTACK_MERCHANT_SECRET_KEYS = mapping;
    return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
        "import { config } from './src/config/env.ts'; process.stdout.write(JSON.stringify(Object.keys(config.paystack.merchantSecretKeys)));"],
        { env: environment, encoding: 'utf8', timeout: 15_000 });
}

test('merchant credentials are opt-in and keyed by exact vendor UUIDs', () => {
    const disabled = probe();
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.ok(disabled.stdout.endsWith('[]'));
    const configured = probe('{"00000000-0000-4000-8000-000000000001":"synthetic-secret"}');
    assert.equal(configured.status, 0, configured.stderr);
    assert.ok(configured.stdout.endsWith('["00000000-0000-4000-8000-000000000001"]'));
    assert.doesNotMatch(configured.stdout, /synthetic-secret/);
});

test('malformed merchant credential maps fail startup without exposing secret values', () => {
    for (const mapping of ['synthetic-secret', '[]', '{"not-a-vendor":"synthetic-secret"}', '{"00000000-0000-4000-8000-000000000001":" "}']) {
        const result = probe(mapping);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Merchant Paystack keys must be a JSON object/);
        assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret/);
    }
});
