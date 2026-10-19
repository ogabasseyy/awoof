import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    appendDurableLedgerEntry,
    assertDurableLedgerAvailableForStartup,
    readDurableLedgerEntries,
    republishMissingDurableLedgerEntries,
    type AcademicProfileLedgerEntry,
} from './academic-profile-ledger.service.js';

test('durable ledger appends entries and reads back valid JSONL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-test-'));
    const ledgerFile = join(dir, 'test-ledger.jsonl');
    try {
        const entry1: AcademicProfileLedgerEntry = {
            userId: '11111111-1111-4111-8111-111111111111',
            generationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            scope: 'profile_only',
            erasedAt: '2026-10-18T12:00:00.000Z',
        };
        const entry2: AcademicProfileLedgerEntry = {
            userId: '22222222-2222-4222-8222-222222222222',
            generationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            scope: 'account_closure',
            erasedAt: '2026-10-18T13:00:00.000Z',
        };

        appendDurableLedgerEntry(entry1, ledgerFile);
        appendDurableLedgerEntry(entry2, ledgerFile);

        const loaded = readDurableLedgerEntries(ledgerFile);
        assert.equal(loaded.length, 2);
        assert.deepEqual(loaded[0], entry1);
        assert.deepEqual(loaded[1], entry2);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('republish appends committed database erasures missing from the host file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-republish-'));
    const ledgerFile = join(dir, 'test-ledger.jsonl');
    try {
        const present: AcademicProfileLedgerEntry = {
            userId: '11111111-1111-4111-8111-111111111111',
            generationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            scope: 'profile_only',
            erasedAt: '2026-10-18T12:00:00.000Z',
        };
        const missing: AcademicProfileLedgerEntry = {
            userId: '22222222-2222-4222-8222-222222222222',
            generationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            scope: 'account_closure',
            erasedAt: '2026-10-18T13:00:00.000Z',
        };
        appendDurableLedgerEntry(present, ledgerFile);
        const client = {
            query: async () => ({
                rows: [present, missing].map((e) => ({
                    user_id: e.userId,
                    generation_id: e.generationId,
                    scope: e.scope,
                    erased_at: new Date(e.erasedAt),
                })),
                rowCount: 2,
            }),
        };
        const result = await republishMissingDurableLedgerEntries(client as never, { ledgerFilePath: ledgerFile });
        assert.equal(result.republished, 1);
        assert.deepEqual(result.latest, missing);
        assert.deepEqual(readDurableLedgerEntries(ledgerFile), [present, missing]);
        const again = await republishMissingDurableLedgerEntries(client as never, { ledgerFilePath: ledgerFile });
        assert.equal(again.republished, 0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('durable ledger append creates nested parent directories', () => {
    const nestedEntry: AcademicProfileLedgerEntry = {
        userId: '11111111-1111-4111-8111-111111111111',
        generationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        scope: 'profile_only',
        erasedAt: '2026-10-18T12:00:00.000Z',
    };
    const dir = mkdtempSync(join(tmpdir(), 'ledger-nested-'));
    const ledgerFile = join(dir, 'a', 'b', 'ledger.jsonl');
    try {
        appendDurableLedgerEntry(nestedEntry, ledgerFile);
        assert.deepEqual(readDurableLedgerEntries(ledgerFile), [nestedEntry]);
        assert.equal(existsSync(`${ledgerFile}.lock`), false, 'append lock must be released');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('durable ledger returns empty array when file does not exist', () => {
    const nonExistent = join(tmpdir(), 'non-existent-ledger-' + Date.now() + '.jsonl');
    const loaded = readDurableLedgerEntries(nonExistent);
    assert.deepEqual(loaded, []);
});

test('durable ledger fails closed on corrupt JSON line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-corrupt-'));
    const ledgerFile = join(dir, 'corrupt-ledger.jsonl');
    try {
        writeFileSync(ledgerFile, '{"valid": true}\ncorrupt json line\n');
        assert.throws(
            () => readDurableLedgerEntries(ledgerFile),
            /Durable deletion ledger is corrupt or invalid/,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('durable ledger fails closed on invalid schema / missing UUID', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-invalid-'));
    const ledgerFile = join(dir, 'invalid-ledger.jsonl');
    try {
        writeFileSync(ledgerFile, JSON.stringify({ userId: 'not-a-uuid', generationId: 'invalid' }) + '\n');
        assert.throws(
            () => readDurableLedgerEntries(ledgerFile),
            /Invalid ledger entry structure/,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('startup ledger gate fails closed when the backups directory is unavailable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-gate-'));
    try {
        const missing = join(dir, 'no-volume', 'ledger.jsonl');
        assert.throws(
            () => assertDurableLedgerAvailableForStartup({ ledgerFilePath: missing }),
            /refusing to start/,
        );
        // An explicit fresh deployment passes and records an initialized
        // marker, so later restarts pass without the flag.
        assertDurableLedgerAvailableForStartup({ ledgerFilePath: missing, freshDeployment: true });
        assertDurableLedgerAvailableForStartup({ ledgerFilePath: missing });
        // An existing parent directory with neither ledger nor marker
        // (an empty recreated volume) still fails closed.
        assert.throws(
            () => assertDurableLedgerAvailableForStartup({ ledgerFilePath: join(dir, 'ledger.jsonl') }),
            /refusing to start/,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('stale lock release does not unlink a replacement owner lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-lock-'));
    const ledgerFile = join(dir, 'test-ledger.jsonl');
    const lockFile = `${ledgerFile}.lock`;
    const entry: AcademicProfileLedgerEntry = {
        userId: '11111111-1111-4111-8111-111111111111',
        generationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        scope: 'profile_only',
        erasedAt: '2026-10-18T12:00:00.000Z',
    };
    try {
        // A stale lock older than the reclaim window gets replaced by a
        // real append and is gone afterwards.
        writeFileSync(lockFile, 'stale-owner\n');
        const stale = new Date(Date.now() - 60_000);
        utimesSync(lockFile, stale, stale);
        appendDurableLedgerEntry(entry, ledgerFile);
        assert.equal(existsSync(lockFile), false);
        assert.equal(readDurableLedgerEntries(ledgerFile).length, 1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('startup gate fails closed when the ledger disappears after tombstones were written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-ever-written-'));
    const ledgerFile = join(dir, 'test-ledger.jsonl');
    try {
        assertDurableLedgerAvailableForStartup({ ledgerFilePath: ledgerFile, freshDeployment: true });
        appendDurableLedgerEntry({
            userId: '11111111-1111-4111-8111-111111111111',
            generationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            scope: 'profile_only',
            erasedAt: '2026-10-18T12:00:00.000Z',
        }, ledgerFile);
        rmSync(ledgerFile);
        assert.throws(
            () => assertDurableLedgerAvailableForStartup({ ledgerFilePath: ledgerFile }),
            /tombstones were previously written/,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
