import { expect, test, type Page } from '@playwright/test';
import { apiOrigin, appOrigin, installSyntheticApi, seedSession } from './fixtures';

// Credentialed SSO calls reject a wildcard CORS origin; echo the app origin instead.
const ssoHeaders = {
    'access-control-allow-origin': appOrigin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'content-type',
};

const HANDOFF_ID = '60000000-0000-4000-8000-000000000001';
const GRANT_ID = '60000000-0000-4000-8000-000000000002';
const HANDOFF_KEY = 'awoof.sso.handoff.v1.tab';

function liveExpiry(): string {
    return new Date(Date.now() + 600_000).toISOString();
}

function expiredExpiry(): string {
    return new Date(Date.now() - 60_000).toISOString();
}

async function seedTabHandoff(page: Page, record: { handoffId: string; handoffSecret: string; expiresAt: string; returnPath: string }): Promise<void> {
    await page.evaluate(({ key, value }) => {
        sessionStorage.setItem(key, JSON.stringify(value));
    }, { key: HANDOFF_KEY, value: record });
}

async function readTabHandoff(page: Page): Promise<unknown> {
    return page.evaluate((key) => {
        const raw = sessionStorage.getItem(key);
        return raw ? JSON.parse(raw) as unknown : null;
    }, HANDOFF_KEY);
}

test('linking the stored handoff continues to verification and clears tab state', async ({ page }) => {
    const reauthBodies: unknown[] = [];
    const linkBodies: unknown[] = [];
    const authHeaders: (string | undefined)[] = [];
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth`, async (route) => {
        reauthBodies.push(JSON.parse(route.request().postData() ?? '{}'));
        authHeaders.push(route.request().headers()['authorization']);
        await route.fulfill({
            status: 201,
            json: {
                success: true,
                data: { grantId: GRANT_ID, grantSecret: 'synthetic-grant-secret', expiresAt: liveExpiry() },
            },
            headers: ssoHeaders,
        });
    });
    await page.route(`${apiOrigin}/api/auth/student/sso/link`, async (route) => {
        linkBodies.push(JSON.parse(route.request().postData() ?? '{}'));
        authHeaders.push(route.request().headers()['authorization']);
        await route.fulfill({
            status: 201,
            json: {
                success: true,
                data: { outcome: 'linked', identity: { id: 'identity-1' }, schoolAssertion: 'recorded', reactivated: false },
            },
            headers: ssoHeaders,
        });
    });

    await page.goto('/auth/student/login');
    await seedSession(page, 'student', { accessToken: 'synthetic-access-token' });
    // The complete page clears the attempt when the handoff is stored, so
    // only the handoff's carried return path drives continuation here.
    await seedTabHandoff(page, { handoffId: HANDOFF_ID, handoffSecret: 'synthetic-handoff-secret', expiresAt: liveExpiry(), returnPath: '/marketplace?from=sso-test' });
    await page.goto('/auth/student/sso/onboarding');
    await expect(page.getByText('Confirm your password to link this school sign-in.')).toBeVisible();
    await page.getByLabel('Account password').fill('Synthetic-Password1!');
    await page.getByRole('button', { name: 'Link school sign-in' }).click();
    await page.waitForURL('**/marketplace?from=sso-test');

    expect(reauthBodies).toEqual([{ password: 'Synthetic-Password1!', purpose: 'link' }]);
    expect(linkBodies).toEqual([{
        handoffId: HANDOFF_ID,
        handoffSecret: 'synthetic-handoff-secret',
        reauthGrant: { grantId: GRANT_ID, grantSecret: 'synthetic-grant-secret' },
    }]);
    // The sessionless SSO client carries no interceptors, so both calls
    // attach the password session's Bearer token explicitly.
    const storedAccessToken = await page.evaluate((key) => {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as { accessToken: string }).accessToken : null;
    }, 'awoof.session.v1');
    expect(storedAccessToken).toBeTruthy();
    expect(authHeaders).toEqual([`Bearer ${storedAccessToken}`, `Bearer ${storedAccessToken}`]);
    expect(await readTabHandoff(page)).toBeNull();
    const attempt = await page.evaluate((key) => sessionStorage.getItem(key), 'awoof.sso.attempt.v1.tab');
    expect(attempt).toBeNull();
    api.assertNoUnexpectedRequests();
});

test('a mismatched school account spends the handoff and restarts', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth`, async (route) => route.fulfill({
        status: 201,
        json: {
            success: true,
            data: { grantId: GRANT_ID, grantSecret: 'synthetic-grant-secret', expiresAt: liveExpiry() },
        },
        headers: ssoHeaders,
    }));
    await page.route(`${apiOrigin}/api/auth/student/sso/link`, async (route) => route.fulfill({
        status: 409,
        json: { success: false, error: { code: 'SSO_LINK_MISMATCH', message: 'Mismatch.' } },
        headers: ssoHeaders,
    }));

    await page.goto('/auth/student/login');
    await seedSession(page, 'student', { accessToken: 'synthetic-access-token' });
    await seedTabHandoff(page, { handoffId: HANDOFF_ID, handoffSecret: 'synthetic-handoff-secret', expiresAt: liveExpiry(), returnPath: '/marketplace' });
    await page.goto('/auth/student/sso/onboarding');
    await page.getByLabel('Account password').fill('Synthetic-Password1!');
    await page.getByRole('button', { name: 'Link school sign-in' }).click();
    await expect(page.getByText('The school account returned is not the one being linked')).toBeVisible();
    expect(await readTabHandoff(page)).toBeNull();
    api.assertNoUnexpectedRequests();
});

