import { expect, test } from '@playwright/test';

const vendorId = '4f088fa7-79d9-4c64-a48c-9ecbbbc3c4a3';
const merchantOrigin = 'https://shop.example';
const appOrigin = 'http://127.0.0.1:3107';
const apiOrigin = 'http://127.0.0.1:3108';
const grantId = '9e4f5a6b-7c8d-4c64-a48c-9ecbbbc3c4a3';
const code = 'z'.repeat(43);
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,authorization', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
test.skip(process.env.AWOOF_WIDGET_PILOT_ENABLED !== 'true', 'Run with the explicit synthetic pilot flag and vendor allowlist');

test('gated hosted pilot asks for disclosure and returns a bound code to the merchant popup', async ({ page, context }) => {
  const calls: string[] = [];
  const session = JSON.stringify({ v: 1, state: 'active', sessionId: 'synthetic-student', accessToken: 'student-access', refreshToken: 'student-refresh' });
  await context.addInitScript(({ origin, value }) => { if (location.origin === origin) localStorage.setItem('awoof.session.v1', value); }, { origin: appOrigin, value: session });
  await context.route(`${merchantOrigin}/**`, (route) => {
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Test merchant</title><button id="start">Check eligibility</button><p id="result"></p><script>
      document.querySelector('#start').onclick = () => {
        const state = 'a'.repeat(32);
        const query = new URLSearchParams({vendorId:'${vendorId}', origin:location.origin, campaignId:'sandbox-campaign', purpose:'Test checkout eligibility', state});
        const popup = window.open('${appOrigin}/widget/verify?' + query, '_blank');
        window.addEventListener('message', event => {
          if (event.origin === '${appOrigin}' && event.source === popup && event.data?.state === state && event.data?.type === 'AWOOF_ELIGIBILITY_CODE') document.querySelector('#result').textContent = 'Code received';
        });
      };
    </script>` });
  });
  await context.route(`${apiOrigin}/api/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    calls.push(path);
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
    let data: unknown;
    if (path === '/api/widget/merchant-context') {
      expect(body).toEqual({ vendorId, origin: merchantOrigin });
      data = { vendorId, origin: merchantOrigin, merchantName: 'Pilot Merchant' };
    } else if (path === '/api/auth/me') {
      data = { id: '00000000-0000-4000-8000-000000000001', email: 'synthetic@student.invalid', role: 'student' };
    } else if (path === '/api/verification/status') {
      data = { eligibility: { eligible: true }, notices: { merchantDisclosure: { version: 'pilot-notice-v1', text: 'Awoof shares current eligibility with this merchant.' } } };
    } else if (path === '/api/verification/disclosures') {
      expect(body).toEqual({ vendorId, origin: merchantOrigin, purpose: 'Test checkout eligibility', accepted: true, noticeVersion: 'pilot-notice-v1' });
      data = { grantId };
    } else if (path === '/api/merchant-verification/pilot-assertions') {
      expect(body).toEqual({ vendorId, origin: merchantOrigin, purpose: 'Test checkout eligibility', campaignId: 'sandbox-campaign', disclosureGrantId: grantId });
      data = { code, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    } else throw new Error(`Unexpected API: ${path}`);
    await route.fulfill({ status: path.endsWith('/disclosures') || path.endsWith('/pilot-assertions') ? 201 : 200, headers: cors, json: { success: true, data } });
  });
  await page.goto(merchantOrigin);
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Check eligibility' }).click();
  const popup = await popupPromise;
  await expect(popup.getByRole('heading', { name: 'Student eligibility check' })).toBeVisible();
  await expect(popup.getByRole('heading', { name: 'Request from Pilot Merchant' })).toBeVisible();
  await expect(popup.getByText('Purpose: Test checkout eligibility')).toBeVisible();
  await popup.setViewportSize({ width: 390, height: 780 });
  expect(await popup.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await expect(popup.getByRole('link', { name: 'Security and trust' })).toHaveAttribute('href', '/trust');
  const consent = popup.getByRole('checkbox', { name: /I approve sharing/ });
  await consent.focus();
  await consent.press('Space');
  await expect(consent).toBeChecked();
  await popup.getByRole('button', { name: 'Continue to merchant' }).click();
  await expect(page.getByText('Code received')).toBeVisible();
  expect(calls).toContain('/api/verification/disclosures');
  expect(calls).toContain('/api/merchant-verification/pilot-assertions');
});

test('signed-out student gets a same-site sign-in return without requesting eligibility', async ({ page, context }) => {
  const calls: string[] = [];
  await context.route(`${apiOrigin}/api/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    if (path !== '/api/widget/merchant-context') throw new Error(`Unexpected API: ${path}`);
    await route.fulfill({ headers: cors, json: { success: true, data: { vendorId, origin: merchantOrigin, merchantName: 'Pilot Merchant' } } });
  });
  const query = new URLSearchParams({ vendorId, origin: merchantOrigin, campaignId: 'sandbox-campaign', purpose: 'Test checkout eligibility', state: 'a'.repeat(32) });
  await page.goto(`/widget/verify?${query}`);
  const login = page.getByRole('link', { name: 'Student sign in' });
  await expect(login).toBeVisible();
  const href = await login.getAttribute('href');
  expect(new URL(href!, appOrigin).searchParams.get('redirect')).toBe(`/widget/verify?${query}`);
  expect(calls).not.toContain('/api/verification/status');
});

test('an ineligible student cannot approve disclosure or request a pilot code', async ({ page, context }) => {
  const calls: string[] = [];
  const session = JSON.stringify({ v: 1, state: 'active', sessionId: 'synthetic-ineligible', accessToken: 'student-access', refreshToken: 'student-refresh' });
  await context.addInitScript((value) => localStorage.setItem('awoof.session.v1', value), session);
  await context.route(`${apiOrigin}/api/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    calls.push(path);
    let data: unknown;
    if (path === '/api/widget/merchant-context') data = { vendorId, origin: merchantOrigin, merchantName: 'Pilot Merchant' };
    else if (path === '/api/auth/me') data = { id: '00000000-0000-4000-8000-000000000001', email: 'synthetic@student.invalid', role: 'student' };
    else if (path === '/api/verification/status') data = { eligibility: { eligible: false, reason: 'expired' }, notices: { merchantDisclosure: { version: 'pilot-notice-v1', text: 'Disclosure notice' } } };
    else throw new Error(`Unexpected API: ${path}`);
    return route.fulfill({ status: 200, headers: cors, json: { success: true, data } });
  });
  const query = new URLSearchParams({ vendorId, origin: merchantOrigin, campaignId: 'sandbox-campaign', purpose: 'Test checkout eligibility', state: 'a'.repeat(32) });
  await page.goto(`/widget/verify?${query}`);
  await expect(page.getByText('Current eligibility is unavailable', { exact: false })).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue to merchant' })).toHaveCount(0);
  expect(calls).not.toContain('/api/verification/disclosures');
  expect(calls).not.toContain('/api/merchant-verification/pilot-assertions');
});
