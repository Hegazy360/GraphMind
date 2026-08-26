/**
 * @graphmind/client — adapter-agnostic runtime for the GraphMind live agent
 * debugger. No dependency on any AI SDK; adapters (e.g. for the `ai`
 * package) build on `createSession` + `session.gate` + `session.emit`.
 */
export {
  createSession,
  CLIENT_VERSION,
  type Session,
  type SessionOptions,
  type SessionStats,
  type RunContext,
} from './session.js';

export {
  CONTINUE_DECISION,
  matcherMatches,
  matcherEquals,
  type GateDecision,
  type GateNode,
} from './gate-engine.js';

export { GraphMindAbortError, isAbortError, toErrorInfo } from './errors.js';

export { DEFAULT_URL, resolveEnabled, resolveUrl, type EnvLike } from './env.js';

export type { WebSocketLike, WebSocketConstructor } from './transport.js';

// Re-export the wire-contract types adapters typically need, so most
// adapters can depend on @graphmind/client alone.
export type {
  BreakpointMatcher,
  Capability,
  ErrorInfo,
  EventPayloadMap,
  EventType,
  NodeKind,
  PausePoint,
  ResumeAction,
  RunMode,
  RunStatus,
  SdkInfo,
  TokenDelta,
  TokenUsage,
} from '@graphmind/schema';