test('an expired handoff shows nothing to link', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.goto('/auth/student/login');
    await seedTabHandoff(page, { handoffId: HANDOFF_ID, handoffSecret: 'synthetic-handoff-secret', expiresAt: expiredExpiry(), returnPath: '/marketplace' });
    await page.goto('/auth/student/sso/onboarding');
    await expect(page.getByText('This tab holds no pending school sign-in')).toBeVisible();
    expect(await readTabHandoff(page)).toBeNull();
    api.assertNoUnexpectedRequests();
});

test('a lost session sends the user back to sign in', async ({ page }) => {
    const api = await installSyntheticApi(page);
    // No session is seeded and no reauth route is mocked: the page must
    // not send the password anywhere without a Bearer token.
    await page.goto('/auth/student/login');
    await seedTabHandoff(page, { handoffId: HANDOFF_ID, handoffSecret: 'synthetic-handoff-secret', expiresAt: liveExpiry(), returnPath: '/marketplace' });
    await page.goto('/auth/student/sso/onboarding');
    await page.getByLabel('Account password').fill('Synthetic-Password1!');
    await page.getByRole('button', { name: 'Link school sign-in' }).click();
    await expect(page.getByText('Your session ended before linking.')).toBeVisible();
    const href = await page.getByRole('link', { name: 'Sign in with your password' }).getAttribute('href');
    expect(href).toContain('/auth/student/login');
    expect(href).toContain('onboarding');
    expect(await readTabHandoff(page)).not.toBeNull();
    api.assertNoUnexpectedRequests();
});

test('a wrong password stays on the form and a repeat signs in again', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth`, async (route) => route.fulfill({
        status: 401,
        json: { success: false, error: { code: 'SSO_REQUEST_REJECTED', statusCode: 401 } },
        headers: ssoHeaders,
    }));

    await page.goto('/auth/student/login');
    await seedSession(page, 'student', { accessToken: 'synthetic-access-token' });
    await seedTabHandoff(page, { handoffId: HANDOFF_ID, handoffSecret: 'synthetic-handoff-secret', expiresAt: liveExpiry(), returnPath: '/marketplace' });
    await page.goto('/auth/student/sso/onboarding');
    await page.getByLabel('Account password').fill('Wrong-Password1!');
    await page.getByRole('button', { name: 'Link school sign-in' }).click();
    await expect(page.getByText('Current password is incorrect.')).toBeVisible();
    expect(await readTabHandoff(page)).not.toBeNull();
    await page.getByLabel('Account password').fill('Wrong-Password1!');
    await page.getByRole('button', { name: 'Link school sign-in' }).click();
    await expect(page.getByText('Your session ended before linking.')).toBeVisible();
    api.assertNoUnexpectedRequests();
});
