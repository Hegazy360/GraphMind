/**
 * Retrospective wasted-work detection over a run's tool calls — the same
 * three behaviours the live loop guard holds on (@graphmind-ai/client,
 * loop-guard.ts), found after the fact in a recording:
 *
 *   repeat        consecutive identical calls (same nodeId, same canonical
 *                 input). Two are already waste: the second call could only
 *                 return what the first did.
 *   error-repeat  the same tool failing with the same error three or more
 *                 times in a row (the live guard's threshold), inputs aside.
 *   cycle         a lap of 2–4 distinct calls repeating identically
 *                 (A→B→A→B...). A lap that is all one call is a repeat, not
 *                 a cycle, and is never reported twice.
 *
 * What is NOT here, deliberately: "dead steps" (an output nothing downstream
 * used) would need data-flow the recording does not carry, and guessing
 * would overclaim. The waste reported here is only what the recording
 * proves.
 *
 * `wastedIndices` is a set over the ORIGINAL execution list, and the single
 * source of totals — incidents may overlap (a repeated call that also failed
 * identically), the union never double-counts.
 */
import { callKey, shortDigest } from './canonical.js';
import type { ExecutionSample } from './sample.js';

/** Live-guard parity: three identical failures in a row before it counts. */
export const ERROR_REPEAT_COUNT = 3;
const CYCLE_MIN_PERIOD = 2;
const CYCLE_MAX_PERIOD = 4;

export interface WasteIncident {
  kind: 'repeat' | 'cycle' | 'error-repeat';
  /** Distinct logical nodes in the streak (one for repeat / error-repeat). */
  nodeIds: string[];
  /** Their display names, same order as `nodeIds`. */
  names: string[];
  /** Executions in the streak, the useful first one(s) included. */
  count: number;
  /** Executions that re-did earlier work. */
  wasted: number;
  /** `cycle` only: calls per lap. */
  period?: number;
  /** `cycle` only: complete laps in the streak. */
  laps?: number;
  /** Envelope seqs of the streak's first and last call, when known. */
  firstSeq?: number;
  lastSeq?: number;
  /** Indices into the analyzed execution list (first and last of the streak). */
  firstIndex: number;
  lastIndex: number;
  /** Short digest of what the calls share — a label, never a comparison key. */
  fingerprint: string;
  /** `error-repeat` only: the message every failure shared. */
  errorMessage?: string;
}

export interface WasteScan {
  /** Tool executions seen (the denominator of every share). */
  toolCalls: number;
  /** Tool calls whose canonical input could not be read (excluded from matching). */
  unreadableCalls: number;
  /** Indices (into the original execution list) of wasted executions. */
  wastedIndices: Set<number>;
  /** Oldest first. May overlap; totals come from `wastedIndices`. */
  incidents: WasteIncident[];
}

interface ToolCall {
  /** Index into the original execution list. */
  index: number;
  execution: ExecutionSample;
  /** Comparison key, or undefined when the input was unreadable. */
  key: string | undefined;
}

function seqRange(calls: readonly ToolCall[], from: number, to: number): { firstSeq?: number; lastSeq?: number } {
  const firstSeq = calls[from]?.execution.seq;
  const lastSeq = calls[to]?.execution.seq;
  return {
    ...(firstSeq !== undefined ? { firstSeq } : {}),
    ...(lastSeq !== undefined ? { lastSeq } : {}),
  };
}

/** Add `calls[from..to]`'s wasted tail to the scan as one incident, union-safe. */
function pushIncident(
  scan: WasteScan,
  calls: readonly ToolCall[],
  incident: WasteIncident,
  wastedCallPositions: readonly number[],
): void {
  const fresh = wastedCallPositions
    .map((position) => calls[position]?.index)
    .filter((index): index is number => index !== undefined && !scan.wastedIndices.has(index));
  // Everything this streak would mark is already covered by an earlier
  // incident — a second card saying the same thing is noise, not evidence.
  if (fresh.length === 0) return;
  for (const index of fresh) scan.wastedIndices.add(index);
  scan.incidents.push(incident);
}

function scanRepeats(scan: WasteScan, calls: readonly ToolCall[]): void {
  let start = 0;
  while (start < calls.length) {
    const key = calls[start]?.key;
    let end = start;
    if (key !== undefined) {
      while (end + 1 < calls.length && calls[end + 1]?.key === key) end += 1;
    }
    const count = end - start + 1;
    if (count >= 2) {
      const execution = calls[start]!.execution;
      const positions: number[] = [];
      for (let p = start + 1; p <= end; p += 1) positions.push(p);
      pushIncident(
        scan,
        calls,
        {
          kind: 'repeat',
          nodeIds: [execution.nodeId],
          names: [execution.name],
          count,
          wasted: count - 1,
          ...seqRange(calls, start, end),
          firstIndex: calls[start]!.index,
          lastIndex: calls[end]!.index,
          fingerprint: shortDigest(key ?? ''),
        },
        positions,
      );
    }
    start = end + 1;
  }
}

