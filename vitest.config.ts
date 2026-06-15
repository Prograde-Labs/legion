import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['packages/**/src/**/*.test.ts', 'packages/**/src/**/*.integration.test.ts'],
    environment: 'node',
  },
});
