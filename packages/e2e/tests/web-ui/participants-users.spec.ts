import { test, expect } from '../../fixtures/index.js';

function data<T>(response: { result: { status: string; data?: T; error?: string } }): T {
  expect(response.result.status, response.result.error).toBe('success');
  return response.result.data as T;
}

test.describe('Participants & users', () => {
  let token: string;

  test.beforeAll(async ({ api, connInfo }) => {
    const login = await api.login('operator', connInfo.password);
    token = login.token;
  });

  test('create a user, set a tool policy, then retire it via 2-click confirm', async ({
    authPage,
    api,
  }) => {
    const { page } = authPage;
    const username = `e2e-user-${Date.now()}`;
    await page.goto('/#/participants');

    await page.locator('[data-test="new-user"]').click();
    await page.locator('[data-test="user-name"]').fill(username);
    await page.locator('input[name="new-password"]').fill('e2e-user-pass-1');
    await page.locator('input[name="confirm-password"]').fill('e2e-user-pass-1');
    await page.locator('[data-test="save"]').click();

    const row = page.locator('[data-test="participant-row"]', { hasText: username });
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Tool policy: toggle the first available tool, save, and prove persistence.
    const firstCheckbox = page.locator('[data-tool-row]').first().locator('input[type="checkbox"]');
    const initiallyChecked = await firstCheckbox.isChecked();
    await firstCheckbox.click();
    await page.locator('[data-test="save"]').click();
    await expect(page.locator('[data-test="user-error"]')).toHaveCount(0);
    // Force an editor reload: visit another participant, then back.
    await page.locator('[data-test="participant-row"]').first().click();
    await row.click();
    await expect(firstCheckbox).toBeChecked({ checked: !initiallyChecked });

    // Retire is a 2-click confirm.
    const retire = page.locator('[data-test="retire"]');
    await retire.click();
    await expect(retire).toHaveText('Confirm retire');
    await retire.click();
    // Successful retire closes the editor; the chat-first participants list
    // keeps the row (dimmed StatusDot) rather than dropping it, so prove the
    // retirement at the source of truth instead of asserting row visibility.
    await expect(page.locator('[data-test="user-error"]')).toHaveCount(0);
    await expect
      .poll(async () => {
        const participant = data<{ status?: string }>(
          await api.execute(token, 'get_participant', { id: username }),
        );
        return participant.status;
      })
      .toBe('retired');
  });

  test('operator cannot be retired from the editor', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/#/participants');
    await page.locator('[data-test="participant-row"]', { hasText: 'Operator' }).first().click();

    await expect(page.locator('[data-test="user-name"]')).toHaveValue('Operator');
    // The operator is self and protected, so the retire affordance is unavailable
    // (hidden in the editor rather than a clickable disabled button).
    await expect(page.locator('[data-test="retire"]')).toHaveCount(0);
  });

  test('account slide-over password change round-trips and is restored', async ({
    authPage,
    api,
    connInfo,
  }) => {
    const { page, participantId: operatorId } = authPage;
    const newPassword = 'e2e-new-operator-pass';

    await page.goto('/#/chat');
    await page.locator('[data-test="avatar"]').click();
    await page.getByRole('button', { name: 'Account…' }).click();
    await page.locator('[data-test="account-new-password"]').fill(newPassword);
    await page.locator('[data-test="account-confirm-password"]').fill(newPassword);
    await page.locator('[data-test="account-submit"]').click();
    await expect(page.locator('[data-test="account-success"]')).toBeVisible();

    // The new password authenticates…
    await api.login('operator', newPassword);
    // …and the operator password is restored for every later spec.
    data(
      await api.execute(token, 'set_credential', {
        participantId: operatorId,
        secret: connInfo.password,
      }),
    );
    await api.login('operator', connInfo.password);
  });
});
