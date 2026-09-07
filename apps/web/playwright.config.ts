import { defineConfig } from '@playwright/test';

const browserMode = process.env.AWOOF_BROWSER_MODE ?? 'dev';

if (browserMode !== 'dev' && browserMode !== 'production') {
  throw new Error('AWOOF_BROWSER_MODE must be either "dev" or "production".');
}

const webServerCommand = browserMode === 'production'
  ? 'NEXT_PUBLIC_API_URL=http://127.0.0.1:3108 NEXT_TELEMETRY_DISABLED=1 node scripts/serve-browser-production.mjs'
  : 'NEXT_PUBLIC_API_URL=http://127.0.0.1:3108 NEXT_TELEMETRY_DISABLED=1 npm run dev -- --hostname 127.0.0.1 --port 3107';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: 'list',
  outputDir: 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:3107',
    channel: 'chrome',
    serviceWorkers: 'block',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  webServer: {
    command: webServerCommand,
    url: 'http://127.0.0.1:3107',
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: browserMode === 'production'
      ? { signal: 'SIGTERM', timeout: 10_000 }
      : undefined,
  },
});
