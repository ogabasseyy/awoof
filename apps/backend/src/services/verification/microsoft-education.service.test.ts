import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyEducation, MicrosoftEducationService } from './microsoft-education.service.js';

const graphUrl = 'https://graph.microsoft.com/v1.0/education/me?$select=id,primaryRole,userType,accountEnabled';
const observedAt = new Date('2026-09-12T10:00:00.000Z');
const valid = { id: 'oid-1', primaryRole: 'student', userType: 'Member', accountEnabled: true };

function service(fetch: typeof globalThis.fetch, timeoutMs?: number): MicrosoftEducationService {
    return new MicrosoftEducationService({ fetch, now: () => observedAt, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

test('classifies only a same-ID enabled Member student as a candidate observation', () => {
    assert.deepEqual(classifyEducation(valid, 'oid-1', observedAt), { outcome: 'student', objectId: 'oid-1', observedAt });
    assert.deepEqual(classifyEducation({ ...valid, id: 'other' }, 'oid-1', observedAt), { outcome: 'unknown', reason: 'identity_mismatch' });
    assert.deepEqual(classifyEducation({ ...valid, userType: 'Guest' }, 'oid-1', observedAt), { outcome: 'unknown', reason: 'account_not_eligible' });
    for (const body of [{ ...valid, accountEnabled: false }, { id: 'oid-1', primaryRole: 'student', userType: 'Member' }, { id: 'oid-1', primaryRole: 'student', accountEnabled: true }]) {
        assert.deepEqual(classifyEducation(body, 'oid-1', observedAt), { outcome: 'unknown', reason: 'account_not_eligible' });
    }
    for (const primaryRole of ['teacher', 'none', 'other']) {
        assert.deepEqual(classifyEducation({ ...valid, primaryRole }, 'oid-1', observedAt), { outcome: 'unknown', reason: 'role_not_confirmed' });
    }
    assert.deepEqual(classifyEducation({ id: 'oid-1', userType: 'Member', accountEnabled: true }, 'oid-1', observedAt), { outcome: 'unknown', reason: 'role_not_confirmed' });
    for (const body of [{ ...valid, id: 1 }, { ...valid, primaryRole: 1 }, { ...valid, userType: 1 }, { ...valid, accountEnabled: 'true' }, { value: valid }]) {
        assert.deepEqual(classifyEducation(body, 'oid-1', observedAt), { outcome: 'unknown', reason: 'unavailable' });
    }
    assert.deepEqual(classifyEducation({ primaryRole: 'student', userType: 'Member', accountEnabled: true }, undefined as unknown as string, observedAt), { outcome: 'unknown', reason: 'unavailable' });
    assert.deepEqual(classifyEducation(valid, 'oid-1', new Date(Number.NaN)), { outcome: 'unknown', reason: 'unavailable' });
});

test('uses one fixed, bounded Graph request and server observation time', async () => {
    let input = ''; let init: RequestInit | undefined;
    const result = await service(async (value, options) => {
        input = value.toString(); init = options;
        return Response.json({ ...valid, observedAt: 'attacker-controlled' });
    }).observe({ accessToken: 'opaque-token', expectedOid: 'oid-1' });
    assert.equal(input, graphUrl);
    assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer opaque-token');
    assert.deepEqual(result, { outcome: 'student', objectId: 'oid-1', observedAt });
});

test('fails closed when the server clock is invalid', async () => {
    const result = await new MicrosoftEducationService({ fetch: async () => Response.json(valid), now: () => new Date(Number.NaN) })
        .observe({ accessToken: 'opaque-token', expectedOid: 'oid-1' });
    assert.deepEqual(result, { outcome: 'unknown', reason: 'unavailable' });
});

test('maps Graph permission and availability failures to non-positive observations without provider details', async () => {
    for (const [status, expected] of [[401, 'permission_required'], [403, 'permission_required'], [404, 'unavailable'], [429, 'unavailable'], [500, 'unavailable']] as const) {
        const result = await service(async () => new Response('profile payload', { status })).observe({ accessToken: 'secret', expectedOid: 'oid-1' });
        assert.deepEqual(result, { outcome: 'unknown', reason: expected });
    }
    const network = await service(async () => { throw new Error('secret profile'); }).observe({ accessToken: 'secret', expectedOid: 'oid-1' });
    assert.deepEqual(network, { outcome: 'unknown', reason: 'unavailable' });
});

test('fails closed for invalid JSON and unexpected response shapes', async () => {
    for (const body of ['not json', JSON.stringify([valid]), JSON.stringify({ value: valid }), JSON.stringify(null)]) {
        const result = await service(async () => new Response(body, { status: 200 })).observe({ accessToken: 'secret', expectedOid: 'oid-1' });
        assert.deepEqual(result, { outcome: 'unknown', reason: 'unavailable' });
    }
});

test('rejects hostile redirects and cancels their response stream', async () => {
    let cancellations = 0;
    const result = await service(async () => new Response(new ReadableStream({ cancel() { cancellations += 1; } }), { status: 302, headers: { location: 'https://attacker.invalid/' } })).observe({ accessToken: 'secret', expectedOid: 'oid-1' });
    assert.deepEqual(result, { outcome: 'unknown', reason: 'unavailable' });
    assert.equal(cancellations, 1);
});

test('bounds chunked response bytes and cancels a locked stream', async () => {
    let cancellations = 0;
    const result = await service(async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(262_145)); },
        cancel() { cancellations += 1; },
    }))).observe({ accessToken: 'secret', expectedOid: 'oid-1' });
    assert.deepEqual(result, { outcome: 'unknown', reason: 'unavailable' });
    assert.equal(cancellations, 1);
});

test('deadline includes a stalled response body and cancels the stream', async () => {
    let cancellations = 0;
    const result = await service(async () => new Response(new ReadableStream({ cancel() { cancellations += 1; } })), 10)
        .observe({ accessToken: 'secret', expectedOid: 'oid-1' });
    assert.deepEqual(result, { outcome: 'unknown', reason: 'unavailable' });
    assert.equal(cancellations, 1);
});

test('deadline includes stalled response headers', async () => {
    const result = await service(async () => await new Promise<Response>(() => undefined), 10)
        .observe({ accessToken: 'secret', expectedOid: 'oid-1' });
    assert.deepEqual(result, { outcome: 'unknown', reason: 'unavailable' });
});
