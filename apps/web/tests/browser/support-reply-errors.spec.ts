import { expect, test } from '@playwright/test';
import { appOrigin, installSyntheticApi, seedSession } from './fixtures';

for (const role of ['student', 'vendor', 'admin'] as const) {
    for (const failure of ['closed', 'network'] as const) {
        test(`${role} preserves a failed ${failure} reply and reports the error before retry`, async ({ page }) => {
            await installSyntheticApi(page);
            await seedSession(page, role);
            const faults: string[] = [];
            page.on('pageerror', (error) => faults.push(error.message));
            const endpoint = role === 'admin' ? '/admin/support/tickets' : `/${role}s/support-tickets`;
            const path = role === 'student' ? '/student/profile/support' : `/${role}/support`;
            const headers = { 'access-control-allow-origin': appOrigin };
            let replies = 0;
            await page.route(`**${endpoint}/test-ticket`, (route) => route.fulfill({ headers, json: { data: {
                ticket: { id: 'test-ticket', subject: 'Test ticket', status: 'open', category: 'general', createdAt: '2026-09-01T00:00:00Z' }, messages: [],
            } } }));
            await page.route(`**${endpoint}/test-ticket/${role === 'student' ? 'responses' : 'messages'}`, async (route) => {
                replies += 1;
                if (replies === 1) {
                    if (failure === 'network') return route.abort('failed');
                    return route.fulfill({ headers, status: 409, json: { error: { message: 'Ticket closed' } } });
                }
                await route.fulfill({ headers, json: { data: {} } });
            });
            await page.goto(`${path}/test-ticket`);
            await page.getByLabel('Reply', { exact: true }).fill('Keep this draft');
            if (role === 'admin') await page.getByRole('checkbox').check();
            await page.getByRole('button', { name: 'Send reply' }).click();
            await expect(page.locator('form').getByRole('alert')).toContainText('Your draft is preserved');
            await expect(page.getByLabel('Reply', { exact: true })).toHaveValue('Keep this draft');
            if (role === 'admin') await expect(page.getByRole('checkbox')).toBeChecked();
            await page.getByRole('button', { name: 'Send reply' }).click();
            await expect(page.getByLabel('Reply', { exact: true })).toHaveValue('');
            await expect(page.locator('form').getByRole('alert')).toHaveCount(0);
            expect(replies).toBe(2);
            expect(faults).toEqual([]);
        });
    }
}
