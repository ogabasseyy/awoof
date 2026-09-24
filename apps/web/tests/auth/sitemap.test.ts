import assert from 'node:assert/strict';
import { test } from 'node:test';
import sitemap from '../../src/app/sitemap';
import { publicPageMetadata } from '../../src/content/public/page-metadata';

const ALLOWLIST = ['/', '/marketplace', '/trust', '/help', '/contact', '/partner', '/developers', '/legal', '/privacy', '/terms', '/terms/v1-0', '/cookies', '/legal/merchant-terms', '/legal/data-protection'];

test('legal sitemap dates distinguish updated and unchanged reading copies', () => {
  const dates = new Map(sitemap().map((entry) => [new URL(entry.url).pathname, entry.lastModified]));
  for (const path of ['/legal', '/privacy', '/terms', '/terms/v1-0']) {
    assert.equal(dates.get(path), '2026-09-24', path);
  }
  for (const path of ['/cookies', '/legal/merchant-terms', '/legal/data-protection']) {
    assert.equal(dates.get(path), '2026-09-23', path);
  }
});

test('sitemap covers exactly the launched public routes', () => {
  const entries = sitemap();
  const paths = entries.map((entry) => new URL(entry.url).pathname);
  assert.deepEqual([...paths].sort(), [...ALLOWLIST].sort());
  for (const entry of entries) {
    assert.ok(entry.url.startsWith('https://awoof.tech'));
    const path: string = new URL(entry.url).pathname;
    assert.ok(!path.startsWith('/auth'));
    assert.ok(!path.startsWith('/admin'));
    assert.ok(!path.startsWith('/student'));
    assert.ok(!path.startsWith('/vendor'));
    void path;
  }
});

test('every registry route has a sitemap entry', () => {
  const paths = new Set(sitemap().map((entry) => new URL(entry.url).pathname));
  for (const pathname of Object.keys(publicPageMetadata)) {
    assert.ok(paths.has(pathname), `sitemap is missing ${pathname}`);
  }
});
