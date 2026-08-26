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

export class TokenBatcher {
  private readonly pending = new Map<string, TokenDelta[]>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly sink: TokenBatchSink,
    private readonly intervalMs: number = 34,
  ) {}

  push(nodeId: string, delta: TokenDelta): void {
    if (this.disposed) return;
    const deltas = this.pending.get(nodeId);
    if (deltas === undefined) this.pending.set(nodeId, [delta]);
    else deltas.push(delta);
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flushAll();
      }, this.intervalMs);
      this.timer.unref?.();
    }
  }

  flushNode(nodeId: string): void {
    const deltas = this.pending.get(nodeId);
    if (deltas === undefined || deltas.length === 0) return;
    this.pending.delete(nodeId);
    this.sink(nodeId, deltas);
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
