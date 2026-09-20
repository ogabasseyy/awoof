// Aggregation and comparison unit tests with synthetic summaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateRoute, evaluateComparison, median, routeSummary } from './audit-public-performance.mjs';

test('median of five known LCP values', () => {
  assert.equal(median([2100, 1800, 2400, 1900, 2000]), 2000);
  assert.equal(median([100, 300]), 200);
  assert.throws(() => median([]), /zero values/);
});

function route(medianLcp, medianCls, medianScript, runs = 5) {
  return { runs, median: { lcpMs: medianLcp, cls: medianCls, tbtMs: 120, scriptBytes: medianScript } };
}

function summary(routes) {
  return {
    toolVersions: { node: 'v24.0.0', lighthouse: '13.5.0', chrome: '152.0' },
    configHash: 'cfg',
    datasetHash: 'data',
    imageHashes: { a: 'b' },
    imageDelivery: 'api-origin-unoptimized',
    routes,
  };
}

test('identical summaries pass comparison', () => {
  const base = summary({ '/': route(2000, 0.05, 300000) });
  const verdict = evaluateComparison(base, summary({ '/': route(2000, 0.05, 300000) }));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.code, 0);
});

test('exact 10% regression passes, over-budget fails', () => {
  const base = summary({ '/': route(2000, 0.05, 300000) });
  const boundary = evaluateComparison(base, summary({ '/': route(2200, 0.05, 330000) }));
  assert.equal(boundary.ok, true);

  const over = evaluateComparison(base, summary({ '/': route(2201, 0.05, 300000) }));
  assert.equal(over.ok, false);
  assert.equal(over.code, 1);
  assert.match(over.failures.join(' '), /LCP regressed/);

  const jsOver = evaluateComparison(base, summary({ '/': route(2000, 0.05, 330001) }));
  assert.equal(jsOver.ok, false);
  assert.match(jsOver.failures.join(' '), /script transfer regressed/);
});

test('absolute budgets apply to candidate routes', () => {
  const base = summary({ '/': route(2000, 0.05, 300000) });
  const slow = evaluateComparison(base, summary({ '/': route(2600, 0.05, 200000) }));
  assert.equal(slow.ok, false);
  assert.match(slow.failures.join(' '), /exceeds 2500ms/);

  const shifty = evaluateComparison(base, summary({ '/': route(2000, 0.2, 200000) }));
  assert.equal(shifty.ok, false);
  assert.match(shifty.failures.join(' '), /exceeds 0.1/);
});

test('missing candidate route is an invalid comparison, never a zero score', () => {
  const base = summary({ '/': route(2000, 0.05, 300000), '/marketplace': route(2100, 0.04, 310000) });
  const verdict = evaluateComparison(base, summary({ '/': route(2000, 0.05, 300000) }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 2);
  assert.match(verdict.failures.join(' '), /missing or incomplete/);
});

test('hash and tool mismatches invalidate the comparison', () => {
  const base = summary({ '/': route(2000, 0.05, 300000) });
  const tampered = summary({ '/': route(2000, 0.05, 300000) });
  tampered.datasetHash = 'other';
  const dataset = evaluateComparison(base, tampered);
  assert.equal(dataset.ok, false);
  assert.equal(dataset.code, 2);

  const retooled = summary({ '/': route(2000, 0.05, 300000) });
  retooled.toolVersions = { ...retooled.toolVersions, lighthouse: '99.0.0' };
  const tools = evaluateComparison(base, retooled);
  assert.equal(tools.ok, false);
  assert.equal(tools.code, 2);
});

test('routeSummary extracts LCP element from Lighthouse 13 insight audits', () => {
  const lhr = {
    audits: {
      'largest-contentful-paint': { numericValue: 1500 },
      'cumulative-layout-shift': { numericValue: 0.02 },
      'total-blocking-time': { numericValue: 90 },
      'lcp-discovery-insight': { details: { items: [{ type: 'node', selector: 'main > img.hero' }] } },
      'network-requests': { details: { items: [
        { url: 'http://127.0.0.1:3107/', statusCode: 200, resourceType: 'Document', transferSize: 1000 },
        { url: 'http://127.0.0.1:3107/app.js', statusCode: 200, resourceType: 'Script', transferSize: 5000 },
      ] } },
    },
  };
  const summary = routeSummary(lhr);
  assert.equal(summary.lcpElement, 'main > img.hero');
  assert.equal(summary.scriptBytes, 5000);
  assert.equal(summary.totalBytes, 6000);
  assert.deepEqual(summary.failedRequests, []);
});

test('routeSummary falls back to the legacy LCP element audit', () => {
  const lhr = {
    audits: {
      'largest-contentful-paint': { numericValue: 1500 },
      'cumulative-layout-shift': { numericValue: 0.02 },
      'total-blocking-time': { numericValue: 90 },
      'largest-contentful-paint-element': { details: { items: [{ node: { selector: 'h1.title' } }] } },
      'network-requests': { details: { items: [{ url: 'http://127.0.0.1:3107/', statusCode: 200, resourceType: 'Document', transferSize: 100 }] } },
    },
  };
  assert.equal(routeSummary(lhr).lcpElement, 'h1.title');
});

test('aggregateRoute rejects runs with missing metrics', () => {
  assert.throws(
    () => aggregateRoute('/x', [{ lcpMs: null, cls: 0, scriptBytes: 1 }]),
    /missing LCP/,
  );
  assert.throws(
    () => aggregateRoute('/x', [{ lcpMs: 1, cls: null, scriptBytes: 1 }]),
    /missing CLS/,
  );
});

test('candidate-only routes get absolute budgets only', () => {
  const base = summary({ '/': route(2000, 0.05, 300000) });
  const good = evaluateComparison(base, summary({
    '/': route(2000, 0.05, 300000),
    '/trust': route(1800, 0.02, 250000),
  }));
  assert.equal(good.ok, true);

  const bad = evaluateComparison(base, summary({
    '/': route(2000, 0.05, 300000),
    '/trust': route(3000, 0.02, 250000),
  }));
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 1);
});
