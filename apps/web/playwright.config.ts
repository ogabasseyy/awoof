import { defineConfig } from '@playwright/test';

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
    command: 'NEXT_PUBLIC_API_URL=http://127.0.0.1:3108 npm run dev -- --hostname 127.0.0.1 --port 3107',
    url: 'http://127.0.0.1:3107',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
