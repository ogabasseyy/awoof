// Deterministic public API fixture for lab performance measurement.
//
// Serves fixed synthetic university/deal responses plus deterministic product
// image bytes on the API origin (default http://127.0.0.1:3108). Unknown paths
// are denied; no live services are proxied. CORS allows only the browser
// origin http://127.0.0.1:3107. Test-only fixture settings, not production policy.
//
// Usable as a library (`startFixture(port)`) or standalone:
//   node scripts/public-performance-fixture.mjs [port]
//   node scripts/public-performance-fixture.mjs --print-hash
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = dirname(here);
const imageDir = join(webRoot, 'tests', 'fixtures', 'public-performance');

export const FIXTURE_PORT = 3108;
export const APPROVED_ORIGIN = 'http://127.0.0.1:3107';
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

const UNIVERSITIES = [
  { id: '10000000-0000-4000-8000-000000000001', name: 'Approved Alpha University', shortcode: 'AAU', domain: 'alpha.approved.test', country: 'Nigeria' },
  { id: '10000000-0000-4000-8000-000000000002', name: 'Synthetic Beta University', shortcode: 'SBU', domain: 'beta.synthetic.test', country: 'Ghana' },
];

const CATEGORIES = [
  { id: 'cat-food', name: 'Food & Drink', slug: 'food-drink', description: 'Synthetic everyday food deals.' },
  { id: 'cat-tech', name: 'Tech & Learning', slug: 'tech-learning', description: 'Synthetic devices and study tools.' },
];

const PRODUCTS = [
  { id: 'prod-alpha-1', name: 'Synthetic Study Fuel Pack', description: 'Fixed synthetic product.', price: 15000, student_price: 12000, image_url: '/images/products/deal-alpha.png', category_id: 'cat-food', category_name: 'Food & Drink', vendor_name: 'Synthetic Foods', vendor_logo_url: '/images/vendors/vendor-acme.png', deal_type: 'product', stock: 40 },
  { id: 'prod-alpha-2', name: 'Synthetic Campus Coffee Box', description: 'Fixed synthetic product.', price: 8000, student_price: 6500, image_url: '/images/products/deal-beta.png', category_id: 'cat-food', category_name: 'Food & Drink', vendor_name: 'Synthetic Foods', vendor_logo_url: '/images/vendors/vendor-acme.png', deal_type: 'product', stock: 25 },
  { id: 'prod-beta-1', name: 'Synthetic Notebook Bundle', description: 'Fixed synthetic product.', price: 6000, student_price: 4500, image_url: '/images/products/deal-beta.png', category_id: 'cat-tech', category_name: 'Tech & Learning', vendor_name: 'Synthetic Supply', vendor_logo_url: '/images/vendors/vendor-acme.png', deal_type: 'product', stock: 100 },
  { id: 'prod-beta-2', name: 'Synthetic Headphone Stand', description: 'Fixed synthetic product.', price: 20000, student_price: 16000, image_url: '/images/products/deal-alpha.png', category_id: 'cat-tech', category_name: 'Tech & Learning', vendor_name: 'Synthetic Supply', vendor_logo_url: '/images/vendors/vendor-acme.png', deal_type: 'product', stock: 12 },
  { id: 'prod-beta-3', name: 'Synthetic Desk Lamp', description: 'Fixed synthetic product.', price: 12000, student_price: 9000, image_url: '/images/products/deal-alpha.png', category_id: 'cat-tech', category_name: 'Tech & Learning', vendor_name: 'Synthetic Supply', vendor_logo_url: '/images/vendors/vendor-acme.png', deal_type: 'product', stock: 30 },
  { id: 'prod-food-3', name: 'Synthetic Snack Crate', description: 'Fixed synthetic product.', price: 5000, student_price: 4000, image_url: '/images/products/deal-beta.png', category_id: 'cat-food', category_name: 'Food & Drink', vendor_name: 'Synthetic Foods', vendor_logo_url: '/images/vendors/vendor-acme.png', deal_type: 'product', stock: 60 },
  { id: 'vouch-gamma-1', name: 'Synthetic Cinema Voucher', description: 'Fixed synthetic voucher.', price: 7000, student_price: 3500, image_url: '/images/products/voucher-gamma.png', category_id: 'cat-food', category_name: 'Food & Drink', vendor_name: 'Synthetic Foods', vendor_logo_url: '/images/vendors/vendor-acme.png', deal_type: 'voucher', stock: 200 },
  { id: 'vouch-gamma-2', name: 'Synthetic Course Voucher', description: 'Fixed synthetic voucher.', price: 25000, student_price: 15000, image_url: '/images/products/voucher-gamma.png', category_id: 'cat-tech', category_name: 'Tech & Learning', vendor_name: 'Synthetic Supply', vendor_logo_url: '/images/vendors/vendor-acme.png', deal_type: 'voucher', stock: 150 },
];

const IMAGE_FILES = {
  '/images/products/deal-alpha.png': 'deal-alpha.png',
  '/images/products/deal-beta.png': 'deal-beta.png',
  '/images/products/voucher-gamma.png': 'voucher-gamma.png',
  '/images/vendors/vendor-acme.png': 'vendor-acme.png',
};

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function loadImageBytes() {
  const entries = {};
  for (const [routePath, file] of Object.entries(IMAGE_FILES)) {
    entries[routePath] = readFileSync(join(imageDir, file));
  }
  return entries;
}

