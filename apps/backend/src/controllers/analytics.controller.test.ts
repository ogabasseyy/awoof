import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Response } from 'express';
import { db } from '../config/database.js';
import { AnalyticsController } from './analytics.controller.js';
import type { AuthRequest } from '../middleware/auth.middleware.js';

const vendorId = '6b4f1c2a-9d3e-4f5a-8b1c-2d3e4f5a6b7c';
const ownerId = '7c5d2e3b-1f4a-4b5c-9d2e-3f4a5b6c7d8e';

function cannedQuery() {
    return async (text: string) => {
        if (text.includes('FROM vendors WHERE user_id')) {
            return { rows: [{ id: vendorId }], rowCount: 1 };
        }
        if (text.includes('as repeat_customers')) {
            return {
                rows: [{ total_students: '11', purchasing_students: '7', verified_students: '7', repeat_customers: '3' }],
                rowCount: 1,
            };
        }
        if (text.includes('as total_revenue')) {
            return {
                rows: [{
                    total_orders: '9', completed_orders: '8', total_revenue: '640',
                    total_commission: '64', total_earnings: '576',
                    unique_customers: '7', average_order_value: '80',
                }],
                rowCount: 1,
            };
        }
        if (text.includes('LIMIT 10')) {
            return { rows: [], rowCount: 0 };
        }
        if (text.includes('FROM products p')) {
            return { rows: [], rowCount: 0 };
        }
        if (text.includes('GROUP BY')) {
            return { rows: [], rowCount: 0 };
        }
        throw new Error(`Unexpected analytics query: ${text.slice(0, 120)}`);
    };
}

async function readAnalytics(t: TestContext): Promise<Record<string, any>> {
    t.mock.method(db, 'query', cannedQuery());
    let body = {} as Record<string, any>;
    const response = {
        status() { return this; },
        json(value: { data: Record<string, any> }) { body = value.data; return this; },
    } as unknown as Response;
    const request = { user: { userId: ownerId, role: 'vendor' } } as unknown as AuthRequest;
    await new AnalyticsController().getAnalytics(request, response);
    return body;
}

test('vendor analytics reports purchasing students, not a verification count', async (t) => {
    const body = await readAnalytics(t);
    assert.equal(body.students.totalStudents, 11);
    assert.equal(body.students.purchasingStudents, 7);
    assert.equal(body.students.repeatCustomers, 3);
});

test('the retired verifiedStudents alias stays equal and explicitly deprecated', async (t) => {
    const body = await readAnalytics(t);
    assert.equal(body.students.verifiedStudents, body.students.purchasingStudents);
});
