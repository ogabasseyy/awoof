#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateArtifactManifest } from './artifact-manifest.mjs';

const backendRoot = resolve(import.meta.dirname, '..');
const controlFiles = [
    'artifact-manifest.mjs',
    'artifact-layout.mjs',
    'postgres-test-mode.mjs',
    'test-postgres-lifecycle.mjs',
    'test-postgres.mjs',
];

export function artifactRuntimeEnvironment(extra = {}) {
    return {
        PATH: process.env.PATH ?? '',
        // initdb validates locale at cluster creation. Keep this explicit and
        // non-secret rather than inheriting the caller's full environment.
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        NODE_ENV: 'test',
        MICROSOFT_OIDC_ENABLED: 'false',
        JWT_SECRET: 'artifact-runtime-jwt-secret-at-least-32-characters',
        JWT_REFRESH_SECRET: 'artifact-runtime-refresh-secret-at-least-32-characters',
        ...extra,
    };
}

export function artifactManifestDigest(runtimeRoot) {
    return createHash('sha256').update(readFileSync(join(runtimeRoot, 'dist/artifact-manifest.json'))).digest('hex');
}

/** Re-checks both content parity and the immutable initial manifest identity. */
export function assertRuntimeArtifactStable(runtimeRoot, initialManifestDigest) {
    const artifact = validateArtifactManifest(runtimeRoot);
    assert.equal(artifactManifestDigest(runtimeRoot), initialManifestDigest, 'Source-absent runtime manifest bytes changed after probes.');
    return artifact;
}

function runNode(args, options = {}) {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30_000, ...options });
    if (result.status !== 0 || result.error) {
        const detail = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 8_000);
        throw new Error(`Source-absent artifact probe failed: ${detail}`);
    }
    return result;
}

function copyRuntimeFixture(root) {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'awoof-artifact-runtime-'));
    try {
        cpSync(join(root, 'dist'), join(runtimeRoot, 'dist'), { recursive: true, dereference: false, errorOnExist: true });
        copyFileSync(join(root, 'package.json'), join(runtimeRoot, 'package.json'));
        copyFileSync(join(root, 'package-lock.json'), join(runtimeRoot, 'package-lock.json'));
        const dependencies = join(root, 'node_modules');
        if (!existsSync(dependencies) || !statSync(dependencies).isDirectory()) throw new Error('Artifact runtime probe requires the existing local backend node_modules directory.');
        const dependencyRoot = realpathSync(dependencies);
        if (!existsSync(join(dependencyRoot, '.package-lock.json'))) throw new Error('Artifact runtime probe requires a resolved local dependency tree with .package-lock.json.');
        symlinkSync(dependencies, join(runtimeRoot, 'node_modules'), 'dir');
        const control = join(runtimeRoot, 'control');
        mkdirSync(control);
        for (const file of controlFiles) copyFileSync(join(root, 'scripts', file), join(control, file));
        return { runtimeRoot, dependencyRoot };
    } catch (error) {
        rmSync(runtimeRoot, { recursive: true, force: true });
        throw error;
    }
}

function verifySwagger(runtimeRoot) {
    const moduleUrl = pathToFileURL(join(runtimeRoot, 'dist/config/swagger.js')).href;
    const requiredPaths = [
        '/api/auth/login',
        '/api/students/savings',
        '/api/merchant-verification/assertions',
        '/api/verification/microsoft/notice',
        '/api/verification/microsoft/consents',
        '/api/verification/microsoft/consents/{id}/withdraw',
        '/api/verification/microsoft/identities',
        '/api/verification/microsoft/identities/{id}/unlink',
        '/api/verification/microsoft/finish',
    ];
    const program = `import { swaggerSpec } from ${JSON.stringify(moduleUrl)};\nconst paths = swaggerSpec.paths;\nconst required = ${JSON.stringify(requiredPaths)};\nconst development = swaggerSpec.servers?.find((server) => server.description === 'Development server');\nif (!paths || required.some((path) => !(path in paths)) || development?.url !== 'http://localhost:5454') process.exit(2);\nprocess.stdout.write(JSON.stringify({ paths: Object.keys(paths).length }) + '\\n');`;
    const result = runNode(['--input-type=module', '--eval', program], { cwd: runtimeRoot, env: artifactRuntimeEnvironment({ PORT: '5454' }) });
    const jsonLine = result.stdout.trim().split('\n').reverse().find((line) => line.startsWith('{'));
    if (!jsonLine) throw new Error('Compiled Swagger probe did not emit its fixed result.');
    const output = JSON.parse(jsonLine);
    assert.equal(typeof output.paths, 'number');
    assert.ok(output.paths > 0, 'compiled Swagger probe must find rendered paths');
}

function verifyCleanupRedaction(runtimeRoot) {
    const canary = 'ARTIFACT_RUNTIME_CONNECTION_CANARY_MUST_NOT_LEAK';
    const result = spawnSync(process.execPath, ['dist/scripts/cleanup-microsoft-attempts.js'], {
        cwd: runtimeRoot,
        encoding: 'utf8',
        timeout: 30_000,
        env: artifactRuntimeEnvironment({ DATABASE_URL: `postgresql://user:${canary}@127.0.0.1:1/awoof`, DB_HOST: '', DB_NAME: '', DB_USER: '' }),
    });
    assert.equal(result.status, 1, 'compiled cleanup failure probe must fail closed');
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'microsoft retention cleanup failed\n');
    assert.equal(`${result.stdout}${result.stderr}`.includes(canary), false, 'compiled cleanup probe must redact connection values');
}

/** Creates a disposable fixture containing no source directory and validates it. */
export function validateSourceAbsentRuntime({ root = backendRoot, runPostgres = false } = {}) {
    const { runtimeRoot, dependencyRoot } = copyRuntimeFixture(root);
    try {
        const initialManifestDigest = artifactManifestDigest(runtimeRoot);
        validateArtifactManifest(runtimeRoot);
        verifySwagger(runtimeRoot);
        verifyCleanupRedaction(runtimeRoot);
        if (runPostgres) {
            const postgres = runNode(['control/test-postgres.mjs'], {
                cwd: runtimeRoot,
                timeout: 240_000,
                env: artifactRuntimeEnvironment({
                    AWOOF_POSTGRES_ARTIFACT_ROOT: 'dist',
                    AWOOF_POSTGRES_ARTIFACT_RUNTIME: '1',
                }),
            });
            process.stdout.write(postgres.stdout || '');
            process.stderr.write(postgres.stderr || '');
        }
        const finalArtifact = assertRuntimeArtifactStable(runtimeRoot, initialManifestDigest);
        return { integrationTestCount: finalArtifact.tests.length, runtimeRoot, dependencyRoot };
    } finally {
        rmSync(runtimeRoot, { recursive: true, force: true });
    }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
    const runPostgres = process.argv[2] === '--postgres';
    if (process.argv.length > (runPostgres ? 3 : 2)) {
        process.stderr.write('artifact runtime control accepts only --postgres\n');
        process.exitCode = 1;
    } else {
        try {
            const result = validateSourceAbsentRuntime({ runPostgres });
            process.stdout.write(`Source-absent artifact runtime passed with ${result.integrationTestCount} compiled integration tests.\n`);
        } catch (error) {
            process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        }
    }
}
