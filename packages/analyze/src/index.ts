/**
 * @graphmind-ai/analyze — behaviour analysis over recorded GraphMind runs.
 *
 * One `BehaviorReport` per run, computed from facts the recording proves:
 * wasted tool calls (repeats, cycles, identical failures), per-tool health
 * including failures that were returned rather than thrown, termination
 * quality (normalized finish reasons), and prompt-size growth across LLM
 * steps. Shared by the CLI (`graphmind runs --behavior`), the MCP server
 * (`get_behavior`) and the viewer's Behaviour section, so every surface
 * reports the same numbers and the same one-line verdict.
 *
 * Platform-neutral: no Node APIs, no I/O, nothing thrown on hostile
 * payloads. Everything recorded in a run is data the user's agent produced —
 * it is analyzed, never trusted.
 */
export {
  callKey,
  canonicalValue,
  shortDigest,
  DEFAULT_IGNORE_KEYS,
} from './canonical.js';
export { errorResultShape, type ErrorResultShape } from './errorShape.js';
export {
  sampleFromEvents,
  type ExecutionSample,
  type RunSample,
  type SampleEvent,
  type SampleOrigin,
} from './sample.js';
export { scanWaste, ERROR_REPEAT_COUNT, type WasteIncident, type WasteScan } from './waste.js';
export {
  analyzeRun,
  outputFinishReason,
  verdictOf,
  type BehaviorReport,
  type ContextPoint,
  type ContextPressure,
  type TerminationSummary,
  type ToolHealth,
  type WasteSummary,
} from './report.js';
export {
  analyzeTrend,
  groupByApp,
  twoProportionZ,
  type BehaviorTrend,
  type ShiftMetric,
  type ToolTrend,
  type TrendOptions,
  type TrendPoint,
  type TrendShift,
  type WindowStats,
} from './trend.js';
export {
  recommend,
  type Evidence,
  type Recommendation,
  type RecommendationId,
  type Recommendations,
  type RecommendOptions,
  type Severity,
} from './recommend.js';
export {
  sampleFromCircuitRun,
  samplesFromJackCalls,
  type CircuitEntryLike,
  type CircuitRunLike,
  type JackCallLike,
} from './adapters.js';
