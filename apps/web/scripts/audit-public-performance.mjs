// Reproducible public-performance audit runner.
//
// capture: checks ports, starts the deterministic fixture, builds production
//   with the test API origin, starts the standalone staging runner, audits
//   each route with five sequential cold-browser Lighthouse runs, writes raw
//   reports plus summary.json, and terminates only its own child processes.
// compare: validates baseline vs candidate summaries and enforces budgets.
//
// Usage:
//   node scripts/audit-public-performance.mjs capture --label baseline|candidate
//   node scripts/audit-public-performance.mjs compare
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, platform, release, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture, datasetDescriptor, FIXTURE_PORT } from './public-performance-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = dirname(here);
const requireFromWeb = createRequire(join(webRoot, 'package.json'));
const ARTIFACT_ROOT = join(webRoot, '.performance-artifacts');
const APP_PORT = 3107;
const RUNS_PER_ROUTE = 5;
const BUDGET_LCP_MS = 2500;
const BUDGET_CLS = 0.1;
const REGRESSION_TOLERANCE = 0.10;

const BASELINE_ROUTES = ['/', '/marketplace'];
const CANDIDATE_EXTRA_ROUTES = ['/trust', '/help', '/contact', '/partner', '/developers'];
// Stable h1 substrings asserted before measuring each route.
const EXPECTED_H1 = {
  '/': 'Student verification',
  '/marketplace': 'savings are warming up',
};
const ALLOWED_FAILURE_PATHS = new Set(['/api/auth/me']);
const ALLOWED_ORIGINS = new Set(['http://127.0.0.1:3107', 'http://127.0.0.1:3108', 'data:', 'blob:']);

export function median(values) {
  if (values.length === 0) throw new Error('Cannot take the median of zero values.');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function lighthouseConfigHash() {
  return sha256Hex(readFileSync(join(webRoot, 'lighthouse.public.cjs')));
}

function chromeVersion() {
  try {
    const launcherModule = requireFromWeb('chrome-launcher');
    const chromePath = launcherModule.getChromePath
      ? launcherModule.getChromePath()
      : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    return execFileSync(chromePath, ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('Unable to resolve the Chrome version. Refusing to capture without version evidence.');
  }
}

function toolVersions() {
  const lighthouse = requireFromWeb('lighthouse/package.json').version;
  const chromeLauncher = requireFromWeb('chrome-launcher/package.json').version;
  const chrome = chromeVersion();
  return { node: process.version, lighthouse, chromeLauncher, chrome, platform: `${platform()} ${release()}`, cpus: cpus().length, totalmem };
}

function gitSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: webRoot, encoding: 'utf8' }).trim();
}

async function portInUse(port) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

export function routeSummary(lhr) {
  const audit = (id) => lhr.audits?.[id];
  const lcp = audit('largest-contentful-paint')?.numericValue;
  const cls = audit('cumulative-layout-shift')?.numericValue;
  const tbt = audit('total-blocking-time')?.numericValue;
  const lcpNode = [
    ...(audit('lcp-discovery-insight')?.details?.items ?? []),
    ...(audit('lcp-breakdown-insight')?.details?.items ?? []),
    ...(audit('largest-contentful-paint-element')?.details?.items ?? []),
  ].find((item) => item?.type === 'node' || item?.node);
  const lcpElement = lcpNode?.selector ?? lcpNode?.node?.selector
    ?? lcpNode?.snippet ?? lcpNode?.node?.snippet
    ?? 'unknown';
  const networkItems = audit('network-requests')?.details?.items ?? [];
  if (networkItems.length === 0) throw new Error('Lighthouse report has no network requests.');
  const scriptBytes = networkItems
    .filter((item) => item.resourceType === 'Script')
    .reduce((sum, item) => sum + (item.transferSize ?? 0), 0);
  const totalBytes = networkItems.reduce((sum, item) => sum + (item.transferSize ?? 0), 0);
  const failedRequests = networkItems
    .filter((item) => (item.statusCode ?? 0) >= 400 || item.failed)
    .map((item) => `${item.statusCode ?? 'failed'} ${item.url}`);
  const origins = [...new Set(networkItems.map((item) => {
    try {
      const parsed = new URL(item.url);
      return parsed.protocol === 'data:' || parsed.protocol === 'blob:' ? parsed.protocol : parsed.origin;
    } catch {
      return 'unparseable';
    }
  }))];
  return { lcpMs: lcp ?? null, cls: cls ?? null, tbtMs: tbt ?? null, lcpElement, scriptBytes, totalBytes, failedRequests, origins };
}

