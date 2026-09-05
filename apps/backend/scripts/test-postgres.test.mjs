import assert from 'node:assert/strict';
import { execPath } from 'node:process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { cleanupOwnedCluster } from './test-postgres-lifecycle.mjs';

test('removes early setup scratch when no startup was attempted', () => {
    const removed = [];
    const result = cleanupOwnedCluster({ scratch: '/tmp/owned', dataDirectory: '/tmp/owned/data', pgCtl: undefined, startupAttempted: false, spawn: () => { throw new Error('not called'); }, remove: (path) => removed.push(path), write: () => {} });
    assert.deepEqual(result, { removed: true, retained: false });
    assert.deepEqual(removed, ['/tmp/owned']);
});

test('retains scratch when a startup-timeout survivor cannot be stopped', () => {
    const removed = [];
    const messages = [];
    const replies = [{ status: 0 }, { status: 1 }, { status: 0 }];
    const result = cleanupOwnedCluster({ scratch: '/tmp/owned', dataDirectory: '/tmp/owned/data', pgCtl: 'pg_ctl', startupAttempted: true, spawn: () => replies.shift(), remove: (path) => removed.push(path), write: (message) => messages.push(message) });
    assert.deepEqual(result, { removed: false, retained: true });
    assert.deepEqual(removed, []);
    assert.match(messages[0], /retaining exact scratch directory/);
});

test('removes scratch only after pg_ctl confirms the owned cluster stopped', () => {
    const removed = [];
    const replies = [{ status: 0 }, { status: 0 }, { status: 3 }];
    const result = cleanupOwnedCluster({ scratch: '/tmp/owned', dataDirectory: '/tmp/owned/data', pgCtl: 'pg_ctl', startupAttempted: true, spawn: () => replies.shift(), remove: (path) => removed.push(path), write: () => {} });
    assert.deepEqual(result, { removed: true, retained: false });
    assert.deepEqual(removed, ['/tmp/owned']);
});

test('retains scratch for every uncertain post-stop result', () => {
    for (const confirmation of [{ status: 4 }, { status: null }, { status: null, signal: 'SIGTERM' }, { error: new Error('probe failed') }]) {
        const removed = [];
        const replies = [{ status: 0 }, { status: 0 }, confirmation];
        const result = cleanupOwnedCluster({ scratch: '/tmp/owned', dataDirectory: '/tmp/owned/data', pgCtl: 'pg_ctl', startupAttempted: true, spawn: () => replies.shift(), remove: (path) => removed.push(path), write: () => {} });
        assert.deepEqual(result, { removed: false, retained: true });
        assert.deepEqual(removed, []);
    }
});

test('uses actual disposable subprocess fixtures for cleanup outcomes', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'awoof-pg-lifecycle-'));
    const script = join(fixture, 'fake-pgctl.mjs');
    const record = join(fixture, 'record.jsonl');
    writeFileSync(script, `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2); appendFileSync(process.env.RECORD, JSON.stringify(args) + '\\n');
if (args.at(-1) === 'status') { const count = existsSync(process.env.COUNT) ? Number(readFileSync(process.env.COUNT, 'utf8')) : 0; writeFileSync(process.env.COUNT, String(count + 1)); process.exit(Number(process.env.STATUS.split(',')[count] ?? 4)); }
if (args.at(-1) === 'stop') process.exit(Number(process.env.STOP)); process.exit(0);`);
    try {
        for (const [name, status, stop, expectedRemoved] of [
            ['startup survivor stop failure', '0,0', '1', false],
            ['confirmed stop', '0,3', '0', true],
            ['unknown post-stop', '0,4', '0', false],
        ]) {
            const scratch = join(fixture, name.replaceAll(' ', '-'));
            mkdirSync(scratch);
            const count = join(scratch, 'count');
            const calls = [];
            const result = cleanupOwnedCluster({ scratch, dataDirectory: join(scratch, 'data'), pgCtl: execPath, startupAttempted: true,
                spawn: (binary, args, timeout) => { const child = spawnSync(binary, [script, ...args], { env: { ...process.env, RECORD: record, COUNT: count, STATUS: status, STOP: stop }, timeout }); calls.push({ args, timeout, child }); return child; },
                remove: (path) => rmSync(path, { recursive: true, force: true }), write: () => {},
            });
            assert.equal(result.removed, expectedRemoved, name);
            assert.ok(calls.every((call) => call.args.includes('-D') && call.args[call.args.indexOf('-D') + 1] === join(scratch, 'data')), name);
            assert.ok(calls.every((call) => call.timeout > 0), name);
        }
        assert.ok(readFileSync(record, 'utf8').includes('"status"'));
    } finally {
        rmSync(fixture, { recursive: true, force: true });
    }
});
