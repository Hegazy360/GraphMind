/**
 * Held-time ledger: how much of a node instance's wall-clock duration was
 * the *debugger* holding it, rather than the node running.
 *
 * `durationMs` on `node.finished` keeps its meaning — wall-clock end minus
 * start, INCLUDING time spent held at a gate — so stored runs and third-party
 * importers are unaffected. `heldMs` is the debugger's share, attached as a
 * loose field to `node.finished` and `node.error`; "ran" = `durationMs -
 * heldMs` (clamped >= 0). Without it a developer who thinks for 40 s at a
 * breakpoint sees a 40 s tool call, and the slow filter agrees.
 *
 * Attribution. A gate is registered against a LOGICAL node (`nodeId`), not
 * an instance, so a hold has to be pinned to one of the node's open
 * instances when it opens:
 *   - `before` / `error` gates: the most recently started open instance
 *     (every adapter opens its `before` gate immediately after `node.started`,
 *     and its `error` gate immediately after `node.error` — for `error` an
 *     instance that `node.error` named is preferred);
 *   - `after` gates: the oldest open instance;
 *   - no open instance: the hold is not attributed at all. That is the
 *     correct answer, not a fallback — a hold that opens after an instance
 *     finished (LangGraph's error gate fires after `node.finished`) is not
 *     inside that instance's `durationMs`, and must not be subtracted from
 *     the next one's.
 * The hold is ALSO pinned to every open ancestor instance (following
 * `parentId` from `node.started`) and to the run's root instance — the
 * node whose `instanceId` is the `runId`, which is how every SDK emits the
 * `agent:<run>` node — because a tool held for 40 s sits inside the agent
 * node's 45 s too, whether or not the tool declared a parent. Each instance
 * accumulates the UNION of the intervals during which at least one hold
 * pinned to it was open, so two children held at the same time do not count
 * twice in their parent.
 *
 * This is exact whenever executions of one logical node do not overlap,
 * which is every sequential agent loop. For overlapping instances of the
 * SAME node (parallel calls of one tool) the pin is a heuristic; the
 * run-level total is still right, the split between siblings may not be.
 *
 * Bookkeeping only: never throws, never keeps a reference to host objects,
 * bounded so an instance that never finishes cannot grow memory forever.
 */
import type { PausePoint } from '@graphmind-ai/schema';
import { monotonicNow, normalizeDurationMs, type Clock } from './clock.js';

interface OpenInstance {
  key: string;
  nodeKey: string;
  instanceId: string;
  /** Union of held intervals closed so far, ms on the ledger clock (raw, unrounded). */
  heldMs: number;
  /** Holds currently open against this instance (directly or via a descendant). */
  openHolds: number;
  /** Clock reading when `openHolds` went 0 -> 1. */
  heldSince: number;
  /** Set when `node.error` named this instance; consumed by the next `error` hold. */
  errored: boolean;
}

/** Instances tracked at once across all runs; oldest are evicted past this. */
export const DEFAULT_MAX_TRACKED_INSTANCES = 10_000;
/** Ancestor hops followed when pinning a hold up the parent chain. */
const MAX_DEPTH = 64;

const SEP = '\u0000';

export class HeldLedger {
  /** Insertion-ordered → oldest-first eviction. */
  private readonly instances = new Map<string, OpenInstance>();
  /** Per logical node (run + nodeId): open instances in start order. */
  private readonly byNode = new Map<string, OpenInstance[]>();
  /** Per logical node: its parent nodeId, from the latest `node.started`. */
  private readonly parentByNode = new Map<string, string>();
  /** Per run: the open instance whose instanceId is the runId (the `agent:` node). */
  private readonly rootByRun = new Map<string, OpenInstance>();
  /** Open holds → every instance they are pinned to (target first, then ancestors). */
  private readonly holds = new Map<string, OpenInstance[]>();

  constructor(
    private readonly now: Clock = monotonicNow,
    private readonly maxInstances: number = DEFAULT_MAX_TRACKED_INSTANCES,
  ) {}

  /** `node.started`: begin tracking an instance. */
  started(runId: string, nodeId: string, instanceId: string, parentId?: string): void {
    const nodeKey = runId + SEP + nodeId;
    const key = nodeKey + SEP + instanceId;
    const existing = this.instances.get(key);
    if (existing !== undefined) this.remove(existing); // restarted id: start clean
    if (this.instances.size >= this.maxInstances) {
      const oldest = this.instances.values().next();
      if (!oldest.done) this.remove(oldest.value);
    }
    if (this.parentByNode.size >= this.maxInstances * 4) this.parentByNode.clear();
    if (parentId !== undefined && parentId !== nodeId) this.parentByNode.set(nodeKey, parentId);
    const instance: OpenInstance = {
      key,
      nodeKey,
      instanceId,
      heldMs: 0,
      openHolds: 0,
      heldSince: 0,
      errored: false,
    };
    this.instances.set(key, instance);
    if (instanceId === runId) this.rootByRun.set(runId, instance);
    let list = this.byNode.get(nodeKey);
    if (list === undefined) {
      list = [];
      this.byNode.set(nodeKey, list);
    }
    list.push(instance);
  }

  /** `node.error`: remember which instance failed so the `error` hold lands on it. */
  errored(runId: string, nodeId: string, instanceId: string | undefined): void {
    const instance = this.pick(runId + SEP + nodeId, instanceId);
    if (instance !== undefined) instance.errored = true;
  }

