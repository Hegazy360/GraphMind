#!/usr/bin/env node
/**
 * An MCP server that logs to stderr the way real ones do — the only channel a
 * stdio server can safely print to. Used to prove the proxy passes stderr
 * through untouched (and, separately, streams it onto the session node).
 */
import { stdin, stdout, stderr } from 'node:process';

stderr.write('noisy-server: booting\n');
stderr.write('noisy-server: ✓ unicode and \x1b[32mcolour\x1b[0m survive\n');

let buffer = '';
stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  for (;;) {
    const nl = buffer.indexOf('\n');
    if (nl === -1) break;
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim() === '') continue;
    const message = JSON.parse(line);
    stderr.write(`noisy-server: handling ${message.method}\n`);
    if (message.id !== undefined) {
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true } })}\n`);
    }
  }
});

// No explicit exit(): let the loop drain so nothing is truncated.
stdin.on('end', () => {
  stderr.write('noisy-server: stdin closed, exiting\n');
});
