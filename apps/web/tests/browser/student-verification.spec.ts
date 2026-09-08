import { expect, test } from '@playwright/test';
import { apiOrigin, installSyntheticApi, seedSession } from './fixtures';

test('an existing student renews eligibility with the current notice and email code', async ({ page }) => {
    await installSyntheticApi(page);
    await seedSession(page, 'student');
    let eligible = false;
    const calls: string[] = [];
    await page.route(`${apiOrigin}/api/verification/**`, async (route) => {
        const endpoint = new URL(route.request().url()).pathname;
        calls.push(endpoint);
        const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
        let data: unknown;
        if (endpoint.endsWith('/status')) data = {
            email: 'student@approved.test', universityId: 'b9c35781-9f75-44b6-98ca-0c928fb993a9',
            eligibility: { eligible }, notices: { verification: { version: 'current-fixture-notice', text: 'I agree to school email verification.' } },
        };
        else if (endpoint.includes('/methods/')) data = { methods: [{ methodType: 'email', isAvailable: true }, { methodType: 'registration', isAvailable: false }] };
        else if (endpoint.endsWith('/initiate')) {
            expect(body).toEqual({ universityId: 'b9c35781-9f75-44b6-98ca-0c928fb993a9', accepted: true, noticeVersion: 'current-fixture-notice' });
            data = { processingGrantId: 'fixture-grant' };
        } else if (endpoint.endsWith('/email/request')) {
            expect(body).toEqual({ processingGrantId: 'fixture-grant' });
            data = { challengeId: 'fixture-challenge', resendAvailableAt: new Date(Date.now() + 60_000).toISOString() };
        } else {
            expect(endpoint).toBe('/api/verification/email/confirm');
            expect(body).toEqual({ challengeId: 'fixture-challenge', otp: '123456' });
            eligible = true; data = { eligibility: { eligible } };
        }
        await route.fulfill({ json: { success: true, data }, headers: { 'access-control-allow-origin': '*' } });
    });
    await page.goto('/student/verification');
    await expect(page.getByRole('button', { name: 'Send verification code' })).toBeDisabled();
    await expect(page.getByText('Enrollment verification is not currently available for your school.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check enrollment' })).toHaveCount(0);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Send verification code' }).click();
    await page.getByLabel('Email code').fill('123456');
    await page.getByRole('button', { name: 'Confirm email', exact: true }).click();
    await expect(page.getByText('Your student eligibility is current.')).toBeVisible();
    expect(calls.filter((value) => value.endsWith('/initiate'))).toHaveLength(1);
});

test('checkout waits for an outstanding status request before scheduling the next poll', async ({ page }) => {
    await installSyntheticApi(page);
    await seedSession(page, 'student');
    await page.clock.install();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`${apiOrigin}/api/checkout/fixture-transaction`, async (route) => {
        calls += 1;
        if (calls === 1) await gate;
        await route.fulfill({ json: { data: { transaction: { status: calls === 1 ? 'pending' : 'completed' } } }, headers: { 'access-control-allow-origin': '*' } });
    });
    await page.goto('/marketplace/purchase/callback?tx=fixture-transaction');
    await expect.poll(() => calls).toBe(1);
    await page.clock.fastForward(15_000);
    expect(calls).toBe(1);
    const response = page.waitForResponse(`${apiOrigin}/api/checkout/fixture-transaction`);
    release(); await response;
    // Let the response continuation schedule the next timer before advancing time.
    await expect(page.getByRole('heading', { name: 'Processing payment…' })).toBeVisible();
    await page.clock.runFor(3_100);
    await expect(page.getByRole('heading', { name: 'Payment successful' })).toBeVisible();
    await page.clock.fastForward(15_000);
    expect(calls).toBe(2);
});

