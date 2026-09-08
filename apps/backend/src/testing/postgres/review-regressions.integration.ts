import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import type { Request, Response } from 'express';
import { ProductController } from '../../controllers/product.controller.js';
import { AdminVendorController } from '../../controllers/admin-vendor.controller.js';
import type { AuthRequest } from '../../middleware/auth.middleware.js';
import { db } from '../../config/database.js';
import { withTestClient } from './test-database.js';

after(() => db.close());

test('admin activation requires a live vendor owner with a confirmed email', async () => {
    await withTestClient(async (client) => {
        const userId = randomUUID();
        await client.query(`INSERT INTO users (id, email, role, verification_status)
            VALUES ($1, $2, 'vendor', 'unverified')`, [userId, `${userId}@example.invalid`]);
        const vendor = await client.query(`INSERT INTO vendors (user_id, name, status)
            VALUES ($1, 'Synthetic Vendor', 'pending') RETURNING id`, [userId]);
        const id = vendor.rows[0].id;
        const response = { status() { return this; }, json() { return this; } } as unknown as Response;
        const controller = new AdminVendorController();
        const update = (status: string) => controller.updateVendorStatus({ params: { id }, body: { status } } as unknown as Request, response);
        await assert.rejects(update('active'), /confirm their email/);
        assert.equal((await client.query('SELECT status FROM vendors WHERE id = $1', [id])).rows[0].status, 'pending');
        await client.query(`UPDATE users SET verification_status = 'verified' WHERE id = $1`, [userId]);
        await update('active');
        assert.equal((await client.query('SELECT status FROM vendors WHERE id = $1', [id])).rows[0].status, 'active');
        await client.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [userId]);
        await assert.rejects(update('active'), /confirm their email/);
        await update('suspended');
    });
});

test('partial and concurrent price edits preserve the student discount', async () => {
    await withTestClient(async (client) => {
        const userId = randomUUID();
        await client.query(`INSERT INTO users (id, email, password_hash, role)
            VALUES ($1, $2, 'synthetic-hash', 'vendor')`, [userId, `${userId}@example.invalid`]);
        const vendor = await client.query(`INSERT INTO vendors (user_id, name, status)
            VALUES ($1, 'Synthetic Vendor', 'active') RETURNING id`, [userId]);
        const product = await client.query(`INSERT INTO products (vendor_id, name, price, student_price)
            VALUES ($1, 'Synthetic Product', 100, 80) RETURNING id`, [vendor.rows[0].id]);
        const id = product.rows[0].id;
        const controller = new ProductController();
        const response = { status() { return this; }, json() { return this; } } as unknown as Response;
        const update = (body: object) => controller.updateProduct({
            user: { userId, role: 'vendor' }, params: { id }, body,
        } as unknown as AuthRequest, response);
        await assert.rejects(update({ price: 70 }), /student price exceeds/);
        await assert.rejects(update({ studentPrice: 110 }), /student price exceeds/);
        const edits = await Promise.allSettled([update({ price: 85 }), update({ studentPrice: 95 })]);
        assert.equal(edits.filter((edit) => edit.status === 'fulfilled').length, 1);
        const state = await client.query('SELECT price, student_price FROM products WHERE id = $1', [id]);
        assert.ok(Number(state.rows[0].student_price) <= Number(state.rows[0].price));
    });
});

test('forward ticket repair restores retained internal notes once and permits vendor notifications', async () => {
    await withTestClient(async (client) => {
        const schema = `review_${randomUUID().replaceAll('-', '')}`;
        await client.query('BEGIN');
        try {
            await client.query(`CREATE SCHEMA ${schema}`);
            await client.query(`SET LOCAL search_path TO ${schema}`);
            await client.query(`CREATE TABLE notifications (student_id text NOT NULL);
                CREATE TABLE tickets (id text PRIMARY KEY);
                CREATE TABLE ticket_messages (ticket_id text, author_user_id text, author_role text,
                    body text, is_internal boolean, created_at timestamp);
                CREATE TABLE support_tickets_legacy (id text, admin_notes text, updated_at timestamp, created_at timestamp);
                CREATE TABLE vendor_support_tickets (LIKE support_tickets_legacy);
                INSERT INTO tickets VALUES ('student'), ('vendor');
                INSERT INTO support_tickets_legacy VALUES ('student', 'Synthetic private student note', NULL, now());
                INSERT INTO vendor_support_tickets VALUES ('vendor', 'Synthetic private vendor note', NULL, now());`);
            const migration = readFileSync(new URL('../../database/migrations/032_legacy_ticket_note_backfill.sql', import.meta.url), 'utf8');
            await client.query(migration);
            await client.query(migration);
            const messages = await client.query('SELECT body, is_internal, author_role FROM ticket_messages');
            assert.equal(messages.rowCount, 2);
            assert.ok(messages.rows.every((row) => row.is_internal && row.author_role === 'admin'));
            await client.query('INSERT INTO notifications VALUES (NULL)');
        } finally {
            await client.query('ROLLBACK');
        }
    });
});

