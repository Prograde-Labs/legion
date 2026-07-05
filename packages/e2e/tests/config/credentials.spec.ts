import { test, expect } from '../../fixtures/index.js';

test.describe('Config — Credentials tab', () => {
  test('renders with empty state text when no credentials set', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/#/config/credentials');

    await expect(page.getByRole('button', { name: 'credentials' })).toBeVisible();
    await expect(page.getByText('Named secrets stored encrypted')).toBeVisible();
  });

  test('"+ Add credential" opens slide-over', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/#/config/credentials');

    await page.getByRole('button', { name: '+ Add credential' }).click();
    await expect(page.getByText('Add credential', { exact: true })).toBeVisible();
  });

  test('fills form and saves — new credential appears in table with masked value', async ({
    authPage,
  }) => {
    const { page } = authPage;
    await page.goto('/#/config/credentials');

    await page.getByRole('button', { name: '+ Add credential' }).click();
    await expect(page.getByText('Add credential', { exact: true })).toBeVisible();

    await page.locator('div:has(label:text-is("Key name")) input').first().fill('ui-test-key');
    await page
      .locator('div:has(label:text-is("Value")) input[type="password"]')
      .first()
      .fill('super-secret');

    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Add credential', { exact: true })).not.toBeVisible();

    // Row appears
    await expect(page.getByRole('row').filter({ hasText: 'ui-test-key' })).toBeVisible();
    // The value cell shows a masked string (not 'super-secret')
    const row = page.getByRole('row').filter({ hasText: 'ui-test-key' });
    await expect(row.getByText('super-secret')).not.toBeVisible();
  });

  test('rotating a credential opens slide-over and updates masked value', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/#/config/credentials');

    const row = page.getByRole('row').filter({ hasText: 'ui-test-key' });
    await row.getByRole('button', { name: 'Rotate' }).click();

    await expect(page.getByText('Rotate credential', { exact: true })).toBeVisible();
    await page
      .locator('div:has(label:text-is("New value")) input[type="password"]')
      .fill('new-super-secret');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByText('Rotate credential', { exact: true })).not.toBeVisible();
    // Row still exists after rotate
    await expect(page.getByRole('row').filter({ hasText: 'ui-test-key' })).toBeVisible();
  });

  test('navigating away and back re-fetches credentials', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/#/config/credentials');
    await expect(page.getByRole('row').filter({ hasText: 'ui-test-key' })).toBeVisible();

    await page.goto('/#/participants');
    await page.goto('/#/config/credentials');

    await expect(page.getByRole('row').filter({ hasText: 'ui-test-key' })).toBeVisible();
  });
});
