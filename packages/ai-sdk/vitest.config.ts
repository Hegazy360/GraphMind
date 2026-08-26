import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Tests (and typecheck) run against the sibling packages' sources so
      // the adapter can be tested without building them first. The emitted
      // build resolves the real workspace dependencies instead.
      '@graphmind/schema': fileURLToPath(new URL('../schema/src/index.ts', import.meta.url)),
      '@graphmind/client': fileURLToPath(new URL('../client/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
