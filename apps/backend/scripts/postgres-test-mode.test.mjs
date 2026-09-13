import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stageMigrationSql } from './artifact-layout.mjs';
import { selectPostgresTestMode } from './postgres-test-mode.mjs';

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'awoof-postgres-mode-'));
    mkdirSync(join(root, 'src/database/migrations'), { recursive: true });
    mkdirSync(join(root, 'src/testing/postgres'), { recursive: true });
    mkdirSync(join(root, 'dist/database/migrations'), { recursive: true });
    mkdirSync(join(root, 'dist/testing/postgres'), { recursive: true });
    writeFileSync(join(root, 'src/database/migrations/001_initial.sql'), 'select 1;\n');
    writeFileSync(join(root, 'src/testing/postgres/fallback.integration.ts'), 'export {};\n');
    writeFileSync(join(root, 'dist/database/migrations/run.js'), 'export {};\n');
    writeFileSync(join(root, 'dist/testing/postgres/fallback.integration.js'), 'export {};\n');
    return root;
}

test('keeps ordinary PostgreSQL tests on the existing TSX source paths', () => {
    const root = fixture();
    try {
        const mode = selectPostgresTestMode({ backendRoot: root, environment: {}, nodeExecutable: 'node-for-test' });
        assert.equal(mode.label, 'source');
        assert.equal(mode.migration, './node_modules/.bin/tsx');
        assert.deepEqual(mode.migrationArgs, ['src/database/migrations/run.ts']);
        assert.equal(mode.runner, './node_modules/.bin/tsx');
        assert.match(mode.testArgs.at(-1), /src\/testing\/postgres\/fallback\.integration\.ts$/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('compiled PostgreSQL tests run only compiled migration and JavaScript paths', () => {
    const root = fixture();
    try {
        stageMigrationSql(root);
        const mode = selectPostgresTestMode({
            backendRoot: root,
            environment: { AWOOF_POSTGRES_ARTIFACT_ROOT: 'dist' },
            nodeExecutable: 'node-for-test',
        });
        assert.equal(mode.label, 'compiled');
        assert.equal(mode.migration, 'node-for-test');
        assert.match(mode.migrationArgs[0], /dist\/database\/migrations\/run\.js$/);
        assert.equal(mode.runner, 'node-for-test');
        assert.match(mode.testArgs.at(-1), /dist\/testing\/postgres\/fallback\.integration\.js$/);
        assert.throws(
            () => selectPostgresTestMode({ backendRoot: root, environment: { AWOOF_POSTGRES_ARTIFACT_ROOT: '../src' }, nodeExecutable: 'node-for-test' }),
            /only supports dist/,
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
