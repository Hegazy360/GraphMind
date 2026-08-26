/**
 * The single entry point for envelopes, shared by the live socket and the
 * fixture replay. Routes `node.token` to the buffer registry (hot path,
 * store untouched) and everything else through the reducer.
 */
import { isEventType, parseEnvelope, type EventEnvelope, type KnownEnvelope } from '@graphmind-ai/schema';
import { tokenBuffers } from '../store/tokenBuffers.js';
import { useRunStore } from '../store/runStore.js';
import type { RunSource } from '../store/types.js';

export function ingestValue(value: unknown, source: RunSource): void {
  const result = parseEnvelope(value);
  if (result.kind === 'ok') {
    ingestEnvelope(result.envelope, source);
  } else if (result.kind === 'unknown-type') {
    // Forward-compat: unknown event types are ignored gracefully.
  } else if (result.kind === 'version-mismatch') {
    console.warn(
      `[graphmind] dropped envelope with protocol v${result.received} (viewer speaks v${result.supported})`,
    );
  } else {
    console.warn('[graphmind] dropped invalid envelope:', result.reason);
  }
}

export function ingestEnvelope(envelope: KnownEnvelope, source: RunSource): void {
  if (!isEventType(envelope.type)) return; // controls/handshake are not viewer input
  const event = envelope as EventEnvelope;
  if (event.type === 'node.token') {
    tokenBuffers.push(
      event.runId,
      event.seq,
      event.payload.nodeId,
      event.payload.deltas,
      event.ts,
    );
    return;
  }
  const applied = useRunStore.getState().applyEvent(event, source);
  // A new execution of a node starts a fresh stream segment: archive the
  // previous instance's buffered tokens (the wire carries no instanceId on
  // node.token, so segmentation happens at node.started boundaries).
  if (applied && event.type === 'node.started') {
    tokenBuffers.beginInstance(event.runId, event.payload.nodeId);
  }
}
