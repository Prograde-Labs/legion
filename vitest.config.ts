import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['packages/**/src/**/*.test.ts', 'packages/**/src/**/*.integration.test.ts'],
    exclude: ['packages/web/**'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/**/src/**/*.ts'],
      exclude: ['packages/web/**', 'packages/e2e/**', '**/*.test.ts', '**/*.integration.test.ts'],
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
    },
  },
});
