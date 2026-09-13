import { join } from 'node:path';
import { ARTIFACT_ROOT_NAME, assertCompiledArtifact, compiledTestSelection, integrationFiles } from './artifact-layout.mjs';
import { validateArtifactManifest } from './artifact-manifest.mjs';

export function selectPostgresTestMode({ backendRoot, environment, nodeExecutable }) {
    const artifactRoot = environment.AWOOF_POSTGRES_ARTIFACT_ROOT;
    if (artifactRoot === undefined) {
        const tests = integrationFiles(join(backendRoot, 'src'), '.integration.ts');
        if (tests.length === 0) throw new Error('No .integration.ts tests were found.');
        return {
            migration: './node_modules/.bin/tsx',
            migrationArgs: ['src/database/migrations/run.ts'],
            runner: './node_modules/.bin/tsx',
            testArgs: ['--test', '--test-concurrency=1', ...tests],
            label: 'source',
        };
    }
    if (artifactRoot !== ARTIFACT_ROOT_NAME) {
        throw new Error(`AWOOF_POSTGRES_ARTIFACT_ROOT only supports ${ARTIFACT_ROOT_NAME}.`);
    }
    const runtimeControl = environment.AWOOF_POSTGRES_ARTIFACT_RUNTIME;
    if (runtimeControl !== undefined && runtimeControl !== '1') {
        throw new Error('AWOOF_POSTGRES_ARTIFACT_RUNTIME only supports the fixed value 1.');
    }
    const artifact = runtimeControl === '1' ? validateArtifactManifest(backendRoot) : assertCompiledArtifact(backendRoot);
    const tests = compiledTestSelection(artifact, environment.AWOOF_POSTGRES_TEST_FILES);
    return {
        migration: nodeExecutable,
        migrationArgs: [artifact.migrationRunner],
        runner: nodeExecutable,
        testArgs: ['--test', '--test-concurrency=1', ...tests],
        label: 'compiled',
    };
}
