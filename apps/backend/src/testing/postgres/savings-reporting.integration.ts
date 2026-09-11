import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import type { Request, Response } from 'express';
import type { AuthRequest } from '../../middleware/auth.middleware.js';
import { db } from '../../config/database.js';
import { StudentController } from '../../controllers/student.controller.js';
import { AdminStudentController } from '../../controllers/admin-student.controller.js';
import { AdminAnalyticsController } from '../../controllers/admin-analytics.controller.js';
import { OrderController } from '../../controllers/order.controller.js';
import { completeMarketplaceTransactionWithClient } from '../../services/payment/checkout.service.js';
import { withTestClient } from './test-database.js';

after(() => db.close());

interface SavingsPayload {
    summary: { totalSavings: number | null; recordedSavings: number; unknownSavingsCount: number; totalValue: number | null; totalSpent: number };
    byCategory: { savings: number | null; recordedSavings: number }[];
    transactions: { status: string; discountAmount: number | null; amount: number | null; finalAmount: number }[];
    students: { totalSavings: number | null; recordedSavings: number; unknownSavingsCount: number }[];
    studentImpact: { totalStudentSavings: number | null; unknownSavingsCount: number };
}

test('savings reports expose unknown legacy credits and ignore synthetic snapshots and edited prices', async () => {
    await withTestClient(async (client) => {
        const label = randomUUID();
        const user = (await client.query(`INSERT INTO users(email, role) VALUES ($1, 'student') RETURNING id`, [`${label}@example.invalid`])).rows[0].id;
        const owner = (await client.query(`INSERT INTO users(email, role) VALUES ($1, 'vendor') RETURNING id`, [`vendor-${label}@example.invalid`])).rows[0].id;
        const student = (await client.query(`INSERT INTO students(user_id, name) VALUES ($1, $2) RETURNING id`, [user, label])).rows[0].id;
        const vendor = (await client.query(`INSERT INTO vendors(user_id, name, status) VALUES ($1, 'Synthetic', 'active') RETURNING id`, [owner])).rows[0].id;
        const product = (await client.query(`INSERT INTO products(vendor_id, name, price, student_price, stock, status) VALUES ($1, 'Synthetic', 900, 400, 4, 'active') RETURNING id`, [vendor])).rows[0].id;
        let body = {} as SavingsPayload;
        const response = { status() { return this; }, json(value: { data: SavingsPayload }) { body = value.data; return this; } } as unknown as Response;
        const request = { user: { userId: user, role: 'student' }, query: {} } as unknown as AuthRequest;
        const controller = new StudentController();
        await controller.getSavings(request, response);
        assert.equal(body.summary.totalSavings, 0);
        await client.query(`INSERT INTO transactions(student_id, product_id, vendor_id, amount, commission, status, list_price_snapshot, recorded_savings_delta)
            VALUES ($1,$2,$3,80,4,'completed',700,NULL), ($1,$2,$3,80,4,'completed',600,20),
                   ($1,$2,$3,80,4,'refunded',600,500), ($1,$2,$3,80,4,'pending',600,NULL)`, [student, product, vendor]);
        await controller.getSavings(request, response);
        assert.equal(body.summary.totalSavings, null);
        assert.equal(body.summary.recordedSavings, 20);
        assert.equal(body.summary.unknownSavingsCount, 1);
        assert.equal(body.summary.totalValue, null);
        assert.equal(body.summary.totalSpent, 160);
        assert.ok(body.byCategory[0]);
        assert.equal(body.byCategory[0].savings, null);
        assert.equal(body.byCategory[0].recordedSavings, 20);
        await controller.getPurchases(request, response);
        const unknown = body.transactions.find((row) => row.status === 'completed' && row.discountAmount === null);
        assert.ok(unknown);
        assert.equal(unknown.amount, null);
        assert.equal(unknown.finalAmount, 80);
        await new AdminStudentController().getStudents({ query: { search: label } } as unknown as Request, response);
        assert.ok(body.students[0]);
        assert.equal(body.students[0].totalSavings, null);
        assert.equal(body.students[0].recordedSavings, 20);
        assert.equal(body.students[0].unknownSavingsCount, 1);
        await new AdminAnalyticsController().getAnalytics({} as Request, response);
        assert.equal(body.studentImpact.totalStudentSavings, null);
        assert.ok(body.studentImpact.unknownSavingsCount >= 1);
        // A fully known zero is distinct from unknown, and survives catalog price edits.
        await client.query(`UPDATE transactions SET recorded_savings_delta = 0 WHERE student_id=$1 AND status='completed'`, [student]);
        await controller.getSavings(request, response);
        assert.equal(body.summary.totalSavings, 0);
        assert.equal(body.summary.totalValue, 160);
        assert.equal(body.summary.unknownSavingsCount, 0);
    });
});

