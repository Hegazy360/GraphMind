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
 * Does this look like a 1.x `RequestHandlerExtra`? Every handler the 1.x SDK
 * invokes gets one as its LAST argument, and it always carries both
 * `requestId` and `signal`. Used only to decide whether the trailing argument
 * is the extra — a mis-detection costs instrumentation detail, never
 * correctness.
 */
export function isHandlerExtra(value: unknown): value is RequestHandlerExtraLike {
  return isObject(value) && 'requestId' in value && 'signal' in value;
}

/**
 * `ctx.mcpReq` — the per-request half of the handler context in
 * `@modelcontextprotocol/server` 2.x. Built per request by `Protocol._onrequest`
 * as a plain object of closures (`send`, `notify`, and, from `Server`,
 * `requestSampling`, `elicitInput`, `log`), so a shallow copy with an
 * instrumented `signal` / `send` / `requestSampling` is safe.
 */
export interface RequestContextMcpReqLike {
  id?: unknown;
  method?: unknown;
  signal?: AbortSignal | undefined;
  send?: ((request: unknown, schemaOrOptions?: unknown, maybeOptions?: unknown) => Promise<unknown>) | undefined;
  requestSampling?: ((params: unknown, options?: unknown) => Promise<unknown>) | undefined;
  [key: string]: unknown;
}

/** The v2 handler context: `{ sessionId?, mcpReq, http? }`. */
export interface RequestContextLike {
  sessionId?: string | undefined;
  mcpReq: RequestContextMcpReqLike;
  [key: string]: unknown;
}

/** Whatever the SDK appends to a handler's arguments: the 1.x extra or the 2.x context. */
export type RequestTrailer = RequestHandlerExtraLike | RequestContextLike;

/**
 * Does this look like a 2.x handler context? Every v2 handler — tool,
 * resource, prompt, low-level — receives it as its LAST argument, and its
 * `mcpReq` always carries the request `id` and `method`. A tool whose own
 * arguments happen to contain an `mcpReq` key is never the last argument when
 * the SDK is the caller, so the guard is only ever consulted on a real
 * trailer; the failure mode of a wrong guess is a coarser node, not a broken
 * request.
 */
export function isHandlerContext(value: unknown): value is RequestContextLike {
  if (!isObject(value)) return false;
  const req = value['mcpReq'];
  return isObject(req) && 'id' in req && typeof req['method'] === 'string';
}

export function isRequestTrailer(value: unknown): value is RequestTrailer {
  return isHandlerExtra(value) || isHandlerContext(value);
}

/**
 * The three things the adapter reads off either trailer shape: the JSON-RPC
 * id (the execution id), the transport session id, and the handler's own
 * abort signal (chained with the debugger's while attached).
 */
export function requestContextOf(
  value: unknown,
): { requestId: unknown; sessionId: string | undefined; signal: AbortSignal | undefined } | undefined {
  if (isHandlerContext(value)) {
    return {
      requestId: value.mcpReq.id,
      sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
      signal: value.mcpReq.signal,
    };
  }
  if (isHandlerExtra(value)) {
    return {
      requestId: value.requestId,
      sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
      signal: value.signal,
    };
  }
  return undefined;
}

/**
 * Which SDK generation a wrapped object comes from, read structurally so the
 * `server` node can say so even when both packages are installed side by
 * side (a migration in progress): the 2.x `McpServer` has no deprecated
 * `tool()` overload and exposes `toolInputSchemaJson`; the 2.x low-level
 * `Server` gained `projectCallToolResult`. Undefined when it cannot tell.
 */
export function detectSdkGeneration(server: unknown): 1 | 2 | undefined {
  try {
    if (!isObject(server)) return undefined;
    if (isFunction(server['registerTool'])) {
      if (isFunction(server['tool'])) return 1;
      return isFunction(server['toolInputSchemaJson']) ? 2 : undefined;
    }
    if (isFunction(server['setRequestHandler'])) {
      return isFunction(server['projectCallToolResult']) ? 2 : 1;
    }
    return undefined;
  } catch {
    return undefined;
  }
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
