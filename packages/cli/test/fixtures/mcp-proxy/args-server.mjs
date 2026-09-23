#!/usr/bin/env node
/**
 * A stdio JSON-RPC "MCP server" for the edited-arguments tests
 * (mcp-proxy-edit.test.ts). Every tool answer quotes the EXACT request line
 * the server received, so a test can prove which bytes reached it: the
 * rewritten frame after an edit, the untouched bytes of every other frame.
 * Responses are hand-built text (odd spacing, `1.50`) so the client-side
 * byte-faithfulness of answers is checked too.
 *
 * Tools (listed with JSON Schemas by tools/list):
 *   echoArgs  {text: string, times?: integer >= 1}, no other keys
 *   divide    {a: number, b: number}; b === 0 answers `isError: true`
 *   strict    answers a JSON-RPC error unless `arguments.token === "ok"`
 *   relist    sends notifications/tools/list_changed, then answers
 *   loose     listed WITHOUT an inputSchema object
 */
import { stdin, stdout, stderr } from 'node:process';

let buffer = '';

function writeLine(text) {
  stdout.write(`${text}\n`);
}

function rawResult(id, resultText) {
  return `{"jsonrpc":"2.0" , "id":${JSON.stringify(id)},"result":${resultText}}`;
}

function rawError(id, code, message) {
  return `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"error":{"code":${code},"message":${JSON.stringify(message)}}}`;
}

/** A tool result quoting the request line exactly as it arrived. */
function received(line, extra = '') {
  return `{"content":[{"type":"text","text":${JSON.stringify(line)}}],"ratio":1.50${extra}}`;
}

const TOOLS = [
  '{"name":"echoArgs","inputSchema":{"type":"object","properties":{"text":{"type":"string"},"times":{"type":"integer","minimum":1}},"required":["text"],"additionalProperties":false}}',
  '{"name":"divide","inputSchema":{"type":"object","properties":{"a":{"type":"number"},"b":{"type":"number"}},"required":["a","b"]}}',
  '{"name":"strict","inputSchema":{"type":"object","properties":{"token":{"type":"string"}}}}',
  '{"name":"relist","inputSchema":{"type":"object","properties":{}}}',
  '{"name":"loose"}',
].join(',');

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
      stderr.write(`args-server: unparseable line: ${line.slice(0, 120)}\n`);
      continue;
    }
    handle(message, line);
  }
});

function handle(message, line) {
  if (message.id === undefined || message.method === undefined) return;
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      writeLine(
        rawResult(
          id,
          '{"protocolVersion":"2025-11-25","serverInfo":{"name":"args-server","version":"1.0.0"},"capabilities":{"tools":{"listChanged":true}}}',
        ),
      );
      return;
    case 'tools/list':
      writeLine(rawResult(id, `{"tools":[${TOOLS}]}`));
      return;
    case 'resources/read':
      writeLine(rawResult(id, `{"contents":[{"uri":${JSON.stringify(params?.uri ?? '')},"text":${JSON.stringify(line)}}]}`));
      return;
    case 'tools/call':
      return callTool(id, params ?? {}, line);
    default:
      writeLine(rawError(id, -32601, `Method not found: ${method}`));
  }
}

function callTool(id, params, line) {
  const args = params.arguments ?? {};
  switch (params.name) {
    case 'echoArgs':
    case 'loose':
      writeLine(rawResult(id, received(line)));
      return;
    case 'divide':
      if (args.b === 0) {
        writeLine(rawResult(id, `{"isError":true,"content":[{"type":"text","text":"division by zero"}]}`));
        return;
      }
      writeLine(rawResult(id, received(line, `,"quotient":${args.a / args.b}`)));
      return;
    case 'strict':
      if (args.token !== 'ok') {
        writeLine(rawError(id, -32602, 'invalid token'));
        return;
      }
      writeLine(rawResult(id, received(line)));
      return;
    case 'relist':
      writeLine('{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}');
      writeLine(rawResult(id, received(line)));
      return;
    default:
      writeLine(rawError(id, -32602, `Unknown tool: ${String(params.name)}`));
  }
}