test('marketplace settlement persists exactly the credited savings and duplicate settlement cannot credit twice', async () => {
    await withTestClient(async (client) => {
        const label = randomUUID();
        const user = (await client.query(`INSERT INTO users(email, role) VALUES ($1, 'student') RETURNING id`, [`${label}@example.invalid`])).rows[0].id;
        const owner = (await client.query(`INSERT INTO users(email, role) VALUES ($1, 'vendor') RETURNING id`, [`vendor-${label}@example.invalid`])).rows[0].id;
        const student = (await client.query(`INSERT INTO students(user_id, name) VALUES ($1, 'Synthetic') RETURNING id`, [user])).rows[0].id;
        const vendor = (await client.query(`INSERT INTO vendors(user_id, name, status) VALUES ($1, 'Synthetic', 'active') RETURNING id`, [owner])).rows[0].id;
        const product = (await client.query(`INSERT INTO products(vendor_id, name, price, student_price, stock, status) VALUES ($1, 'Synthetic', 900, 400, 4, 'active') RETURNING id`, [vendor])).rows[0].id;
        await client.query(`INSERT INTO transactions(student_id, product_id, vendor_id, amount, commission, status, list_price_snapshot, paystack_reference)
            VALUES ($1,$2,$3,80,4,'pending',100,$4)`, [student, product, vendor, label]);
        const eligible = async () => ({ eligible: true as const, studentId: student, universityId: randomUUID(), evidenceId: randomUUID(), processingGrantId: randomUUID(), method: 'student_email' as const, verifiedAt: new Date(), expiresAt: new Date('2100-01-01') });
        await completeMarketplaceTransactionWithClient(client, label, 80, eligible);
        await client.query('UPDATE transactions SET list_price_snapshot=800 WHERE paystack_reference=$1', [label]);
        await completeMarketplaceTransactionWithClient(client, label, 80, eligible);
        const transaction = (await client.query('SELECT status, recorded_savings_delta FROM transactions WHERE paystack_reference=$1', [label])).rows[0];
        assert.equal(transaction.status, 'completed');
        assert.equal(Number(transaction.recorded_savings_delta), 20);
        const stats = (await client.query('SELECT total_savings, total_purchases FROM savings_stats WHERE student_id=$1', [student])).rows[0];
        assert.equal(Number(stats.total_savings), 20);
        assert.equal(stats.total_purchases, 1);
        const transactionId = (await client.query('SELECT id FROM transactions WHERE paystack_reference=$1', [label])).rows[0].id;
        const response = { status() { return this; }, json() { return this; } } as unknown as Response;
        await assert.rejects(new OrderController().updateOrderStatus({ user: { userId: owner, role: 'vendor' }, params: { id: transactionId }, body: { status: 'refunded' } } as unknown as AuthRequest, response), /Awoof-managed payment states/);
        assert.equal(Number((await client.query('SELECT total_savings FROM savings_stats WHERE student_id=$1', [student])).rows[0].total_savings), 20);
    });
});
