import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { db } from '../config/database.js';
import { errorHandler } from '../common/middleware/errorHandler.js';
import adminRouter from '../routes/admin.routes.js';
import { jwtService } from '../services/auth/jwt.service.js';

test('stale admin JWTs cannot read support inboxes or threads after demotion or deletion', async (t) => {
    let rows: { role: string; deleted_at: Date | null }[] = [];
    t.mock.method(db, 'query', async (sql: string) => {
        assert.equal(sql, 'SELECT role, deleted_at FROM users WHERE id = $1');
        return { rows };
    });
    const app = express(); app.use('/admin', adminRouter); app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback server');
    const token = jwtService.generateAccessToken({ userId: '35176342-b6fc-43e8-bad2-31052c61cf88', role: 'admin', email: 'admin@example.invalid' });
    try {
        for (const actor of [[], [{ role: 'vendor', deleted_at: null }], [{ role: 'admin', deleted_at: new Date() }]]) {
            rows = actor;
            for (const path of ['/support/tickets', '/support/tickets/35176342-b6fc-43e8-bad2-31052c61cf88']) {
                const response = await fetch(`http://127.0.0.1:${address.port}/admin${path}`, { headers: { authorization: `Bearer ${token}` } });
                assert.equal(response.status, 403);
                assert.ok(!(await response.text()).includes('requester_email'));
            }
        }
    } finally { server.close(); await once(server, 'close'); }
});
