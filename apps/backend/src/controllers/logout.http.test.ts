import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { db } from '../config/database.js';
import { createAuthRouter } from '../routes/auth.routes.js';
import { jwtService } from '../services/auth/jwt.service.js';
import { errorHandler } from '../common/middleware/errorHandler.js';

test('logout authenticates the refresh credential even when access authentication fails', async () => {
    const original = db.query; let writes = 0;
    db.query = (async (sql: string, values: unknown[]) => {
        assert.match(sql, /refresh_token_hash = \$2/);
        assert.equal(values[0], 'fixture-user'); writes += 1;
        return { rowCount: 1, rows: [] };
    }) as typeof db.query;
    const app = express(); app.use(express.json()); app.use('/auth', createAuthRouter()); app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/auth/logout`;
    try {
        const refreshToken = jwtService.generateRefreshToken({ userId: 'fixture-user', role: 'student', email: 'synthetic@example.invalid' });
        const send = (token: string) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer expired-access-token' }, body: JSON.stringify({ refreshToken: token }) });
        assert.equal((await send(refreshToken)).status, 200); assert.equal(writes, 1);
        assert.equal((await send('invalid-refresh-token')).status, 401); assert.equal(writes, 1);
    } finally { db.query = original; server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
