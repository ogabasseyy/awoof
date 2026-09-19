import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import { isMicrosoftRoute, microsoftCors } from './microsoft-cors.js';

test('classifies only the Microsoft verification namespace', () => {
    assert.equal(isMicrosoftRoute('/api/verification/microsoft/start'), true);
    assert.equal(isMicrosoftRoute('/api/verification/microsoft'), true);
    assert.equal(isMicrosoftRoute('/API/Verification/Microsoft/START'), true);
    assert.equal(isMicrosoftRoute('/api/verification/Microsoft/consents'), true);
    assert.equal(isMicrosoftRoute('/api/verification/microsoft-extra'), false);
    assert.equal(isMicrosoftRoute('/API/Verification/Microsoft-extra'), false);
    assert.equal(isMicrosoftRoute('/api/widget/config'), false);
});

test('advertises GET in Microsoft CORS preflights so credentialed reads pass', () => {
    const middleware = microsoftCors({ frontendOrigin: 'http://localhost:3000' });
    const headers: Record<string, string> = {};
    let statusCode = 0;
    let ended = false;
    const req = {
        path: '/api/verification/microsoft/notice', method: 'OPTIONS',
        header: (name: string) => name.toLowerCase() === 'origin' ? 'http://localhost:3000' : undefined,
    } as unknown as Request;
    const res = {
        getHeader: (name: string) => headers[name],
        setHeader: (name: string, value: string) => { headers[name] = value; },
        status: (code: number) => ({ end: () => { statusCode = code; ended = true; }, json: () => undefined }),
    } as unknown as Response;
    middleware(req, res, () => { throw new Error('preflight must not reach the router'); });
    assert.equal(statusCode, 204);
    assert.equal(ended, true);
    assert.match(headers['Access-Control-Allow-Methods'] ?? '', /\bGET\b/);
});
