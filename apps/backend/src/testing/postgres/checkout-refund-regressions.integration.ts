import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, mock } from 'node:test';
import type { Response } from 'express';
import type { PoolClient } from 'pg';
import { db } from '../../config/database.js';
import { CheckoutController } from '../../controllers/checkout.controller.js';
import { OrderController } from '../../controllers/order.controller.js';
import type { AuthRequest } from '../../middleware/auth.middleware.js';
import { grantVerificationProcessing } from '../../services/verification/eligibility-consent.service.js';
import { lockStudentContext } from '../../services/verification/eligibility-context.service.js';
import { requestChallenge, consumeChallenge } from '../../services/verification/challenge.service.js';
import { recordEmailAssurance } from '../../services/verification/eligibility-evidence.service.js';
import { updateInstitutionPolicy } from '../../services/verification/eligibility-policy.service.js';
import { VERIFICATION_NOTICE_VERSION } from '../../services/verification/verification-notices.js';
import { inTransaction, withTestClient } from './test-database.js';

after(() => db.close());
const response = { status() { return this; }, json() { return this; } } as unknown as Response;

async function fixture(client: PoolClient, eligible = false) {
    const label = randomUUID();
    const studentUser = (await client.query(`INSERT INTO users(email, role) VALUES ($1, 'student') RETURNING id`, [`${label}@students.example`])).rows[0].id;
    const owner = (await client.query(`INSERT INTO users(email, role) VALUES ($1, 'vendor') RETURNING id`, [`vendor-${label}@example.invalid`])).rows[0].id;
    const university = (await client.query(`INSERT INTO universities(name, is_active) VALUES ($1, true) RETURNING id`, [label])).rows[0].id;
    const student = (await client.query(`INSERT INTO students(user_id, name, university_id) VALUES ($1, 'Synthetic', $2) RETURNING id`, [studentUser, university])).rows[0].id;
    const vendor = (await client.query(`INSERT INTO vendors(user_id, name, status) VALUES ($1, 'Synthetic', 'active') RETURNING id`, [owner])).rows[0].id;
    const product = (await client.query(`INSERT INTO products(vendor_id, name, price, student_price, stock, status) VALUES ($1, 'Synthetic', 100, 80, 4, 'active') RETURNING id`, [vendor])).rows[0].id;
    if (eligible) {
        const admin = (await client.query(`INSERT INTO users(email, role) VALUES ($1, 'admin') RETURNING id`, [`admin-${label}@example.invalid`])).rows[0].id;
        await inTransaction(client, () => updateInstitutionPolicy(client, admin, university, { domains: ['students.example'], emailEvidenceValidityDays: 90, enrollmentValidityDays: 30, registrationNormalization: null, isActive: true }));
        const grant = await inTransaction(client, () => grantVerificationProcessing(client, studentUser, university, { accepted: true, noticeVersion: VERIFICATION_NOTICE_VERSION }));
        await inTransaction(client, async () => {
            const context = await lockStudentContext(client, studentUser);
            const challenge = await requestChallenge(client, { purpose: 'student_email', subjectKey: studentUser, bindings: { ...context, processingGrantId: grant, noticeVersion: VERIFICATION_NOTICE_VERSION } });
            assert.equal(challenge.status, 'issued');
            if (challenge.status !== 'issued') throw new Error('Fixture challenge unavailable');
            assert.equal((await consumeChallenge(client, { purpose: 'student_email', subjectKey: studentUser, challengeId: challenge.challengeId, code: challenge.code })).status, 'verified');
            await recordEmailAssurance(client, studentUser, { challengeId: challenge.challengeId, processingGrantId: grant });
        });
    }
    return { studentUser, owner, student, vendor, product };
}

test('checkout retains owner, vendor and product authority until its reservation decision commits', async () => {
    await withTestClient(async (client) => {
        const f = await fixture(client, true);
        await client.query(`INSERT INTO transactions(student_id, product_id, vendor_id, amount, commission, status, payment_source, paystack_reference, checkout_authorization_url)
            VALUES ($1, $2, $3, 80, 4, 'pending', 'awoof', $4, 'https://example.invalid/synthetic-checkout')`, [f.student, f.product, f.vendor, randomUUID()]);
        const checkoutClient = await db.getPool().connect();
        const originalQuery = checkoutClient.query.bind(checkoutClient);
        const connect = mock.method(db.getPool(), 'connect', async () => checkoutClient);
        let tested = false;
        const query = mock.method(checkoutClient, 'query', async (sql: string, values?: unknown[]) => {
            if (sql.includes('SELECT id, paystack_reference, checkout_authorization_url')) {
                tested = true;
                for (const [statement, id] of [
                    ['UPDATE users SET deleted_at = now() WHERE id = $1', f.owner],
                    ["UPDATE vendors SET status = 'suspended' WHERE id = $1", f.vendor],
                    ["UPDATE products SET status = 'inactive' WHERE id = $1", f.product],
                ]) {
                    await client.query('BEGIN');
                    await client.query("SET LOCAL lock_timeout = '100ms'");
                    try { await assert.rejects(client.query(statement!, [id]), { code: '55P03' }); }
                    finally { await client.query('ROLLBACK'); }
                }
            }
            return originalQuery(sql, values);
        });
        try {
            await new CheckoutController().createCheckout({ user: { userId: f.studentUser, role: 'student' }, body: { productId: f.product } } as AuthRequest, response);
            assert.equal(tested, true);
        } finally { query.mock.restore(); connect.mock.restore(); }
    });
});

for (const inventoryConsumed of [true, false]) {
test(`concurrent external refunds reverse recorded savings once (inventory consumed: ${inventoryConsumed})`, async () => {
    await withTestClient(async (client) => {
        const f = await fixture(client);
        const order = (await client.query(`INSERT INTO transactions(student_id, product_id, vendor_id, amount, commission, list_price_snapshot, status, payment_source, inventory_consumed)
            VALUES ($1, $2, $3, 80, 4, 100, 'completed', 'vendor_other', $4) RETURNING id`, [f.student, f.product, f.vendor, inventoryConsumed])).rows[0].id;
        await client.query(`INSERT INTO savings_stats(student_id, total_savings, total_purchases) VALUES ($1, 70, 3)`, [f.student]);
        await client.query('UPDATE products SET price = 500 WHERE id = $1', [f.product]);
        const refund = () => new OrderController().updateOrderStatus({ user: { userId: f.owner, role: 'vendor' }, params: { id: order }, body: { status: 'refunded' } } as unknown as AuthRequest, response);
        const attempts = await Promise.allSettled([refund(), refund()]);
        assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
        const stats = (await client.query('SELECT total_savings, total_purchases FROM savings_stats WHERE student_id = $1', [f.student])).rows[0];
        assert.equal(Number(stats.total_savings), 50);
        assert.equal(Number(stats.total_purchases), 2);
        assert.equal((await client.query('SELECT stock FROM products WHERE id = $1', [f.product])).rows[0].stock, inventoryConsumed ? 5 : 4);
    });
});
}
