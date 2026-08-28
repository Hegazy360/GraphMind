/**
 * Inject coercion at the proxy boundary.
 *
 * `inject` is the headline of MCP debugging: hold a request, type a different
 * answer, and watch what the REAL client does with it. But MCP results are
 * typed (`CallToolResult`, `ReadResourceResult`, `GetPromptResult`,
 * `CreateMessageResult`) and the client's SDK validates them on the way in.
 * Sending `{"price": 42}` as a raw `result` for a `tools/call` produced a
 * frame with no `content`, so the host silently displayed an EMPTY tool
 * result — no error, nothing in the log, just a wrong answer. That is the
 * most likely first-use failure of the feature the product is named for, so
 * the proxy lifts an injected value into the shape the request must return.
 *
 * A value that already looks like the right result shape is passed through
 * untouched, so full control is still available when you want it.
 *
 * DUPLICATED, deliberately, from `@graphmind-ai/mcp`'s `coerce.ts`: that
 * package declares `@modelcontextprotocol/sdk` as a peer dependency, and the
 * CLI must not force every `npx graphmind-ai` user to install the MCP SDK to
 * run `graphmind serve`. The two are kept honest by a parity test
 * (`test/mcp-proxy/coerce-parity.test.ts`) that runs the same inputs through
 * both implementations and asserts identical output.
 */

/** Which MCP result shape a held request has to answer with. */
export type InjectShape = 'tool' | 'resource' | 'prompt' | 'sampling';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON text for a value, never throwing (cycles, BigInt, ...). */
function safeJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text };
}

/** `CallToolResult`: `{ content: [...] }` (+ `structuredContent` when useful). */
function toToolResult(value: unknown): unknown {
  if (isRecord(value) && (Array.isArray(value['content']) || 'structuredContent' in value)) {
    return value; // already a CallToolResult — the injector knows what they want
  }
  if (value === undefined) return { content: [] };
  if (typeof value === 'string') return { content: [textBlock(value)] };
  const content = [textBlock(safeJson(value))];
  // A tool with an `outputSchema` MUST return structuredContent; supplying it
  // for every injected object makes inject work on typed tools too.
  return isRecord(value) ? { content, structuredContent: value } : { content };
}

/** `ReadResourceResult`: `{ contents: [{ uri, text | blob }] }`. */
function toResourceResult(value: unknown, uri: string): unknown {
  if (isRecord(value) && Array.isArray(value['contents'])) return value;
  if (typeof value === 'string') return { contents: [{ uri, text: value }] };
  return { contents: [{ uri, mimeType: 'application/json', text: safeJson(value) }] };
}

/** `GetPromptResult`: `{ messages: [{ role, content }] }`. */
function toPromptResult(value: unknown): unknown {
  if (isRecord(value) && Array.isArray(value['messages'])) return value;
  const text = typeof value === 'string' ? value : safeJson(value);
  return { messages: [{ role: 'user', content: textBlock(text) }] };
}

/** `CreateMessageResult`: `{ model, role, content }`. */
function toSamplingResult(value: unknown): unknown {
  if (isRecord(value) && 'content' in value) return value;
  const text = typeof value === 'string' ? value : safeJson(value);
  return {
    model: 'graphmind-injected',
    role: 'assistant',
    content: textBlock(text),
    stopReason: 'endTurn',
  };
}

/**
 * Lift a debugger-supplied value into the result shape this request must
 * return. Never throws: on any surprise the original value is handed back
 * unchanged and the peer's own validation decides.
 */
export function coerceInjected(shape: InjectShape, value: unknown, uri?: string): unknown {
  try {
    switch (shape) {
      case 'tool':
        return toToolResult(value);
      case 'resource':
        return toResourceResult(value, uri ?? 'graphmind://injected');
      case 'prompt':
        return toPromptResult(value);
      case 'sampling':
        return toSamplingResult(value);
      default:
        return value;
    }
  } catch {
    return value;
  }
}

/**
 * The result shape a method must answer with, or undefined for a method whose
 * result GraphMind does not model — those are relayed exactly as typed, since
 * guessing at an unknown shape would be worse than passing it through.
 */
export function injectShapeFor(method: string): InjectShape | undefined {
  switch (method) {
    case 'tools/call':
      return 'tool';
    case 'resources/read':
      return 'resource';
    case 'prompts/get':
      return 'prompt';
    case 'sampling/createMessage':
      return 'sampling';
    default:
      return undefined;
  }
}

/**
 * Coerce an injected value for one held request.
 *
 * A value that is already a whole JSON-RPC frame (it carries `jsonrpc`) is
 * left alone: that is the escape hatch for someone who wants byte-level
 * control over the reply, including replying with an `error`.
 */
export function coerceInjectedFor(method: string, params: unknown, value: unknown): unknown {
  if (isRecord(value) && typeof value['jsonrpc'] === 'string') return value;
  const shape = injectShapeFor(method);
  if (shape === undefined) return value;
  const uri = isRecord(params) && typeof params['uri'] === 'string' ? params['uri'] : undefined;
  return coerceInjected(shape, value, uri);
}
