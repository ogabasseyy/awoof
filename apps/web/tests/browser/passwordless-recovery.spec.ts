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

test('fresh grants drive generation then a second re-entry activation without persisting plaintext', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = '74000000-0000-4000-8000-000000000001';
    const activationBodies: unknown[] = [];
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => {
        const attemptId = (JSON.parse(route.request().postData() ?? '{}') as { attemptId?: string }).attemptId;
        return route.fulfill({ status: 201, headers, json: { success: true, data: attemptId === '75000000-0000-4000-8000-000000000002'
            ? { grantId: '76000000-0000-4000-8000-000000000002', grantSecret: 'activate-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_activate', pendingCodeId: pendingId, targetIdentityId: null, activeCodeGeneration: null }
            : { grantId: '76000000-0000-4000-8000-000000000001', grantSecret: 'generate-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_generate', pendingCodeId: null, targetIdentityId: null, activeCodeGeneration: null } } });
    });
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/generate`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { pendingCodeId: pendingId, code: 'one-time-recovery-code' } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/activate`, route => { activationBodies.push(JSON.parse(route.request().postData() ?? '{}')); return route.fulfill({ headers, json: { success: true, data: { active: true } } }); });
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=75000000-0000-4000-8000-000000000001');
    await expect(page.getByText('one-time-recovery-code')).toBeVisible();
    expect(await page.evaluate(() => `${location.href}|${localStorage.getItem('awoof.session.v1')}|${sessionStorage.getItem('awoof.recovery.intent.v1.tab') ?? ''}`)).not.toContain('one-time-recovery-code');
    await page.getByRole('button', { name: 'I saved my code' }).click();
    await page.goto('/auth/student/sso/complete?reauth=75000000-0000-4000-8000-000000000002');
    await page.getByLabel('Re-enter saved recovery code').fill('one-time-recovery-code');
    await page.getByRole('button', { name: 'Activate recovery code' }).click();
    await expect(page.getByRole('heading', { name: 'Recovery code active' })).toBeVisible();
    expect(activationBodies).toEqual([{ reauthGrant: { grantId: '76000000-0000-4000-8000-000000000002', grantSecret: 'activate-grant' }, pendingCodeId: pendingId, code: 'one-time-recovery-code' }]);
    api.assertNoUnexpectedRequests();
});

test('active code replacement and removal require the old code after fresh callback', async ({ page }) => {
    const api = await installSyntheticApi(page); const bodies: unknown[] = [];
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => {
        const id = (JSON.parse(route.request().postData() ?? '{}') as { attemptId?: string }).attemptId;
        const remove = id === '77000000-0000-4000-8000-000000000002';
        return route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: remove ? '78000000-0000-4000-8000-000000000002' : '78000000-0000-4000-8000-000000000001', grantSecret: remove ? 'remove-grant' : 'replace-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: remove ? 'recovery_code_remove' : 'recovery_code_generate', pendingCodeId: null, targetIdentityId: null, activeCodeGeneration: 1 } } });
    });
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/generate`, route => { bodies.push(JSON.parse(route.request().postData() ?? '{}')); return route.fulfill({ status: 201, headers, json: { success: true, data: { pendingCodeId: '79000000-0000-4000-8000-000000000001', code: 'replacement-code' } } }); });
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/remove`, route => { bodies.push(JSON.parse(route.request().postData() ?? '{}')); return route.fulfill({ status: 204, headers }); });
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=77000000-0000-4000-8000-000000000001');
    await page.getByLabel('Current recovery code').fill('old-code'); await page.getByRole('button', { name: 'Generate replacement code' }).click();
    await expect(page.getByText('replacement-code')).toBeVisible();
    await page.goto('/auth/student/sso/complete?reauth=77000000-0000-4000-8000-000000000002');
    await page.getByLabel('Current recovery code').fill('old-code'); await page.getByRole('button', { name: 'Remove recovery code' }).click();
    expect(bodies).toEqual([{ reauthGrant: { grantId: '78000000-0000-4000-8000-000000000001', grantSecret: 'replace-grant' }, oldCode: 'old-code' }, { reauthGrant: { grantId: '78000000-0000-4000-8000-000000000002', grantSecret: 'remove-grant' }, oldCode: 'old-code' }]);
    api.assertNoUnexpectedRequests();
});

test('expired fresh callback and lost generation response leave no code active in the browser', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 409, headers, json: { success: false, error: { code: 'SSO_RESTART_REQUIRED' } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=7a000000-0000-4000-8000-000000000001');
    await expect(page.getByRole('heading', { name: 'Security confirmation unavailable' })).toBeVisible();
    expect(await page.evaluate(() => `${location.href}|${localStorage.getItem('awoof.session.v1')}|${sessionStorage.getItem('awoof.recovery.intent.v1.tab') ?? ''}`)).not.toContain('recovery-code');
    api.assertNoUnexpectedRequests();
});

test('server callback context does not require a tab intent and never persists generated plaintext', async ({ page }) => {
    const api = await installSyntheticApi(page); const pendingId = '7b000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '7c000000-0000-4000-8000-000000000001', grantSecret: 'grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_generate', pendingCodeId: null, targetIdentityId: null, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/generate`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { pendingCodeId: pendingId, code: 'display-once-code' } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=7d000000-0000-4000-8000-000000000001');
    await expect(page.getByText('display-once-code')).toBeVisible();
    expect(await page.evaluate(() => `${location.href}|${localStorage.getItem('awoof.session.v1')}`)).not.toContain('display-once-code');
    api.assertNoUnexpectedRequests();
});