export function aggregateRoute(route, runSummaries) {
  for (const [index, run] of runSummaries.entries()) {
    if (run.lcpMs === null || run.lcpMs === undefined) throw new Error(`Route ${route} run ${index + 1} is missing LCP.`);
    if (run.cls === null || run.cls === undefined) throw new Error(`Route ${route} run ${index + 1} is missing CLS.`);
    if (run.scriptBytes === null || run.scriptBytes === undefined) throw new Error(`Route ${route} run ${index + 1} is missing script transfer.`);
  }
  const lcp = runSummaries.map((r) => r.lcpMs);
  const cls = runSummaries.map((r) => r.cls);
  const tbt = runSummaries.map((r) => r.tbtMs ?? 0);
  const script = runSummaries.map((r) => r.scriptBytes);
  return {
    runs: runSummaries.length,
    lcpElements: [...new Set(runSummaries.map((run) => run.lcpElement))],
    median: { lcpMs: median(lcp), cls: median(cls), tbtMs: median(tbt), scriptBytes: median(script) },
    worst: { lcpMs: Math.max(...lcp), cls: Math.max(...cls), tbtMs: Math.max(...tbt), scriptBytes: Math.max(...script) },
  };
}

export function evaluateComparison(baseline, candidate) {
  const failures = [];
  const rows = [];
  const pushRow = (route, kind, checks) => rows.push({ route, kind, ...checks });

  if (!baseline?.routes || !candidate?.routes) {
    return { ok: false, code: 2, failures: ['Missing baseline or candidate route summaries.'], rows };
  }
  if (baseline.toolVersions?.lighthouse !== candidate.toolVersions?.lighthouse
    || baseline.toolVersions?.chrome !== candidate.toolVersions?.chrome
    || baseline.toolVersions?.node !== candidate.toolVersions?.node) {
    failures.push(`Tool mismatch: baseline ${JSON.stringify(baseline.toolVersions)} vs candidate ${JSON.stringify(candidate.toolVersions)}.`);
  }
  if (baseline.configHash !== candidate.configHash) failures.push('Lighthouse config hash mismatch.');
  if (baseline.datasetHash !== candidate.datasetHash) failures.push('Fixture dataset hash mismatch.');
  if (JSON.stringify(baseline.imageHashes) !== JSON.stringify(candidate.imageHashes)) failures.push('Fixture image hashes mismatch.');
  if (baseline.imageDelivery !== candidate.imageDelivery) failures.push('Image delivery mode mismatch.');
  if (failures.length > 0) return { ok: false, code: 2, failures, rows };

  for (const route of Object.keys(baseline.routes)) {
    const base = baseline.routes[route];
    const cand = candidate.routes[route];
    if (!cand || cand.runs < RUNS_PER_ROUTE) {
      failures.push(`Route ${route} is missing or incomplete in the candidate.`);
      pushRow(route, 'comparable', { status: 'incomplete' });
      continue;
    }
    const row = { status: 'pass', notes: [] };
    if (cand.median.lcpMs > BUDGET_LCP_MS) {
      row.status = 'fail';
      row.notes.push(`median LCP ${Math.round(cand.median.lcpMs)}ms exceeds ${BUDGET_LCP_MS}ms`);
    }
    if (cand.median.cls > BUDGET_CLS) {
      row.status = 'fail';
      row.notes.push(`median CLS ${cand.median.cls} exceeds ${BUDGET_CLS}`);
    }
    const lcpRegression = (cand.median.lcpMs - base.median.lcpMs) / base.median.lcpMs;
    if (lcpRegression > REGRESSION_TOLERANCE) {
      row.status = 'fail';
      row.notes.push(`median LCP regressed ${(lcpRegression * 100).toFixed(1)}% (>10%)`);
    }
    const jsRegression = (cand.median.scriptBytes - base.median.scriptBytes) / base.median.scriptBytes;
    if (jsRegression > REGRESSION_TOLERANCE) {
      row.status = 'fail';
      row.notes.push(`script transfer regressed ${(jsRegression * 100).toFixed(1)}% (>10%)`);
    }
    row.lcpRegression = lcpRegression;
    row.jsRegression = jsRegression;
    if (row.status === 'fail') failures.push(`Route ${route}: ${row.notes.join('; ')}.`);
    pushRow(route, 'comparable', row);
  }

  for (const route of Object.keys(candidate.routes)) {
    if (baseline.routes[route]) continue;
    const cand = candidate.routes[route];
    if (!cand || cand.runs < RUNS_PER_ROUTE) {
      failures.push(`Candidate-only route ${route} is incomplete.`);
      pushRow(route, 'absolute', { status: 'incomplete' });
      continue;
    }
    const row = { status: 'pass', notes: [] };
    if (cand.median.lcpMs > BUDGET_LCP_MS) {
      row.status = 'fail';
      row.notes.push(`median LCP ${Math.round(cand.median.lcpMs)}ms exceeds ${BUDGET_LCP_MS}ms`);
    }
    if (cand.median.cls > BUDGET_CLS) {
      row.status = 'fail';
      row.notes.push(`median CLS ${cand.median.cls} exceeds ${BUDGET_CLS}`);
    }
    if (row.status === 'fail') failures.push(`Route ${route}: ${row.notes.join('; ')}.`);
    pushRow(route, 'absolute', row);
  }

  if (failures.length > 0) {
    const incomplete = rows.some((row) => row.status === 'incomplete');
    return { ok: false, code: incomplete ? 2 : 1, failures, rows };
  }
  return { ok: true, code: 0, failures, rows };
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not ready yet.
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${url}.`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function assertRouteReady(base, route) {
  const response = await fetch(`${base}${route}`);
  if (!response.ok) throw new Error(`Route ${route} responded ${response.status}.`);
  const html = await response.text();
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!h1Match) throw new Error(`Route ${route} has no h1.`);
  const text = h1Match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const expected = EXPECTED_H1[route];
  if (expected && !text.includes(expected)) {
    throw new Error(`Route ${route} h1 "${text}" does not contain "${expected}".`);
  }
  if (/api-error|something went wrong|failed to load/i.test(html)) {
    throw new Error(`Route ${route} shows an API-error screen.`);
  }
  return text;
}

async function runLighthouseOnce(url, port, config) {
  const lighthouseModule = await import('lighthouse');
  const lighthouse = lighthouseModule.default;
  const { launch } = await import('chrome-launcher');
  const chrome = await launch({
    port,
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  try {
    const result = await lighthouse(url, { port: chrome.port, output: 'json', logLevel: 'error' }, config);
    if (!result?.lhr) throw new Error(`Lighthouse returned no report for ${url}.`);
    return result.lhr;
  } finally {
    try {
      await chrome.kill();
    } catch {
      // Teardown is best-effort; the run result stands on its own.
    }
  }
}

async function capture(label) {
  if (label !== 'baseline' && label !== 'candidate') {
    throw new Error(`Unknown label "${label}". Use baseline or candidate.`);
  }
  for (const port of [APP_PORT, FIXTURE_PORT]) {
    if (await portInUse(port)) throw new Error(`Port ${port} is already in use. Refusing to capture against an unknown server.`);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = label === 'baseline'
    ? join(ARTIFACT_ROOT, 'baseline')
    : join(ARTIFACT_ROOT, 'candidate', timestamp);
  if (label === 'baseline' && existsSync(join(runDir, 'summary.json'))) {
    throw new Error('Baseline already captured. Refusing to overwrite the immutable baseline report.');
  }
  mkdirSync(runDir, { recursive: true });

  const fixture = await startFixture(FIXTURE_PORT);
  let serverProcess = null;
  try {
    const { datasetHash, imageHashes } = datasetDescriptor();
    const versions = toolVersions();
    const sha = gitSha();
    const configHash = lighthouseConfigHash();
    const config = requireFromWeb('./lighthouse.public.cjs');

    console.log(`Building production bundle for ${label}...`);
    execFileSync('npm', ['run', 'build'], {
      cwd: webRoot,
      env: { ...process.env, NEXT_PUBLIC_API_URL: `http://127.0.0.1:${FIXTURE_PORT}`, NEXT_TELEMETRY_DISABLED: '1' },
      stdio: 'inherit',
    });

    serverProcess = spawn(process.execPath, ['scripts/serve-browser-production.mjs'], {
      cwd: webRoot,
      stdio: 'inherit',
    });
    await waitForServer(`http://127.0.0.1:${APP_PORT}/`, 120_000);

    const base = `http://127.0.0.1:${APP_PORT}`;
    let routes = [...BASELINE_ROUTES];
    if (label === 'candidate') {
      for (const extra of CANDIDATE_EXTRA_ROUTES) {
        try {
          await assertRouteReady(base, extra);
          routes.push(extra);
        } catch {
          console.log(`Skipping ${extra}: not present or not ready.`);
        }
      }
    }

    const summaryRoutes = {};
    const chromeDebugBasePort = 9400 + Math.floor(Math.random() * 100);
    for (const route of routes) {
      const h1 = await assertRouteReady(base, route);
      const runSummaries = [];
      for (let run = 1; run <= RUNS_PER_ROUTE; run += 1) {
        const lhr = await runLighthouseOnce(`${base}${route}`, chromeDebugBasePort + run, config);
        writeFileSync(join(runDir, `lhr-${route === '/' ? 'home' : route.slice(1).replaceAll('/', '-')}-run${run}.json`), JSON.stringify(lhr));
        const summary = routeSummary(lhr);
        for (const origin of summary.origins) {
          if (!ALLOWED_ORIGINS.has(origin)) {
            throw new Error(`Route ${route} run ${run} loaded unexpected origin ${origin}.`);
          }
        }
        runSummaries.push(summary);
        console.log(`${route} run ${run}/${RUNS_PER_ROUTE}: LCP ${Math.round(summary.lcpMs)}ms CLS ${summary.cls}`);
      }
      const normalizedFailures = fixture.requests.filter((entry) => {
        if (entry.status < 400) return false;
        if (entry.status === 401 && ALLOWED_FAILURE_PATHS.has(entry.path)) return false;
        return true;
      });
      if (normalizedFailures.length > 0) {
        const details = normalizedFailures.map((e) => `${e.method} ${e.path} -> ${e.status}`).join(', ');
        throw new Error(`Route ${route} had failed fixture requests: ${details}.`);
      }
      const failedLighthouseRequests = runSummaries.flatMap((run) => run.failedRequests);
      if (failedLighthouseRequests.length > 0) {
        throw new Error(`Route ${route} had failed network requests: ${[...new Set(failedLighthouseRequests)].join(', ')}.`);
      }
      summaryRoutes[route] = { h1, ...aggregateRoute(route, runSummaries) };
    }

    const summary = {
      label,
      capturedAt: new Date().toISOString(),
      runDir,
      sha,
      toolVersions: versions,
      configHash,
      datasetHash,
      imageHashes,
      imageDelivery: 'api-origin-unoptimized',
      buildEnv: { NEXT_PUBLIC_API_URL: `http://127.0.0.1:${FIXTURE_PORT}` },
      screenProfile: 'mobile 390x844 simulate rtt150/1638kbps/cpu4',
      cachePolicy: 'browser-cold/server-warm, storage reset per run',
      routes: summaryRoutes,
    };
    writeFileSync(join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    if (label === 'candidate') {
      writeFileSync(join(ARTIFACT_ROOT, 'candidate', 'latest.json'), JSON.stringify({ runDir }));
    }
    console.log(`Captured ${label} summary at ${join(runDir, 'summary.json')}`);
  } finally {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (!serverProcess.killed) serverProcess.kill('SIGKILL');
    }
    await fixture.close().catch(() => undefined);
  }
}