export function datasetDescriptor() {
  const images = loadImageBytes();
  const imageHashes = Object.fromEntries(
    Object.entries(images).map(([routePath, bytes]) => [routePath, sha256Hex(bytes)]),
  );
  const canonical = JSON.stringify({ UNIVERSITIES, CATEGORIES, PRODUCTS, imageHashes });
  return { datasetHash: sha256Hex(canonical), imageHashes };
}

function json(res, status, payload, origin) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    vary: 'Origin',
    ...(origin ? { 'access-control-allow-origin': origin } : {}),
  });
  res.end(body);
}

export async function startFixture(port = FIXTURE_PORT) {
  const images = loadImageBytes();
  const { datasetHash } = datasetDescriptor();
  const requests = [];

  const server = createServer((req, res) => {
    const origin = req.headers.origin;
    const approved = origin === undefined || origin === APPROVED_ORIGIN;
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const record = (status) => requests.push({ method: req.method, path: url.pathname, query: url.search, status });

    if (!approved) {
      record(403);
      json(res, 403, { success: false, error: { message: 'Origin not allowed by the performance fixture.' } }, undefined);
      return;
    }
    const corsOrigin = origin === APPROVED_ORIGIN ? APPROVED_ORIGIN : undefined;

    if (req.method === 'OPTIONS') {
      record(204);
      res.writeHead(204, {
        vary: 'Origin',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'Content-Type, Authorization',
        'access-control-max-age': '600',
        ...(corsOrigin ? { 'access-control-allow-origin': corsOrigin } : {}),
      });
      res.end();
      return;
    }

    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/images/')) {
      record(404);
      json(res, 404, { success: false, error: { message: 'Denied by the performance fixture.' } }, corsOrigin);
      return;
    }

    if (url.pathname === '/api/universities' && req.method === 'GET') {
      record(200);
      json(res, 200, { success: true, data: { universities: UNIVERSITIES, total: UNIVERSITIES.length } }, corsOrigin);
      return;
    }

    if (url.pathname === '/api/products' && req.method === 'GET') {
      const dealType = url.searchParams.get('deal_type');
      const categoryId = url.searchParams.get('categoryId');
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
      let list = [...PRODUCTS];
      if (dealType === 'product' || dealType === 'voucher') list = list.filter((p) => p.deal_type === dealType);
      if (categoryId) list = list.filter((p) => p.category_id === categoryId);
      if (Number.isFinite(limit) && limit >= 0) list = list.slice(0, limit);
      record(200);
      json(res, 200, { success: true, data: { products: list } }, corsOrigin);
      return;
    }

    if (url.pathname === '/api/products/categories' && req.method === 'GET') {
      record(200);
      json(res, 200, { success: true, data: CATEGORIES }, corsOrigin);
      return;
    }

    if (url.pathname === '/api/auth/me' && req.method === 'GET') {
      record(401);
      json(res, 401, { success: false, error: { message: 'Unauthorized' } }, corsOrigin);
      return;
    }

    if (url.pathname === '/api/verification/status' && req.method === 'GET') {
      record(200);
      json(res, 200, { success: true, data: { mailboxConfirmed: false, eligibility: { eligible: false } } }, corsOrigin);
      return;
    }

    if (url.pathname === '/api/students/savings' && req.method === 'GET') {
      record(200);
      json(res, 200, { success: true, data: { summary: { totalSavings: 0, totalPurchases: 0 } } }, corsOrigin);
      return;
    }

    if (url.pathname.startsWith('/images/') && req.method === 'GET') {
      const bytes = images[url.pathname];
      if (!bytes) {
        record(404);
        json(res, 404, { success: false, error: { message: 'No such fixture image.' } }, corsOrigin);
        return;
      }
      record(200);
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': bytes.length,
        'cache-control': CACHE_CONTROL,
        etag: `"${sha256Hex(bytes).slice(0, 32)}"`,
        vary: 'Origin',
        ...(corsOrigin ? { 'access-control-allow-origin': corsOrigin } : {}),
      });
      res.end(bytes);
      return;
    }

    record(404);
    json(res, 404, { success: false, error: { message: 'Denied by the performance fixture.' } }, corsOrigin);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    server,
    port: server.address().port,
    datasetHash,
    requests,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const invoked = process.argv[1] === fileURLToPath(import.meta.url);
if (invoked) {
  if (process.argv.includes('--print-hash')) {
    const { datasetHash, imageHashes } = datasetDescriptor();
    process.stdout.write(`${JSON.stringify({ datasetHash, imageHashes }, null, 2)}\n`);
  } else {
    const port = Number.parseInt(process.argv[2] ?? String(FIXTURE_PORT), 10);
    const fixture = await startFixture(Number.isFinite(port) ? port : FIXTURE_PORT);
    process.stdout.write(`fixture on 127.0.0.1:${fixture.port} dataset=${fixture.datasetHash}\n`);
  }
}
