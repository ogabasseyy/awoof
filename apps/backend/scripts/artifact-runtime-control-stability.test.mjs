import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { artifactManifestDigest, assertRuntimeArtifactStable } from './artifact-runtime-control.mjs';
import { validateArtifactManifest, writeArtifactManifest } from './artifact-manifest.mjs';

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'awoof-runtime-stability-'));
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'database/migrations'), { recursive: true });
    mkdirSync(join(dist, 'testing/postgres'), { recursive: true });
    mkdirSync(join(dist, 'config'), { recursive: true });
    mkdirSync(join(dist, 'scripts'), { recursive: true });
    writeFileSync(join(dist, 'database/migrations/001_initial.sql'), 'select 1;\n');
    writeFileSync(join(dist, 'database/migrations/run.js'), 'export {};\n');
    writeFileSync(join(dist, 'testing/postgres/example.integration.js'), 'export {};\n');
    writeFileSync(join(dist, 'config/openapi.json'), '{"paths":{"/api/auth/login":{}}}\n');
    writeFileSync(join(dist, 'scripts/cleanup-microsoft-attempts.js'), 'export {};\n');
    writeArtifactManifest(root);
    return root;
}

test('runtime stability rejects direct file changes, manifest-only changes, and coordinated rewrites', () => {
    const roots = [fixture(), fixture(), fixture()];
    try {
        const directDigest = artifactManifestDigest(roots[0]);
        writeFileSync(join(roots[0], 'dist/config/openapi.json'), '{"paths":{}}\n');
        assert.throws(() => assertRuntimeArtifactStable(roots[0], directDigest), /exactly match/);

        const manifestDigest = artifactManifestDigest(roots[1]);
        const manifestPath = join(roots[1], 'dist/artifact-manifest.json');
        writeFileSync(manifestPath, `${readFileSync(manifestPath, 'utf8')}\n`);
        assert.throws(() => assertRuntimeArtifactStable(roots[1], manifestDigest), /manifest bytes changed/);

        const coordinatedDigest = artifactManifestDigest(roots[2]);
        writeFileSync(join(roots[2], 'dist/config/openapi.json'), '{"paths":{"/api/changed":{}}}\n');
        writeArtifactManifest(roots[2]);
        assert.doesNotThrow(() => validateArtifactManifest(roots[2]));
        assert.throws(() => assertRuntimeArtifactStable(roots[2], coordinatedDigest), /manifest bytes changed/);
    } finally {
        for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
});
