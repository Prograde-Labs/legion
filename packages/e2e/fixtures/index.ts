import { test as base, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApiClient } from '../helpers/api.js';

export const CONN_INFO_FILE = join(tmpdir(), 'legion-e2e.json');

export interface ConnInfo {
  serverUrl: string;
  mockProviderUrl: string;
  password: string;
}

export interface AuthPageResult {
  page: Page;
  token: string;
  participantId: string;
}

type Fixtures = {
  connInfo: ConnInfo;
  api: ApiClient;
  authPage: AuthPageResult;
};

export const test = base.extend<Fixtures>({
  connInfo: async ({}, use) => {
    const raw = await readFile(CONN_INFO_FILE, 'utf-8');
    await use(JSON.parse(raw) as ConnInfo);
  },

  api: async ({ connInfo, request }, use) => {
    await use(new ApiClient(request, connInfo.serverUrl));
  },

  authPage: async ({ connInfo, api, page }, use) => {
    // Log in via API to get a valid JWT
    const { token, participantId } = await api.login('operator', connInfo.password);

    // Inject token into localStorage BEFORE the SPA scripts run.
    // @vueuse/core's useLocalStorage reads from localStorage on first call;
    // addInitScript runs before any page script on every navigation.
    await page.addInitScript((t: string) => {
      (window as Record<string, unknown>).localStorage.setItem('legion-token', t);
    }, token);

    await use({ page, token, participantId });
  },
});

export { expect };