test('Paystack references cannot cross vendors or checkout paths, including failed attempts', async () => {
    await withTestClient(async (client) => {
        const schema = `payments_${randomUUID().replaceAll('-', '')}`;
        await client.query('BEGIN');
        try {
            await client.query(`CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema};
                CREATE TABLE transactions (id text, payment_source text, paystack_reference text,
                    vendor_payment_reference text, status text);
                INSERT INTO transactions VALUES ('old', 'awoof', 'reserved', NULL, 'pending');`);
            await client.query(readFileSync(new URL('../../database/migrations/033_payment_reference_and_initialization.sql', import.meta.url), 'utf8'));
            assert.equal((await client.query('SELECT checkout_initialization_state FROM transactions')).rows[0].checkout_initialization_state, 'unknown');
            for (const sql of [
                `INSERT INTO transactions (payment_source, vendor_payment_reference) VALUES ('vendor_paystack', 'reserved')`,
                `INSERT INTO transactions (payment_source, paystack_reference, status) VALUES ('awoof', 'reserved', 'failed')`,
                `INSERT INTO transactions (payment_source, paystack_reference, vendor_payment_reference) VALUES ('vendor_paystack', 'different', 'another')`,
            ]) {
                await client.query('SAVEPOINT attempted');
                await assert.rejects(client.query(sql), (error: { code?: string }) => ['23505', '23514'].includes(error.code ?? ''));
                await client.query('ROLLBACK TO SAVEPOINT attempted');
            }
            await client.query(`INSERT INTO transactions (payment_source, vendor_payment_reference) VALUES ('vendor_paystack', 'external')`);
            await client.query('SAVEPOINT attempted');
            await assert.rejects(client.query(`INSERT INTO transactions (payment_source, paystack_reference) VALUES ('awoof', 'external')`), { code: '23505' });
            await client.query('ROLLBACK TO SAVEPOINT attempted');
            await client.query(`INSERT INTO transactions (payment_source, vendor_payment_reference) VALUES ('vendor_other', 'external')`);
        } finally {
            await client.query('ROLLBACK');
        }
    });
});

test('vendors cannot activate external payments while verification token issuance is unavailable', async () => {
    const { PaymentController } = await import('../../controllers/payment.controller.js');
    await withTestClient(async (client) => {
        const id = randomUUID();
        await client.query(`INSERT INTO users (id, email, role) VALUES ($1, $2, 'vendor')`, [id, `${id}@example.invalid`]);
        const vendor = (await client.query(`INSERT INTO vendors (user_id, name, status) VALUES ($1, 'Synthetic', 'active') RETURNING id`, [id])).rows[0];
        const response = { status() { return this; }, json() { return this; } } as unknown as Response;
        const controller = new PaymentController();
        await assert.rejects(controller.updatePaymentMethod({ user: { userId: id, role: 'vendor' }, body: { paymentMethod: 'vendor_website' } } as unknown as AuthRequest, response), /Vendor-site checkout is unavailable/);
        assert.notEqual((await client.query('SELECT payment_method FROM vendors WHERE id = $1', [vendor.id])).rows[0].payment_method, 'vendor_website');
    });
});

test('inventory migration preserves the distinction between legacy marketplace and vendor-site sales', async () => {
    await withTestClient(async (client) => {
        const schema = `inventory_${randomUUID().replaceAll('-', '')}`;
        await client.query('BEGIN');
        try {
            await client.query(`CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema};
                CREATE TABLE transactions (id text, payment_source text, paystack_reference text, status text);
                INSERT INTO transactions VALUES ('vendor', 'vendor_paystack', NULL, 'completed'),
                    ('marketplace', 'awoof', 'synthetic', 'completed'), ('pending', 'awoof', 'pending', 'pending');`);
            await client.query(readFileSync(new URL('../../database/migrations/034_transaction_inventory_consumed.sql', import.meta.url), 'utf8'));
            assert.deepEqual((await client.query('SELECT id, inventory_consumed FROM transactions ORDER BY id')).rows, [
                { id: 'marketplace', inventory_consumed: true },
                { id: 'pending', inventory_consumed: false },
                { id: 'vendor', inventory_consumed: false },
            ]);
        } finally { await client.query('ROLLBACK'); }
    });
});
