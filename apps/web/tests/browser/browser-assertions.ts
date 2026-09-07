import { expect, type ConsoleMessage, type Page } from '@playwright/test';
import { apiOrigin, type ApiFixture } from './fixtures';

function isExpectedSyntheticHttpFailure(message: ConsoleMessage, api: ApiFixture): boolean {
  const status = /^Failed to load resource: the server responded with a status of (\d{3})\b/.exec(message.text())?.[1];
  const location = message.location().url;
  if (!status || !location) return false;

  try {
    const url = new URL(location);
    if (url.origin !== apiOrigin) return false;
    const path = url.pathname.replace(/^\/api/, '');
    return api.syntheticHttpFailures.some((failure) => failure.path === path && failure.status === Number(status));
  } catch {
    return false;
  }
}

export function collectBrowserFaults(page: Page, api: ApiFixture): string[] {
  const faults: string[] = [];
  page.on('pageerror', (error) => faults.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error' || isExpectedSyntheticHttpFailure(message, api)) return;
    const location = message.location().url;
    faults.push(location ? `${message.text()} (${location})` : message.text());
  });
  return faults;
}

export async function assertCleanFixture(api: ApiFixture, faults: string[]): Promise<void> {
  await api.drainPendingHandlers();
  api.assertNoUnexpectedRequests();
  expect(faults).toEqual([]);
}
