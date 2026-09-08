import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import { db } from '../config/database.js';
import { AuthController } from './auth.controller.js';

test('committed vendor registration reports session recovery without attempting rollback', async (t) => {
    const statements: string[] = [];
    t.mock.method(db, 'query', async () => ({ rows: [] }));
    t.mock.method(db, 'getPool', () => ({ connect: async () => ({
        query: async (sql: string) => {
            statements.push(sql.trim());
            return { rows: sql.includes('INSERT INTO users') ? [{ id: 'synthetic-user', email: 'vendor@example.invalid', role: 'vendor', verification_status: 'unverified' }] : [] };
        },
        release() {},
    }) }));
    const controller = new AuthController({
        issueSession: async () => { throw new Error('Synthetic session failure'); },
        sendVendorVerification: async () => ({ success: true }),
    });
    await assert.rejects(controller.register({ body: { email: 'vendor@example.invalid', password: 'SyntheticStrong1!', name: 'Synthetic Vendor', role: 'vendor' } } as Request, {} as Response),
        { code: 'SESSION_ISSUANCE_UNAVAILABLE', statusCode: 503 });
    assert.ok(statements.includes('COMMIT'));
    assert.ok(!statements.includes('ROLLBACK'));
});
