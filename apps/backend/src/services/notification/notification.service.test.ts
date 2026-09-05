import assert from 'node:assert/strict';
import { it } from 'node:test';
import { db } from '../../config/database.js';
import { NotificationService } from './notification.service.js';

it('claims the highest reached savings milestone atomically before publishing', async (t) => {
    const calls: { sql: string; values: unknown[] }[] = [];
    t.mock.method(db, 'query', async (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        return { rows: [] };
    });
    await NotificationService.notifySavingsMilestone('student', 999);
    assert.equal(calls.length, 0);
    for (const total of [1100, 1200, 3000, 5000, 150000]) {
        await NotificationService.notifySavingsMilestone('student', total);
    }
    assert.deepEqual(calls.map((call) => call.values[1]), [1000, 1000, 1000, 5000, 100000]);
    for (const { sql } of calls) {
        assert.match(sql, /ON CONFLICT \(user_id, milestone\) DO NOTHING/);
        assert.match(sql, /INSERT INTO notifications[\s\S]*FROM claimed/);
    }
});
