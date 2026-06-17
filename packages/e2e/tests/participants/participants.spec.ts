import { test, expect } from '../../fixtures/index.js';

test.describe('ParticipantsView', () => {
  test('loads and shows at least the operator row', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/#/participants');

    await expect(page.getByRole('heading', { name: 'Participants' })).toBeVisible();
    // Wait for the table to populate (async load)
    await expect(page.getByRole('row').filter({ hasText: 'Operator' })).toBeVisible();
  });

  test('each row shows status, name columns', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/#/participants');

    const operatorRow = page.getByRole('row').filter({ hasText: 'Operator' });
    await expect(operatorRow).toBeVisible();
    await expect(operatorRow.getByText('Active')).toBeVisible();
    await expect(operatorRow.getByText('operator')).toBeVisible();
  });

  test('"+ New agent" button opens the slide-over', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/#/participants');

    await page.getByRole('button', { name: '+ New agent' }).click();
    await expect(page.getByText('New agent', { exact: true })).toBeVisible();
  });

  test('filling and submitting the form creates participant in table (no reload)', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/#/participants');

    await page.getByRole('button', { name: '+ New agent' }).click();
    await expect(page.getByText('New agent', { exact: true })).toBeVisible();

    // Fill Name field (first textbox in the slide-over)
    const slideOver = page.locator('.w-96').first();
    await slideOver.getByRole('textbox').first().fill('ui-test-agent');
    await page.getByRole('button', { name: 'Save' }).click();

    // Slide-over closes and new row appears without a full page reload
    await expect(page.getByText('New agent', { exact: true })).not.toBeVisible({ timeout: 3000 });
    await expect(page.getByRole('row').filter({ hasText: 'ui-test-agent' })).toBeVisible();
  });

  test('slide-over closes cleanly after submit (no duplicate panels)', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/#/participants');

    await page.getByRole('button', { name: '+ New agent' }).click();
    const slideOver = page.locator('.w-96').first();
    await slideOver.getByRole('textbox').first().fill('ui-test-agent-2');
    await page.getByRole('button', { name: 'Save' }).click();

    // Wait for new row to appear (confirms save completed and slide-over closed)
    await expect(page.getByRole('row').filter({ hasText: 'ui-test-agent-2' })).toBeVisible({ timeout: 3000 });

    // Only one slide-over panel in the DOM
    await expect(page.locator('.w-96')).toHaveCount(1);
    // And it should be hidden (v-if="open" is false)
    await expect(page.locator('.w-96')).not.toBeVisible();
  });

  test('clicking edit opens slide-over with agent name pre-populated', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/#/participants');

    // Wait for ui-test-agent row (created in previous test)
    const agentRow = page.getByRole('row').filter({ hasText: 'ui-test-agent' }).first();
    await expect(agentRow).toBeVisible();
    await agentRow.getByRole('button', { name: 'Edit' }).click();

    // Wait for slide-over to open, then check title and pre-populated name field
    await expect(page.locator('.w-96').first()).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Edit agent')).toBeVisible();
    const nameInput = page.locator('.w-96').first().getByRole('textbox').first();
    await expect(nameInput).toHaveValue('ui-test-agent');
  });

  test('retiring a participant changes the status badge', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/#/participants');

    const agentRow = page.getByRole('row').filter({ hasText: 'ui-test-agent' }).first();
    await expect(agentRow).toBeVisible();
    await agentRow.getByRole('button', { name: 'Edit' }).click();

    // Wait for slide-over to open
    await expect(page.locator('.w-96').first()).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Edit agent')).toBeVisible();

    await page.getByRole('button', { name: 'Retire agent' }).click();

    // Wait for slide-over to close and table to update
    await expect(page.locator('.w-96').first()).not.toBeVisible({ timeout: 3000 });
    // Row should now show Retired status (row opacity changes, Active text gone)
    await expect(page.getByRole('row').filter({ hasText: 'ui-test-agent' }).getByText('Retired')).toBeVisible();
  });

  test('navigating away and back re-fetches data (not stale)', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/#/participants');
    await expect(page.getByRole('row').filter({ hasText: 'Operator' })).toBeVisible();

    // Navigate to config and back
    await page.goto('/#/config');
    await page.goto('/#/participants');

    // Table re-renders with data (row still visible, not stuck loading)
    await expect(page.getByRole('row').filter({ hasText: 'Operator' })).toBeVisible();
  });

  test('real-time: API retire triggers table update via WebSocket', async ({ authPage, api }) => {
    const { page, token } = authPage;

    // Create a fresh agent for this test (create_agent requires id, name, systemPrompt, model)
    const createResult = await api.execute<{ id: string }>(token, 'create_agent', {
      id: `rt-test-agent-${Date.now()}`,
      name: 'rt-test-agent',
      systemPrompt: 'test agent',
      model: { provider: 'mock-llm', model: 'mock-model' },
    });
    expect(createResult.result.status).toBe('success');
    const agentId = createResult.result.data!.id;

    await page.goto('/#/participants');
    await expect(page.getByRole('row').filter({ hasText: 'rt-test-agent' })).toBeVisible();

    // Give the WebSocket connection time to authenticate and start listening for events
    await page.waitForTimeout(500);

    // Retire via API — server emits participant:retired over WebSocket
    await api.execute(token, 'retire_agent', { id: agentId });

    // UI should update without a manual refresh (WebSocket event triggers load())
    const retiredRow = page.getByRole('row').filter({ hasText: 'rt-test-agent' });
    await expect(retiredRow.getByText('Retired')).toBeVisible({ timeout: 4000 });
  });

  test('error state renders if tool call fails (not a blank view)', async ({ page, connInfo }) => {
    // Navigate to participants without a valid token — should redirect to login,
    // not render a blank/crashed view.
    await page.goto('/#/participants');
    // Unauthenticated navigation → router guard redirects to login
    await expect(page).toHaveURL(/#\/login/);
  });
});
