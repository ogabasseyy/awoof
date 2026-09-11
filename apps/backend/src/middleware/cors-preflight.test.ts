import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { skipCorsPreflight } from './cors-preflight.js';

test('preflights leave the action quota intact while actual requests are limited', async () => {
    const app = express();
    app.use(rateLimit({ windowMs: 60_000, max: 2, skip: skipCorsPreflight }));
    app.use((_req, res) => { res.sendStatus(204); });
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/`;
    try {
        for (let index = 0; index < 10; index++) assert.equal((await fetch(url, { method: 'OPTIONS' })).status, 204);
        assert.equal((await fetch(url)).status, 204);
        assert.equal((await fetch(url)).status, 204);
        assert.equal((await fetch(url)).status, 429);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
