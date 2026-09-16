#!/usr/bin/env node
/**
 * A REAL MCP server on the v2 SDK family — `@modelcontextprotocol/server`
 * 2.0.0, the package that replaced `@modelcontextprotocol/sdk` 1.x on
 * 2026-07-28 — wired the way its README's first example wires it:
 * `McpServer` + `StdioServerTransport` from the `./stdio` subpath.
 *
 * This shape serves the LEGACY era only (the 2025-11-25 `initialize`
 * handshake): a `server/discover` probe from a 2026-era client is answered
 * with -32601 by the SDK itself. See serve-stdio.mjs for the both-eras entry.
 *
 * Everything human goes to stderr; stdout is the wire.
 */
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { buildServer } from './surface.mjs';

process.stderr.write('v2-server: ready\n');
await buildServer().connect(new StdioServerTransport());
