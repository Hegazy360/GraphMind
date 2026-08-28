import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Tests (and typecheck) run against the schema package's source so the
      // CLI can be tested without building schema first. The emitted build
      // resolves the real workspace dependency instead.
      '@graphmind-ai/schema': fileURLToPath(new URL('../schema/src/index.ts', import.meta.url)),
      '@graphmind-ai/client': fileURLToPath(new URL('../client/src/index.ts', import.meta.url)),
      // TEST-ONLY, and deliberately not a package dependency: the proxy's
      // inject coercion is a copy of the one in @graphmind-ai/mcp (which
      // declares the MCP SDK as a peer dep, so the CLI must not depend on
      // it). This alias lets one parity test prove the copies agree.
      '@graphmind-ai/mcp/coerce': fileURLToPath(new URL('../mcp/src/coerce.ts', import.meta.url)),
    },
  },
  test: {
    // Several suites assert real elapsed time (gate holds, sub-millisecond

    // detached overhead, disconnect auto-continue). Hosted CI runners are

    // noisy neighbours, so give those two retries there; locally a failure

    // is a failure, first time.

    retry: process.env['CI'] !== undefined ? 2 : 0,
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
