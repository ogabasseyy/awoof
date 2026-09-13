import assert from 'node:assert/strict';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

export const ARTIFACT_ROOT_NAME = 'dist';
export const DISABLED_FALLBACK_SMOKE = 'testing/postgres/microsoft-fallback-artifact.integration.js';

function listFiles(directory, predicate) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return listFiles(path, predicate);
        return predicate(entry.name) ? [path] : [];
    }).sort();
}

function requireRegularFile(path, message) {
    if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(message);
}

export function migrationFiles(directory) {
    if (!existsSync(directory)) throw new Error(`Migration directory is missing: ${directory}`);
    return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
        .map((entry) => join(directory, entry.name))
        .sort();
}

export function integrationFiles(directory, extension) {
    if (!existsSync(directory)) throw new Error(`Integration-test directory is missing: ${directory}`);
    return listFiles(directory, (name) => name.endsWith(extension));
}

export function stageMigrationSql(backendRoot) {
    const sourceDirectory = join(backendRoot, 'src/database/migrations');
    const artifactDirectory = join(backendRoot, ARTIFACT_ROOT_NAME, 'database/migrations');
    const sourceFiles = migrationFiles(sourceDirectory);
    if (sourceFiles.length === 0) throw new Error('No source migration SQL files were found.');

    mkdirSync(artifactDirectory, { recursive: true });
    for (const entry of readdirSync(artifactDirectory, { withFileTypes: true })) {
        if (entry.name.endsWith('.sql')) rmSync(join(artifactDirectory, entry.name), { recursive: true, force: true });
    }
    for (const sourceFile of sourceFiles) copyFileSync(sourceFile, join(artifactDirectory, basename(sourceFile)));
    assertExactMigrationSql(backendRoot);
    return sourceFiles.length;
}

export function assertExactMigrationSql(backendRoot) {
    const sourceDirectory = join(backendRoot, 'src/database/migrations');
    const artifactDirectory = join(backendRoot, ARTIFACT_ROOT_NAME, 'database/migrations');
    const sourceFiles = migrationFiles(sourceDirectory);
    const artifactFiles = migrationFiles(artifactDirectory);
    const sourceNames = sourceFiles.map((path) => basename(path));
    const artifactNames = artifactFiles.map((path) => basename(path));
    assert.deepEqual(artifactNames, sourceNames, 'staged migration SQL filenames must exactly match source migrations');
    for (const name of sourceNames) {
        const sourceFile = join(sourceDirectory, name);
        const artifactFile = join(artifactDirectory, name);
        requireRegularFile(artifactFile, `Staged migration SQL is missing: ${name}`);
        assert.deepEqual(readFileSync(artifactFile), readFileSync(sourceFile), `staged migration SQL differs from source: ${name}`);
    }
}

export function assertCompiledArtifact(backendRoot) {
    const artifactRoot = join(backendRoot, ARTIFACT_ROOT_NAME);
    const migrationRunner = join(artifactRoot, 'database/migrations/run.js');
    requireRegularFile(migrationRunner, 'Compiled migration runner is missing: dist/database/migrations/run.js. Run npm run build:artifact first.');
    assertExactMigrationSql(backendRoot);

    const sourceRoot = join(backendRoot, 'src');
    const expectedTests = integrationFiles(sourceRoot, '.integration.ts')
        .map((path) => relative(sourceRoot, path).replace(/\.ts$/, '.js'));
    const compiledTests = integrationFiles(artifactRoot, '.integration.js')
        .map((path) => relative(artifactRoot, path));
    assert.deepEqual(compiledTests, expectedTests, 'compiled integration tests must exactly match source integration tests');
    if (compiledTests.length === 0) throw new Error('No compiled .integration.js tests were found. Run npm run build:artifact first.');

    return {
        artifactRoot,
        migrationRunner,
        tests: compiledTests.map((path) => resolve(artifactRoot, path)),
    };
}

export function compiledTestSelection(artifact, requestedFile) {
    if (requestedFile === undefined) return artifact.tests;
    if (requestedFile !== DISABLED_FALLBACK_SMOKE) {
        throw new Error(`AWOOF_POSTGRES_TEST_FILES only supports ${DISABLED_FALLBACK_SMOKE}.`);
    }
    const selected = resolve(artifact.artifactRoot, requestedFile);
    if (!artifact.tests.includes(selected)) {
        throw new Error(`Dedicated compiled fallback smoke is not present: ${DISABLED_FALLBACK_SMOKE}.`);
    }
    return [selected];
}
