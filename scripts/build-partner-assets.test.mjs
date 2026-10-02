import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { buildPartnerAssets, merchantApiReference, partnerOperations, starterArchiveEpoch, starterFiles } from './build-partner-assets.mjs';

function spec() {
  return {
    openapi: '3.0.0',
    info: { version: '1.0.0', contact: { email: 'unverified-address@example.test' } },
    servers: [{ url: 'https://internal.example.test' }],
    paths: {
      ...Object.fromEntries(partnerOperations.map(([path, method]) => [path, { [method]: {
        responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Receipt' } } } } },
        security: [{ merchantServerKey: [] }],
      } }])),
      '/api/admin/private': { get: { responses: { 200: {} } } },
    },
    components: {
      schemas: { Receipt: { properties: { subject: { $ref: '#/components/schemas/Subject' } } }, Subject: { type: 'string' }, InternalAdmin: { type: 'object' } },
      securitySchemes: { merchantServerKey: { type: 'http', scheme: 'bearer' }, adminKey: { type: 'apiKey' } },
    },
  };
}

test('public merchant artifact excludes internal paths, unused schemas, contacts and runtime addresses', () => {
  const reference = merchantApiReference(spec());
  assert.equal(reference.paths['/api/admin/private'], undefined);
  assert.equal(reference.components.schemas.InternalAdmin, undefined);
  assert.equal(reference.components.securitySchemes.adminKey, undefined);
  assert.equal(reference.info.contact, undefined);
  assert.equal(JSON.stringify(reference).includes('internal.example.test'), false);
  assert.deepEqual(Object.keys(reference.components.schemas).sort(), ['Receipt', 'Subject']);
  assert.ok(reference.components.securitySchemes.merchantServerKey);
});

test('publication fails for missing merchant operations or unresolved components', () => {
  const missing = spec();
  delete missing.paths['/api/vendors/transactions/report'];
  assert.throws(() => merchantApiReference(missing), /Merchant contract missing/);
  const dangling = spec();
  delete dangling.components.schemas.Subject;
  assert.throws(() => merchantApiReference(dangling), /Missing API component/);
});

test('starter package excludes local state and credentials and refuses symlinks or secret-shaped values', () => {
  const root = mkdtempSync(join(tmpdir(), 'awoof-partner-download-'));
  try {
    const sdk = join(root, 'packages/partner-sdk');
    const merchant = join(root, 'examples/merchant-integration');
    mkdirSync(sdk, { recursive: true }); mkdirSync(merchant, { recursive: true });
    writeFileSync(join(sdk, 'package.json'), '{}'); writeFileSync(join(merchant, 'package.json'), '{}');
    writeFileSync(join(merchant, '.env'), 'PRIVATE_LOCAL_VALUE=secret');
    writeFileSync(join(merchant, '.env.example'), 'AWOOF_SERVER_KEY=REPLACE_ME');
    writeFileSync(join(merchant, 'local.sqlite'), 'private state');
    const files = starterFiles(root).map((file) => file.path);
    assert.ok(files.includes('examples/merchant-integration/.env.example'));
    assert.ok(!files.some((file) => file.endsWith('.env') || file.endsWith('.sqlite')));
    symlinkSync(join(merchant, '.env'), join(sdk, 'linked.mjs'));
    assert.throws(() => starterFiles(root), /symbolic links/);
    rmSync(join(sdk, 'linked.mjs'));
    writeFileSync(join(sdk, 'bad.mjs'), `const key = '${'sk_live_'}${'a'.repeat(24)}';`);
    assert.throws(() => starterFiles(root), /Secret-shaped/);
    writeFileSync(join(sdk, 'bad.mjs'), `const key = '${'sk_test_'}${'b'.repeat(24)}';`);
    assert.throws(() => starterFiles(root), /Secret-shaped/);
    writeFileSync(join(sdk, 'bad.mjs'), `const key = 'sk_test_fixture';`);
    assert.ok(starterFiles(root).some((file) => file.path === 'packages/partner-sdk/bad.mjs'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('publication rejects merchant operations carrying YAML-split null values', () => {
  const corrupted = spec();
  corrupted.paths['/api/vendors/transactions/report'].post.responses['400'] = { description: 'Invalid input', 'retired token': null };
  assert.throws(() => merchantApiReference(corrupted), /null value/);
});

test('published starter archive normalizes ownership, timestamps and gzip metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'awoof-partner-archive-'));
  try {
    mkdirSync(join(root, 'apps/backend/dist/config'), { recursive: true });
    writeFileSync(join(root, 'apps/backend/dist/config/openapi.json'), JSON.stringify(spec()));
    const sdk = join(root, 'packages/partner-sdk');
    const merchant = join(root, 'examples/merchant-integration');
    mkdirSync(sdk, { recursive: true }); mkdirSync(merchant, { recursive: true });
    writeFileSync(join(sdk, 'package.json'), '{}'); writeFileSync(join(merchant, 'package.json'), '{}');
    writeFileSync(join(merchant, 'server.js'), 'export const example = 1;\n');
    buildPartnerAssets(root);
    const archive = join(root, 'apps/web/public/developers/merchant-starter.tar.gz');
    const first = readFileSync(archive);
    buildPartnerAssets(root);
    assert.deepEqual(readFileSync(archive), first);
    assert.deepEqual([...first.subarray(0, 3)], [0x1f, 0x8b, 0x08]);
    assert.equal(first.readUInt32LE(4), 0);
    const member = gunzipSync(first);
    const octal = (offset, length) => parseInt(member.subarray(offset, offset + length).toString('utf8').replace(/[\0 ]/g, ''), 8);
    assert.equal(octal(108, 8), 0);
    assert.equal(octal(116, 8), 0);
    assert.equal(octal(136, 12), starterArchiveEpoch);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
