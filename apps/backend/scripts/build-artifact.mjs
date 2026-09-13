#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { assertCompiledArtifact, stageMigrationSql } from './artifact-layout.mjs';

const backendRoot = resolve(import.meta.dirname, '..');

export function buildArtifact({ root = backendRoot, spawn = spawnSync } = {}) {
    const compilation = spawn('./node_modules/.bin/tsc', [], { cwd: root, encoding: 'utf8', timeout: 120_000 });
    if (compilation.status !== 0 || compilation.error) {
        const detail = [compilation.error?.message, compilation.stdout, compilation.stderr].filter(Boolean).join('\n').slice(0, 8_000);
        throw new Error(`TypeScript artifact build failed: ${detail}`);
    }
    const migrationCount = stageMigrationSql(root);
    const artifact = assertCompiledArtifact(root);
    return { migrationCount, testCount: artifact.tests.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    try {
        const artifact = buildArtifact();
        process.stdout.write(`Packaged compiled artifact with ${artifact.testCount} integration tests and ${artifact.migrationCount} staged migration SQL files.\n`);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
