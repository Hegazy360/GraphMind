import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The React transform is only needed by the component suites (*.test.tsx);
  // it is harmless for the pure ones, which import no JSX at all.
  plugins: [react()],
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
    /**
     * Node by default — most of this suite is pure functions over the run
     * store, and a DOM would only slow them down. The component suites opt
     * in per file with `@vitest-environment jsdom` at the top, so the cost
     * is paid only where a render actually happens.
     */
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