function latestCandidateDir() {
  const pointer = join(ARTIFACT_ROOT, 'candidate', 'latest.json');
  if (existsSync(pointer)) {
    const { runDir } = JSON.parse(readFileSync(pointer, 'utf8'));
    if (runDir && existsSync(join(runDir, 'summary.json'))) return runDir;
  }
  const candidateRoot = join(ARTIFACT_ROOT, 'candidate');
  if (!existsSync(candidateRoot)) throw new Error('No candidate capture found.');
  const stamped = readdirSync(candidateRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (stamped.length === 0) throw new Error('No candidate capture found.');
  return join(candidateRoot, stamped[stamped.length - 1]);
}

function compare() {
  const baselinePath = join(ARTIFACT_ROOT, 'baseline', 'summary.json');
  if (!existsSync(baselinePath)) throw new Error('No baseline summary found. Run audit:public:baseline first.');
  const candidateDir = latestCandidateDir();
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const candidate = JSON.parse(readFileSync(join(candidateDir, 'summary.json'), 'utf8'));
  const verdict = evaluateComparison(baseline, candidate);
  for (const row of verdict.rows) {
    const detail = row.notes && row.notes.length > 0 ? ` (${row.notes.join('; ')})` : '';
    process.stdout.write(`${row.status.toUpperCase()} ${row.kind} ${row.route}${detail}\n`);
  }
  if (!verdict.ok) {
    for (const failure of verdict.failures) process.stderr.write(`FAIL: ${failure}\n`);
    process.exitCode = verdict.code;
    return;
  }
  process.stdout.write('Performance comparison passed.\n');
}

export { capture, compare };

const invoked = process.argv[1] === fileURLToPath(import.meta.url);
if (invoked) {
  const command = process.argv[2];
  try {
    if (command === 'capture') {
      const labelFlag = process.argv.indexOf('--label');
      const label = labelFlag >= 0 ? process.argv[labelFlag + 1] : undefined;
      await capture(label);
    } else if (command === 'compare') {
      compare();
    } else {
      process.stderr.write('Usage: audit-public-performance.mjs capture --label baseline|candidate | compare\n');
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`audit-public-performance failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = process.exitCode || 1;
  }
}
