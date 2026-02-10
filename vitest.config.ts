import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    // E2E suites spawn real MCP servers and hit a shared LM Studio instance.
    // Running test files in parallel can overload the backend and make tests flaky.
    fileParallelism: false,
    // Exclude test artifacts created by generate_tests tool
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/tests/tmp/**',
      '**/_backup_dedup/**',
    ],
  },
});
