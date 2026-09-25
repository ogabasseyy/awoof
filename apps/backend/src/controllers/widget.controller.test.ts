import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import { db } from '../config/database.js';
import { BadRequestError, ForbiddenError } from '../common/errors/AppError.js';
import { domainCheck, merchantContext } from './widget.controller.js';
import { canonicalWidgetOrigin } from '../services/verification/eligibility-merchant-context.service.js';

test('development widget origins accept the bracketed IPv6 loopback hostname', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
        assert.equal(canonicalWidgetOrigin('http://[::1]:3107'), 'http://[::1]:3107');
    } finally {
        if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
    }
});

function responseRecorder() {
    const bodies: unknown[] = [];
    const recorder = {
        status: () => recorder,
        set: () => recorder,
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
    assert.deepEqual(seen[0]?.params, ['awoof_widget_body', 'shop.example.com', null]);
    assert.deepEqual(bodies, [{
        success: true,
        message: 'Domain allowed',
        data: { allowed: true, vendorId: 'vendor-1' },
    }]);
});

test('domainCheck binds a pilot site to its exact registered origin', async (t) => {
    let queries = 0;
    t.mock.method(db, 'query', async (_text: string, params?: unknown[]) => {
        queries += 1;
        assert.deepEqual(params, ['widget-key', 'shop.example.com', 'https://shop.example.com']);
        return { rows: [{ vendor_id: 'vendor-1' }], rowCount: 1 } as never;
    });
    const { res } = responseRecorder();
    await domainCheck({ body: { domain: 'shop.example.com', origin: 'https://shop.example.com', apiKey: 'widget-key' } } as Request, res);
    assert.equal(queries, 1);
    await assert.rejects(domainCheck({ body: { domain: 'shop.example.com', origin: 'https://evil.example.com', apiKey: 'widget-key' } } as Request, res), BadRequestError);
    assert.equal(queries, 1);
});

test('merchantContext returns only a registered merchant display name and origin', async (t) => {
    const vendorId = '4f088fa7-79d9-4c64-a48c-9ecbbbc3c4a3';
    const previous = [process.env.AWOOF_WIDGET_PILOT_ENABLED, process.env.AWOOF_WIDGET_PILOT_VENDOR_IDS];
    process.env.AWOOF_WIDGET_PILOT_ENABLED = 'true';
    process.env.AWOOF_WIDGET_PILOT_VENDOR_IDS = vendorId;
    t.mock.method(db, 'query', async (_text: string, params?: unknown[]) => {
        assert.deepEqual(params, [vendorId, 'https://shop.example.com']);
        return { rows: [{ name: 'Test Merchant' }], rowCount: 1 } as never;
    });
    const { bodies, res } = responseRecorder();
    try {
        await merchantContext({ body: { vendorId, origin: 'https://shop.example.com' } } as Request, res);
        assert.deepEqual(bodies, [{ success: true, message: 'Merchant context', data: { vendorId, origin: 'https://shop.example.com', merchantName: 'Test Merchant' } }]);
    } finally {
        if (previous[0] === undefined) delete process.env.AWOOF_WIDGET_PILOT_ENABLED; else process.env.AWOOF_WIDGET_PILOT_ENABLED = previous[0];
        if (previous[1] === undefined) delete process.env.AWOOF_WIDGET_PILOT_VENDOR_IDS; else process.env.AWOOF_WIDGET_PILOT_VENDOR_IDS = previous[1];
    }
});

test('merchantContext stays unavailable without the pilot gate', async (t) => {
    const previous = process.env.AWOOF_WIDGET_PILOT_ENABLED;
    process.env.AWOOF_WIDGET_PILOT_ENABLED = 'false';
    t.mock.method(db, 'query', async () => { throw new Error('disabled pilot must not query'); });
    const { res } = responseRecorder();
    try {
        await assert.rejects(merchantContext({ body: { vendorId: '4f088fa7-79d9-4c64-a48c-9ecbbbc3c4a3', origin: 'https://shop.example.com' } } as Request, res), ForbiddenError);
    } finally {
        if (previous === undefined) delete process.env.AWOOF_WIDGET_PILOT_ENABLED; else process.env.AWOOF_WIDGET_PILOT_ENABLED = previous;
    }
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
