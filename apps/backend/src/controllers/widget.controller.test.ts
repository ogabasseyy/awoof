import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import { db } from '../config/database.js';
import { BadRequestError, ForbiddenError } from '../common/errors/AppError.js';
import { domainCheck } from './widget.controller.js';

function responseRecorder() {
    const bodies: unknown[] = [];
    const recorder = {
        status: () => recorder,
        json: (body: unknown) => { bodies.push(body); },
    };
    return { bodies, res: recorder as unknown as Response };
}

test('domainCheck ignores API keys in the query string', async (t) => {
    // The key must never travel in the URL (logs/history/Referer exposure),
    // so query parameters must not authenticate — not even reach the database.
    t.mock.method(db, 'query', async () => { throw new Error('query string must not reach the database'); });
    const { bodies, res } = responseRecorder();
    await assert.rejects(
        domainCheck(
            { query: { domain: 'shop.example.com', apiKey: 'awoof_widget_query' } } as unknown as Request,
            res,
        ),
        (error: unknown) => error instanceof BadRequestError,
    );
    assert.deepEqual(bodies, []);
});

test('domainCheck accepts body credentials and normalizes the domain', async (t) => {
    const seen: Array<{ params: unknown[] | undefined }> = [];
    t.mock.method(db, 'query', async (_text: string, params?: unknown[]) => {
        seen.push({ params });
        return { rows: [{ vendor_id: 'vendor-1' }], rowCount: 1 } as never;
    });
    const { bodies, res } = responseRecorder();
    await domainCheck(
        { body: { domain: 'https://Shop.Example.com/some/path', apiKey: 'awoof_widget_body' } } as unknown as Request,
        res,
    );
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]?.params, ['awoof_widget_body', 'shop.example.com']);
    assert.deepEqual(bodies, [{
        success: true,
        message: 'Domain allowed',
        data: { allowed: true, vendorId: 'vendor-1' },
    }]);
});

test('domainCheck rejects unknown domain/key pairs', async (t) => {
    t.mock.method(db, 'query', async () => ({ rows: [], rowCount: 0 }) as never);
    const { bodies, res } = responseRecorder();
    await assert.rejects(
        domainCheck(
            { body: { domain: 'evil.example.com', apiKey: 'awoof_widget_unknown' } } as unknown as Request,
            res,
        ),
        (error: unknown) => error instanceof ForbiddenError,
    );
    assert.deepEqual(bodies, []);
});
