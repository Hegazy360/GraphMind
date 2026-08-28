/**
 * `graphmind mcp-proxy` internals. See proxy.ts for the wiring diagram and
 * reporter.ts for the protocol -> graph mapping and gate semantics.
 */
export { LineFramer, type FramerResult } from './framing.js';
export {
  GRAPHMIND_ABORTED_CODE,
  classify,
  encodeFrame,
  errorResponse,
  idKey,
  injectedResponse,
  isErrorResult,
  parseFrame,
  resultResponse,
  type ClassifiedFrame,
  type JsonRpcErrorBody,
  type JsonRpcId,
} from './jsonrpc.js';
export {
  SESSION_NODE_ID,
  commandLabel,
  directionLabel,
  mapMethod,
  otherSide,
  type Direction,
  type MappedNode,
} from './mapping.js';
export { FrameRelay, FORWARD, type FrameAction, type RelayOptions } from './relay.js';
export { ProxyReporter, type ReporterOptions } from './reporter.js';
export { FrameWriter } from './writer.js';
export { MCP_PROXY_SUMMARY, mcpProxyHelp } from './help.js';
export {
  ATTACH_WAIT_MS,
  DEFAULT_MAX_FRAME_BYTES,
  exitCodeFor,
  startMcpProxy,
  type ExitInfo,
  type McpProxyHandle,
  type McpProxyOptions,
} from './proxy.js';
