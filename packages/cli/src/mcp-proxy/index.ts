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
  PROTOCOL_NODE_ID,
  PROTOCOL_NODE_NAME,
  SESSION_NODE_ID,
  STDOUT_NOISE_NODE_ID,
  STDOUT_NOISE_NODE_NAME,
  commandLabel,
  directionLabel,
  isWorkMethod,
  mapMethod,
  otherSide,
  type Direction,
  type MappedNode,
} from './mapping.js';
export { durationBetween, monotonicNow, roundDurationMs, type Clock } from './clock.js';
export { describeExit, ntstatusName } from './exit-status.js';
export { STDERR_RING_MAX_BYTES, STDERR_RING_MAX_LINES, StderrRing } from './stderr-ring.js';
export { FrameRelay, FORWARD, type FrameAction, type RelayOptions } from './relay.js';
export {
  ProxyReporter,
  STDOUT_NOISE_MAX_RECORDED,
  STDOUT_NOISE_QUOTE_BYTES,
  type ReporterOptions,
} from './reporter.js';
export { FrameWriter } from './writer.js';
export { MCP_PROXY_SUMMARY, mcpProxyHelp } from './help.js';
export {
  ATTACH_WAIT_MS,
  SPAWN_FAILURE_ATTACH_MS,
  DEFAULT_MAX_FRAME_BYTES,
  exitCodeFor,
  spawnFailureMessage,
  startMcpProxy,
  type ExitInfo,
  type McpProxyHandle,
  type McpProxyOptions,
} from './proxy.js';
