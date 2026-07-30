import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // `passWithNoTests` is deliberately left at its default (`false`): the
    // engine modules and their tests have landed together since Task 2, so
    // `tests/**/*.test.ts` always matches real files now, and CI's `pnpm
    // test` should fail loudly if that glob ever comes up empty (a deleted
    // tests/ directory, a broken pattern, ...) rather than silently
    // "passing" zero tests -- exactly the vacuous-pass failure mode the rest
    // of this suite's test-hygiene rules exist to prevent.
  },
});
