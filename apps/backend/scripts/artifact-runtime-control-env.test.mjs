import assert from 'node:assert/strict';
import test from 'node:test';
import { artifactRuntimeEnvironment, boundedProbeDetail } from './artifact-runtime-control.mjs';

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

test('bounded source-absent probe diagnostics retain metadata, startup, and terminal failures', () => {
    const detail = boundedProbeDetail({
        status: 1,
        signal: null,
        error: new Error('synthetic child failure'),
        stdout: `Applied migration filenames: ["001_initial.sql"]\n${'x'.repeat(2_000)}\nnot ok 18 - final compiled integration failure\n# tests 18\n# fail 1\n`,
        stderr: `${'y'.repeat(2_000)}\nIntegration tests failed: non-zero exit\n`,
    }, 512);
    assert.ok(detail.length <= 512);
    assert.match(detail, /exit=1 signal=none error=synthetic child failure/);
    assert.match(detail, /Applied migration filenames/);
    assert.match(detail, /probe output truncated/);
    assert.match(detail, /Integration tests failed: non-zero exit/);
    assert.match(detail, /# fail 1/);
});
