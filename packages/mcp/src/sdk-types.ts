/**
 * Structural (duck-typed) views of the pieces of `@modelcontextprotocol/sdk`
 * this adapter touches.
 *
 * Nothing here imports the SDK. The public API is generic (`wrapServer<T>(s):
 * T`), so the adapter type-checks and builds with no peer installed, and it
 * cannot be broken by a peer version whose type declarations moved. Every
 * access is guarded at runtime instead — the adapter must degrade to a no-op
 * on a server shape it does not recognise, never throw into the host.
 */

/** JSON-RPC request id, as the SDK models it. */
export type RequestId = string | number;

/**
 * `RequestHandlerExtra` — the second (or last) argument every MCP request
 * handler receives. Built fresh per request by `Protocol._onrequest`, so a
 * shallow copy with an instrumented `signal` / `sendRequest` is safe.
 */
export interface RequestHandlerExtraLike {
  signal?: AbortSignal | undefined;
  requestId?: RequestId | undefined;
  sessionId?: string | undefined;
  sendRequest?: ((request: unknown, resultSchema: unknown, options?: unknown) => Promise<unknown>) | undefined;
  [key: string]: unknown;
}

/** A transport, as far as this adapter cares: it may expose a session id. */
export interface TransportLike {
  sessionId?: string | undefined;
  [key: string]: unknown;
}

/** The shape `McpServer.registerTool()` and friends hand back. */
export interface RegistrationLike {
  update?: ((updates: Record<string, unknown>) => unknown) | undefined;
  [key: string]: unknown;
}

/** An incoming JSON-RPC request as seen by a low-level `setRequestHandler`. */
export interface JsonRpcRequestLike {
  method?: unknown;
  params?: Record<string, unknown> | undefined;
}

export type AnyFn = (...args: unknown[]) => unknown;

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isFunction(value: unknown): value is AnyFn {
  return typeof value === 'function';
}

/**
 * Does this look like a `RequestHandlerExtra`? Every handler the SDK invokes
 * gets one as its LAST argument, and it always carries both `requestId` and
 * `signal`. Used only to decide whether the trailing argument is the extra —
 * a mis-detection costs instrumentation detail, never correctness.
 */
export function isHandlerExtra(value: unknown): value is RequestHandlerExtraLike {
  return isObject(value) && 'requestId' in value && 'signal' in value;
}

/** `String(id)`, tolerating the odd shapes a loose peer could hand over. */
export function requestIdString(id: unknown): string | undefined {
  if (typeof id === 'string') return id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return undefined;
}

/**
 * Best-effort read of `new Server({name, version})`'s own record of itself.
 * The field is `private` in TypeScript, which is a compile-time fiction — the
 * value is a plain own property at runtime. Reading it is what lets the viewer
 * label the node with the server's REAL name instead of the app name; every
 * access is guarded and the caller falls back when it yields nothing.
 */
export function readServerInfo(server: unknown): { name?: string; version?: string } {
  try {
    if (!isObject(server)) return {};
    const inner = isObject(server['server']) ? server['server'] : server;
    const info = inner['_serverInfo'];
    if (!isObject(info)) return {};
    const name = typeof info['name'] === 'string' ? info['name'] : undefined;
    const version = typeof info['version'] === 'string' ? info['version'] : undefined;
    return {
      ...(name !== undefined ? { name } : {}),
      ...(version !== undefined ? { version } : {}),
    };
  } catch {
    return {};
  }
}
