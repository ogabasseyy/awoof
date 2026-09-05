import assert from 'node:assert/strict';
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