function scanErrorRepeats(scan: WasteScan, calls: readonly ToolCall[]): void {
  let start = 0;
  while (start < calls.length) {
    const head = calls[start]!.execution;
    const message = head.errorMessage;
    let end = start;
    if (message !== undefined) {
      while (end + 1 < calls.length) {
        const next = calls[end + 1]!.execution;
        if (next.nodeId !== head.nodeId || next.errorMessage !== message) break;
        end += 1;
      }
    }
    const count = end - start + 1;
    if (message !== undefined && count >= ERROR_REPEAT_COUNT) {
      const positions: number[] = [];
      for (let p = start + 1; p <= end; p += 1) positions.push(p);
      pushIncident(
        scan,
        calls,
        {
          kind: 'error-repeat',
          nodeIds: [head.nodeId],
          names: [head.name],
          count,
          wasted: count - 1,
          ...seqRange(calls, start, end),
          firstIndex: calls[start]!.index,
          lastIndex: calls[end]!.index,
          fingerprint: shortDigest(`${head.nodeId}\u0000${message}`),
          errorMessage: message,
        },
        positions,
      );
    }
    start = end + 1;
  }
}

/** A lap of one repeated key is a repeat; only mixed laps count as cycles. */
function lapIsUniform(calls: readonly ToolCall[], lapStart: number, period: number): boolean {
  const first = calls[lapStart]?.key;
  for (let i = 1; i < period; i += 1) {
    if (calls[lapStart + i]?.key !== first) return false;
  }
  return true;
}

function scanCycles(scan: WasteScan, calls: readonly ToolCall[]): void {
  for (let period = CYCLE_MIN_PERIOD; period <= CYCLE_MAX_PERIOD; period += 1) {
    let i = period;
    while (i < calls.length) {
      // Maximal run of positions matching the call `period` back.
      let matches = 0;
      while (
        i + matches < calls.length &&
        calls[i + matches]?.key !== undefined &&
        calls[i + matches]?.key === calls[i + matches - period]?.key
      ) {
        matches += 1;
      }
      // At least one full repeated lap, and a lap that is really a mix.
      if (matches >= period && !lapIsUniform(calls, i - period, period)) {
        const blockStart = i - period;
        const blockEnd = i + matches - 1;
        const nodeIds: string[] = [];
        const names: string[] = [];
        for (let p = blockStart; p < blockStart + period; p += 1) {
          const execution = calls[p]!.execution;
          if (!nodeIds.includes(execution.nodeId)) {
            nodeIds.push(execution.nodeId);
            names.push(execution.name);
          }
        }
        const lapKeys: string[] = [];
        for (let p = blockStart; p < blockStart + period; p += 1) lapKeys.push(calls[p]?.key ?? '');
        const positions: number[] = [];
        for (let p = i; p <= blockEnd; p += 1) positions.push(p);
        pushIncident(
          scan,
          calls,
          {
            kind: 'cycle',
            nodeIds,
            names,
            count: matches + period,
            wasted: matches,
            period,
            laps: Math.floor((matches + period) / period),
            ...seqRange(calls, blockStart, blockEnd),
            firstIndex: calls[blockStart]!.index,
            lastIndex: calls[blockEnd]!.index,
            fingerprint: shortDigest(lapKeys.join('\u0000')),
          },
          positions,
        );
        i = blockEnd + 1;
      } else {
        i += Math.max(1, matches);
      }
    }
  }
}

/** Scan a run's executions (any kinds; only tools are analyzed) for wasted work. */
export function scanWaste(executions: readonly ExecutionSample[]): WasteScan {
  const calls: ToolCall[] = [];
  let unreadable = 0;
  for (let index = 0; index < executions.length; index += 1) {
    const execution = executions[index]!;
    if (execution.kind !== 'tool') continue;
    const key = callKey(execution.nodeId, execution.input);
    if (key === undefined) unreadable += 1;
    calls.push({ index, execution, key });
  }
  const scan: WasteScan = {
    toolCalls: calls.length,
    unreadableCalls: unreadable,
    wastedIndices: new Set(),
    incidents: [],
  };
  scanRepeats(scan, calls);
  scanErrorRepeats(scan, calls);
  scanCycles(scan, calls);
  scan.incidents.sort((a, b) => a.firstIndex - b.firstIndex);
  return scan;
}
