import { expect, test } from '@playwright/test';
import { apiOrigin, appOrigin, installSyntheticApi, seedSession } from './fixtures';

for (const fixture of [
    { totalSavings: null, recordedSavings: 20, unknownSavingsCount: 1, label: '₦20 recorded · partial' },
    { totalSavings: null, recordedSavings: 0, unknownSavingsCount: 2, label: 'Unknown' },
    { totalSavings: 0, recordedSavings: 0, unknownSavingsCount: 0, label: '₦0' },
]) {
    test(`marketplace displays ${fixture.label} without inventing complete savings`, async ({ page }) => {
        await installSyntheticApi(page);
        await seedSession(page, 'student');
        await page.route(`${apiOrigin}/api/students/savings`, (route) => route.fulfill({
            headers: { 'access-control-allow-origin': appOrigin },
            json: { success: true, data: { summary: { ...fixture, totalPurchases: 2 }, byCategory: [] } },
        }));
        await page.goto('/marketplace');
        const card = page.getByText('Money saved', { exact: true }).locator('..');
        await expect(card.getByText(fixture.label, { exact: true })).toBeVisible();
        if (fixture.totalSavings === null) {
            await expect(card.getByText('Your first discount will show up here')).toHaveCount(0);
            await expect(card.getByText('₦0', { exact: true })).toHaveCount(0);
        }
    });
}

for (const width of [390, 1280]) {
test(`receipt preserves unknown original price and savings while displaying the paid amount at width ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await installSyntheticApi(page);
    await seedSession(page, 'student');
    await page.route(`${apiOrigin}/api/students/purchases`, (route) => route.fulfill({
        headers: { 'access-control-allow-origin': appOrigin },
        json: { success: true, data: { transactions: [{
            id: 'synthetic-purchase', transactionId: 'synthetic-purchase', amount: null,
            discountAmount: null, finalAmount: 80, status: 'completed',
            createdAt: '2026-09-01T00:00:00Z', product: { name: 'Historical purchase', vendorName: 'Synthetic vendor' },
        }] } },
    }));
    await page.goto('/student/profile/receipts');
    await expect(page.getByText('Historical purchase', { exact: true }).filter({ visible: true })).toBeVisible();
    await expect(page.getByText('Unknown', { exact: true }).filter({ visible: true })).toHaveCount(2);
    await expect(page.getByText('₦80', { exact: true }).filter({ visible: true })).toBeVisible();
    await expect(page.getByText('-₦0', { exact: true })).toHaveCount(0);
    await expect(page.getByText('₦0', { exact: true })).toHaveCount(0);
});
}
