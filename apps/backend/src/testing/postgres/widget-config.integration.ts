import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Request, Response } from 'express';
import { db } from '../../config/database.js';
import { getWidgetConfig, updateWidgetConfig } from '../../controllers/widget-config.controller.js';
import { prepareMerchantDisclosure } from '../../services/verification/eligibility-merchant-context.service.js';
import { assertFixtureDatabase, createTestPool } from './test-database.js';

test('new and existing widget configs persist canonical HTTPS origins accepted by disclosure checks', async () => {
    const pool = createTestPool(); const tx = await pool.connect();
    const res = { status: () => res, json: () => res } as unknown as Response;
    try {
        await assertFixtureDatabase(tx);
        const studentId = randomUUID();
        await tx.query("INSERT INTO users(id,email,role) VALUES ($1,$2,'student')", [studentId, `${studentId}@example.invalid`]);
        for (const existing of [true, false]) {
            const owner = randomUUID(); const vendorId = randomUUID();
            await tx.query("INSERT INTO users(id,email,role) VALUES ($1,$2,'vendor')", [owner, `${owner}@example.invalid`]);
            await tx.query("INSERT INTO vendors(id,user_id,name,status) VALUES ($1,$2,'Synthetic','active')", [vendorId, owner]);
            const req = { user: { userId: owner, role: 'vendor' }, body: { allowedDomains: ['SHOP.example', 'https://shop.example/', 'other.example'] } } as Request;
            if (existing) await getWidgetConfig(req, res);
            await updateWidgetConfig(req, res);
            const config = (await tx.query('SELECT allowed_domains, allowed_origins FROM widget_configs WHERE vendor_id=$1', [vendorId])).rows[0];
            assert.deepEqual(config.allowed_domains, ['shop.example', 'other.example']);
            assert.deepEqual(config.allowed_origins, ['https://shop.example', 'https://other.example']);
            await tx.query('BEGIN');
            assert.ok(await prepareMerchantDisclosure(tx, studentId, vendorId, 'https://shop.example'));
            await tx.query('ROLLBACK');
            await tx.query('BEGIN');
            assert.equal(await prepareMerchantDisclosure(tx, studentId, vendorId, 'https://not-allowed.example'), null);
            await tx.query('ROLLBACK');
            req.body = { allowedDomains: ['https://shop.example:8443'] };
            await assert.rejects(updateWidgetConfig(req, res), /without ports/);
        }
    } finally { tx.release(); await pool.end(); await db.close(); }
});
