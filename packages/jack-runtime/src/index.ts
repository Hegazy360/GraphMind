/**
 * @graphmind-ai/jack-runtime — serves a Jack Manifest as an MCP server
 * (protocol 2026-07-28 only): argument validation, scope filtering, MRTR
 * confirmations, request building, the egress guard and response shaping.
 */
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { createToolServerFactory, type ToolServerOptions } from './server.js';

export { PROTOCOL_VERSION } from '@graphmind-ai/jack-schema';

/** 2025-era clients are rejected with the unsupported-version error, never served. */
export const LEGACY_POLICY = 'reject' as const;

export { checkTarget, EgressDeniedError, guardedLookup, isPrivateAddress, type EgressPolicy } from './egress.js';
export { guardedFetch, sendUpstream, UpstreamError, type GuardedFetchOptions, type SendOptions, type UpstreamErrorKind, type UpstreamRequest, type UpstreamResponse } from './http.js';
export { ArgumentError, buildRequest } from './request.js';
export { parsePick, pick, PickError, shapeResponse, truncate, type ToolResult } from './shape.js';
export {
  createToolServerFactory,
  CredentialError,
  headerCredentials,
  type CallContext,
  type CallRecord,
  type CallStatus,
  type CredentialResolver,
  type ToolServerOptions,
} from './server.js';

/** The HTTP handler for a manifest: Streamable HTTP, 2026-07-28 only. */
export function createToolHttpHandler(opts: ToolServerOptions & { onerror?: (err: Error) => void }): McpHttpHandler {
  return createMcpHandler(createToolServerFactory(opts), {
    legacy: LEGACY_POLICY,
    maxRequestBodySize: 1024 * 1024,
    ...(opts.onerror ? { onerror: opts.onerror } : {}),
  });
}
