import { test, expect } from '../../fixtures/index.js';

test.describe('Config — MCP sources', () => {
  test('adds an MCP server, persists it across reload, rejects duplicates client-side', async ({
    authPage,
  }) => {
    const { page } = authPage;
    const serverName = `e2e-mcp-${Date.now()}`;

    await page.goto('/#/config');
    // The MCP section renders the existing list before any edit.
    await expect(page.locator('[data-test="add-server"]')).toBeVisible({ timeout: 15_000 });

    // Add e2e-mcp (stdio, command: echo) and save.
    await page.locator('[data-test="add-server"]').click();
    const card = page.locator('[data-test="mcp-card"]').last();
    await card.locator('input[name="name"]').fill(serverName);
    await card.locator('input[name="command"]').fill('echo');
    await page.locator('[data-test="mcp-save"]').click();

    const banner = page.locator('[data-test="mcp-saved"]');
    await expect(banner).toBeVisible({ timeout: 15_000 });

    // Reload and prove persistence via list_mcp_sources read-back. The config
    // view re-mounts to a fresh state, so re-assert the MCP section content.
    await page.reload();
    await expect(page.locator('[data-test="add-server"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-test="mcp-card"]', { hasText: serverName })).toBeVisible();

    // Invalid case: duplicate name is caught client-side — the error banner
    // appears and NO save_mcp_sources request leaves the page.
    const saveRequests: string[] = [];
    page.on('request', (request) => {
      if (request.postData()?.includes('save_mcp_sources')) saveRequests.push(request.url());
    });
    await page.locator('[data-test="add-server"]').click();
    const dup = page.locator('[data-test="mcp-card"]').last();
    await dup.locator('input[name="name"]').fill(serverName);
    await dup.locator('input[name="command"]').fill('echo');
    await page.locator('[data-test="mcp-save"]').click();
    await expect(page.locator('[data-test="mcp-error"]')).toContainText(
      'duplicate MCP server name',
    );
    expect(saveRequests).toHaveLength(0);
  });
});
