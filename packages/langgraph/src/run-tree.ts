/**
 * The run registry: LangChain's run tree, remembered just long enough to
 * answer three questions when a callback fires.
 *
 *  - which GraphMind node is this run?          (runId  -> nodeId/kind/name)
 *  - what is its parent node?                   (parentRunId -> record)
 *  - which root invocation does it belong to?   (rootRunId -> RunScope)
 *
 * Records are removed when their run ends or errors. A hard cap bounds the map
 * for pathological graphs (or hosts that drop end callbacks) — the oldest
 * entries are evicted, which degrades parentage, never correctness.
 */
import type { NodeKind } from '@graphmind-ai/client';

export interface RunRecord {
  runId: string;
  rootRunId: string;
  parentRunId: string | undefined;
  /** The GraphMind node this run maps to, or its nearest emitted ancestor. */
  nodeId: string;
  kind: NodeKind;
  name: string;
  /** Per-execution id carried on every event for this run. */
  instanceId: string;
  startedAt: number;
  /**
   * False for runs we deliberately do not render (LangGraph internals, chains
   * excluded by policy). They stay in the tree so their children can still
   * attach to the nearest emitted ancestor.
   */
  emitted: boolean;
  /** True when a tool wrapper owns this run's gates (see wrap-tools.ts). */
  gatedByWrapper: boolean;
  /**
   * `langgraphTaskKey(metadata)` for this run: which LangGraph node execution
   * it belongs to. A child run carrying the SAME key is LangGraph's own inner
   * wrapper around the node body, not a nested node.
   */
  langgraphTask?: string | undefined;
}

const DEFAULT_MAX_RUNS = 5000;

export class RunTree {
  private readonly runs = new Map<string, RunRecord>();

  constructor(private readonly maxRuns: number = DEFAULT_MAX_RUNS) {}

  get size(): number {
    return this.runs.size;
  }

  get(runId: string | undefined): RunRecord | undefined {
    return runId === undefined ? undefined : this.runs.get(runId);
  }

  /** The root run id for a new run under `parentRunId` (itself, if root). */
  rootFor(runId: string, parentRunId: string | undefined): string {
    const parent = this.get(parentRunId);
    return parent?.rootRunId ?? parentRunId ?? runId;
  }

  set(record: RunRecord): RunRecord {
    if (this.runs.size >= this.maxRuns) {
      const oldest = this.runs.keys().next();
      if (oldest.done !== true) this.runs.delete(oldest.value);
    }
    this.runs.set(record.runId, record);
    return record;
  }

  /** Remove and return a finished run. */
  take(runId: string): RunRecord | undefined {
    const record = this.runs.get(runId);
    if (record !== undefined) this.runs.delete(runId);
    return record;
  }

  /** Drop every run belonging to one root (called when the root finishes). */
  clearRoot(rootRunId: string): void {
    for (const [runId, record] of this.runs) {
      if (record.rootRunId === rootRunId) this.runs.delete(runId);
    }
  }

  clear(): void {
    this.runs.clear();
  }
}
