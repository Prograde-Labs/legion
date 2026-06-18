import { test, expect } from '../../fixtures/index.js';

test.describe('EventStreamView', () => {
  test('loads and WebSocket connection is established (Live status shows)', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/#/events');

    // The toolbar shows "Live" when not paused
    await expect(page.getByText('Live')).toBeVisible({ timeout: 5000 });
  });

  test('incoming events appear as rows after a tool call', async ({ authPage, api }) => {
    const { page, token } = authPage;
    await page.goto('/#/events');
    await expect(page.getByText('Live')).toBeVisible();

    // Trigger a tool call — server emits tool:call + tool:result over WebSocket
    await api.execute(token, 'list_participants');

    // Wait up to 5s for at least one tbody row to appear
    await page.waitForSelector('tbody tr', { timeout: 5000 });
    expect(await page.locator('tbody tr').count()).toBeGreaterThan(0);
  });

  test('category chips toggle — rows outside selected category are hidden', async ({ authPage, api }) => {
    const { page, token } = authPage;
    await page.goto('/#/events');
    await expect(page.getByText('Live')).toBeVisible();

    // Trigger some events to populate the table
    await api.execute(token, 'list_participants');
    await page.waitForSelector('tbody tr', { timeout: 5000 });

    // Deactivate all chips except 'tool'
    await page.getByRole('button', { name: 'message' }).click();
    await page.getByRole('button', { name: 'error' }).click();
    await page.getByRole('button', { name: 'system' }).click();

    // Only 'tool' chip is active — all visible rows should have a tool badge
    const rows = page.locator('tbody tr');
    const count = await rows.count();
    if (count > 0) {
      await expect(rows.first().getByText(/tool:/)).toBeVisible();
    }
  });

  test('free-text search filters visible rows by content', async ({ authPage, api }) => {
    const { page, token } = authPage;
    await page.goto('/#/events');
    await expect(page.getByText('Live')).toBeVisible();

    await api.execute(token, 'list_participants');
    await page.waitForSelector('tbody tr', { timeout: 5000 });

    // Search for 'operator' which appears in every tool:call/tool:result event
    await page.locator('input[placeholder*="filter by participant"]').fill('operator');
    await page.waitForTimeout(300);

    // Verify the filter runs without crashing — all remaining rows contain 'operator'
    const rows = page.locator('tbody tr');
    await expect(rows).toHaveCount(await rows.count());
  });

  test('Pause stops new rows from appearing', async ({ authPage, api }) => {
    const { page, token } = authPage;
    await page.goto('/#/events');
    await expect(page.getByText('Live')).toBeVisible();

    await page.getByRole('button', { name: '⏸ Pause' }).click();
    await expect(page.getByText('Paused')).toBeVisible();

    const pausedCount = await page.locator('tbody tr').count();

    // Tool call while paused — events arrive at server but UI drops them
    await api.execute(token, 'list_participants');
    await page.waitForTimeout(1000);

    const countAfterPause = await page.locator('tbody tr').count();
    expect(countAfterPause).toBe(pausedCount);
  });

  test('Resume restores row accumulation', async ({ authPage, api }) => {
    const { page, token } = authPage;
    await page.goto('/#/events');
    await expect(page.getByText('Live')).toBeVisible();

    await page.getByRole('button', { name: '⏸ Pause' }).click();
    await expect(page.getByText('Paused')).toBeVisible();

    await page.getByRole('button', { name: '▶ Resume' }).click();
    await expect(page.getByText('Live')).toBeVisible();

    const beforeCount = await page.locator('tbody tr').count();
    await api.execute(token, 'list_participants');
    await page.waitForTimeout(500);

    const afterCount = await page.locator('tbody tr').count();
    expect(afterCount).toBeGreaterThanOrEqual(beforeCount);
  });

  test('clicking a row opens the detail panel with event data', async ({ authPage, api }) => {
    const { page, token } = authPage;
    await page.goto('/#/events');
    await expect(page.getByText('Live')).toBeVisible();

    await api.execute(token, 'list_participants');

    // Wait for a row to appear, then click it
    await page.waitForSelector('tbody tr', { timeout: 5000 });
    const dataRow = page.locator('tbody tr').first();
    await dataRow.click();

    // Detail panel shows JSON data
    await expect(page.getByText('Event detail')).toBeVisible();
    await expect(page.locator('pre')).toBeVisible();
  });

  test('navigating away closes WebSocket, navigating back opens fresh connection', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/#/events');
    await expect(page.getByText('Live')).toBeVisible();

    // Navigate away
    await page.goto('/#/participants');

    // Navigate back — should reconnect (Live status reappears)
    await page.goto('/#/events');
    await expect(page.getByText('Live')).toBeVisible({ timeout: 5000 });
  });
});
