/**
 * graphmind-ai — the GraphMind local server + CLI, programmatic API.
 * The `graphmind` binary lives in cli.ts; this module exposes the server
 * and its protocol types for embedding and for the viewer.
 */
export { startServer, type ServerOptions, type GraphMindServer } from './server.js';
export { Hub, DEFAULT_ABANDON_GRACE_MS, type HubOptions, type LogFn } from './hub.js';
export {
  DebugState,
  parsePauseOnError,
  DEFAULT_BREAKPOINTS,
  PAUSE_ON_ERROR_VALUES,
  type PauseOnErrorResult,
} from './debug-state.js';
export { SqliteStorage } from './sqlite-storage.js';
export {
  MAX_PAYLOAD_BYTES,
  MAX_FRAME_BYTES,
  type Storage,
  type StoredEvent,
  type RunRecord,
  type RunSummary,
  type RunSource,
  type RunLifecycleStatus,
  type EventQuery,
  type EventPage,
} from './storage.js';
export {
  type UiClientMessage,
  type UiServerMessage,
  type RunInfo,
  type WireEnvelope,
} from './ui-protocol.js';
export { resolveDbPath, resolveViewerDist, DEFAULT_PORT, packageRoot } from './paths.js';
export { VERSION } from './version.js';
