#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const backendRoot = resolve(import.meta.dirname, '..');

function environment(port) {
    return {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'test',
        PORT: String(port),
        MICROSOFT_OIDC_ENABLED: 'false',
        JWT_SECRET: 'openapi-parity-jwt-secret-at-least-32-characters',
        JWT_REFRESH_SECRET: 'openapi-parity-refresh-secret-at-least-32-characters',
    };
}

function captureSpec(args, port) {
    const result = spawnSync(process.execPath, args, { cwd: backendRoot, encoding: 'utf8', timeout: 30_000, env: environment(port) });
    if (result.status !== 0 || result.error) throw new Error(`OpenAPI parity probe failed: ${(result.stderr || result.error?.message || '').slice(0, 8_000)}`);
    const line = result.stdout.trim().split('\n').reverse().find((value) => value.startsWith('{'));
    if (!line) throw new Error('OpenAPI parity probe emitted no document.');
    return JSON.parse(line);
}

function normalizeDevelopmentServer(spec) {
    const normalized = JSON.parse(JSON.stringify(spec));
    const development = normalized.servers?.find((server) => server.description === 'Development server');
    assert.ok(development, 'OpenAPI document must retain its development server');
    development.url = 'http://localhost:PORT';
    return normalized;
}

const sourceUrl = pathToFileURL(joinPath('src/config/swagger.ts')).href;
const compiledUrl = pathToFileURL(joinPath('dist/config/swagger.js')).href;
function joinPath(path) { return resolve(backendRoot, path); }
const program = (url) => `import { swaggerSpec } from ${JSON.stringify(url)}; process.stdout.write(JSON.stringify(swaggerSpec) + '\\n');`;
const rendered = JSON.parse(readFileSync(joinPath('dist/config/openapi.json'), 'utf8'));
const source = captureSpec(['--import', 'tsx', '--input-type=module', '--eval', program(sourceUrl)], 5000);
const compiled = captureSpec(['--input-type=module', '--eval', program(compiledUrl)], 5454);

assert.deepEqual(rendered, source, 'rendered OpenAPI must exactly match source Swagger with the fixed build port');
assert.deepEqual(normalizeDevelopmentServer(compiled), normalizeDevelopmentServer(rendered), 'compiled OpenAPI may differ only in the documented runtime development-server port');
process.stdout.write('OpenAPI source/artifact parity passed; only the development server port is runtime-specific.\n');
