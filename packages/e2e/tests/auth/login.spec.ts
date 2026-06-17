import { test, expect } from '../../fixtures/index.js';

test.describe('Login UI', () => {
  test('login form renders with name and password fields', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('input[autocomplete="username"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('valid credentials redirect to /#/participants', async ({ page, connInfo }) => {
    await page.goto('/');
    await page.locator('input[autocomplete="username"]').fill('operator');
    await page.locator('input[type="password"]').fill(connInfo.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/#\/participants/);
    // Participants heading confirms the redirect landed correctly
    await expect(page.getByRole('heading', { name: 'Participants' })).toBeVisible();
  });

  test('invalid credentials show error and stay on login', async ({ page }) => {
    await page.goto('/');
    await page.locator('input[autocomplete="username"]').fill('operator');
    await page.locator('input[type="password"]').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByText('Incorrect name or password.')).toBeVisible();
    await expect(page).toHaveURL(/#\/login/);
  });

  test('unauthenticated access to protected route redirects to login', async ({ page }) => {
    await page.goto('/#/participants');
    await expect(page).toHaveURL(/#\/login/);
  });

  test('logout clears session and redirects to login', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/#/participants');
    // Click logout in the sidebar
    await page.getByText('logout').click();
    await expect(page).toHaveURL(/#\/login/);
  });

  test('after logout, navigating to protected route redirects to login', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/#/participants');
    await page.getByText('logout').click();
    await expect(page).toHaveURL(/#\/login/);

    await page.goto('/#/participants');
    await expect(page).toHaveURL(/#\/login/);
  });
});
