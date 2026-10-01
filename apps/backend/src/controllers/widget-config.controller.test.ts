import assert from 'node:assert/strict';
import test from 'node:test';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { db } from '../config/database.js';
import { BadRequestError } from '../common/errors/AppError.js';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import { updateWidgetConfig } from './widget-config.controller.js';

function responseRecorder() {
    const bodies: unknown[] = [];
    const recorder = {
        status: () => recorder,
        set: () => recorder,
        json: (body: unknown) => { bodies.push(body); },
    };
    return { bodies, res: recorder as unknown as Response };
}

const vendorReq = (body: unknown) => ({ user: { userId: 'user-1', role: 'vendor' }, body }) as unknown as AuthRequest;

async function queryDouble(t: Parameters<Parameters<typeof test>[1]>[0], seen: unknown[][], existingOrigins: unknown = null) {
    t.mock.method(db, 'query', async (text: string, params?: unknown[]) => {
        if (text.includes('FROM vendors WHERE user_id')) return { rows: [{ id: 'vendor-1' }], rowCount: 1 } as never;
        if (text.includes('FROM widget_configs WHERE vendor_id')) {
            return (existingOrigins === null
                ? { rows: [], rowCount: 0 }
                : { rows: [{ allowed_origins: existingOrigins }], rowCount: 1 }) as never;
        }
        seen.push(params ?? []);
        return { rows: [{ api_key: 'awoof_widget_new', status: 'active' }], rowCount: 1 } as never;
    });
}

test('updateWidgetConfig stores exact origins with ports and development localhost', async (t) => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const seen: unknown[][] = [];
    await queryDouble(t, seen, ['https://stale.example.com']);
    const { bodies, res } = responseRecorder();
    try {
        await updateWidgetConfig(vendorReq({
            allowedDomains: ['shop.example.com', 'localhost'],
            allowedOrigins: ['https://shop.example.com:8443', 'http://localhost:8080'],
        }), res);
    } finally {
        if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
    }
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]?.[2], ['https://shop.example.com:8443', 'http://localhost:8080']);
    assert.deepEqual((bodies[0] as { data: { allowedOrigins: unknown } }).data.allowedOrigins,
        ['https://shop.example.com:8443', 'http://localhost:8080']);
});

test('updateWidgetConfig rejects origins the enforcement path cannot match', async (t) => {
    const seen: unknown[][] = [];
    await queryDouble(t, seen);
    const { res } = responseRecorder();
    await assert.rejects(
        updateWidgetConfig(vendorReq({ allowedDomains: ['shop.example.com'], allowedOrigins: ['https://shop.example.com/search?q=1'] }), res),
        BadRequestError,
    );
    assert.equal(seen.length, 0);
});

test('updateWidgetConfig rejects explicit origins outside the submitted domains', async (t) => {
    const seen: unknown[][] = [];
    await queryDouble(t, seen);
    const { res } = responseRecorder();
    await assert.rejects(
        updateWidgetConfig(vendorReq({ allowedDomains: ['shop.example.com'], allowedOrigins: ['https://other.example.com'] }), res),
        /must belong to a submitted allowed domain/,
    );
    assert.equal(seen.length, 0);
});

test('updateWidgetConfig derives https origins when none are supplied', async (t) => {
    const seen: unknown[][] = [];
    await queryDouble(t, seen);
    const { bodies, res } = responseRecorder();
    await updateWidgetConfig(vendorReq({ allowedDomains: ['Shop.Example.com'] }), res);
    assert.deepEqual(seen[0]?.[2], ['https://shop.example.com']);
    assert.deepEqual((bodies[0] as { data: { allowedOrigins: unknown } }).data.allowedOrigins, ['https://shop.example.com']);
});

test('updateWidgetConfig keeps compatible custom origins when origins are omitted', async (t) => {
    const seen: unknown[][] = [];
    await queryDouble(t, seen, ['https://shop.example.com:8443']);
    const { bodies, res } = responseRecorder();
    await updateWidgetConfig(vendorReq({ allowedDomains: ['shop.example.com', 'new.example.com'] }), res);
    assert.deepEqual(seen[0]?.[2], ['https://shop.example.com:8443', 'https://new.example.com']);
    assert.deepEqual((bodies[0] as { data: { allowedOrigins: unknown } }).data.allowedOrigins,
        ['https://shop.example.com:8443', 'https://new.example.com']);
});

test('updateWidgetConfig drops omitted origins whose domain was removed', async (t) => {
    const seen: unknown[][] = [];
    await queryDouble(t, seen, ['https://shop.example.com:8443', 'https://old.example.com']);
    const { res } = responseRecorder();
    await updateWidgetConfig(vendorReq({ allowedDomains: ['shop.example.com'] }), res);
    assert.deepEqual(seen[0]?.[2], ['https://shop.example.com:8443']);
});

test('updateWidgetConfig drops stored origins that cannot match enforcement', async (t) => {
    const seen: unknown[][] = [];
    await queryDouble(t, seen, ['not-a-url', 42, 'https://shop.example.com:8443']);
    const { res } = responseRecorder();
    await updateWidgetConfig(vendorReq({ allowedDomains: ['shop.example.com'] }), res);
    assert.deepEqual(seen[0]?.[2], ['https://shop.example.com:8443']);
});

test('updateWidgetConfig rejects a string regenerateApiKey without touching the stored key', async (t) => {
    const seen: unknown[][] = [];
    await queryDouble(t, seen);
    const { res } = responseRecorder();
    await assert.rejects(
        updateWidgetConfig(vendorReq({ allowedDomains: ['shop.example.com'], regenerateApiKey: 'false' }), res),
        ZodError,
    );
    assert.equal(seen.length, 0);
});

test('updateWidgetConfig rotates the key only for a boolean true regenerateApiKey', async (t) => {
    const seen: unknown[][] = [];
    await queryDouble(t, seen);
    const { bodies, res } = responseRecorder();
    await updateWidgetConfig(vendorReq({ allowedDomains: ['shop.example.com'], regenerateApiKey: true }), res);
    assert.equal(seen[0]?.[4], true);
    assert.equal((bodies[0] as { data: { apiKey: unknown } }).data.apiKey, 'awoof_widget_new');
});
