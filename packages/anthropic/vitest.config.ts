import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Tests (and typecheck) run against the sibling packages' sources so
      // the adapter can be tested without building them first. The emitted
      // build resolves the real workspace dependencies instead.
      '@graphmind-ai/schema': fileURLToPath(new URL('../schema/src/index.ts', import.meta.url)),
      '@graphmind-ai/client': fileURLToPath(new URL('../client/src/index.ts', import.meta.url)),
    },
  },
  test: {
    // Several suites assert real elapsed time (gate holds, sub-millisecond

    // detached overhead, disconnect auto-continue). Hosted CI runners are

    // noisy neighbours, so give those two retries there; locally a failure

    // is a failure, first time.

    retry: process.env['CI'] !== undefined ? 2 : 0,
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
