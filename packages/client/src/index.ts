/**
 * @graphmind-ai/client — adapter-agnostic runtime for the GraphMind live agent
 * debugger. No dependency on any AI SDK; adapters (e.g. for the `ai`
 * package) build on `createSession` + `session.gate` + `session.emit`.
 */
export {
  createSession,
  VALIDATION_TIMEOUT_MS,
  type AfterGateContext,
  type GateDetector,
  type GateOptions,
  type Session,
  type SessionOptions,
  type SessionStats,
  type SmartInfo,
  type ReadyOptions,
  type RunContext,
} from './session.js';

export { CLIENT_VERSION } from './version.js';

export {
  CONTINUE_DECISION,
  matcherMatches,
  matcherEquals,
  type GateDecision,
  type GateNode,
} from './gate-engine.js';

// Edited input (0.6.0): what an adapter's `validateInput` returns, and the
// default rule for tool arguments (top-level keys replace the live ones).
export {
  MAX_REFUSAL_MESSAGE,
  mergeToolInput,
  type InputValidation,
  type RefusalCode,
  type ValidateInput,
} from './edit-input.js';

export { GraphMindAbortError, isAbortError, toErrorInfo } from './errors.js';

// Duration clock: every adapter measures `durationMs` with these, never with
// Date.now() (millisecond granularity reads a 80µs handler as `0ms`).
export { monotonicNow, elapsedMs, normalizeDurationMs, setClock, type Clock } from './clock.js';

export { DEFAULT_URL, killSwitchOn, resolveEnabled, resolveUrl, type EnvLike } from './env.js';

// Coarse redaction (the four GRAPHMIND_HIDE_* kill switches). `REDACTED` is
// the placeholder every hidden value becomes; `Redactor` is exported so the
// conformance fixture and other language ports can be checked against it.
// It fails closed: `apply` returns `undefined` for an event that must not be
// emitted, and a failed form carries `redaction.keys` = FAILED_REDACTION_KEYS.
export {
  FAILED_REDACTION_KEYS,
  REDACTED,
  Redactor,
  envFlagOn,
  optionFlagOn,
  resolveRedaction,
  anyRedaction,
  type RedactionOptions,
  type RedactionSummary,
  type RedactionSwitches,
  type RedactionWarn,
} from './redaction.js';

// Loop hold: the Nth identical tool call made back-to-back (rule v3: no other
// watched call of the same kind in between) is held at the before-gate
// while a debugger is attached (session option `loopGuard`, env
// GRAPHMIND_LOOP_THRESHOLD / GRAPHMIND_ON_LOOP). The fingerprint helpers are
// exported so ports and tests can prove parity against the same canon.
export {
  DEFAULT_LOOP_IGNORE_KEYS,
  DEFAULT_LOOP_KINDS,
  DEFAULT_LOOP_MODE,
  DEFAULT_LOOP_THRESHOLD,
  canonicalCall,
  canonicalize,
  fingerprintCall,
  parseLoopMode,
  parseLoopAllow,
  parseLoopThreshold,
  resolveLoopGuard,
  type LoopGuardOptions,
  type LoopInfo,
  type LoopMode,
  type ResolvedLoopGuard,
} from './loop-guard.js';

// LLM-step capture (contract C1, 0.6.0+): inclusive usage, normalized finish
// reasons and tool calls, tool definitions recorded once per run by hash,
// the allow-listed sampling parameters. Shared by every TS adapter.
export {
  MAX_SCHEMA_HASHES_PER_RUN,
  MAX_SCHEMA_RUNS,
  SAMPLING_PARAM_KEYS,
  SCHEMA_HASH_HEX_CHARS,
  captureTools,
  makeUsage,
  normalizeFinishReason,
  pickParams,
  resetToolSchemaMemory,
  schemaHash,
  sumReported,
  tokenCount,
  toolCall,
  toolCalls,
  withBinaryPlaceholders,
  type CapturedTools,
  type FinishReason,
  type RecordedToolCall,
  type ToolRef,
  type UsageParts,
  type WireUsage,
} from './llm-capture.js';

export type { WebSocketLike, WebSocketConstructor } from './transport.js';

// Re-export the wire-contract types adapters typically need, so most
// adapters can depend on @graphmind-ai/client alone.
export type {
  BreakpointMatcher,
  Capability,
  ErrorInfo,
  EventPayloadMap,
  EventType,
  GraphNodeHint,
  NodeKind,
  PausePoint,
  ResumeAction,
  RunMode,
  RunStatus,
  SdkInfo,
  TokenDelta,
  TokenUsage,
} from '@graphmind-ai/schema';
