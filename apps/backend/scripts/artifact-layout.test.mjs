import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ARTIFACT_ROOT_NAME, DISABLED_FALLBACK_SMOKE, assertCompiledArtifact, compiledTestSelection, stageMigrationSql, stageProgrammeReferenceJson } from './artifact-layout.mjs';
import { validateArtifactManifest, writeArtifactManifest } from './artifact-manifest.mjs';
import { buildReference } from './build-academic-programme-reference.mjs';

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'awoof-artifact-layout-'));
    const sourceMigrations = join(root, 'src/database/migrations');
    const sourceTests = join(root, 'src/testing/postgres');
    const artifactMigrations = join(root, ARTIFACT_ROOT_NAME, 'database/migrations');
    const artifactTests = join(root, ARTIFACT_ROOT_NAME, 'testing/postgres');
    const sourceReference = join(root, 'src/data/academic-programmes');
    const artifactReference = join(root, ARTIFACT_ROOT_NAME, 'data/academic-programmes');
    mkdirSync(sourceMigrations, { recursive: true });
    mkdirSync(sourceTests, { recursive: true });
    mkdirSync(artifactMigrations, { recursive: true });
    mkdirSync(artifactTests, { recursive: true });
    mkdirSync(sourceReference, { recursive: true });
    mkdirSync(artifactReference, { recursive: true });
    mkdirSync(join(root, ARTIFACT_ROOT_NAME, 'config'), { recursive: true });
    mkdirSync(join(root, ARTIFACT_ROOT_NAME, 'scripts'), { recursive: true });
    writeFileSync(join(sourceMigrations, '001_initial.sql'), 'select 1;\n');
    writeFileSync(join(sourceMigrations, '002_authority.sql'), 'select 2;\n');
    writeFileSync(join(sourceTests, 'fallback.integration.ts'), 'export {};\n');
    writeFileSync(join(sourceTests, 'microsoft-fallback-artifact.integration.ts'), 'export {};\n');
    writeFileSync(join(artifactMigrations, 'run.js'), 'export {};\n');
    writeFileSync(join(artifactTests, 'fallback.integration.js'), 'export {};\n');
    writeFileSync(join(root, ARTIFACT_ROOT_NAME, DISABLED_FALLBACK_SMOKE), 'export {};\n');
    writeFileSync(join(root, ARTIFACT_ROOT_NAME, 'config/openapi.json'), '{"paths":{"/api/auth/login":{}}}\n');
    writeFileSync(join(root, ARTIFACT_ROOT_NAME, 'scripts/cleanup-microsoft-attempts.js'), 'export {};\n');
    writeFileSync(join(root, ARTIFACT_ROOT_NAME, 'scripts/cleanup-student-sso.js'), 'export {};\n');
    writeFileSync(join(root, ARTIFACT_ROOT_NAME, 'scripts/cleanup-academic-profile-data.js'), 'export {};\n');
    const fixtureChecksum = 'a'.repeat(64);
    const fixtureReference = buildReference({
        extract: { sourceVersion: 'fixture-v1', sourceChecksumSha256: fixtureChecksum, rows: [] },
        expectedChecksum: fixtureChecksum,
        redistribution: 'blocked',
    });
    writeFileSync(join(sourceReference, 'nuc-v2.normalized.json'), `${JSON.stringify(fixtureReference, null, 2)}\n`);
    return root;
}

