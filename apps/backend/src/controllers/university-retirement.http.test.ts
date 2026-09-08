import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import universities from '../routes/universities.routes.js';
import { errorHandler } from '../common/middleware/errorHandler.js';

test('legacy public verification configuration route is retired without returning provider details', async () => {
    const app = express(); app.use('/universities', universities); app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    try {
        const response = await fetch(`http://127.0.0.1:${address.port}/universities/fixture/verification-methods`);
        assert.equal(response.status, 410);
        const body = await response.text();
        assert.match(body, /VERIFICATION_ROUTE_RETIRED/);
        assert.doesNotMatch(body, /apiConfig|apiEndpoint|api_config|api_endpoint/);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
