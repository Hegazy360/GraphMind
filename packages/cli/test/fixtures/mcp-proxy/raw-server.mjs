#!/usr/bin/env node
/**
 * A hand-rolled stdio JSON-RPC "MCP server" for the proxy tests.
 *
 * It deliberately writes its frames as HAND-BUILT TEXT rather than through
 * JSON.stringify: odd whitespace, non-alphabetical key order, `\u` escapes
 * and `1.50` (which any re-serialization would turn into `1.5`). If the proxy
 * ever parses-and-re-emits a frame instead of relaying the original bytes,
 * the byte-faithfulness test fails loudly.
 *
 * Tools: echo, boom (JSON-RPC error), softfail (isError result), slow,
 * never (no answer at all), big (oversized payload), notify (server->client
 * notification first), sample (server->client sampling request), die (exit
 * mid-request).
 */
import { stdin, stdout, stderr, exit } from 'node:process';

let buffer = '';
const pendingSampling = new Map();

function writeLine(text) {
  stdout.write(`${text}\n`);
}

/** A response with deliberately non-canonical JSON formatting. */
function rawResult(id, resultText) {
  return `{"jsonrpc":"2.0" , "id":${JSON.stringify(id)},"result":${resultText}}`;
}

function rawError(id, code, message) {
  return `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"error":{"code":${code},"message":${JSON.stringify(message)}}}`;
}

function textContent(text) {
  return `{"zzz":"ordered-last-on-purpose","content":[{"type":"text","text":${JSON.stringify(text)}}],"ratio":1.50,"note":"caf\\u00e9"}`;
}

stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  for (;;) {
    const nl = buffer.indexOf('\n');
    if (nl === -1) break;
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim() === '') continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      stderr.write(`raw-server: unparseable line: ${line.slice(0, 120)}\n`);
      continue;
    }
    handle(message);
  }
});

// Deliberately no explicit exit(): process.exit() can truncate a pending
// pipe write, and these fixtures exist to compare bytes. When stdin ends and
// nothing is pending the event loop drains and Node exits 0 on its own.

function handle(message) {
  if (Array.isArray(message)) {
    for (const item of message) handle(item);
    return;
  }
  if (message.method === undefined) {
    // A response to one of OUR requests (sampling/createMessage).
    const waiter = pendingSampling.get(String(message.id));
    if (waiter !== undefined) {
      pendingSampling.delete(String(message.id));
      waiter(message);
    }
    return;
  }
  if (message.id === undefined) {
    stderr.write(`raw-server: notification ${message.method}\n`);
    return;
  }
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      writeLine(
        rawResult(
          id,
          '{"protocolVersion":"2025-11-25","serverInfo":{"name":"raw-server","version":"1.0.0"},"capabilities":{"tools":{},"resources":{},"prompts":{}}}',
        ),
      );
      return;
    case 'ping':
      writeLine(rawResult(id, '{}'));
      return;
    case 'tools/list':
      writeLine(
        rawResult(
          id,
          '{"tools":[{"name":"echo","inputSchema":{"type":"object"}},{"name":"boom","inputSchema":{"type":"object"}}]}',
        ),
      );
      return;
    case 'resources/read':
      writeLine(
        rawResult(
          id,
          `{"contents":[{"uri":${JSON.stringify(params?.uri ?? '')},"text":"resource body"}]}`,
        ),
      );
      return;
    case 'prompts/get':
      writeLine(
        rawResult(
          id,
          '{"messages":[{"role":"user","content":{"type":"text","text":"prompt body"}}]}',
        ),
      );
      return;
    case 'tools/call':
      return callTool(id, params ?? {});
    default:
      writeLine(rawError(id, -32601, `Method not found: ${method}`));
  }
}

function callTool(id, params) {
  const name = params.name;
  const args = params.arguments ?? {};
  switch (name) {
    case 'echo':
      writeLine(rawResult(id, textContent(String(args.text ?? ''))));
      return;
    case 'boom':
      writeLine(rawError(id, -32603, 'the tool exploded'));
      return;
    case 'softfail':
      writeLine(
        rawResult(
          id,
          '{"isError":true,"content":[{"type":"text","text":"tool reported failure"}]}',
        ),
      );
      return;
    case 'slow':
      setTimeout(() => writeLine(rawResult(id, textContent('slow done'))), Number(args.ms ?? 50));
      return;
    case 'never':
      // The bug this proxy exists to reveal: no answer, ever.
      stderr.write('raw-server: swallowing tools/call never\n');
      return;
    case 'big': {
      const size = Number(args.size ?? 1024);
      writeLine(rawResult(id, `{"content":[{"type":"text","text":"${'x'.repeat(size)}"}]}`));
      return;
    }
    case 'notify':
      writeLine('{"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"before answer"}}');
      writeLine(rawResult(id, textContent('notified')));
      return;
    case 'sample': {
      const samplingId = `s-${id}`;
      pendingSampling.set(String(samplingId), (response) => {
        writeLine(rawResult(id, textContent(JSON.stringify(response.result ?? response.error))));
      });
      writeLine(
        `{"jsonrpc":"2.0","id":${JSON.stringify(samplingId)},"method":"sampling/createMessage","params":{"messages":[{"role":"user","content":{"type":"text","text":"hi"}}],"maxTokens":16}}`,
      );
      return;
    }
    case 'die':
      stderr.write('raw-server: dying mid-request\n');
      exit(3);
      return;
    default:
      writeLine(rawError(id, -32602, `Unknown tool: ${String(name)}`));
  }
}
