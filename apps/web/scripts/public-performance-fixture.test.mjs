// Fixture completeness gate: CORS, deterministic data, image bytes, denials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { APPROVED_ORIGIN, datasetDescriptor, startFixture } from './public-performance-fixture.mjs';

const EVIL_ORIGIN = 'http://evil.test';

function pngSize(bytes) {
  const view = new Uint8Array(bytes);
  assert.deepEqual([...view.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const width = (view[16] << 24) | (view[17] << 16) | (view[18] << 8) | view[19];
  const height = (view[20] << 24) | (view[21] << 16) | (view[22] << 8) | view[23];
  return { width, height };
}

test('fixture serves approved origins with CORS headers and rejects others', async () => {
  const fixture = await startFixture(0);
  try {
    const base = `http://127.0.0.1:${fixture.port}`;
    const ok = await fetch(`${base}/api/universities`, { headers: { Origin: APPROVED_ORIGIN } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), APPROVED_ORIGIN);
    assert.equal(ok.headers.get('vary'), 'Origin');

    const evil = await fetch(`${base}/api/universities`, { headers: { Origin: EVIL_ORIGIN } });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
  } finally {
    await fixture.close();
  }
});

test('fixture answers preflight for the methods and headers the app client sends', async () => {
  const fixture = await startFixture(0);
  try {
    const base = `http://127.0.0.1:${fixture.port}`;
    const preflight = await fetch(`${base}/api/products`, {
      method: 'OPTIONS',
      headers: {
        Origin: APPROVED_ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Content-Type, Authorization',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), APPROVED_ORIGIN);
    assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /Content-Type/i);

    const evilPreflight = await fetch(`${base}/api/products`, {
      method: 'OPTIONS',
      headers: { Origin: EVIL_ORIGIN, 'Access-Control-Request-Method': 'GET' },
    });
    assert.equal(evilPreflight.status, 403);
  } finally {
    await fixture.close();
  }
});

test('fixture query-dependent responses are stable and correctly filtered', async () => {
  const fixture = await startFixture(0);
  try {
    const base = `http://127.0.0.1:${fixture.port}`;
    const first = await (await fetch(`${base}/api/products?limit=20&deal_type=product`)).text();
    const second = await (await fetch(`${base}/api/products?limit=20&deal_type=product`)).text();
    assert.equal(first, second);
    const products = JSON.parse(first).data.products;
    assert.equal(products.length, 6);
    assert.ok(products.every((p) => p.deal_type === 'product'));

    const vouchers = JSON.parse(await (await fetch(`${base}/api/products?limit=20&deal_type=voucher`)).text()).data.products;
    assert.equal(vouchers.length, 2);

    const filtered = JSON.parse(await (await fetch(`${base}/api/products?categoryId=cat-food&limit=20&deal_type=product`)).text()).data.products;
    assert.ok(filtered.length > 0 && filtered.every((p) => p.category_id === 'cat-food'));

    const limited = JSON.parse(await (await fetch(`${base}/api/products?limit=2&deal_type=product`)).text()).data.products;
    assert.equal(limited.length, 2);

    const categories = JSON.parse(await (await fetch(`${base}/api/products/categories`)).text()).data;
    assert.equal(categories.length, 2);
  } finally {
    await fixture.close();
  }
});

test('fixture serves deterministic image bytes with fixed dimensions', async () => {
  const fixture = await startFixture(0);
  try {
    const base = `http://127.0.0.1:${fixture.port}`;
    const first = Buffer.from(await (await fetch(`${base}/images/products/deal-alpha.png`)).arrayBuffer());
    const response = await fetch(`${base}/images/products/deal-alpha.png`, { headers: { Origin: APPROVED_ORIGIN } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('access-control-allow-origin'), APPROVED_ORIGIN);
    const second = Buffer.from(await response.arrayBuffer());
    assert.ok(first.equals(second));
    assert.deepEqual(pngSize(first), { width: 800, height: 450 });

    const logo = Buffer.from(await (await fetch(`${base}/images/vendors/vendor-acme.png`)).arrayBuffer());
    assert.deepEqual(pngSize(logo), { width: 200, height: 200 });
  } finally {
    await fixture.close();
  }
});

test('fixture denies missing images and unknown paths', async () => {
  const fixture = await startFixture(0);
  try {
    const base = `http://127.0.0.1:${fixture.port}`;
    assert.equal((await fetch(`${base}/images/products/nope.png`)).status, 404);
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
    assert.equal((await fetch(`${base}/other`)).status, 404);
  } finally {
    await fixture.close();
  }
});

test('fixture dataset hash is stable', async () => {
  const first = datasetDescriptor();
  const second = datasetDescriptor();
  assert.equal(first.datasetHash, second.datasetHash);
  assert.deepEqual(Object.keys(first.imageHashes).sort(), [
    '/images/products/deal-alpha.png',
    '/images/products/deal-beta.png',
    '/images/products/voucher-gamma.png',
    '/images/vendors/vendor-acme.png',
  ]);
});
