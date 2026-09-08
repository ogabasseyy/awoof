import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sevenDaySeries } from '../../src/lib/dashboard-dates';

test('daily chart keeps the API day and label aligned across Lagos and UTC midnight', () => {
    const points = [{ date: '2026-09-07', orders: 7, completedOrders: 5, revenue: 100 }];
    const duringDay = sevenDaySeries(points, new Date('2026-09-07T12:00:00+01:00'));
    assert.equal(duringDay[6].key, '2026-09-07');
    assert.equal(duringDay[6].label, 'Mon');
    assert.equal(duringDay[6].orders, 5);
    const afterLocalMidnight = sevenDaySeries(points, new Date('2026-09-08T00:30:00+01:00'));
    assert.deepEqual(afterLocalMidnight, duringDay);
});
