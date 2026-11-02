import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The same alias vite.config.ts sets: the spec and its generator come from
  // the CLI's builder source, which the Build page runs in the browser.
  resolve: {
    alias: { '@workflow': fileURLToPath(new URL('../../packages/cli/src/builder', import.meta.url)) },
  },
  test: {
    // Several suites assert real elapsed time (gate holds, sub-millisecond

    // detached overhead, disconnect auto-continue). Hosted CI runners are

    // noisy neighbours, so give those two retries there; locally a failure

    // is a failure, first time.

    retry: process.env['CI'] !== undefined ? 2 : 0,
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
