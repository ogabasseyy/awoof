import { expect, test } from '@playwright/test';
import { apiOrigin, appOrigin, installSyntheticApi, seedSession } from './fixtures';

const headers = { 'access-control-allow-origin': appOrigin, 'access-control-allow-credentials': 'true' };

test('security setup keeps the generated recovery code out of URL and web storage and requires a second fresh proof', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ json: { success: true, data: { status: 'unconfigured', generation: null } }, headers }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [] } } }));
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

test('ambiguous recovery completion keeps the password and points at sign-in before another recovery', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/start`, route => route.fulfill({ status: 202, headers, json: { success: true, data: { attemptId: '90000000-0000-4000-8000-000000000001', secret: 'recovery-secret', expiresAt: new Date(Date.now() + 300_000).toISOString() } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/verify`, route => route.fulfill({ headers, json: { success: true, data: { verified: true } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/complete`, route => route.fulfill({ status: 500, headers, json: { success: false, error: { message: 'boom', code: 'INTERNAL', statusCode: 500 } } }));
    await page.goto('/auth/student/recovery');
    await page.getByLabel('School email').fill('student@school.example');
    await page.getByRole('button', { name: 'Start recovery' }).click();
    await page.getByLabel('Saved recovery code').fill('saved-code');
    await page.getByLabel('Email confirmation code').fill('123456');
    await page.getByRole('button', { name: 'Confirm recovery proofs' }).click();
    await page.getByLabel('New password').fill('Brand-New-Password-1');
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByText('did not confirm')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Try signing in with this password' })).toBeVisible();
    await expect(page.getByLabel('New password')).toHaveValue('Brand-New-Password-1');
    api.assertNoUnexpectedRequests();
});

test('recovery completion surfaces password-policy rejections without sign-in advice', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/start`, route => route.fulfill({ status: 202, headers, json: { success: true, data: { attemptId: '97000000-0000-4000-8000-000000000001', secret: 'recovery-secret', expiresAt: new Date(Date.now() + 300_000).toISOString() } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/verify`, route => route.fulfill({ headers, json: { success: true, data: { verified: true } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/complete`, route => route.fulfill({ status: 409, headers, json: { success: false, error: { message: 'Password must contain at least one uppercase letter', code: 'CONFLICT', statusCode: 409 } } }));
    await page.goto('/auth/student/recovery');
    await page.getByLabel('School email').fill('student@school.example');
    await page.getByRole('button', { name: 'Start recovery' }).click();
    await page.getByLabel('Saved recovery code').fill('saved-code');
    await page.getByLabel('Email confirmation code').fill('123456');
    await page.getByRole('button', { name: 'Confirm recovery proofs' }).click();
    // Deterministic rejections save nothing, so the page shows the reason
    // and keeps the form instead of suggesting an unsaved password works.
    await expect(page.getByText('at least 8 characters with an uppercase letter')).toBeVisible();
    await page.getByLabel('New password').fill('all-lowercase-1!');
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByText('Password must contain at least one uppercase letter')).toBeVisible();
    expect(await page.getByRole('link', { name: 'Try signing in with this password' }).count()).toBe(0);
    await expect(page.getByLabel('New password')).toHaveValue('all-lowercase-1!');
    api.assertNoUnexpectedRequests();
});

test('recovery shows the attempt deadline while proofs are pending', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/start`, route => route.fulfill({ status: 202, headers, json: { success: true, data: { attemptId: '98000000-0000-4000-8000-000000000001', secret: 'recovery-secret', expiresAt: new Date(Date.now() + 300_000).toISOString() } } }));
    await page.goto('/auth/student/recovery');
    await page.getByLabel('School email').fill('student@school.example');
    await page.getByRole('button', { name: 'Start recovery' }).click();
    await expect(page.getByRole('timer')).toContainText(/Complete this recovery within \d+:\d\d/);
    api.assertNoUnexpectedRequests();
});

test('expired recovery attempts show an explicit restart state', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/start`, route => route.fulfill({ status: 202, headers, json: { success: true, data: { attemptId: '99000000-0000-4000-8000-000000000001', secret: 'recovery-secret', expiresAt: new Date(Date.now() - 1_000).toISOString() } } }));
    await page.goto('/auth/student/recovery');
    await page.getByLabel('School email').fill('student@school.example');
    await page.getByRole('button', { name: 'Start recovery' }).click();
    await expect(page.getByText('This recovery attempt expired before completion.')).toBeVisible();
    await page.getByRole('button', { name: 'Start again' }).click();
    await expect(page.getByRole('button', { name: 'Start recovery' })).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('recovery deadlines use the server clock on skewed devices', async ({ page }) => {
    const api = await installSyntheticApi(page);
    // The device clock runs ten minutes fast: the expiry is device-past
    // but the server clock in the same response keeps nine minutes left.
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/start`, route => route.fulfill({ status: 202, headers, json: { success: true, data: { attemptId: '9a000000-0000-4000-8000-000000000001', secret: 'recovery-secret', expiresAt: new Date(Date.now() - 30_000).toISOString(), serverNow: new Date(Date.now() - 600_000).toISOString() } } }));
    await page.goto('/auth/student/recovery');
    await page.getByLabel('School email').fill('student@school.example');
    await page.getByRole('button', { name: 'Start recovery' }).click();
    await expect(page.getByRole('timer')).toContainText(/Complete this recovery within 9:(29|30|31)/);
    await expect(page.getByLabel('Saved recovery code')).toBeVisible();
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
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/generate`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { pendingCodeId: pendingId, code: 'one-time-recovery-code', expiresAt: new Date(Date.now() + 600_000).toISOString() } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/activate`, route => { activationBodies.push(JSON.parse(route.request().postData() ?? '{}')); return route.fulfill({ headers, json: { success: true, data: { active: true } } }); });
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'pending', generation: 1, pendingCodeId: pendingId, pendingExpiresAt: new Date(Date.now() + 600_000).toISOString() } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=75000000-0000-4000-8000-000000000001');
    await expect(page.getByText('one-time-recovery-code')).toBeVisible();
    await expect(page.getByRole('timer')).toContainText(/Activate this code within \d+:\d\d/);
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
    await expect(page.getByRole('heading', { name: 'Recovery code removed' })).toBeVisible();
    expect(bodies).toEqual([{ reauthGrant: { grantId: '78000000-0000-4000-8000-000000000001', grantSecret: 'replace-grant' }, oldCode: 'old-code' }, { reauthGrant: { grantId: '78000000-0000-4000-8000-000000000002', grantSecret: 'remove-grant' }, oldCode: 'old-code' }]);
    api.assertNoUnexpectedRequests();
});

test('replacement activation submits the current code alongside the re-entered code', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = '7f000000-0000-4000-8000-000000000001';
    const activationBodies: unknown[] = [];
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '80000000-0000-4000-8000-000000000001', grantSecret: 'activate-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_activate', pendingCodeId: pendingId, targetIdentityId: null, activeCodeGeneration: 1 } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/activate`, route => { activationBodies.push(JSON.parse(route.request().postData() ?? '{}')); return route.fulfill({ headers, json: { success: true, data: { active: true } } }); });
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'pending', generation: 2, pendingCodeId: pendingId, pendingExpiresAt: new Date(Date.now() + 600_000).toISOString() } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=81000000-0000-4000-8000-000000000001');
    await expect(page.getByRole('timer')).toContainText(/Activate this code within \d+:\d\d/);
    await page.getByLabel('Re-enter saved recovery code').fill('replacement-code');
    await page.getByLabel('Current recovery code').fill('old-code');
    await page.getByRole('button', { name: 'Activate recovery code' }).click();
    await expect(page.getByRole('heading', { name: 'Recovery code active' })).toBeVisible();
    expect(activationBodies).toEqual([{ reauthGrant: { grantId: '80000000-0000-4000-8000-000000000001', grantSecret: 'activate-grant' }, pendingCodeId: pendingId, code: 'replacement-code', oldCode: 'old-code' }]);
    api.assertNoUnexpectedRequests();
});

test('password confirmation drives generation then activation without a provider redirect', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = '82000000-0000-4000-8000-000000000001';
    const bodies: unknown[] = [];
    let statusCalls = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => { statusCalls++; return route.fulfill({ headers, json: { success: true, data: statusCalls === 1 ? { status: 'unconfigured', generation: null, pendingCodeId: null } : { status: 'active', generation: 1, pendingCodeId: null } } }); });
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth`, route => { bodies.push(JSON.parse(route.request().postData() ?? '{}')); return route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '83000000-0000-4000-8000-000000000001', grantSecret: 'pw-grant', expiresAt: new Date(Date.now() + 60_000).toISOString() } } }); });
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/generate`, route => { bodies.push(JSON.parse(route.request().postData() ?? '{}')); return route.fulfill({ status: 201, headers, json: { success: true, data: { pendingCodeId: pendingId, code: 'password-flow-code', expiresAt: new Date(Date.now() + 600_000).toISOString() } } }); });
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/activate`, route => { bodies.push(JSON.parse(route.request().postData() ?? '{}')); return route.fulfill({ headers, json: { success: true, data: { active: true } } }); });
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [] } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    await page.getByRole('button', { name: 'Use your password instead' }).click();
    await page.getByRole('button', { name: 'Confirm identity to generate a code' }).click();
    await page.getByLabel('Current password').fill('Correct!horse-9-battery');
    await page.getByRole('button', { name: 'Generate code' }).click();
    await expect(page.getByText('password-flow-code')).toBeVisible();
    await expect(page.getByRole('timer')).toContainText(/Activate this code within \d+:\d\d/);
    await page.getByRole('button', { name: 'I saved my code' }).click();
    await expect(page.getByRole('timer')).toContainText(/Activate this code within \d+:\d\d/);
    await page.getByLabel('Current password').fill('Correct!horse-9-battery');
    await page.getByLabel('Re-enter saved recovery code').fill('password-flow-code');
    await page.getByRole('button', { name: 'Activate code' }).click();
    await expect(page.getByText('A recovery code is active.')).toBeVisible();
    expect(bodies).toEqual([
        { password: 'Correct!horse-9-battery', purpose: 'recovery_code_generate' },
        { reauthGrant: { grantId: '83000000-0000-4000-8000-000000000001', grantSecret: 'pw-grant' } },
        { password: 'Correct!horse-9-battery', purpose: 'recovery_code_activate', pendingCodeId: pendingId },
        { reauthGrant: { grantId: '83000000-0000-4000-8000-000000000001', grantSecret: 'pw-grant' }, pendingCodeId: pendingId, code: 'password-flow-code' },
    ]);
    api.assertNoUnexpectedRequests();
});

test('fresh unlink proof continues to identity removal with a last-method escape', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const targetId = '84000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '85000000-0000-4000-8000-000000000001', grantSecret: 'unlink-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'unlink', pendingCodeId: null, targetIdentityId: targetId, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities/${targetId}/unlink`, route => route.fulfill({ headers, json: { success: true, data: { unlinked: true, sessionRevoked: false } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=86000000-0000-4000-8000-000000000001');
    await expect(page.getByRole('heading', { name: 'Sign-in method removed' })).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('unlink that revokes the active session clears local tokens and signs out', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const targetId = '8a000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '8b000000-0000-4000-8000-000000000001', grantSecret: 'unlink-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'unlink', pendingCodeId: null, targetIdentityId: targetId, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities/${targetId}/unlink`, route => route.fulfill({ headers, json: { success: true, data: { unlinked: true, sessionRevoked: true } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=8c000000-0000-4000-8000-000000000001');
    await expect(page.getByText('You have been signed out.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to sign-in' })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('awoof.session.v1'))).toContain('"signed_out"');
    api.assertNoUnexpectedRequests();
});

test('fresh unlink proof surfaces the last-method guard instead of failing', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const targetId = '87000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '88000000-0000-4000-8000-000000000001', grantSecret: 'unlink-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'unlink', pendingCodeId: null, targetIdentityId: targetId, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities/${targetId}/unlink`, route => route.fulfill({ status: 409, headers, json: { success: false, error: { message: 'Removing this sign-in would lock the account.', code: 'SSO_LAST_LOGIN_METHOD', statusCode: 409 } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=89000000-0000-4000-8000-000000000001');
    await expect(page.getByRole('heading', { name: 'Cannot remove the last sign-in method' })).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('ambiguous fresh-proof link failure retains the handoff for retry', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const handoffId = '61000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '62000000-0000-4000-8000-000000000001', grantSecret: 'link-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'link', pendingCodeId: null, targetIdentityId: null, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/link`, route => route.fulfill({ status: 500, headers, json: { success: false, error: { message: 'Link is temporarily unavailable', code: 'INTERNAL', statusCode: 500 } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.evaluate(({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)), {
        key: 'awoof.sso.handoff.v1.tab',
        value: { handoffId, handoffSecret: 'synthetic-handoff-secret', expiresAt: new Date(Date.now() + 600_000).toISOString(), returnPath: '/marketplace' },
    });
    await page.goto('/auth/student/sso/complete?reauth=63000000-0000-4000-8000-000000000001');
    // The transient failure leaves no terminal outcome, so the tab keeps
    // its only copy of the live handoff for a retry with a fresh grant.
    await expect(page.getByRole('heading', { name: 'Security confirmation unavailable' })).toBeVisible();
    expect(await page.evaluate((key) => sessionStorage.getItem(key), 'awoof.sso.handoff.v1.tab')).toContain(handoffId);
    api.assertNoUnexpectedRequests();
});

test('terminal fresh-proof link mismatch spends the handoff and restarts', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const handoffId = '64000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '65000000-0000-4000-8000-000000000001', grantSecret: 'link-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'link', pendingCodeId: null, targetIdentityId: null, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/link`, route => route.fulfill({ status: 409, headers, json: { success: false, error: { message: 'Mismatch.', code: 'SSO_LINK_MISMATCH', statusCode: 409 } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.evaluate(({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)), {
        key: 'awoof.sso.handoff.v1.tab',
        value: { handoffId, handoffSecret: 'synthetic-handoff-secret', expiresAt: new Date(Date.now() + 600_000).toISOString(), returnPath: '/marketplace' },
    });
    await page.goto('/auth/student/sso/complete?reauth=66000000-0000-4000-8000-000000000001');
    await expect(page.getByRole('heading', { name: 'School sign-in link unavailable' })).toBeVisible();
    expect(await page.evaluate((key) => sessionStorage.getItem(key), 'awoof.sso.handoff.v1.tab')).toBeNull();
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

test('lost generation or activation responses recover only through server status and never reveal plaintext', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'pending', generation: 1, pendingCodeId: '7e000000-0000-4000-8000-000000000001' } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [] } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    await expect(page.getByText('A pending code exists')).toBeVisible();
    await expect(page.getByText('one-time-recovery-code')).toHaveCount(0);
    await page.unroute(`${apiOrigin}/api/auth/student/sso/recovery-code`);
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'active', generation: 1, pendingCodeId: null } } }));
    await page.reload();
    await expect(page.getByText('A recovery code is active.')).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('replacement generation ignores a second click while the first request is in flight', async ({ page }) => {
    const api = await installSyntheticApi(page); let release!: () => void; let calls = 0; const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '81000000-0000-4000-8000-000000000001', grantSecret: 'grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_generate', pendingCodeId: null, targetIdentityId: null, activeCodeGeneration: 1 } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/generate`, async route => { calls += 1; await gate; await route.fulfill({ status: 201, headers, json: { success: true, data: { pendingCodeId: '82000000-0000-4000-8000-000000000001', code: 'new-code' } } }); });
    await page.goto('/auth/student/login'); await seedSession(page, 'student'); await page.goto('/auth/student/sso/complete?reauth=83000000-0000-4000-8000-000000000001');
    const submit = page.getByRole('button', { name: 'Generate replacement code' }); await submit.click(); await expect(submit).toBeEnabled(); expect(calls).toBe(0); await page.getByLabel('Current recovery code').fill('old-code'); await submit.click(); await expect(submit).toBeDisabled(); await submit.click({ force: true }); expect(calls).toBe(1); release(); await expect(page.getByText('new-code')).toBeVisible(); api.assertNoUnexpectedRequests();
});

test('a dropped generation response resumes only as server pending state without plaintext', async ({ page }) => {
    const api = await installSyntheticApi(page); let serverPending = false; let markServerPending!: () => void;
    const serverWrite = new Promise<void>(resolve => { markServerPending = resolve; });
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '84000000-0000-4000-8000-000000000001', grantSecret: 'grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_generate', pendingCodeId: null, targetIdentityId: null, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/generate`, route => { serverPending = true; markServerPending(); return route.abort('failed'); });
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: serverPending ? 'pending' : 'unconfigured', generation: 1, pendingCodeId: serverPending ? '85000000-0000-4000-8000-000000000001' : null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [] } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student'); await page.goto('/auth/student/sso/complete?reauth=86000000-0000-4000-8000-000000000001'); await expect(page.getByRole('heading', { name: 'Security confirmation unavailable' })).toBeVisible(); await serverWrite; await page.goto('/student/security'); await expect(page.getByText('A pending code exists')).toBeVisible(); await expect(page.getByRole('button', { name: 'Cancel pending code' })).toBeVisible(); expect(await page.content()).not.toContain('new-code'); api.assertNoUnexpectedRequests();
});

test('account security lists school sign-ins and removes one with password confirmation', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const targetId = '8d000000-0000-4000-8000-000000000001';
    const grantId = '8e000000-0000-4000-8000-000000000001';
    const bodies: unknown[] = [];
    let identitiesCalls = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'unconfigured', generation: null, pendingCodeId: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => { identitiesCalls++; return route.fulfill({ headers, json: { success: true, data: { identities: identitiesCalls === 1 ? [{ id: targetId, provider: 'microsoft', universityName: 'Fixture University', linkedAt: new Date().toISOString() }] : [] } } }); });
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth`, route => { bodies.push(JSON.parse(route.request().postData() ?? '{}')); return route.fulfill({ status: 201, headers, json: { success: true, data: { grantId, grantSecret: 'unlink-pw-grant', expiresAt: new Date(Date.now() + 60_000).toISOString() } } }); });
    await page.route(`${apiOrigin}/api/auth/student/sso/identities/${targetId}/unlink`, route => { bodies.push(JSON.parse(route.request().postData() ?? '{}')); return route.fulfill({ headers, json: { success: true, data: { unlinked: true, sessionRevoked: false } } }); });
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    await expect(page.getByText('Microsoft · Fixture University')).toBeVisible();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    // The school sign-in path starts a target-bound fresh proof; the
    // password path completes inline below.
    await expect(page.getByRole('button', { name: 'Remove with school sign-in' })).toBeVisible();
    await page.getByLabel('Current password').fill('Correct!horse-9-battery');
    await page.getByRole('button', { name: 'Remove with password' }).click();
    await expect(page.getByText('No school sign-ins are linked.')).toBeVisible();
    expect(bodies).toEqual([
        { password: 'Correct!horse-9-battery', purpose: 'unlink', targetIdentityId: targetId },
        { reauthGrant: { grantId, grantSecret: 'unlink-pw-grant' } },
    ]);
    api.assertNoUnexpectedRequests();
});

test('account security surfaces the last-method guard instead of removing', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const targetId = '8f000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'unconfigured', generation: null, pendingCodeId: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [{ id: targetId, provider: 'google', universityName: 'Fixture University', linkedAt: new Date().toISOString() }] } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '90000000-0000-4000-8000-000000000001', grantSecret: 'unlink-pw-grant', expiresAt: new Date(Date.now() + 60_000).toISOString() } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities/${targetId}/unlink`, route => route.fulfill({ status: 409, headers, json: { success: false, error: { message: 'last', code: 'SSO_LAST_LOGIN_METHOD', statusCode: 409 } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    await expect(page.getByText('Google · Fixture University')).toBeVisible();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.getByLabel('Current password').fill('Correct!horse-9-battery');
    await page.getByRole('button', { name: 'Remove with password' }).click();
    await expect(page.getByText('This is the last sign-in method. Link another school sign-in first.')).toBeVisible();
    await expect(page.getByText('Google · Fixture University')).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('identity controls stay available when recovery status is unavailable', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const targetId = '93000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ status: 503, headers, json: { success: false, error: { message: 'Account recovery is unavailable', statusCode: 503 } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [{ id: targetId, provider: 'microsoft', universityName: 'Fixture University', linkedAt: new Date().toISOString() }] } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    // The recovery section reports its own outage inline while the
    // already-loaded school sign-in stays removable.
    await expect(page.getByText('Recovery-code setup is unavailable.')).toBeVisible();
    await expect(page.getByText('Microsoft · Fixture University')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('pending-code deadlines use the server clock on skewed devices', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = '9b000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'pending', generation: 1, pendingCodeId: pendingId, pendingExpiresAt: new Date(Date.now() - 30_000).toISOString(), serverNow: new Date(Date.now() - 600_000).toISOString() } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [] } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    // The device-past deadline is server-live, so the pending view and
    // its countdown render instead of the expired restart state.
    await expect(page.getByRole('timer')).toContainText(/Activate this code within 9:(29|30|31)/);
    await expect(page.getByRole('button', { name: 'Confirm identity to activate saved code' })).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('replacement deadlines use the server clock on skewed devices', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = '9c000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '9d000000-0000-4000-8000-000000000001', grantSecret: 'grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_generate', pendingCodeId: null, targetIdentityId: null, activeCodeGeneration: 1 } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/generate`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { pendingCodeId: pendingId, code: 'skewed-replacement-code', expiresAt: new Date(Date.now() - 30_000).toISOString(), serverNow: new Date(Date.now() - 600_000).toISOString() } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=9e000000-0000-4000-8000-000000000001');
    await page.getByLabel('Current recovery code').fill('old-code');
    await page.getByRole('button', { name: 'Generate replacement code' }).click();
    // The replacement response carries the skew sample, so the fresh
    // code displays with its countdown instead of the expired view.
    await expect(page.getByText('skewed-replacement-code')).toBeVisible();
    await expect(page.getByRole('timer')).toContainText(/Activate this code within 9:(29|30|31)/);
    api.assertNoUnexpectedRequests();
});

test('ambiguous activation reconciles against status and renders success', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = '9f000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: 'a0000000-0000-4000-8000-000000000001', grantSecret: 'grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_activate', pendingCodeId: pendingId, targetIdentityId: null, activeCodeGeneration: null } } }));
    let statusCalls = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => {
        statusCalls++;
        return statusCalls === 1
            ? route.fulfill({ headers, json: { success: true, data: { status: 'pending', generation: 1, pendingCodeId: pendingId, pendingExpiresAt: new Date(Date.now() + 600_000).toISOString(), serverNow: new Date().toISOString() } } })
            : route.fulfill({ headers, json: { success: true, data: { status: 'active', generation: 1, pendingCodeId: null, pendingExpiresAt: null, serverNow: new Date().toISOString() } } });
    });
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/activate`, route => route.fulfill({ status: 500, headers, json: { success: false, error: { message: 'unavailable' } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=a1000000-0000-4000-8000-000000000001');
    await page.getByLabel('Re-enter saved recovery code').fill('saved-code');
    await page.getByRole('button', { name: 'Activate recovery code' }).click();
    // The activation committed but the response was lost: the consumed
    // grant cannot retry, so status confirms the active code instead.
    await expect(page.getByRole('heading', { name: 'Recovery code active' })).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('ambiguous activation rejects a stale active generation after replacement expiry', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = 'a5000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: 'a6000000-0000-4000-8000-000000000001', grantSecret: 'grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_activate', pendingCodeId: pendingId, targetIdentityId: null, activeCodeGeneration: 1 } } }));
    let statusCalls = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => {
        statusCalls++;
        return statusCalls === 1
            ? route.fulfill({ headers, json: { success: true, data: { status: 'pending', generation: 2, pendingCodeId: pendingId, pendingExpiresAt: new Date(Date.now() + 600_000).toISOString(), serverNow: new Date().toISOString() } } })
            : route.fulfill({ headers, json: { success: true, data: { status: 'active', generation: 1, pendingCodeId: null, pendingExpiresAt: null, serverNow: new Date().toISOString() } } });
    });
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/activate`, route => route.fulfill({ status: 500, headers, json: { success: false, error: { message: 'unavailable' } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=a7000000-0000-4000-8000-000000000001');
    await page.getByLabel('Re-enter saved recovery code').fill('saved-code');
    await page.getByLabel('Current recovery code').fill('old-code');
    await page.getByRole('button', { name: 'Activate recovery code' }).click();
    // The pending replacement never committed and the old generation is
    // still authoritative: an unrelated active code must not read as the
    // newly saved code's success.
    await expect(page.getByText('This confirmation could not be completed.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Activate recovery code' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Recovery code active' })).toHaveCount(0);
    api.assertNoUnexpectedRequests();
});

test('ambiguous activation keeps the form when status shows the code still pending', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = 'a2000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: 'a3000000-0000-4000-8000-000000000001', grantSecret: 'grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_activate', pendingCodeId: pendingId, targetIdentityId: null, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'pending', generation: 1, pendingCodeId: pendingId, pendingExpiresAt: new Date(Date.now() + 600_000).toISOString(), serverNow: new Date().toISOString() } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/activate`, route => route.fulfill({ status: 500, headers, json: { success: false, error: { message: 'unavailable' } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=a4000000-0000-4000-8000-000000000001');
    await page.getByLabel('Re-enter saved recovery code').fill('saved-code');
    await page.getByRole('button', { name: 'Activate recovery code' }).click();
    await expect(page.getByText('This confirmation could not be completed.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Activate recovery code' })).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('failed school sign-in start keeps the password fallback available', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = '91000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'unconfigured', generation: null, pendingCodeId: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [] } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/microsoft/start`, route => route.fulfill({ status: 503, headers, json: { success: false, error: { message: 'unavailable', statusCode: 503 } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '92000000-0000-4000-8000-000000000001', grantSecret: 'pw-grant', expiresAt: new Date(Date.now() + 60_000).toISOString() } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/generate`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { pendingCodeId: pendingId, code: 'fallback-code' } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    await page.getByRole('button', { name: 'Confirm identity to generate a code' }).click();
    await expect(page.getByText('School sign-in confirmation is unavailable right now.')).toBeVisible();
    // The password toggle survives the school failure: the
    // provider-independent flow still completes generation.
    await page.getByRole('button', { name: 'Use your password instead' }).click();
    await page.getByRole('button', { name: 'Confirm identity to generate a code' }).click();
    await page.getByLabel('Current password').fill('Correct!horse-9-battery');
    await page.getByRole('button', { name: 'Generate code' }).click();
    await expect(page.getByText('fallback-code')).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('account security links a new school sign-in through school confirmation', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const bodies: unknown[] = [];
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'unconfigured', generation: null, pendingCodeId: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [] } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/microsoft/start`, route => { bodies.push(JSON.parse(route.request().postData() ?? '{}')); return route.fulfill({ status: 503, headers, json: { success: false, error: { message: 'unavailable', statusCode: 503 } } }); });
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    await expect(page.getByText('No school sign-ins are linked.')).toBeVisible();
    // Linking confirms against the signed-in account with a Microsoft
    // fresh proof, so passwordless owners are not sent down a password
    // journey. The failure path stays inline with the session intact.
    await page.getByRole('button', { name: 'Link a school sign-in' }).click();
    await expect(page.getByText('School sign-in confirmation could not start.')).toBeVisible();
    expect(bodies).toEqual([{ purpose: 'link' }]);
    expect(api.logoutCalls).toBe(0);
    await expect(page).toHaveURL(/\/student\/security$/);
    api.assertNoUnexpectedRequests();
});

test('an expired pending code shows a restart state instead of a usable activation form', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = '93000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '94000000-0000-4000-8000-000000000001', grantSecret: 'activate-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_activate', pendingCodeId: pendingId, targetIdentityId: null, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'pending', generation: 1, pendingCodeId: pendingId, pendingExpiresAt: new Date(Date.now() + 2_000).toISOString() } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=95000000-0000-4000-8000-000000000001');
    await expect(page.getByRole('timer')).toContainText(/Activate this code within \d+:\d\d/);
    await expect(page.getByRole('heading', { name: 'Pending code expired' })).toBeVisible();
    await expect(page.getByText('expired before activation and cannot recover your account')).toBeVisible();
    expect(await page.getByRole('button', { name: 'Activate recovery code' }).count()).toBe(0);
    api.assertNoUnexpectedRequests();
});

test('an expired pending on account security refreshes to current status and restarts', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = '96000000-0000-4000-8000-000000000001';
    let statusCalls = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => { statusCalls++; return route.fulfill({ headers, json: { success: true, data: statusCalls === 1 ? { status: 'pending', generation: 1, pendingCodeId: pendingId, pendingExpiresAt: new Date(Date.now() + 2_000).toISOString() } : { status: 'unconfigured', generation: 1, pendingCodeId: null, pendingExpiresAt: null } } }); });
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [] } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    await expect(page.getByRole('timer')).toContainText(/Activate this code within \d+:\d\d/);
    await expect(page.getByText('expired before activation and cannot recover your account')).toBeVisible();
    await page.getByRole('button', { name: 'Refresh status' }).click();
    await expect(page.getByRole('button', { name: 'Confirm identity to generate a code' })).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('re-enrollment after account recovery requires the password path on account security', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/me`, route => route.fulfill({ headers, json: { success: true, data: { id: '00000000-0000-4000-8000-000000000001', email: 'student@approved.test', role: 'student', verificationStatus: 'verified', recoveryReenrollmentRequired: true } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'unconfigured', generation: null, pendingCodeId: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [] } } }));
    let schoolStartCalls = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/microsoft/start`, route => { schoolStartCalls++; return route.fulfill({ status: 201, headers, json: { success: true, data: { authorizationUrl: 'https://provider.example.invalid/authorize' } } }); });
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    // generate() rejects provider-backed grants while the re-enrollment
    // marker stands, so the page must not offer the school round-trip.
    await expect(page.getByText('School sign-in cannot be used for this enrollment.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use your password instead' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Confirm identity to generate a code' }).click();
    await expect(page.getByRole('heading', { name: 'Confirm with your password' })).toBeVisible();
    expect(schoolStartCalls).toBe(0);
    api.assertNoUnexpectedRequests();
});

test('marketplace surfaces recovery-code re-enrollment after account recovery', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/me`, route => route.fulfill({ headers, json: { success: true, data: { id: '00000000-0000-4000-8000-000000000001', email: 'student@approved.test', role: 'student', verificationStatus: 'verified', recoveryReenrollmentRequired: true } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/marketplace');
    await expect(page.getByText('Account recovery used your only recovery code.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Set up a new code' })).toHaveAttribute('href', '/student/security');
    api.assertNoUnexpectedRequests();
});
