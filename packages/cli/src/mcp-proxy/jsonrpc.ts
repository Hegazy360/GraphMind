/**
 * The slice of JSON-RPC 2.0 the proxy needs in order to *watch* a
 * conversation. Deliberately permissive: anything this module cannot
 * classify is still relayed byte-for-byte, it just does not become a node.
 *
 * Shapes follow `@modelcontextprotocol/sdk` 1.30's `types.ts`
 * (JSONRPCRequest / JSONRPCNotification / JSONRPCResponse / JSONRPCError,
 * `JSONRPC_VERSION = "2.0"`); the SDK's zod schemas are not used at runtime
 * because a proxy must not reject frames its schema copy happens to be older
 * than.
 */

/** JSON-RPC request/response correlation id. `null` is legal but unpairable. */
export type JsonRpcId = string | number;

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export type ClassifiedFrame =
  | { kind: 'request'; id: JsonRpcId; method: string; params: unknown }
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'response'; id: JsonRpcId; result: unknown; error: JsonRpcErrorBody | undefined }
  /** A JSON-RPC batch (arrays were dropped in MCP 2025-06-18, older peers emit them). */
  | { kind: 'batch'; items: ClassifiedFrame[] }
  /** Valid JSON, but not a shape we correlate (e.g. an `id: null` error). */
  | { kind: 'other' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readId(value: unknown): JsonRpcId | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

function readError(value: unknown): JsonRpcErrorBody | undefined {
  if (!isRecord(value)) return undefined;
  const code = typeof value['code'] === 'number' ? value['code'] : 0;
  const message = typeof value['message'] === 'string' ? value['message'] : 'unknown error';
  return 'data' in value ? { code, message, data: value['data'] } : { code, message };
}

/** Classify one already-parsed JSON value. Never throws. */
export function classify(value: unknown): ClassifiedFrame {
  if (Array.isArray(value)) {
    return { kind: 'batch', items: value.map((item) => classify(item)) };
  }
  if (!isRecord(value)) return { kind: 'other' };

  const method = value['method'];
  const id = readId(value['id']);
  if (typeof method === 'string') {
    if (id === undefined) return { kind: 'notification', method, params: value['params'] };
    return { kind: 'request', id, method, params: value['params'] };
  }
  if (id !== undefined && ('result' in value || 'error' in value)) {
    return {
      kind: 'response',
      id,
      result: value['result'],
      error: 'error' in value ? readError(value['error']) : undefined,
    };
  }
  return { kind: 'other' };
}

/** Parse a frame's bytes. Returns `undefined` for anything that is not JSON. */
export function parseFrame(raw: Buffer): unknown | undefined {
  const text = raw.toString('utf8').trim();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Map key for a pending request. Keeps `1` and `"1"` distinct, as JSON-RPC does. */
export function idKey(id: JsonRpcId): string {
  return typeof id === 'number' ? `n:${id}` : `s:${id}`;
}

/**
 * JSON-RPC reserves -32000..-32099 for implementation-defined server errors.
 * The MCP SDK claims -32000 (ConnectionClosed), -32001 (RequestTimeout) and
 * -32042 (UrlElicitationRequired); -32099 is ours.
 */
export const GRAPHMIND_ABORTED_CODE = -32099;

/**
 * Serialize a frame. Returns `undefined` for anything that cannot become a
 * JSON object frame (a BigInt, a cycle, or a bare `undefined`) — the caller
 * relays the original bytes instead of putting garbage on the wire.
 */
export function encodeFrame(message: unknown): Buffer | undefined {
  try {
    const json = JSON.stringify(message);
    if (json === undefined) return undefined;
    return Buffer.from(json, 'utf8');
  } catch {
    return undefined;
  }
}

/** Same, for frames we build ourselves and know are serializable. */
function encodeOwnFrame(message: Record<string, unknown>): Buffer {
  return encodeFrame(message) ?? Buffer.from('{}', 'utf8');
}

export function errorResponse(id: JsonRpcId, code: number, message: string): Buffer {
  return encodeOwnFrame({ jsonrpc: '2.0', id, error: { code, message } });
}

/**
 * `result` must be PRESENT for the frame to be a valid JSON-RPC response, and
 * `JSON.stringify` silently drops an `undefined` value — so "inject" with no
 * value becomes an explicit `null` rather than a frame with neither `result`
 * nor `error`, which every client rejects.
 */
export function resultResponse(id: JsonRpcId, result: unknown): Buffer {
  return encodeOwnFrame({ jsonrpc: '2.0', id, result: result ?? null });
}

/**
 * Build the frame that replaces a gated response.
 *
 * `inject` normally substitutes the `result`, which is what "give the client
 * a different answer" means 99% of the time. The escape hatch: an injected
 * object carrying its own `jsonrpc` field replaces the entire frame, so a
 * debugger can also hand the client a raw JSON-RPC error.
 */
export function injectedResponse(id: JsonRpcId, output: unknown): Buffer {
  if (isRecord(output) && typeof output['jsonrpc'] === 'string') {
    return encodeFrame({ ...output, id }) ?? resultResponse(id, output);
  }
  return resultResponse(id, output);
}

/**
 * An MCP tool result signals failure in-band (`isError: true`) rather than as
 * a JSON-RPC error, so the error gate has to look for both.
 */
export function isErrorResult(result: unknown): boolean {
  return isRecord(result) && result['isError'] === true;
}
