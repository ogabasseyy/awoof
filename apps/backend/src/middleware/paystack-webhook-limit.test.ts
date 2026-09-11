import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { config } from '../config/env.js';
import { paystackWebhookLimiter } from './paystack-webhook-limit.js';

test('authentic webhook bursts bypass the shared IP abuse quota', async () => {
    const key = config.paystack.secretKey;
    Object.assign(config.paystack, { secretKey: 'synthetic-webhook-key' });
    const app = express();
    app.post('/', express.raw({ type: 'application/json', limit: '100kb' }), paystackWebhookLimiter, (_req, res) => { res.sendStatus(200); });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/`;
    const body = JSON.stringify({ event: 'synthetic' });
    const signature = createHmac('sha512', 'synthetic-webhook-key').update(body).digest('hex');
    try {
        for (let i = 0; i < 120; i++) {
            const response = await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-paystack-signature': signature } });
            assert.equal(response.status, 200);
            await response.text();
        }
        for (let i = 0; i < 61; i++) {
            const response = await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
            assert.equal(response.status, i < 60 ? 200 : 429);
            await response.text();
        }
        const response = await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-paystack-signature': signature } });
        assert.equal(response.status, 200);
        await response.text();
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        Object.assign(config.paystack, { secretKey: key });
    }
});
