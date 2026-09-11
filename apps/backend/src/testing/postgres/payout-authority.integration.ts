import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Request, Response } from 'express';
import axios from 'axios';
import { db } from '../../config/database.js';
import { config } from '../../config/env.js';
import { PaymentController } from '../../controllers/payment.controller.js';
import { NotificationService } from '../../services/notification/notification.service.js';
import { assertFixtureDatabase, createTestPool } from './test-database.js';

for (const scenario of ['suspend-during-resolution', 'suspend-during-mutation', 'rejected', 'unknown'] as const) {
    test(`payout authority and guard handling: ${scenario}`, async () => {
        const pool = createTestPool(); const tx = await pool.connect();
        const originalGet = axios.get; const originalPost = axios.post;
        const originalNotice = NotificationService.notifyVendorPayoutEnabled;
        const oldKey = config.paystack.secretKey;
        const owner = randomUUID(); const vendorId = randomUUID();
        let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
        let arrived!: () => void; const arrival = new Promise<void>((resolve) => { arrived = resolve; });
        let mutations = 0;
        const res = { status: () => res, json: () => res } as unknown as Response;
        const req = { user: { userId: owner, role: 'vendor' }, body: { bankName: 'Synthetic', bankCode: '000', accountNumber: '0000000000' } } as Request;
        try {
            await assertFixtureDatabase(tx);
            await tx.query("INSERT INTO users(id,email,role) VALUES ($1,$2,'vendor')", [owner, `${owner}@example.invalid`]);
            await tx.query("INSERT INTO vendors(id,user_id,name,status) VALUES ($1,$2,'Synthetic','active')", [vendorId, owner]);
            Object.assign(config.paystack, { secretKey: 'synthetic-key' });
            NotificationService.notifyVendorPayoutEnabled = async () => undefined;
            axios.get = (async () => {
                if (scenario === 'suspend-during-resolution') { arrived(); await gate; }
                return { data: { data: { account_name: 'Synthetic Holder', account_number: '0000000000' } } };
            }) as typeof axios.get;
            axios.post = (async (_url: unknown, _body: unknown, options: { signal?: AbortSignal }) => {
                mutations++; assert.ok(options.signal);
                if (scenario === 'suspend-during-mutation') { arrived(); await gate; }
                if (scenario === 'rejected') throw { isAxiosError: true, response: { status: 400, data: { status: false, message: 'Invalid account' } } };
                if (scenario === 'unknown') throw { isAxiosError: true, code: 'ECONNABORTED' };
                return { data: { data: { subaccount_code: 'ACCT_synthetic' } } };
            }) as typeof axios.post;
            const controller = new PaymentController();
            const outcome = controller.updatePayoutSettings(req, res).then(() => null, (error: unknown) => error);
            if (scenario === 'suspend-during-resolution') {
                await Promise.race([arrival, outcome.then(() => { throw new Error('Request settled before reaching the expected provider gate'); })]);
                await tx.query("UPDATE vendors SET status='suspended' WHERE id=$1", [vendorId]);
                release(); assert.ok(await outcome instanceof Error); assert.equal(mutations, 0);
            } else if (scenario === 'suspend-during-mutation') {
                await Promise.race([arrival, outcome.then(() => { throw new Error('Request settled before reaching the expected provider gate'); })]);
                const pid = (await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
                const suspension = tx.query("UPDATE vendors SET status='suspended' WHERE id=$1", [vendorId]);
                let blocked = false;
                for (let attempt = 0; attempt < 100; attempt++) {
                    blocked = (await pool.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])).rows[0].blocked;
                    if (blocked) break;
                    await delay(10);
                }
                assert.equal(blocked, true, 'suspension must wait for the authorized payout mutation');
                release(); assert.equal(await outcome, null); await suspension;
                assert.equal(mutations, 1);
            } else { assert.ok(await outcome instanceof Error); }
            const request = (await tx.query('SELECT status FROM payout_change_requests WHERE vendor_id=$1', [vendorId])).rows[0];
            assert.equal(request.status, scenario === 'suspend-during-mutation' ? 'applied' : scenario === 'unknown' ? 'pending' : 'failed');
            const vendor = (await tx.query('SELECT account_number FROM vendors WHERE id=$1', [vendorId])).rows[0];
            assert.equal(vendor.account_number, scenario === 'suspend-during-mutation' ? '0000000000' : null);
            if (scenario === 'unknown') {
                await assert.rejects(controller.updatePayoutSettings(req, res), /already pending reconciliation/);
                assert.equal(mutations, 1);
            }
        } finally {
            release(); axios.get = originalGet; axios.post = originalPost;
            NotificationService.notifyVendorPayoutEnabled = originalNotice;
            Object.assign(config.paystack, { secretKey: oldKey });
            tx.release(); await pool.end(); await db.close();
        }
    });
}
