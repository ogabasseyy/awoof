import assert from 'node:assert/strict';
import { execPath } from 'node:process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const args = process.argv.slice(2); const operation = args[args.indexOf('-D') + 2] ?? args[0]; appendFileSync(process.env.RECORD, JSON.stringify(args) + '\\n');
if (operation === 'status') { const count = existsSync(process.env.COUNT) ? Number(readFileSync(process.env.COUNT, 'utf8')) : 0; writeFileSync(process.env.COUNT, String(count + 1)); process.exit(Number(process.env.STATUS.split(',')[count] ?? 4)); }
if (operation === 'stop') process.exit(Number(process.env.STOP)); process.exit(0);`);
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
            const stopCall = calls.find((call) => call.args[call.args.indexOf('-D') + 2] === 'stop');
            if (stopCall) assert.equal(stopCall.child.status, Number(stop), `${name} invokes the requested stop exit`);
        }
        assert.ok(readFileSync(record, 'utf8').includes('"status"'));
    } finally {
        rmSync(fixture, { recursive: true, force: true });
    }
});

test('launches failing setup and timed-out startup fixtures before safe cleanup', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'awoof-pg-subprocess-'));
    const script = join(fixture, 'fake-pgctl.mjs');
    const record = join(fixture, 'record.jsonl');
    writeFileSync(script, `import { appendFileSync } from 'node:fs'; const args = process.argv.slice(2); appendFileSync(process.env.RECORD, JSON.stringify(args) + '\\n'); if (args[0] === 'setup-fail') process.exit(2); if (args[0] === 'start-timeout') setTimeout(() => process.exit(0), 10_000); const operation = args[args.indexOf('-D') + 2]; if (operation === 'status') process.exit(0); if (operation === 'stop') process.exit(1); process.exit(0);`);
    const launch = (args, timeout) => spawnSync(execPath, [script, ...args], { env: { ...process.env, RECORD: record }, timeout });
    try {
        const setupScratch = join(fixture, 'setup-failure');
        mkdirSync(setupScratch);
        const setup = launch(['setup-fail'], 1_000);
        assert.equal(setup.status, 2);
        assert.equal(setup.error, undefined);
        assert.equal(existsSync(setupScratch), true);
        const setupCleanup = cleanupOwnedCluster({ scratch: setupScratch, dataDirectory: join(setupScratch, 'data'), pgCtl: undefined, startupAttempted: false, spawn: () => { throw new Error('not called'); }, remove: (path) => rmSync(path, { recursive: true, force: true }), write: () => {} });
        assert.equal(setupCleanup.removed, true);
        assert.equal(existsSync(setupScratch), false);

        const timeoutScratch = join(fixture, 'startup-timeout');
        mkdirSync(timeoutScratch);
        const startup = launch(['start-timeout'], 30);
        assert.ok(startup.error?.code === 'ETIMEDOUT' || startup.signal !== null);
        assert.equal(existsSync(timeoutScratch), true);
        const timeoutCleanup = cleanupOwnedCluster({ scratch: timeoutScratch, dataDirectory: join(timeoutScratch, 'data'), pgCtl: execPath, startupAttempted: true,
            spawn: (binary, args, timeout) => spawnSync(binary, [script, ...args], { env: { ...process.env, RECORD: record }, timeout }),
            remove: (path) => rmSync(path, { recursive: true, force: true }), write: () => {},
        });
        assert.equal(timeoutCleanup.retained, true);
        assert.equal(existsSync(timeoutScratch), true);
        if (typeof startup.pid === 'number') assert.throws(() => process.kill(startup.pid, 0), /ESRCH/);
    } finally {
        rmSync(fixture, { recursive: true, force: true });
    }
});
