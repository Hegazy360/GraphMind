#!/usr/bin/env node
/**
 * A server that answers requests but IGNORES stdin EOF and never exits — the
 * zombie case. The proxy must not sit forever holding a process nobody is
 * talking to any more.
 */
import { stdin, stdout, stderr } from 'node:process';

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
    if (message.id !== undefined) {
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`);
    }
  }
});

stderr.write('deaf-server: ignoring stdin EOF on purpose\n');
// Hold the event loop open forever.
setInterval(() => {}, 1000);
