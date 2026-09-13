import assert from 'node:assert/strict';
import test from 'node:test';
import { artifactRuntimeEnvironment } from './artifact-runtime-control.mjs';

test('source-absent runtime control keeps only the fixed safe locale and environment allowlist', () => {
    const canary = 'ARTIFACT_RUNTIME_PARENT_ENV_CANARY';
    const previous = {
        canary: process.env[canary],
        nodeOptions: process.env.NODE_OPTIONS,
        databaseUrl: process.env.DATABASE_URL,
    };
    process.env[canary] = 'must-not-be-inherited';
    process.env.NODE_OPTIONS = '--import=parent-controlled-preload';
    process.env.DATABASE_URL = 'postgresql://parent-controlled-secret@127.0.0.1:1/awoof';
    try {
        const environment = artifactRuntimeEnvironment({ PORT: '5454' });
        assert.equal(environment.LANG, 'C.UTF-8');
        assert.equal(environment.LC_ALL, 'C.UTF-8');
        assert.equal(environment.NODE_ENV, 'test');
        assert.equal(environment[canary], undefined);
        assert.equal(environment.NODE_OPTIONS, undefined);
        assert.equal(environment.DATABASE_URL, undefined);
    } finally {
        if (previous.canary === undefined) delete process.env[canary]; else process.env[canary] = previous.canary;
        if (previous.nodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous.nodeOptions;
        if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.databaseUrl;
    }
});
