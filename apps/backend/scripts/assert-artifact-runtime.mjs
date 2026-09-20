#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { validateSourceAbsentRuntime } from './artifact-runtime-control.mjs';

const outcome = validateSourceAbsentRuntime();
assert.ok(outcome.integrationTestCount > 0);
assert.match(outcome.dependencyRoot, /node_modules/);
assert.equal(existsSync(outcome.runtimeRoot), false, 'runtime fixture is removed after the fixed probe');
process.stdout.write('Source-absent rendered Swagger and compiled cleanup probes passed.\n');
