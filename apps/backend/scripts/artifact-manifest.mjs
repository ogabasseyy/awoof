import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export const ARTIFACT_MANIFEST_FILE = 'artifact-manifest.json';
export const DISABLED_FALLBACK_SMOKE = 'testing/postgres/microsoft-fallback-artifact.integration.js';

function assertRegularFile(path, description) {
    if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`${description}: ${path}`);
}

function existsIncludingBrokenLink(path) {
    try {
        lstatSync(path);
        return true;
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
        throw error;
    }
}

function digest(path) {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function codepointCompare(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function isSafeRelativePath(path) {
    return typeof path === 'string'
        && path.length > 0
        && !path.startsWith('/')
        && !path.split('/').includes('..')
        && !path.includes('\\');
}

function listRegularFiles(directory) {
    if (!existsSync(directory)) throw new Error(`Artifact directory is missing: ${directory}`);
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Artifact must not contain symlinks: ${path}`);
        if (entry.isDirectory()) return listRegularFiles(path);
        if (!entry.isFile()) throw new Error(`Artifact must contain regular files only: ${path}`);
        return [path];
    }).sort(codepointCompare);
}

function artifactFiles(artifactRoot) {
    return listRegularFiles(artifactRoot)
        .map((path) => ({ path: relative(artifactRoot, path).split(sep).join('/'), sha256: digest(path) }))
        .filter((entry) => entry.path !== ARTIFACT_MANIFEST_FILE)
        .sort((left, right) => codepointCompare(left.path, right.path));
}

function requiredArtifactFiles(files) {
    const names = new Set(files.map((entry) => entry.path));
    for (const path of ['config/openapi.json', 'database/migrations/run.js', 'scripts/cleanup-microsoft-attempts.js']) {
        if (!names.has(path)) throw new Error(`Compiled artifact is missing required file: dist/${path}`);
    }
}

function manifestForArtifactRoot(artifactRoot) {
    const files = artifactFiles(artifactRoot);
    requiredArtifactFiles(files);
    const migrations = files
        .filter((entry) => entry.path.startsWith('database/migrations/') && entry.path.endsWith('.sql'))
        .map((entry) => ({ filename: entry.path.slice('database/migrations/'.length), sha256: entry.sha256 }));
    if (migrations.length === 0) throw new Error('Compiled artifact has no staged migration SQL files.');
    const integrationTests = files.filter((entry) => entry.path.endsWith('.integration.js')).map((entry) => entry.path);
    if (integrationTests.length === 0) throw new Error('Compiled artifact has no integration tests.');
    return { version: 1, files, migrations, integrationTests, disabledFallbackSmoke: DISABLED_FALLBACK_SMOKE };
}

function stringifyManifest(manifest) {
    return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function writeArtifactManifest(backendRoot) {
    const artifactRoot = join(backendRoot, 'dist');
    const manifest = manifestForArtifactRoot(artifactRoot);
    writeFileSync(join(artifactRoot, ARTIFACT_MANIFEST_FILE), stringifyManifest(manifest), { encoding: 'utf8' });
    return manifest;
}

function assertManifestShape(manifest) {
    assert.deepEqual(Object.keys(manifest).sort(), ['disabledFallbackSmoke', 'files', 'integrationTests', 'migrations', 'version']);
    assert.equal(manifest.version, 1);
    assert.equal(manifest.disabledFallbackSmoke, DISABLED_FALLBACK_SMOKE);
    assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, 'artifact manifest must contain files');
    assert.ok(Array.isArray(manifest.migrations) && manifest.migrations.length > 0, 'artifact manifest must contain migrations');
    assert.ok(Array.isArray(manifest.integrationTests) && manifest.integrationTests.length > 0, 'artifact manifest must contain integration tests');
    const fileNames = manifest.files.map((entry) => entry.path);
    assert.deepEqual(fileNames, [...fileNames].sort(codepointCompare), 'artifact manifest file paths must be sorted');
    assert.equal(new Set(fileNames).size, fileNames.length, 'artifact manifest file paths must be unique');
    for (const entry of manifest.files) {
        assert.ok(isSafeRelativePath(entry.path), `artifact manifest has unsafe file path: ${entry.path}`);
        assert.match(entry.sha256, /^[a-f0-9]{64}$/u, `artifact manifest has invalid digest: ${entry.path}`);
    }
    const migrationNames = manifest.migrations.map((entry) => entry.filename);
    assert.deepEqual(migrationNames, [...migrationNames].sort(codepointCompare), 'artifact manifest migration filenames must be sorted');
    assert.equal(new Set(migrationNames).size, migrationNames.length, 'artifact manifest migration filenames must be unique');
    for (const entry of manifest.migrations) {
        assert.ok(isSafeRelativePath(entry.filename) && entry.filename.endsWith('.sql'), `artifact manifest has invalid migration filename: ${entry.filename}`);
        assert.match(entry.sha256, /^[a-f0-9]{64}$/u, `artifact manifest has invalid migration digest: ${entry.filename}`);
    }
    assert.deepEqual(manifest.integrationTests, [...manifest.integrationTests].sort(codepointCompare), 'artifact manifest integration tests must be sorted');
    assert.equal(new Set(manifest.integrationTests).size, manifest.integrationTests.length, 'artifact manifest integration tests must be unique');
    for (const path of manifest.integrationTests) assert.ok(isSafeRelativePath(path) && path.endsWith('.integration.js'), `artifact manifest has invalid integration path: ${path}`);
}

/** Validates a disposable runtime tree which contains only dist plus fixed harness files. */
export function validateArtifactManifest(runtimeRoot) {
    const root = resolve(runtimeRoot);
    if (existsIncludingBrokenLink(join(root, 'src'))) throw new Error('Source-absent artifact validation refuses a runtime fixture containing src.');
    const artifactRoot = join(root, 'dist');
    if (!existsSync(artifactRoot) || lstatSync(artifactRoot).isSymbolicLink() || !lstatSync(artifactRoot).isDirectory()) {
        throw new Error('Source-absent artifact validation requires a regular dist directory.');
    }
    const manifestPath = join(artifactRoot, ARTIFACT_MANIFEST_FILE);
    assertRegularFile(manifestPath, 'Artifact manifest is missing');
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
    catch { throw new Error('Artifact manifest is not valid JSON.'); }
    assertManifestShape(manifest);
    const actual = manifestForArtifactRoot(artifactRoot);
    assert.deepEqual(manifest, actual, 'artifact manifest must exactly match allowed regular dist files and byte hashes');
    return {
        artifactRoot,
        migrationRunner: join(artifactRoot, 'database/migrations/run.js'),
        tests: manifest.integrationTests.map((path) => join(artifactRoot, path)),
        migrations: manifest.migrations.map((entry) => entry.filename),
    };
}