for (const eligible of [true, false]) {
    test(`profile follows effective eligibility ${eligible} despite the opposite legacy flag`, async ({ page }) => {
        await installSyntheticApi(page);
        await seedSession(page, 'student');
        await page.route(`${apiOrigin}/api/auth/me`, (route) => route.fulfill({ json: { success: true, data: {
            id: '00000000-0000-4000-8000-000000000001', email: 'student@approved.test', role: 'student', verificationStatus: eligible ? 'unverified' : 'verified',
        } }, headers: { 'access-control-allow-origin': '*' } }));
        await page.route(`${apiOrigin}/api/verification/status`, (route) => route.fulfill({ json: { data: { eligibility: { eligible } } }, headers: { 'access-control-allow-origin': '*' } }));
        await page.goto('/student/profile');
        await expect(page.getByText(eligible ? 'Verified' : 'Unverified', { exact: true })).toBeVisible();
        await expect(page.getByText(eligible ? 'Unverified' : 'Verified', { exact: true })).toHaveCount(0);
    });
}

test('enrollment becomes actionable only after school email confirmation', async ({ page }) => {
    await installSyntheticApi(page); await seedSession(page, 'student');
    let emailConfirmed = false; let eligible = false;
    await page.route(`${apiOrigin}/api/verification/**`, async (route) => {
        const endpoint = new URL(route.request().url()).pathname;
        let data: unknown;
        if (endpoint.endsWith('/status')) data = { mailboxConfirmed: emailConfirmed, email: 'student@approved.test', universityId: 'b9c35781-9f75-44b6-98ca-0c928fb993a9', eligibility: { eligible }, notices: { verification: { version: 'fixture', text: 'I agree to verification.' } } };
        else if (endpoint.includes('/methods/')) data = { methods: [{ methodType: 'email', isAvailable: true }, { methodType: 'registration', isAvailable: true }] };
        else if (endpoint.endsWith('/initiate')) data = { processingGrantId: 'fixture-grant' };
        else if (endpoint.endsWith('/email/request')) data = { challengeId: 'fixture-challenge', resendAvailableAt: new Date().toISOString() };
        else if (endpoint.endsWith('/email/confirm')) { emailConfirmed = true; data = { eligibility: { eligible: false } }; }
        else {
            expect(endpoint).toBe('/api/verification/registration'); expect(emailConfirmed).toBe(true);
            eligible = true; data = { eligibility: { eligible } };
        }
        await route.fulfill({ json: { data }, headers: { 'access-control-allow-origin': '*' } });
    });
    await page.goto('/student/verification');
    await page.getByRole('checkbox').check();
    await expect(page.getByText('Confirm your school email above before checking enrollment.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check enrollment' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Send verification code' }).click();
    await page.getByLabel('Email code').fill('123456');
    await page.getByRole('button', { name: 'Confirm email', exact: true }).click();
    await page.getByLabel('Registration number').fill('SYNTHETIC-123');
    await page.getByRole('button', { name: 'Check enrollment' }).click();
    await expect(page.getByText('Your student eligibility is current.')).toBeVisible();
});

test('persisted mailbox proof allows enrollment while email delivery is unavailable', async ({ page }) => {
    await installSyntheticApi(page); await seedSession(page, 'student');
    let eligible = false;
    await page.route(`${apiOrigin}/api/verification/**`, async (route) => {
        const endpoint = new URL(route.request().url()).pathname;
        let data: unknown;
        if (endpoint.endsWith('/status')) data = { mailboxConfirmed: true, email: 'student@approved.test', universityId: 'b9c35781-9f75-44b6-98ca-0c928fb993a9', eligibility: { eligible }, notices: { verification: { version: 'fixture', text: 'I agree to verification.' } } };
        else if (endpoint.includes('/methods/')) data = { methods: [{ methodType: 'email', isAvailable: false }, { methodType: 'registration', isAvailable: true }] };
        else if (endpoint.endsWith('/initiate')) data = { processingGrantId: 'fixture-grant' };
        else {
            expect(endpoint).toBe('/api/verification/registration');
            eligible = true; data = { eligibility: { eligible } };
        }
        await route.fulfill({ json: { data }, headers: { 'access-control-allow-origin': '*' } });
    });
    await page.goto('/student/verification');
    await page.getByRole('checkbox').check();
    await expect(page.getByRole('button', { name: 'Send verification code' })).toBeDisabled();
    await page.getByLabel('Registration number').fill('SYNTHETIC-123');
    await page.getByRole('button', { name: 'Check enrollment' }).click();
    await expect(page.getByText('Your student eligibility is current.')).toBeVisible();
});

for (const eligible of [true, false]) {
    test(`marketplace banner follows effective eligibility ${eligible} despite the opposite legacy flag`, async ({ page }) => {
        await installSyntheticApi(page); await seedSession(page, 'student');
        await page.route(`${apiOrigin}/api/auth/me`, (route) => route.fulfill({ json: { data: {
            id: '00000000-0000-4000-8000-000000000001', email: 'student@approved.test', role: 'student', verificationStatus: eligible ? 'unverified' : 'verified',
        } }, headers: { 'access-control-allow-origin': '*' } }));
        await page.route(`${apiOrigin}/api/verification/status`, (route) => route.fulfill({ json: { data: { eligibility: { eligible } } }, headers: { 'access-control-allow-origin': '*' } }));
        await page.goto('/marketplace');
        if (eligible) {
            await expect(page.getByText('You’re verified and ready.', { exact: false })).toBeVisible();
            await expect(page.getByRole('link', { name: 'Finish verification' })).toHaveCount(0);
        } else {
            await expect(page.getByRole('link', { name: 'Finish verification' })).toBeVisible();
            await expect(page.getByText('You’re verified and ready.', { exact: false })).toHaveCount(0);
        }
    });
}

for (const role of ['vendor', 'admin'] as const) {
    test(`${role} returns to their dashboard without student checkout or session refresh`, async ({ page }) => {
        await installSyntheticApi(page); await seedSession(page, role);
        let checkoutCalls = 0; let refreshCalls = 0;
        await page.route(`${apiOrigin}/api/products/synthetic-product`, (route) => route.fulfill({ json: { data: { product: {
            id: 'synthetic-product', name: 'Synthetic student deal', description: 'Test product', price: 100, student_price: 80,
            stock: 10, image_url: null, deal_type: 'product', vendor_payment_method: 'awoof', vendor_name: 'Test vendor',
        } } }, headers: { 'access-control-allow-origin': '*' } }));
        await page.route(`${apiOrigin}/api/checkout`, (route) => { checkoutCalls += 1; return route.fulfill({ status: 401, json: {} }); });
        await page.route(`${apiOrigin}/api/auth/refresh`, (route) => { refreshCalls += 1; return route.fulfill({ status: 401, json: {} }); });
        await page.goto('/marketplace/synthetic-product');
        await page.getByRole('button', { name: 'Claim student price' }).click();
        await expect(page).toHaveURL(new RegExp(`/${role}/dashboard$`));
        expect(checkoutCalls).toBe(0); expect(refreshCalls).toBe(0);
        expect(await page.evaluate(() => localStorage.getItem('awoof.session.v1'))).not.toBeNull();
    });
}

for (const completed of [false, true]) {
    test(`payment polling deadline preserves completed=${completed} and stops requesting status`, async ({ page }) => {
        await installSyntheticApi(page); await seedSession(page, 'student'); await page.clock.install();
        let calls = 0;
        await page.route(`${apiOrigin}/api/checkout/fixture-timeout`, (route) => {
            calls += 1;
            return route.fulfill({ json: { data: { transaction: { status: completed ? 'completed' : 'pending' } } }, headers: { 'access-control-allow-origin': '*' } });
        });
        await page.goto('/marketplace/purchase/callback?tx=fixture-timeout');
        await expect.poll(() => calls).toBe(1);
        if (completed) await expect(page.getByRole('heading', { name: 'Payment successful' })).toBeVisible();
        await page.clock.runFor(121_000);
        await expect(page.getByRole('heading', { name: completed ? 'Payment successful' : 'Payment confirmation delayed' })).toBeVisible();
        if (!completed) {
            await expect(page.getByText('Do not pay again.', { exact: false })).toBeVisible();
            await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible();
        }
        const callsAtDeadline = calls;
        await page.clock.runFor(30_000);
        expect(calls).toBe(callsAtDeadline);
    });
}
