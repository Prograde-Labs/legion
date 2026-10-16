import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  workers: 1,
  reporter: 'list',
  globalSetup: './global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:4000',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        // Container /dev/shm is small (1G); without this the renderer host
        // intermittently crashes under memory pressure ("Target crashed").
        launchOptions: { args: ['--disable-dev-shm-usage'] },
      },
    },
  ],
});
