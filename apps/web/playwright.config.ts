import { defineConfig } from '@playwright/test';

type BrowserServerMode = 'dev' | 'production';

const browserServerMode = process.env.AWOOF_BROWSER_SERVER_MODE ?? 'dev';
if (browserServerMode !== 'dev' && browserServerMode !== 'production') {
  throw new Error(
    `Unsupported AWOOF_BROWSER_SERVER_MODE ${JSON.stringify(browserServerMode)}. Expected "dev" or "production".`,
  );
}

const webServerCommand: Record<BrowserServerMode, string> = {
  dev: 'NEXT_PUBLIC_API_URL=http://127.0.0.1:3108 npm run dev -- --hostname 127.0.0.1 --port 3107',
  // Next standalone server.js changes its working directory to the artifact,
  // so this requires a separately staged artifact with public/ and
  // .next/static already present. build:browser bakes NEXT_PUBLIC_API_URL but
  // deliberately does not add generated-asset copying here.
  production: 'test -f .next/standalone/server.js -a -d .next/standalone/.next/static -a -d .next/standalone/public && HOSTNAME=127.0.0.1 PORT=3107 node .next/standalone/server.js',
};

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
    command: webServerCommand[browserServerMode],
    url: 'http://127.0.0.1:3107',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
