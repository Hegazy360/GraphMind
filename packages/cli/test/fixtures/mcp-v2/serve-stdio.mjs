#!/usr/bin/env node
/**
 * The same v2 surface served through `serveStdio(factory)` from
 * `@modelcontextprotocol/server/stdio` — the v2 entry point that "owns the
 * era decision": a 2025-era `initialize` opening pins a legacy instance, a
 * 2026-07-28 `server/discover` opening pins a modern one (per-request `_meta`
 * envelope, `resultType` on every result, no `initialize` at all).
 *
 * Everything human goes to stderr; stdout is the wire.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildServer } from './surface.mjs';

process.stderr.write('v2-serve-stdio: ready\n');
serveStdio(() => buildServer(), {
  onerror: (error) => process.stderr.write(`v2-serve-stdio: ${error.message}\n`),
});
