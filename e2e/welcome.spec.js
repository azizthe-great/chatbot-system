const { test, expect } = require('@playwright/test');

const unavailable = 'Google sign-in is currently unavailable. You can use your email and password.';

async function configureGoogle(page, enabled) {
  await page.route('**/api/auth/config', (route) => route.fulfill({ json: { googleEnabled: enabled } }));
}

test('welcome explains the app before account access and supports returning from login', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await configureGoogle(page, false);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your next import starts here.' })).toBeVisible();
  await expect(page.locator('#welcome-view')).toBeVisible();
  await expect(page.locator('#login-view')).toBeHidden();
  await expect(page.locator('#app-nav')).toBeHidden();
  await page.screenshot({ path: '/tmp/portside-welcome-desktop.png', fullPage: true });

  await page.locator('header [data-auth-open="login"]').click();
  await expect(page).toHaveURL(/#login$/);
  await expect(page.locator('#login-form')).toBeVisible();
  await expect(page.locator('#welcome-view')).toBeHidden();
  await page.locator('#back-to-welcome').click();
  await expect(page).toHaveURL(/#welcome$/);
  await expect(page.locator('#welcome-view')).toBeVisible();
  await expect(page.locator('#login-view')).toBeHidden();

  await page.locator('#welcome-view [data-auth-open="register"]').first().click();
  await expect(page).toHaveURL(/#register$/);
  await expect(page.locator('#login-form').getByLabel('Full name')).toBeVisible();
  await expect(page.locator('#auth-submit')).toHaveText('Create account');
  await page.reload();
  await expect(page.locator('#login-form').getByLabel('Full name')).toBeVisible();
  expect(errors).toEqual([]);
});

test('mobile welcome and account access fit a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await configureGoogle(page, false);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your next import starts here.' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/portside-welcome-mobile.png', fullPage: true });
  await page.locator('#welcome-view [data-auth-open="register"]').first().click();
  await expect(page.locator('#auth-submit')).toBeVisible();
  await expect(page.locator('#google-login')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('unconfigured Google sign-in explains availability and preserves password login', async ({ page }) => {
  await configureGoogle(page, false);
  await page.goto('/#login');
  await expect(page.getByRole('button', { name: 'Sign in with Google', exact: true })).toBeDisabled();
  await expect(page.getByText(unavailable, { exact: true })).toBeVisible();
  await page.locator('#login-form').getByLabel('Email', { exact: true }).fill('importer@example.test');
  await page.getByLabel('Password', { exact: true }).fill('Importer-password-1!');
  await page.locator('#auth-submit').click();
  await expect(page.locator('#importer-view')).toBeVisible();
  await expect(page.locator('#welcome-view')).toBeHidden();
  await expect(page.locator('#login-view')).toBeHidden();
  await page.reload();
  await expect(page.locator('#importer-view')).toBeVisible();
  await expect(page.locator('#welcome-view')).toBeHidden();
});

test('configured Google sign-in starts the server OAuth flow', async ({ page }) => {
  await configureGoogle(page, true);
  // Intercept the first-party start endpoint so this test never visits Google.
  await page.route('**/api/auth/google', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Google authorization started</h1>' }));
  await page.goto('/#login');
  await expect(page.getByRole('button', { name: 'Sign in with Google', exact: true })).toBeEnabled();
  await expect(page.getByText(unavailable, { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Sign in with Google', exact: true }).click();
  await expect(page).toHaveURL(/\/api\/auth\/google$/);
  await expect(page.getByRole('heading', { name: 'Google authorization started' })).toBeVisible();
});

test('Google callback errors return to login and never render raw query content', async ({ page }) => {
  await configureGoogle(page, true);
  await page.goto('/?auth_error=google_cancelled');
  await expect(page.locator('#login-view')).toBeVisible();
  await expect(page.locator('#notice')).toHaveText('Google sign-in was cancelled. Try again or use your email and password.');
  await expect(page).toHaveURL(/\/#login$/);

  await page.goto('/?auth_error=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E');
  await expect(page.locator('#login-view')).toBeVisible();
  await expect(page.locator('#welcome-view')).toBeHidden();
  await expect(page.locator('#notice')).toBeVisible();
  await expect(page.locator('#notice')).toHaveText('Could not complete sign-in. Please try again.');
  await expect(page.locator('#notice')).not.toContainText('<img');
  await expect(page.locator('#notice img')).toHaveCount(0);
  await expect(page).toHaveURL(/\/#login$/);
  await expect(page.locator('#auth-submit')).toBeEnabled();
});

test('Google account settings show email and support name changes without password fields', async ({ page }) => {
  const user = { id: '00000000-0000-4000-8000-000000000001', name: 'Google User', role: 'customer', authProvider: 'google', email: 'person@example.com' };
  let profileInput;
  await configureGoogle(page, true);
  await page.route('**/api/session', (route) => route.fulfill({ json: { user } }));
  await page.route('**/api/catalog', (route) => route.fulfill({ json: { providers: {}, models: [] } }));
  await page.route('**/api/profile', (route) => {
    profileInput = route.request().postDataJSON();
    return route.fulfill({ json: { user: { ...user, name: profileInput.name } } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(page.locator('#profile-form').getByLabel('Email address')).toHaveValue('person@example.com');
  await expect(page.locator('#password-settings')).toBeHidden();
  await expect(page.locator('#google-account-note')).toContainText('person@example.com');
  await page.locator('#profile-form').getByLabel('Full name').fill('Updated Google User');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('#profile-feedback')).toHaveText('Account updated.');
  await expect(page.locator('#account-name')).toHaveText('Updated Google User');
  expect(profileInput.name).toBe('Updated Google User');
  expect(profileInput).not.toHaveProperty('password');
  expect(profileInput).not.toHaveProperty('currentPassword');
});
