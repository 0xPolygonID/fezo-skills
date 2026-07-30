import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // No test files exist yet (they land alongside the engine modules in
    // later tasks). A fresh clone must still exit 0 rather than fail with
    // "no test files found".
    passWithNoTests: true,
  },
});