test('stages exactly the source migration names and bytes, replacing stale SQL only', () => {
    const root = fixture();
    try {
        const artifactMigrations = join(root, ARTIFACT_ROOT_NAME, 'database/migrations');
        writeFileSync(join(artifactMigrations, '001_initial.sql'), 'stale');
        writeFileSync(join(artifactMigrations, '999_stale.sql'), 'stale');
        stageMigrationSql(root);
        assert.deepEqual(
            ['001_initial.sql', '002_authority.sql'],
            ['001_initial.sql', '002_authority.sql'].filter((name) => existsSync(join(artifactMigrations, name))),
        );
        assert.equal(existsSync(join(artifactMigrations, '999_stale.sql')), false);
        assert.deepEqual(readFileSync(join(artifactMigrations, '001_initial.sql')), Buffer.from('select 1;\n'));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('stages exactly the source programme reference bytes, replacing stale JSON only', () => {
    const root = fixture();
    try {
        const artifactReference = join(root, ARTIFACT_ROOT_NAME, 'data/academic-programmes');
        writeFileSync(join(artifactReference, 'nuc-v2.normalized.json'), 'stale');
        writeFileSync(join(artifactReference, '999_stale.json'), 'stale');
        assert.equal(stageProgrammeReferenceJson(root), 1);
        assert.equal(existsSync(join(artifactReference, '999_stale.json')), false);
        assert.deepEqual(
            readFileSync(join(artifactReference, 'nuc-v2.normalized.json')),
            readFileSync(join(root, 'src/data/academic-programmes/nuc-v2.normalized.json')),
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('staging rejects a reference that bypasses the deterministic importer', () => {
    const root = fixture();
    try {
        const source = join(root, 'src/data/academic-programmes/nuc-v2.normalized.json');
        const parsed = JSON.parse(readFileSync(source, 'utf8'));
        parsed.calculationsEnabled = true;
        writeFileSync(source, JSON.stringify(parsed));
        assert.throws(() => stageProgrammeReferenceJson(root), /programme reference/);
        assert.equal(existsSync(join(root, ARTIFACT_ROOT_NAME, 'data/academic-programmes/nuc-v2.normalized.json')), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('runtime manifest rejects source presence, extra files, tampered bytes, and symlinks', () => {
    const root = fixture();
    try {
        stageMigrationSql(root);
        stageProgrammeReferenceJson(root);
        writeFileSync(join(root, ARTIFACT_ROOT_NAME, DISABLED_FALLBACK_SMOKE), 'export {};\n');
        writeArtifactManifest(root);
        assert.throws(() => validateArtifactManifest(root), /containing src/);
        rmSync(join(root, 'src'), { recursive: true, force: true });
        assert.equal(validateArtifactManifest(root).tests.length, 2);
        writeFileSync(join(root, ARTIFACT_ROOT_NAME, 'extra.js'), 'export {};\n');
        assert.throws(() => validateArtifactManifest(root), /exactly match/);
        rmSync(join(root, ARTIFACT_ROOT_NAME, 'extra.js'));
        writeFileSync(join(root, ARTIFACT_ROOT_NAME, 'config/openapi.json'), '{}\n');
        assert.throws(() => validateArtifactManifest(root), /exactly match/);
        writeArtifactManifest(root);
        symlinkSync(join(root, ARTIFACT_ROOT_NAME, 'config/openapi.json'), join(root, ARTIFACT_ROOT_NAME, 'openapi-link.json'));
        assert.throws(() => validateArtifactManifest(root), /must not contain symlinks/);
        rmSync(join(root, ARTIFACT_ROOT_NAME, 'openapi-link.json'));
        renameSync(join(root, ARTIFACT_ROOT_NAME), join(root, 'real-dist'));
        symlinkSync(join(root, 'real-dist'), join(root, ARTIFACT_ROOT_NAME), 'dir');
        assert.throws(() => validateArtifactManifest(root), /regular dist directory/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('compiled artifact rejects missing or stale integration outputs before a database starts', () => {
    const root = fixture();
    try {
        stageMigrationSql(root);
        stageProgrammeReferenceJson(root);
        assert.equal(assertCompiledArtifact(root).tests.length, 2);
        writeFileSync(join(root, ARTIFACT_ROOT_NAME, 'testing/postgres/stale.integration.js'), 'export {};\n');
        assert.throws(() => assertCompiledArtifact(root), /compiled integration tests must exactly match/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('compiled fallback selector is constrained to the dedicated smoke and cannot pass empty', () => {
    const root = fixture();
    try {
        stageMigrationSql(root);
        stageProgrammeReferenceJson(root);
        const artifact = assertCompiledArtifact(root);
        assert.deepEqual(
            compiledTestSelection(artifact, DISABLED_FALLBACK_SMOKE),
            [join(root, ARTIFACT_ROOT_NAME, DISABLED_FALLBACK_SMOKE)],
        );
        rmSync(join(root, ARTIFACT_ROOT_NAME, DISABLED_FALLBACK_SMOKE));
        assert.throws(() => compiledTestSelection(artifact, DISABLED_FALLBACK_SMOKE), /not present/);
        assert.throws(() => compiledTestSelection(artifact, 'testing/postgres/anything.integration.js'), /only supports/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
