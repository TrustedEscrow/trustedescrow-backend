import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // The actual measured baseline on main was 77.1% lines; 77 is that number rounded
      // down, not a guessed target. Raise it as coverage genuinely improves — don't lower
      // it to make a red build pass.
      thresholds: { lines: 77 },
    },
  },
});
