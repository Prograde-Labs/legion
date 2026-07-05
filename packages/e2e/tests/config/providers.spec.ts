import { test, expect } from '../../fixtures/index.js';

test.describe('Config — Providers tab', () => {
  test('renders with empty state text when no providers configured', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/#/config');

    await expect(page.getByRole('button', { name: 'providers' })).toBeVisible();
    // The descriptive text is always visible; the table body is empty
    await expect(page.getByText('Provider instances available to agents')).toBeVisible();
  });

  test('"+ Add provider" opens slide-over', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/#/config');

    await page.getByRole('button', { name: '+ Add provider' }).click();
    await expect(page.getByText('Add provider', { exact: true })).toBeVisible();
  });

  test('fills form and saves — new provider appears in table', async ({ authPage, connInfo }) => {
    const { page } = authPage;
    await page.goto('/#/config');

    await page.getByRole('button', { name: '+ Add provider' }).click();
    await expect(page.getByText('Add provider', { exact: true })).toBeVisible();

    // Form fields in order: Name (textbox 0), Base URL (textbox 1), Default model (textbox 2)
    const slideOver = page.locator('.w-96').first();
    await slideOver.getByRole('textbox').nth(0).fill('ui-mock-provider');
    // Type is already 'openai-compatible' by default; Base URL field is visible
    await slideOver.getByRole('textbox').nth(1).fill(connInfo.mockProviderUrl);
    await slideOver.getByRole('textbox').nth(2).fill('mock-model');

    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Add provider', { exact: true })).not.toBeVisible({
      timeout: 3000,
    });

    // Provider row appears in table
    await expect(page.getByRole('row').filter({ hasText: 'ui-mock-provider' })).toBeVisible();
  });

  test('new provider row shows correct values', async ({ authPage, connInfo }) => {
    const { page } = authPage;
    await page.goto('/#/config');

    const row = page.getByRole('row').filter({ hasText: 'ui-mock-provider' });
    await expect(row).toBeVisible();
    await expect(row.getByText(connInfo.mockProviderUrl)).toBeVisible();
    await expect(row.getByText('mock-model')).toBeVisible();
  });

  test('editing a provider updates the table row', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/#/config');

    const row = page.getByRole('row').filter({ hasText: 'ui-mock-provider' });
    await row.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByText('Edit provider')).toBeVisible();

    // Default model is textbox 2 in the edit form (Name is readonly)
    const slideOver = page.locator('.w-96').first();
    await slideOver.getByRole('textbox').nth(2).fill('mock-model-v2');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(
      page.getByRole('row').filter({ hasText: 'ui-mock-provider' }).getByText('mock-model-v2'),
    ).toBeVisible();
  });

  test('provider with no credential shows "none" indicator', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/#/config');

    const row = page.getByRole('row').filter({ hasText: 'ui-mock-provider' });
    // No credential key was set, so the cell shows italic 'none'
    await expect(row.getByText('none')).toBeVisible();
  });

  test('switching between Providers and Credentials tabs does not lose state', async ({
    authPage,
  }) => {
    const { page } = authPage;
    await page.goto('/#/config');

    // Providers tab is active; switch to credentials
    await page.getByRole('button', { name: 'credentials' }).click();
    await expect(page.getByText('Named secrets stored encrypted')).toBeVisible();

    // Switch back to providers — data still visible
    await page.getByRole('button', { name: 'providers' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'ui-mock-provider' })).toBeVisible();
  });

  test('navigating away and back re-fetches providers', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/#/config');
    await expect(page.getByRole('row').filter({ hasText: 'ui-mock-provider' })).toBeVisible();

    await page.goto('/#/participants');
    await page.goto('/#/config');

    await expect(page.getByRole('row').filter({ hasText: 'ui-mock-provider' })).toBeVisible();
  });
});
