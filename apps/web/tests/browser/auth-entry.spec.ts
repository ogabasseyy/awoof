import { expect, test, type Locator } from '@playwright/test';
import { assertCleanFixture, collectBrowserFaults } from './browser-assertions';
import {
  createGate,
  installSyntheticApi,
  studentSignupTestData,
} from './fixtures';

const { email, password } = studentSignupTestData;
const safeWidgetRedirect = '%2Fmarketplace%3Fsource%3Dwidget';
const safeStudentRegisterPath = `/auth/student/register?redirect=${safeWidgetRedirect}`;
const safeStudentLoginPath = `/auth/student/login?redirect=${safeWidgetRedirect}`;
const fallbackStudentRegisterPath = '/auth/student/register?redirect=%2Fmarketplace';

async function expectKeyboardPasswordToggle(input: Locator): Promise<void> {
  const field = input.locator('xpath=..');
  await input.focus();
  await input.press('Tab');

  const show = field.getByRole('button', { name: 'Show password', exact: true });
  await expect(show).toBeFocused();
  const box = await show.boundingBox();
  expect(box).not.toBeNull();
  // Browser transforms can report 24 CSS px as 23.99997; ignore sub-millipixel rounding.
  expect(Math.round(box!.width * 1000) / 1000).toBeGreaterThanOrEqual(24);
  expect(Math.round(box!.height * 1000) / 1000).toBeGreaterThanOrEqual(24);
  const focus = await show.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  });
  expect(focus.outlineStyle).not.toBe('none');
  expect(focus.outlineWidth).toBeGreaterThanOrEqual(2);

  await show.press('Space');
  await expect(input).toHaveAttribute('type', 'text');
  const hide = field.getByRole('button', { name: 'Hide password', exact: true });
  await hide.press('Enter');
  await expect(input).toHaveAttribute('type', 'password');
}

test('generic entry links students into the proof flow and preserves vendor entry', async ({ page }) => {
  const api = await installSyntheticApi(page);
  const faults = collectBrowserFaults(page, api);

  await page.goto(`/auth/register?redirect=${safeWidgetRedirect}`);
  await expect(page.getByRole('link', { name: 'Continue as a student' }))
    .toHaveAttribute('href', safeStudentRegisterPath);
  await expect(page.getByRole('link', { name: 'Continue as a vendor' }))
    .toHaveAttribute('href', '/auth/vendor/register');
  await expect(page.locator('form')).toHaveCount(0);
  await expect(page.locator('input[type="password"], input[type="radio"]')).toHaveCount(0);
  expect(api.registerCalls).toBe(0);
  await assertCleanFixture(api, faults);
});

test('student entry round-trips a safe widget return through signup and login', async ({ page }) => {
  const api = await installSyntheticApi(page);
  const faults = collectBrowserFaults(page, api);

  await page.goto(`/auth/register?redirect=${safeWidgetRedirect}`);
  await page.getByRole('link', { name: 'Continue as a student' }).click();
  await expect(page).toHaveURL(safeStudentRegisterPath);

  const signIn = page.getByRole('link', { name: 'Sign in', exact: true });
  await expect(signIn).toHaveAttribute('href', safeStudentLoginPath);
  await signIn.click();
  await expect(page).toHaveURL(safeStudentLoginPath);

  const signUp = page.getByRole('link', { name: 'Sign up free', exact: true });
  await expect(signUp).toHaveAttribute('href', safeStudentRegisterPath);
  await signUp.click();
  await expect(page).toHaveURL(safeStudentRegisterPath);
  await assertCleanFixture(api, faults);
});

for (const candidate of [
  'https%3A%2F%2Foutside.test%2Fwidget',
  '%2Fauth%2Fstudent%2Flogin',
]) {
  test(`student entry falls back safely for ${candidate}`, async ({ page }) => {
    const api = await installSyntheticApi(page);
    const faults = collectBrowserFaults(page, api);

    await page.goto(`/auth/register?redirect=${candidate}`);
    await expect(page.getByRole('link', { name: 'Continue as a student' }))
      .toHaveAttribute('href', fallbackStudentRegisterPath);
    expect(api.registerCalls).toBe(0);
    await assertCleanFixture(api, faults);
  });
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`student password visibility is a native keyboard control at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const api = await installSyntheticApi(page);
    const faults = collectBrowserFaults(page, api);

    await page.goto('/auth/student/login');
    const input = page.getByLabel('Password', { exact: true });
    await expectKeyboardPasswordToggle(input);
    await expect(input).toHaveAttribute('autocomplete', 'current-password');
    expect(api.loginCalls).toBe(0);
    await assertCleanFixture(api, faults);
  });
}

test('student signup password controls are independently keyboard accessible', async ({ page }) => {
  const api = await installSyntheticApi(page);
  const faults = collectBrowserFaults(page, api);

  await page.goto('/auth/student/register');
  await expectKeyboardPasswordToggle(page.getByLabel('Password', { exact: true }));
  await expectKeyboardPasswordToggle(page.getByLabel('Confirm Password', { exact: true }));
  await assertCleanFixture(api, faults);
});

test('student login exposes associated live validation errors', async ({ page }) => {
  const api = await installSyntheticApi(page);
  const faults = collectBrowserFaults(page, api);

  await page.goto('/auth/student/login');
  await page.getByRole('button', { name: 'Login', exact: true }).click();

  const emailInput = page.getByLabel('Email', { exact: true });
  const passwordInput = page.getByLabel('Password', { exact: true });
  await expect(emailInput).toHaveAttribute('aria-describedby', 'student-login-email-error');
  await expect(passwordInput).toHaveAttribute('aria-describedby', 'student-login-password-error');
  await expect(page.locator('#student-login-email-error')).toHaveAttribute('role', 'alert');
  await expect(page.locator('#student-login-password-error')).toHaveAttribute('role', 'alert');
  expect(api.loginCalls).toBe(0);
  await assertCleanFixture(api, faults);
});

test('student login submits once by Enter and locks password controls while pending', async ({ page }) => {
  const loginGate = createGate('student login pending control state');
  const api = await installSyntheticApi(page, { loginGate });
  const faults = collectBrowserFaults(page, api);

  try {
    await page.goto('/auth/student/login');
    await page.getByLabel('Email', { exact: true }).fill(email);
    const passwordInput = page.getByLabel('Password', { exact: true });
    await passwordInput.fill(password);
    await passwordInput.press('Enter');
    await api.waitForLoginStarted(1);

    await expect(page.getByLabel('Email', { exact: true })).toBeDisabled();
    await expect(passwordInput).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Show password', exact: true })).toBeDisabled();
    await expect(passwordInput).toHaveAttribute('type', 'password');
    expect(api.loginCalls).toBe(1);

    loginGate.release();
    await api.waitForLoginCompleted(1);
    await api.waitForCurrentUserCompleted(1);
    await expect(page).toHaveURL(/\/marketplace$/);
    await assertCleanFixture(api, faults);
  } finally {
    loginGate.release();
    await api.drainPendingHandlers();
  }
});