  /**
   * A gate opened. Pins the hold to an open instance of the held node (when
   * there is one), to that node's open ancestors and to the run root — or to
   * nothing at all.
   */
  holdOpened(pauseId: string, runId: string, nodeId: string, point: PausePoint): void {
    const nodeKey = runId + SEP + nodeId;
    const list = this.byNode.get(nodeKey);
    let target: OpenInstance | undefined;
    if (list !== undefined && list.length > 0) {
      if (point === 'after') {
        target = list[0];
      } else {
        if (point === 'error') {
          for (let i = list.length - 1; i >= 0; i -= 1) {
            const candidate = list[i];
            if (candidate !== undefined && candidate.errored) {
              target = candidate;
              break;
            }
          }
        }
        target ??= list[list.length - 1];
      }
      if (target !== undefined && point === 'error') target.errored = false; // one hold per failure
    }

    // No open instance of the held node (LangGraph's after/error gates fire
    // AFTER node.finished): the hold is outside every instance of this node's
    // durationMs and must not be charged to the next one — but the ancestors
    // and the run root are still running while the developer looks, and it
    // IS inside theirs.
    const pinned: OpenInstance[] = target === undefined ? [] : [target];
    // Ancestors: the newest open instance of each parent up the chain.
    let current = nodeKey;
    const seen = new Set<string>([current]);
    for (let hops = 0; hops < MAX_DEPTH; hops += 1) {
      const parentId = this.parentByNode.get(current);
      if (parentId === undefined) break;
      const parentKey = runId + SEP + parentId;
      if (seen.has(parentKey)) break;
      seen.add(parentKey);
      const parents = this.byNode.get(parentKey);
      const parent = parents?.[parents.length - 1];
      if (parent !== undefined) pinned.push(parent);
      current = parentKey;
    }
    const root = this.rootByRun.get(runId);
    if (root !== undefined && !pinned.includes(root)) pinned.push(root);
    if (pinned.length === 0) return;

    const now = this.now();
    for (const instance of pinned) {
      if (instance.openHolds === 0) instance.heldSince = now;
      instance.openHolds += 1;
    }
    this.holds.set(pauseId, pinned);
  }

  /** The gate closed. Every instance it was pinned to stops accruing. */
  holdClosed(pauseId: string): void {
    const pinned = this.holds.get(pauseId);
    if (pinned === undefined) return;
    this.holds.delete(pauseId);
    const now = this.now();
    for (const instance of pinned) this.release(instance, now);
  }

  /**
   * Held time accumulated so far by an instance (for `node.error`, which is
   * emitted while the instance is still open), including a hold that is
   * open right now. `undefined` when the instance is unknown — the field is
   * then omitted rather than claimed as 0.
   */
  peek(runId: string, nodeId: string, instanceId: string | undefined): number | undefined {
    const instance = this.pick(runId + SEP + nodeId, instanceId);
    if (instance === undefined) return undefined;
    return this.total(instance, this.now());
  }

  /**
   * `node.finished`: close the instance and return its held total. A hold
   * still open against it is credited up to now (that time IS inside the
   * `durationMs` the adapter just measured) and unpinned from it.
   */
  finished(runId: string, nodeId: string, instanceId: string | undefined): number | undefined {
    const instance = this.pick(runId + SEP + nodeId, instanceId);
    if (instance === undefined) return undefined;
    const held = this.total(instance, this.now());
    this.remove(instance);
    return held;
  }

  /** Diagnostics for tests. */
  get trackedInstances(): number {
    return this.instances.size;
  }

  get openHolds(): number {
    return this.holds.size;
  }

  private total(instance: OpenInstance, now: number): number {
    const open = instance.openHolds > 0 ? Math.max(0, now - instance.heldSince) : 0;
    return normalizeDurationMs(instance.heldMs + open);
  }

  private release(instance: OpenInstance, now: number): void {
    if (instance.openHolds === 0) return;
    instance.openHolds -= 1;
    if (instance.openHolds === 0) instance.heldMs += Math.max(0, now - instance.heldSince);
  }

  /** Exact instance when named; otherwise the newest open one for the node. */
  private pick(nodeKey: string, instanceId: string | undefined): OpenInstance | undefined {
    const list = this.byNode.get(nodeKey);
    if (list === undefined || list.length === 0) return undefined;
    // An unknown instanceId is not "the newest one" — it is an instance we
    // never saw start (or already closed), and it has no held time.
    if (instanceId !== undefined) return this.instances.get(nodeKey + SEP + instanceId);
    return list[list.length - 1];
  }

  private remove(instance: OpenInstance): void {
    this.instances.delete(instance.key);
    const runId = instance.nodeKey.slice(0, instance.nodeKey.indexOf(SEP));
    if (this.rootByRun.get(runId) === instance) this.rootByRun.delete(runId);
    const list = this.byNode.get(instance.nodeKey);
    if (list !== undefined) {
      const index = list.indexOf(instance);
      if (index >= 0) list.splice(index, 1);
      if (list.length === 0) this.byNode.delete(instance.nodeKey);
    }
    if (instance.openHolds > 0) {
      for (const [pauseId, pinned] of this.holds) {
        const index = pinned.indexOf(instance);
        if (index >= 0) pinned.splice(index, 1);
        if (pinned.length === 0) this.holds.delete(pauseId);
      }
      instance.openHolds = 0;
    }
  }
}
