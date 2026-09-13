import { defineConfig } from '@playwright/test';

/** Isolated from playwright.config.ts: normal browser coverage remains HTTP. */
export default defineConfig({
  testDir: './tests/browser',
  testMatch: 'microsoft-verification.spec.ts',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: 'list',
  outputDir: 'test-results/microsoft-https',
  use: {
    baseURL: 'https://app.awoof.test:3443',
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block',
    trace: 'off', video: 'off', screenshot: 'off',
    launchOptions: {
      // Process-only DNS mapping; no /etc/hosts or global resolver change.
      args: ['--host-resolver-rules=MAP app.awoof.test 127.0.0.1, MAP api.awoof.test 127.0.0.1'],
    },
  },
  webServer: {
    command: 'node scripts/microsoft-https-fixture.mjs',
    // Playwright's Node-side readiness probe does not inherit Chromium's
    // resolver rules. The browser still uses app.awoof.test below.
    url: 'https://127.0.0.1:3443',
    reuseExistingServer: false,
    timeout: 120_000,
    ignoreHTTPSErrors: true,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
});
