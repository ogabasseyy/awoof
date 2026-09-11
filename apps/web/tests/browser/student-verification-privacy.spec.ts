import { expect, test } from '@playwright/test';
import { apiOrigin, appOrigin, installSyntheticApi, seedSession, storageTabPath } from './fixtures';

for (const heldRead of ['status', 'methods'] as const) {
    test(`withdrawal supersedes an older ${heldRead} response in the same session`, async ({ page }) => {
        await installSyntheticApi(page); await seedSession(page, 'student');
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let arrived = false; let withdrawn = false;
        await page.route(`${apiOrigin}/api/verification/**`, async (route) => {
            const path = new URL(route.request().url()).pathname;
            const wasWithdrawn = withdrawn;
            let data: unknown;
            if (path.endsWith('/status')) {
                if (heldRead === 'status' && !wasWithdrawn) { arrived = true; await held; }
                data = { email: 'student@approved.test', emailDomainApproved: true, universityId: 'school', eligibility: { eligible: heldRead === 'status' && !wasWithdrawn }, notices: { verification: { version: 'v1', text: 'Consent notice' } } };
            } else if (path.includes('/methods/')) {
                if (heldRead === 'methods' && !wasWithdrawn) { arrived = true; await held; }
                data = { methods: [{ methodType: 'email', isAvailable: !wasWithdrawn }] };
            } else if (path.endsWith('/consents/grant-a')) { withdrawn = true; data = { grantId: 'grant-a' }; }
            else data = { items: [{ id: 'grant-a', kind: 'processing', acceptedAt: '2026-09-01T00:00:00.000Z', withdrawnAt: null }], nextCursor: null };
            await route.fulfill({ json: { data }, headers: { 'access-control-allow-origin': '*' } });
        });
        try {
            await page.goto('/student/verification');
            await expect.poll(() => arrived).toBe(true);
            await page.getByRole('button', { name: 'Withdraw verification consent' }).click();
            await expect(page.getByText('School email verification is currently unavailable. Please contact support.')).toBeVisible();
            const settled = page.waitForResponse((response) => response.url().includes(heldRead === 'status' ? '/verification/status' : '/verification/methods/'));
            release(); await settled;
            await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
            await expect(page.getByText('Your student eligibility is current.')).toHaveCount(0);
            await page.getByRole('checkbox').check();
            await expect(page.getByRole('button', { name: 'Send verification code' })).toBeDisabled();
        } finally { release(); }
    });
}

