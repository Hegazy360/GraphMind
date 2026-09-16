#!/usr/bin/env node
/**
 * The classic stdio mistake: a server that `console.log`s. Every line it
 * prints to stdout lands on the JSON-RPC wire. It boots with one such line,
 * answers requests correctly, and logs one more line per request, so a test
 * can check both the first-line report and the per-session count.
 *
 * `CHATTY_LONG=1` makes the boot line 1000 bytes (quote truncation).
 */
import { stdin, stdout, env } from 'node:process';

const bootLine =
  env.CHATTY_LONG === '1' ? `debug: ${'x'.repeat(1000)}` : 'debug: loading config from ./config.json';
console.log(bootLine);

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
    console.log(`handling ${message.method}`); // the bug under test
    if (message.id !== undefined) {
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true } })}\n`);
    }
  }
});
