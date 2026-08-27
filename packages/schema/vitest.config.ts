import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Several suites assert real elapsed time (gate holds, sub-millisecond

    // detached overhead, disconnect auto-continue). Hosted CI runners are

    // noisy neighbours, so give those two retries there; locally a failure

    // is a failure, first time.

    retry: process.env['CI'] !== undefined ? 2 : 0,
    include: ['test/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
