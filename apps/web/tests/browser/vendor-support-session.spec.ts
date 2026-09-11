import { expect, test, type Page } from '@playwright/test';
import { appOrigin, createGate, installSyntheticApi, seedSession, storageTabPath } from './fixtures';

const ticketPath = '/vendor/support/private-ticket';
const headers = { 'access-control-allow-origin': appOrigin };
const ticket = {
  id: 'private-ticket', subject: 'Vendor A private subject', category: 'general', status: 'open',
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};
const data = { ticket, messages: [{ id: 'message', authorRole: 'vendor', body: 'Vendor A private history', createdAt: ticket.createdAt }] };

async function changeSession(other: Page, sameSession = false) {
  await other.evaluate((same) => {
    const key = 'awoof.session.v1';
    const previous = JSON.parse(localStorage.getItem(key)!);
    localStorage.setItem(key, JSON.stringify({ ...previous,
      sessionId: same ? previous.sessionId : 'vendor-b-session',
      accessToken: same ? 'vendor-rotated-access' : 'vendor-b-access',
      refreshToken: same ? 'vendor-rotated-refresh' : 'vendor-b-refresh',
    }));
  }, sameSession);
}

for (const pending of [false, true]) {
  test(`vendor ticket discards previous session ${pending ? 'pending response' : 'visible thread and draft'}`, async ({ page, context }) => {
    await installSyntheticApi(page);
    await seedSession(page, 'vendor');
    const oldResponse = createGate();
    const newAccount = createGate();
    let supportCalls = 0;
    await page.route('**/auth/me', async (route) => {
      if (route.request().headers().authorization !== 'Bearer vendor-b-access') return route.fallback();
      await newAccount.wait();
      await route.fulfill({ headers, json: { success: true, data: { id: 'vendor-b', email: 'b@approved.test', role: 'vendor' } } });
    });
    await page.route('**/vendors/support-tickets/private-ticket', async (route) => {
      supportCalls += 1;
      if (route.request().headers().authorization === 'Bearer vendor-b-access') {
        await route.fulfill({ headers, json: { success: true, data: { ticket: null, messages: [] } } });
        return;
      }
      if (pending) await oldResponse.wait();
      await route.fulfill({ headers, json: { success: true, data } });
    });
    await page.goto(ticketPath);
    const other = await context.newPage();
    await other.goto(`${appOrigin}${storageTabPath}`);
    try {
      if (pending) await oldResponse.waitForArrival();
      else {
        await expect(page.getByText(ticket.subject, { exact: true })).toBeVisible();
        await page.locator('textarea').fill('Vendor A private draft');
      }
      await changeSession(other);
      await newAccount.waitForArrival();
      await expect(page.getByText(ticket.subject, { exact: true })).toHaveCount(0);
      oldResponse.release();
      newAccount.release();
      await expect(page.getByText('Ticket not found', { exact: true })).toBeVisible();
      await expect(page.getByText('Vendor A private history', { exact: true })).toHaveCount(0);
      await expect(page.locator('textarea')).toHaveCount(0);
      expect(supportCalls).toBeGreaterThanOrEqual(2);
    } finally {
      oldResponse.release();
      newAccount.release();
    }
  });
}

test('vendor same logical session token rotation preserves the ticket and reply draft', async ({ page, context }) => {
  await installSyntheticApi(page);
  await seedSession(page, 'vendor');
  let calls = 0;
  await page.route('**/vendors/support-tickets/private-ticket', async (route) => {
    calls += 1;
    await route.fulfill({ headers, json: { success: true, data } });
  });
  await page.goto(ticketPath);
  await expect(page.getByText(ticket.subject, { exact: true })).toBeVisible();
  await page.locator('textarea').fill('Current session draft');
  const other = await context.newPage();
  await other.goto(`${appOrigin}${storageTabPath}`);
  const callsBeforeRotation = calls;
  await changeSession(other, true);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByText(ticket.subject, { exact: true })).toBeVisible();
  await expect(page.locator('textarea')).toHaveValue('Current session draft');
  expect(calls).toBe(callsBeforeRotation);
});

test('vendor a late reply completion cannot refresh or notify the replacement session', async ({ page, context }) => {
  await installSyntheticApi(page);
  await seedSession(page, 'vendor');
  const reply = createGate();
  let reads = 0;
  await page.route('**/auth/me', async (route) => {
    if (route.request().headers().authorization !== 'Bearer vendor-b-access') return route.fallback();
    await route.fulfill({ headers, json: { data: { id: 'vendor-b', email: 'b@approved.test', role: 'vendor' } } });
  });
  await page.route('**/vendors/support-tickets/private-ticket', async (route) => {
    reads += 1;
    const next = route.request().headers().authorization === 'Bearer vendor-b-access';
    await route.fulfill({ headers, json: { data: next ? { ticket: null, messages: [] } : data } });
  });
  await page.route('**/vendors/support-tickets/private-ticket/messages', async (route) => {
    await reply.wait();
    await route.fulfill({ headers, json: { data: {} } });
  });
  await page.goto(ticketPath);
  await expect(page.getByText(ticket.subject, { exact: true })).toBeVisible();
  const other = await context.newPage();
  await other.goto(`${appOrigin}${storageTabPath}`);
  try {
    await page.locator('textarea').fill('Private pending reply');
    await page.getByRole('button', { name: 'Send reply' }).click();
    await reply.waitForArrival();
    await changeSession(other);
    await expect(page.getByText('b@approved.test', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Ticket not found', { exact: true })).toBeVisible();
    const readsBeforeCompletion = reads;
    const completed = page.waitForResponse('**/vendors/support-tickets/private-ticket/messages');
    reply.release();
    await completed;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByText('Reply sent', { exact: true })).toHaveCount(0);
    expect(reads).toBe(readsBeforeCompletion);
  } finally { reply.release(); }
});
