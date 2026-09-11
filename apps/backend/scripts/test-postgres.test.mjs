import assert from 'node:assert/strict';
import { execPath } from 'node:process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { cleanupOwnedCluster } from './test-postgres-lifecycle.mjs';

function operationFor(args) {
    const dataFlag = args.indexOf('-D');
    return dataFlag === -1 ? undefined : args[dataFlag + 2];
}

function assertChildExited(child, description) {
    assert.equal(typeof child.pid, 'number', `${description} records a child PID`);
    assert.throws(
        () => process.kill(child.pid, 0),
        (error) => error?.code === 'ESRCH',
        `${description} child has exited`,
    );
}

function assertChildrenExited(calls, description) {
    for (const [index, call] of calls.entries()) assertChildExited(call.child, `${description} child ${index + 1}`);
}

function assertOwnedLifecycleCalls(calls, dataDirectory, stopStatus, description) {
    assert.equal(calls.length, 3, `${description} performs initial status, stop, and confirmation status`);
    for (const call of calls) {
        const dataFlag = call.args.indexOf('-D');
        assert.notEqual(dataFlag, -1, `${description} child receives -D`);
        assert.equal(call.args[dataFlag + 1], dataDirectory, `${description} child targets the exact owned data directory`);
        assert.ok(['status', 'stop'].includes(operationFor(call.args)), `${description} uses only status or stop children`);
        assert.ok(call.timeout > 0, `${description} child has a bounded timeout`);
    }
    const stopCall = calls.find((call) => operationFor(call.args) === 'stop');
    assert.ok(stopCall, `${description} invokes an owned stop child`);
    assert.equal(stopCall.child.status, stopStatus, `${description} stop child returns its requested status`);
}

function createCleanupFixture() {
    const fixture = mkdtempSync(join(tmpdir(), 'awoof-pg-lifecycle-'));
    const script = join(fixture, 'fake-pgctl.mjs');
    const record = join(fixture, 'record.jsonl');
    writeFileSync(script, `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const operation = args[args.indexOf('-D') + 2];
appendFileSync(process.env.RECORD, JSON.stringify(args) + '\\n');
if (operation === 'status') {
  const count = existsSync(process.env.COUNT) ? Number(readFileSync(process.env.COUNT, 'utf8')) : 0;
  writeFileSync(process.env.COUNT, String(count + 1));
  process.exit(Number(process.env.STATUS.split(',')[count] ?? 4));
}
if (operation === 'stop') process.exit(Number(process.env.STOP));
process.exit(9);`);
    return { fixture, script, record };
}

function exerciseCleanupScenario({ name, status, stop, expectedRemoved }) {
    const { fixture, script, record } = createCleanupFixture();
    try {
        const scratch = join(fixture, name.replaceAll(' ', '-'));
        const dataDirectory = join(scratch, 'data');
        const count = join(scratch, 'status-count');
        mkdirSync(dataDirectory, { recursive: true });
        assert.equal(existsSync(scratch), true, `${name} owns a scratch directory before cleanup`);
        assert.equal(existsSync(dataDirectory), true, `${name} owns a data directory before cleanup`);
        const calls = [];
        const result = cleanupOwnedCluster({
            scratch,
            dataDirectory,
            pgCtl: execPath,
            startupAttempted: true,
            spawn: (binary, args, timeout) => {
                const child = spawnSync(binary, [script, ...args], {
                    env: { ...process.env, RECORD: record, COUNT: count, STATUS: status, STOP: String(stop) },
                    timeout,
                });
                calls.push({ args, timeout, child });
                return child;
            },
            remove: (path) => {
                assert.equal(path, scratch, `${name} removes only its exact scratch directory`);
                assertChildrenExited(calls, `${name} before scratch deletion`);
                rmSync(path, { recursive: true, force: true });
            },
            write: () => {},
        });

        assert.equal(result.removed, expectedRemoved, name);
        assert.equal(result.retained, !expectedRemoved, name);
        assertOwnedLifecycleCalls(calls, dataDirectory, stop, name);
        assertChildrenExited(calls, `${name} after cleanup`);
        assert.equal(existsSync(scratch), !expectedRemoved, `${name} ${expectedRemoved ? 'removes' : 'retains'} its owned scratch directory`);
        assert.equal(existsSync(dataDirectory), !expectedRemoved, `${name} ${expectedRemoved ? 'removes' : 'retains'} its owned data directory`);
        assert.equal(readFileSync(record, 'utf8').trim().split('\n').length, 3, `${name} launched three real lifecycle children`);
    } finally {
        rmSync(fixture, { recursive: true, force: true });
    }
}

