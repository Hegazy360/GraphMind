/**
 * Batches streamed token deltas into `node.token` events, at most one batch
 * per node per `intervalMs` (~30/sec by default), so a fast provider stream
 * cannot flood the wire. A single unref'd timer flushes all pending nodes;
 * `flushNode` forces a flush before a `node.finished` so ordering holds.
 *
 * (Same design as @graphmind-ai/sdk's batcher — duplicated rather than shared
 * so neither adapter depends on the other.)
 */
import type { TokenDelta } from '@graphmind-ai/client';

export type TokenBatchSink = (nodeId: string, deltas: TokenDelta[]) => void;

interface PendingBatch {
  deltas: TokenDelta[];
  /**
   * How to emit THIS node's batch. Captured per push, because the interval
   * flush fires from a bare timer callback — outside the AsyncLocalStorage run
   * context the tokens belong to. Without it, a mid-stream batch would be
   * attributed to the session's implicit run instead of its own.
   */
  sink: TokenBatchSink;
}

export class TokenBatcher {
  private readonly pending = new Map<string, PendingBatch>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly defaultSink: TokenBatchSink,
    private readonly intervalMs: number = 34,
  ) {}

  push(nodeId: string, delta: TokenDelta, sink?: TokenBatchSink): void {
    if (this.disposed) return;
    const batch = this.pending.get(nodeId);
    if (batch === undefined) {
      this.pending.set(nodeId, { deltas: [delta], sink: sink ?? this.defaultSink });
    } else {
      batch.deltas.push(delta);
      if (sink !== undefined) batch.sink = sink;
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flushAll();
      }, this.intervalMs);
      this.timer.unref?.();
    }
  }

  flushNode(nodeId: string): void {
    const batch = this.pending.get(nodeId);
    if (batch === undefined || batch.deltas.length === 0) return;
    this.pending.delete(nodeId);
    batch.sink(nodeId, batch.deltas);
  }

  /**
   * Remove and return a node's pending deltas so the CALLER emits them.
   * Used right before a `node.finished`: the caller is already inside the
   * right run context and emits synchronously, which keeps `node.token`
   * strictly ordered before the `node.finished` it belongs to.
   */
  take(nodeId: string): TokenDelta[] | undefined {
    const batch = this.pending.get(nodeId);
    if (batch === undefined || batch.deltas.length === 0) return undefined;
    this.pending.delete(nodeId);
    return batch.deltas;
  }

  flushAll(): void {
    for (const nodeId of [...this.pending.keys()]) this.flushNode(nodeId);
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.flushAll();
    this.disposed = true;
  }
}
