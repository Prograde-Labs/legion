import { test, expect } from '../../fixtures/index.js';

test.describe('Config — Providers', () => {
  test('adds a provider through the new Config page and shows it in the table', async ({
    authPage,
    connInfo,
  }) => {
    const { page } = authPage;
    const name = `e2e-provider-${Date.now()}`;
    const baseUrl = `${connInfo.mockProviderUrl}/v1`;

    await page.goto('/#/config');
    await page.locator('[data-test="add-provider"]').click();

    await page.locator('[data-test="provider-name"]').fill(name);
    await page.locator('[data-test="provider-base-url"]').fill(baseUrl);
    await page.locator('[data-test="provider-api-key"]').fill('test-key');
    await page.locator('[data-test="provider-save"]').click();

    const row = page.locator('[data-test="provider-row"]', { hasText: name });
    await expect(row).toBeVisible();
    await expect(row.getByText(baseUrl)).toBeVisible();
    await expect(row.getByText('openai-compatible')).toBeVisible();
  });
});
