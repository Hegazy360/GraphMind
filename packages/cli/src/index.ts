/**
 * graphmind-ai — the GraphMind local server + CLI, programmatic API.
 * The `graphmind` binary lives in cli.ts; this module exposes the server
 * and its protocol types for embedding and for the viewer.
 */
export { startServer, type ServerOptions, type GraphMindServer } from './server.js';
export { Hub, type LogFn } from './hub.js';
export { DebugState } from './debug-state.js';
export { SqliteStorage } from './sqlite-storage.js';
export {
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
