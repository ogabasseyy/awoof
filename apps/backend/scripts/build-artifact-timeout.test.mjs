import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArtifact } from './build-artifact.mjs';

test('artifact compilation permits slow production builds while retaining a deadline', () => {
    const root = mkdtempSync(join(tmpdir(), 'awoof-compiler-timeout-'));
    try {
        let options;
        assert.throws(() => buildArtifact({ root, spawn: (_cmd, _args, opts) => { options = opts; return { status: 1, stderr: 'synthetic compiler failure' }; } }), /synthetic compiler failure/);
        assert.ok(options.timeout >= 600_000 && options.timeout <= 900_000);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
