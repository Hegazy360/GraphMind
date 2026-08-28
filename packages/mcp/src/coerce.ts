/**
 * Inject coercion.
 *
 * `inject` is the reason this package exists: hold a request, type a different
 * answer, and watch what YOUR CLIENT does with it — no server edit, no
 * redeploy. The debugger sends whatever JSON you typed, but MCP results are
 * typed (`CallToolResult`, `ReadResourceResult`, `GetPromptResult`,
 * `CreateMessageResult`) and the SDK validates them on the way out. Handing
 * the SDK a bare string would turn the killer feature into a schema error.
 *
 * So: a value that ALREADY looks like the right result shape is passed
 * through untouched (full control when you want it), and anything else is
 * lifted into the smallest valid result that carries it. Objects also land in
 * `structuredContent` for tools, so injecting `{"price": 42}` satisfies a tool
 * that declares an `outputSchema`.
 */

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
  if (typeof value === 'string') {
    return { contents: [{ uri, text: value }] };
  }
  return {
    contents: [{ uri, mimeType: 'application/json', text: safeJson(value) }],
  };
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
 * unchanged and the SDK's own validation decides.
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