test('an older consent history response cannot erase a newly granted consent', async ({ page }) => {
    await installSyntheticApi(page); await seedSession(page, 'student');
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`${apiOrigin}/api/verification/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        let data: unknown;
        if (path.endsWith('/status')) data = { email: 'student@approved.test', emailDomainApproved: true, universityId: 'school', eligibility: { eligible: false }, notices: { verification: { version: 'v1', text: 'Consent notice' } } };
        else if (path.includes('/methods/')) data = { methods: [{ methodType: 'email', isAvailable: true }] };
        else if (path.endsWith('/consents')) { await held; data = { items: [], nextCursor: null }; }
        else if (path.endsWith('/initiate')) data = { processingGrantId: 'new-grant' };
        else data = { challengeId: 'challenge', resendAvailableAt: new Date().toISOString() };
        await route.fulfill({ json: { data }, headers: { 'access-control-allow-origin': '*' } });
    });
    try {
        await page.goto('/student/verification'); await page.getByRole('checkbox').check();
        await page.getByRole('button', { name: 'Send verification code' }).click();
        await expect(page.getByRole('button', { name: 'Withdraw verification consent' })).toBeVisible();
        const settled = page.waitForResponse(`${apiOrigin}/api/verification/consents`);
        release(); await settled;
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await expect(page.getByRole('button', { name: 'Withdraw verification consent' })).toBeVisible();
    } finally { release(); }
});

for (const eligible of [true, false]) {
    test(`withdraws persisted consent after reload with eligibility=${eligible}`, async ({ page }) => {
        await installSyntheticApi(page); await seedSession(page, 'student');
        let withdrawn = false;
        await page.route(`${apiOrigin}/api/verification/**`, async (route) => {
            const path = new URL(route.request().url()).pathname;
            let data: unknown;
            if (path.endsWith('/status')) data = { email: 'student@approved.test', universityId: null, eligibility: { eligible: eligible && !withdrawn }, notices: { verification: { version: 'v1', text: 'Consent notice' } } };
            else if (path.endsWith('/consents/grant-a')) {
                expect(route.request().method()).toBe('DELETE'); withdrawn = true; data = { grantId: 'grant-a' };
            } else if (path.endsWith('/consents')) data = { items: [{ id: 'grant-a', kind: 'processing', acceptedAt: '2026-09-01T00:00:00.000Z', withdrawnAt: withdrawn ? '2026-09-11T00:00:00.000Z' : null }], nextCursor: null };
            else throw new Error(`Unexpected path ${path}`);
            await route.fulfill({ json: { data }, headers: { 'access-control-allow-origin': '*' } });
        });
        await page.goto('/student/verification');
        await page.reload();
        await page.getByRole('button', { name: 'Withdraw verification consent' }).click();
        await expect(page.getByText('Consent withdrawn.', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Withdraw verification consent' })).toHaveCount(0);
        expect(withdrawn).toBe(true);
    });
}

test('replacement clears private verification inputs and never sends an old grant under the new account', async ({ page, context }) => {
    await installSyntheticApi(page); await seedSession(page, 'student');
    const other = await context.newPage(); await other.goto(`${appOrigin}${storageTabPath}`);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let requestStarted = false;
    let emailRequests = 0;
    await page.route(`${apiOrigin}/api/auth/me`, (route) => route.fulfill({ json: { data: { id: route.request().headers().authorization?.includes('student-b') ? 'student-b' : 'student-a', email: 'student@approved.test', role: 'student' } }, headers: { 'access-control-allow-origin': '*' } }));
    await page.route(`${apiOrigin}/api/verification/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        const second = route.request().headers().authorization?.includes('student-b');
        let data: unknown;
        if (path.endsWith('/status')) data = { emailDomainApproved: true, email: second ? 'new@approved.test' : 'private-old@approved.test', universityId: 'school', eligibility: { eligible: false }, notices: { verification: { version: 'v1', text: 'Consent notice' } } };
        else if (path.endsWith('/consents')) data = { items: [], nextCursor: null };
        else if (path.includes('/methods/')) data = { methods: [{ methodType: 'email', isAvailable: true }] };
        else if (path.endsWith('/initiate')) { requestStarted = true; await held; data = { processingGrantId: 'old-grant' }; }
        else { emailRequests += 1; data = { challengeId: 'old-challenge', resendAvailableAt: new Date().toISOString() }; }
        await route.fulfill({ json: { data }, headers: { 'access-control-allow-origin': '*' } });
    });
    try {
        await page.goto('/student/verification'); await page.getByRole('checkbox').check();
        await page.getByRole('button', { name: 'Send verification code' }).click();
        await expect.poll(() => requestStarted).toBe(true);
        await other.evaluate(() => localStorage.setItem('awoof.session.v1', JSON.stringify({ v: 1, state: 'active', sessionId: 'replacement-student', accessToken: 'student-b-access', refreshToken: 'student-b-refresh' })));
        await expect(page.getByText('new@approved.test', { exact: false })).toBeVisible();
        await expect(page.getByText('private-old@approved.test', { exact: false })).toHaveCount(0);
        const settled = page.waitForResponse(`${apiOrigin}/api/verification/initiate`);
        release(); await settled;
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await expect(page.getByRole('checkbox')).not.toBeChecked();
        await expect(page.getByLabel('Email code')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Send verification code' })).toBeDisabled();
        expect(emailRequests).toBe(0);
    } finally { release(); }
});
