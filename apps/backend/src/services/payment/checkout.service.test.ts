import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PoolClient, QueryResult } from 'pg';
import {
    completeMarketplaceTransactionWithClient,
} from './checkout.service.js';

type QueryReply = Pick<QueryResult, 'rows'>;

function fakeClient(replies: QueryReply[]) {
    const statements: string[] = [];
    const query = async (text: string): Promise<QueryReply> => {
        statements.push(text.trim());
        const reply = replies.shift();
        if (!reply) throw new Error(`Unexpected query: ${text}`);
        return reply;
    };

    return {
        client: { query } as unknown as Pick<PoolClient, 'query'>,
        statements,
    };
}

describe('completeMarketplaceTransactionWithClient', () => {
    it('commits stock, transaction, and savings changes on one client', async () => {
        const { client, statements } = fakeClient([
            { rows: [] }, // BEGIN
            {
                rows: [{
                    id: 'tx-1',
                    status: 'pending',
                    amount: '900',
                    list_price: '1000',
                    product_id: 'product-1',
                    student_id: 'student-1',
                }],
            },
            { rows: [{ id: 'product-1' }] },
            { rows: [{ id: 'tx-1' }] },
            { rows: [] }, // savings upsert
            { rows: [] }, // COMMIT
        ]);

        const result = await completeMarketplaceTransactionWithClient(
            client,
            'awoof_reference',
            900
        );

        assert.deepEqual(result, {
            completed: true,
            transactionId: 'tx-1',
            newlyCompleted: true,
        });
        assert.equal(statements[0], 'BEGIN');
        assert.match(statements[1] ?? '', /FOR UPDATE OF t/);
        assert.match(statements[2] ?? '', /SET stock = stock - 1/);
        assert.match(statements[3] ?? '', /SET status = 'completed'/);
        assert.match(statements[4] ?? '', /INSERT INTO savings_stats/);
        assert.equal(statements[5], 'COMMIT');
    });

    it('rolls back an underpayment without changing stock', async () => {
        const { client, statements } = fakeClient([
            { rows: [] }, // BEGIN
            {
                rows: [{
                    id: 'tx-1',
                    status: 'pending',
                    amount: '900',
                    list_price: '1000',
                    product_id: 'product-1',
                    student_id: 'student-1',
                }],
            },
            { rows: [] }, // ROLLBACK
        ]);

        await assert.rejects(
            completeMarketplaceTransactionWithClient(client, 'awoof_reference', 899),
            /Payment amount mismatch/
        );
        assert.deepEqual(statements, [
            'BEGIN',
            statements[1],
            'ROLLBACK',
        ]);
        assert.match(statements[1] ?? '', /FOR UPDATE OF t/);
    });

    it('is idempotent when the transaction is already complete', async () => {
        const { client, statements } = fakeClient([
            { rows: [] }, // BEGIN
            { rows: [{ id: 'tx-1', status: 'completed' }] },
            { rows: [] }, // COMMIT
        ]);

        const result = await completeMarketplaceTransactionWithClient(
            client,
            'awoof_reference',
            900
        );

        assert.deepEqual(result, {
            completed: true,
            transactionId: 'tx-1',
            newlyCompleted: false,
        });
        assert.equal(statements.at(-1), 'COMMIT');
        assert.equal(statements.some((text) => text.includes('stock = stock - 1')), false);
    });

    it('queues a verified payment for refund when stock is unavailable', async () => {
        const { client, statements } = fakeClient([
            { rows: [] }, // BEGIN
            {
                rows: [{
                    id: 'tx-1',
                    status: 'pending',
                    amount: '900',
                    list_price: '1000',
                    product_id: 'product-1',
                    student_id: 'student-1',
                }],
            },
            { rows: [] }, // stock update
            { rows: [] }, // requires_refund update
            { rows: [] }, // reconciliation queue insert
            { rows: [] }, // COMMIT
        ]);

        const result = await completeMarketplaceTransactionWithClient(
            client,
            'awoof_reference',
            900
        );

        assert.deepEqual(result, { completed: false, transactionId: 'tx-1' });
        assert.match(statements[3] ?? '', /status = 'requires_refund'/);
        assert.match(statements[4] ?? '', /INSERT INTO payment_reconciliation_queue/);
        assert.equal(statements[5], 'COMMIT');
    });
});
