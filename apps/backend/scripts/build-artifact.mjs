#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { assertCompiledArtifact, stageMigrationSql } from './artifact-layout.mjs';
import { writeArtifactManifest } from './artifact-manifest.mjs';

const backendRoot = resolve(import.meta.dirname, '..');

export function buildArtifact({ root = backendRoot, spawn = spawnSync } = {}) {
    const compilation = spawn('./node_modules/.bin/tsc', [], { cwd: root, encoding: 'utf8', timeout: 120_000 });
    if (compilation.status !== 0 || compilation.error) {
        const detail = [compilation.error?.message, compilation.stdout, compilation.stderr].filter(Boolean).join('\n').slice(0, 8_000);
        throw new Error(`TypeScript artifact build failed: ${detail}`);
    }
    const migrationCount = stageMigrationSql(root);
    const render = spawn(process.execPath, ['--import', 'tsx', 'scripts/render-openapi.mjs'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
            PATH: process.env.PATH ?? '',
            NODE_ENV: 'test',
            PORT: '5000',
            MICROSOFT_OIDC_ENABLED: 'false',
            JWT_SECRET: 'artifact-render-jwt-secret-at-least-32-characters',
            JWT_REFRESH_SECRET: 'artifact-render-refresh-secret-at-least-32-characters',
        },
    });
    if (render.status !== 0 || render.error) {
        const detail = [render.error?.message, render.stdout, render.stderr].filter(Boolean).join('\n').slice(0, 8_000);
        throw new Error(`OpenAPI artifact render failed: ${detail}`);
    }
    const artifact = assertCompiledArtifact(root);
    const manifest = writeArtifactManifest(root);
    return { migrationCount, testCount: artifact.tests.length, manifestFileCount: manifest.files.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    try {
        const artifact = buildArtifact();
        process.stdout.write(`Packaged compiled artifact with ${artifact.testCount} integration tests, ${artifact.migrationCount} staged migration SQL files, and ${artifact.manifestFileCount} hashed files.\n`);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
