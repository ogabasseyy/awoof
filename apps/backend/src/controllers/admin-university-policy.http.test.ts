import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { db } from '../config/database.js';
import { errorHandler } from '../common/middleware/errorHandler.js';
import adminRouter from '../routes/admin.routes.js';
import { jwtService } from '../services/auth/jwt.service.js';

test('policy approval rejects incomplete, wildcard and caller-authority payloads before acquiring a connection', async (t) => {
    t.mock.method(db, 'query', async () => ({ rows: [{ role: 'admin', deleted_at: null }] }));
    t.mock.method(db, 'getPool', () => { throw new Error('Invalid input must not acquire a database connection'); });
    const app = express();
    app.use(express.json());
    app.use('/admin', adminRouter);
    app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a loopback port');
    const token = jwtService.generateAccessToken({ userId: '35176342-b6fc-43e8-bad2-31052c61cf88', email: 'admin@example.invalid', role: 'admin' });
    const endpoint = `http://127.0.0.1:${address.port}/admin/universities/80dcaee5-d77e-4eb2-bc35-a54d83b5ade4/verification-policy`;
    const policy = { domains: [], emailEvidenceValidityDays: 90, enrollmentValidityDays: 30, registrationNormalization: null, isActive: true };
    try {
        for (const body of [{}, { ...policy, actorUserId: 'another-user' }, { ...policy, emailEvidenceValidityDays: 0 }]) {
            const response = await fetch(endpoint, {
                method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            assert.equal(response.status, 422);
        }
        const wildcard = await fetch(endpoint, {
            method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ ...policy, domains: ['*.school.example'] }),
        });
        assert.equal(wildcard.status, 400);
        assert.equal((await fetch(endpoint)).status, 401);
    } finally {
        server.close();
        await once(server, 'close');
    }
});
