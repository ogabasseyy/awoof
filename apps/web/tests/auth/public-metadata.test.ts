import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertUniqueCanonicals,
  assertValidPublicMetadataInput,
  buildPublicMetadata,
} from '../../src/lib/public-metadata';
import { publicPageMetadata } from '../../src/content/public/page-metadata';

test('trust metadata uses its own production canonical and Open Graph URL', () => {
  const metadata = buildPublicMetadata(publicPageMetadata['/trust']);
  assert.equal(metadata.alternates?.canonical, 'https://awoof.tech/trust');
  const openGraph = metadata.openGraph;
  assert.ok(openGraph && 'url' in openGraph);
  assert.equal(openGraph.url, 'https://awoof.tech/trust');
  assert.deepEqual(metadata.title, { absolute: 'Security and Trust | Awoof' });
});

test('missing social image produces a summary card', () => {
  const metadata = buildPublicMetadata(publicPageMetadata['/help']);
  const twitter = metadata.twitter;
  assert.ok(twitter && 'card' in twitter);
  assert.equal(twitter.card, 'summary');
  assert.equal(metadata.twitter?.images, undefined);
  assert.equal(metadata.openGraph && 'images' in metadata.openGraph ? metadata.openGraph.images : undefined, undefined);
});

test('optional social image resolves to the production origin with a large card', () => {
  const metadata = buildPublicMetadata({
    pathname: '/trust',
    title: 'Security and Trust | Awoof',
    description: 'Trust copy.',
    socialImagePath: '/images/trust-og.png',
  });
  const twitter = metadata.twitter;
  assert.ok(twitter && 'card' in twitter);
  assert.equal(twitter.card, 'summary_large_image');
  assert.deepEqual(metadata.twitter?.images, ['https://awoof.tech/images/trust-og.png']);
});

test('registry rejects malformed paths', () => {
  for (const pathname of ['//evil.test/x', 'https://awoof.tech/trust', '/trust?x=1', '/trust#top', 'trust', '']) {
    assert.throws(
      () => assertValidPublicMetadataInput({ pathname, title: 't', description: 'd' }),
      /invalid pathname/,
      pathname,
    );
  }
  assert.throws(
    () => assertValidPublicMetadataInput({ pathname: '/trust', title: '', description: 'd' }),
    /title/,
  );
});

test('registry has unique titles, descriptions, and canonicals for public routes only', () => {
  const entries = Object.values(publicPageMetadata);
  assert.ok(entries.length >= 6);
  for (const entry of entries) {
    assertValidPublicMetadataInput(entry);
    assert.ok(!entry.pathname.startsWith('/admin'));
    assert.ok(!entry.pathname.startsWith('/auth'));
    assert.ok(!entry.pathname.startsWith('/student'));
    assert.ok(!entry.pathname.startsWith('/vendor'));
  }
  assertUniqueCanonicals(entries);
  const titles = new Set(entries.map((entry) => entry.title));
  assert.equal(titles.size, entries.length);
});
