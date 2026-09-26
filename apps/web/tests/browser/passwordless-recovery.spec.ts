import { expect, test } from '@playwright/test';
import { apiOrigin, appOrigin, installSyntheticApi, seedSession } from './fixtures';

const headers = { 'access-control-allow-origin': appOrigin, 'access-control-allow-credentials': 'true' };

test('security setup keeps the generated recovery code out of URL and web storage and requires a second fresh proof', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ json: { success: true, data: { status: 'unconfigured', generation: null } }, headers }));
    await page.goto('/auth/student/login');
    await seedSession(page, 'student');
    await page.goto('/student/security');
    await expect(page.getByText('Confirm your identity, save your code, then confirm your identity again to activate it.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm identity to generate a code' })).toBeVisible();
    expect(await page.evaluate(() => `${location.href}|${localStorage.length}|${sessionStorage.length}`)).not.toContain('recovery-code');
    api.assertNoUnexpectedRequests();
});

test('independent password recovery requires an explicit purpose and does not promise school-login recovery', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.goto('/auth/student/recovery');
    await expect(page.getByRole('heading', { name: 'Account recovery' })).toBeVisible();
    await expect(page.getByText('school mailbox and saved recovery code')).toBeVisible();
    await page.getByLabel('School email').fill('student@school.example');
    await page.getByLabel('I think my sign-in was compromised').check();
    await expect(page.getByText('disconnect all linked external sign-in identities')).toBeVisible();
    api.assertNoUnexpectedRequests();
});
