// Baseline/candidate route screenshots at fixed widths.
//
// Starts the deterministic fixture plus the already-built standalone staging
// server, screenshots each route logged-out, and terminates its children.
// Usage: node scripts/capture-route-screenshots.mjs <outDir> [label]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startFixture, FIXTURE_PORT } from './public-performance-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = dirname(here);
const APP_PORT = 3107;
const WIDTHS = [360, 390, 768, 1440];
const ROUTES = [
  { path: '/', slug: 'home', h1: 'Student verification' },
  { path: '/marketplace', slug: 'marketplace', h1: 'savings are warming up' },
  { path: '/widget/verify', slug: 'widget-verify', h1: 'Merchant verification is unavailable' },
  { path: '/trust', slug: 'trust', h1: 'Security and trust' },
  { path: '/help', slug: 'help', h1: 'Help with verification' },
  { path: '/contact', slug: 'contact', h1: 'Contact Awoof' },
  { path: '/partner', slug: 'partner', h1: 'Student verification for partners' },
  { path: '/developers', slug: 'developers', h1: 'Developer integration guide' },
];

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

const outDir = process.argv[2];
if (!outDir) throw new Error('Usage: capture-route-screenshots.mjs <outDir> [label]');
mkdirSync(outDir, { recursive: true });

const fixture = await startFixture(FIXTURE_PORT);
let serverProcess = null;
let browser = null;
try {
  serverProcess = spawn(process.execPath, ['scripts/serve-browser-production.mjs'], {
    cwd: webRoot,
    stdio: 'inherit',
  });
  await waitForServer(`http://127.0.0.1:${APP_PORT}/`, 120_000);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const route of ROUTES) {
    for (const width of WIDTHS) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        const response = await page.goto(`http://127.0.0.1:${APP_PORT}${route.path}`, { waitUntil: 'load' });
        if (!response || !response.ok()) throw new Error(`${route.path} responded ${response?.status()}.`);
        await page.waitForTimeout(1500);
        const h1 = await page.locator('h1').first().innerText();
        if (!h1.includes(route.h1)) throw new Error(`${route.path} h1 "${h1}" missing "${route.h1}".`);
        const file = join(outDir, `${route.slug}-${width}.png`);
        await page.screenshot({ path: file });
        console.log(`saved ${file}`);
      } finally {
        await page.close();
      }
    }
  }
} finally {
  await browser?.close().catch(() => undefined);
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (!serverProcess.killed) serverProcess.kill('SIGKILL');
  }
  await fixture.close().catch(() => undefined);
}