test('retains actual owned scratch when the real stop child exits nonzero', () => {
    exerciseCleanupScenario({ name: 'startup survivor stop failure', status: '0,0', stop: 1, expectedRemoved: false });
});

test('removes actual owned scratch only after a clean exact-status-3 confirmation', () => {
    exerciseCleanupScenario({ name: 'confirmed stop', status: '0,3', stop: 0, expectedRemoved: true });
});

test('retains actual owned scratch when the real post-stop status is uncertain', () => {
    exerciseCleanupScenario({ name: 'unknown post-stop', status: '0,4', stop: 0, expectedRemoved: false });
});

test('removes setup-failure scratch and retains timed-start scratch after a proved timeout', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'awoof-pg-subprocess-'));
    const script = join(fixture, 'fake-pgctl.mjs');
    const record = join(fixture, 'record.jsonl');
    let fixtureCanBeRemoved = false;
    writeFileSync(script, `import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.RECORD, JSON.stringify(args) + '\\n');
if (args[0] === 'setup-fail') process.exit(2);
if (args[0] === 'start-timeout') {
  writeFileSync(process.env.STARTUP_MARKER, 'entered');
  setTimeout(() => process.exit(0), 10_000);
} else {
  const operation = args[args.indexOf('-D') + 2];
  if (operation === 'status') process.exit(0);
  if (operation === 'stop') process.exit(1);
  process.exit(9);
}`);
    const launch = (args, timeout, env = {}) => spawnSync(execPath, [script, ...args], {
        env: { ...process.env, RECORD: record, ...env },
        timeout,
    });
    try {
        const setupScratch = join(fixture, 'setup-failure');
        mkdirSync(join(setupScratch, 'data'), { recursive: true });
        const setup = launch(['setup-fail'], 1_000);
        assert.equal(setup.status, 2);
        assert.equal(setup.error, undefined);
        assertChildExited(setup, 'setup failure');
        assert.equal(existsSync(setupScratch), true, 'setup-failure scratch exists before cleanup');
        const setupCleanup = cleanupOwnedCluster({
            scratch: setupScratch,
            dataDirectory: join(setupScratch, 'data'),
            pgCtl: undefined,
            startupAttempted: false,
            spawn: () => { throw new Error('setup cleanup must not spawn a child'); },
            remove: (path) => rmSync(path, { recursive: true, force: true }),
            write: () => {},
        });
        assert.deepEqual(setupCleanup, { removed: true, retained: false });
        assert.equal(existsSync(setupScratch), false, 'setup-failure scratch is actually removed');

        const timeoutScratch = join(fixture, 'startup-timeout');
        const timeoutDataDirectory = join(timeoutScratch, 'data');
        const startupMarker = join(timeoutScratch, 'startup-entered');
        mkdirSync(timeoutDataDirectory, { recursive: true });
        const startup = launch(['start-timeout'], 1_000, { STARTUP_MARKER: startupMarker });
        assert.equal(startup.error?.code, 'ETIMEDOUT');
        assert.equal(readFileSync(startupMarker, 'utf8'), 'entered', 'the exclusive timed-start branch executed before timeout');
        assertChildExited(startup, 'timed startup');
        assert.equal(existsSync(timeoutScratch), true, 'timed-start scratch exists before cleanup');

        const calls = [];
        const timeoutCleanup = cleanupOwnedCluster({
            scratch: timeoutScratch,
            dataDirectory: timeoutDataDirectory,
            pgCtl: execPath,
            startupAttempted: true,
            spawn: (binary, args, timeout) => {
                const child = launch(args, timeout);
                calls.push({ args, timeout, child });
                return child;
            },
            remove: () => { throw new Error('failed stop must retain timed-start scratch'); },
            write: () => {},
        });
        assert.deepEqual(timeoutCleanup, { removed: false, retained: true });
        assertOwnedLifecycleCalls(calls, timeoutDataDirectory, 1, 'timed-start cleanup');
        assertChildrenExited(calls, 'timed-start cleanup');
        assert.equal(existsSync(timeoutScratch), true, 'failed timed-start cleanup retains scratch');
        assert.equal(existsSync(timeoutDataDirectory), true, 'failed timed-start cleanup retains data directory');
        fixtureCanBeRemoved = true;
    } finally {
        if (fixtureCanBeRemoved) rmSync(fixture, { recursive: true, force: true });
    }
});
