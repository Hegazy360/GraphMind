/**
 * `--substitute <nodeId>[#ordinal]=<json|@file>` — the counterfactual.
 *
 * "What would have happened if `convertCurrency` had returned the right
 * rate?" is the question a recording cannot answer and a debugger can. This
 * module turns that question into a tape: the recording up to the named
 * call, your value AT that call, and a cut after it.
 *
 * WHY EVERYTHING AFTER THE CUT RUNS FOR REAL. Once one call returns
 * something different, the next model step is handed a prompt that never
 * existed. The recorded reply answered the OLD prompt; serving it would
 * ignore the substitution entirely and make the whole exercise a lie. So
 * past the cut the agent genuinely runs — a provider is called, tools
 * execute, it costs tokens — and `graphmind replay` says so before it
 * starts.
 *
 * The cut is by envelope `seq`, not by "everything after this node", so
 * calls the model requested in the SAME step as the substituted one (its
 * parallel siblings, already decided before your value existed) are not
 * treated as consequences of it.
 */
import { readFileSync } from 'node:fs';
import type { Tape, TapeEntry } from '@graphmind-ai/client';

export class SubstituteError extends Error {}

export interface Substitution {
  nodeId: string;
  ordinal: number;
  value: unknown;
}

/**
 * Parse one `--substitute` argument. The value is JSON, or `@path` to read
 * JSON from a file — the same spelling `graphmind resume --output` uses, so
 * there is one way to hand GraphMind a value from a terminal.
 */
export function parseSubstitution(raw: string): Substitution {
  const eq = raw.indexOf('=');
  if (eq <= 0) {
    throw new SubstituteError(
      `--substitute needs <nodeId>[#ordinal]=<json|@file> (got "${raw}"). ` +
        'Example: --substitute \'tool:convertCurrency={"usd":2693.4}\'',
    );
  }
  const target = raw.slice(0, eq);
  const rawValue = raw.slice(eq + 1);
  const hash = target.lastIndexOf('#');
  let nodeId = target;
  let ordinal = 0;
  if (hash > 0) {
    const suffix = target.slice(hash + 1);
    const parsed = Number(suffix);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new SubstituteError(`"${suffix}" is not a call number — use e.g. ${target.slice(0, hash)}#1 for the second call`);
    }
    nodeId = target.slice(0, hash);
    ordinal = parsed;
  }
  if (nodeId === '') throw new SubstituteError(`--substitute needs a nodeId before "=" (got "${raw}")`);

  const text = rawValue.startsWith('@') ? readFile(rawValue.slice(1)) : rawValue;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new SubstituteError(
      `the value for ${nodeId} is not valid JSON (${(error as Error).message}). ` +
        'Quote it for your shell, or pass @file.json.',
    );
  }
  return { nodeId, ordinal, value };
}

function readFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new SubstituteError(`cannot read ${path} (${(error as Error).message})`);
  }
}

/** The nodes a tape could substitute, for an error message that helps. */
function replayableTargets(tape: Tape): string {
  const seen = new Map<string, number>();
  for (const entry of tape.entries) {
    if (entry.kind === 'llm') continue;
    seen.set(entry.nodeId, (seen.get(entry.nodeId) ?? 0) + 1);
  }
  if (seen.size === 0) return '(this run recorded no tool calls)';
  return [...seen.entries()].map(([nodeId, n]) => (n > 1 ? `${nodeId} (${n} calls)` : nodeId)).join(', ');
}

/**
 * Apply substitutions to a tape: replace each target's recorded output and
 * cut the tape after the EARLIEST of them (everything later is a
 * consequence of the change and must be lived, not replayed).
 *
 * Returns a new tape; the input is not modified.
 */
export function applySubstitutions(tape: Tape, substitutions: readonly Substitution[]): Tape {
  if (substitutions.length === 0) return tape;
  const entries: TapeEntry[] = tape.entries.map((entry) => ({ ...entry }));
  const applied: { nodeId: string; ordinal: number }[] = [];
  let cutSeq: number | undefined;

  for (const substitution of substitutions) {
    const entry = entries.find(
      (candidate) => candidate.nodeId === substitution.nodeId && candidate.ordinal === substitution.ordinal,
    );
    if (entry === undefined) {
      const which = substitution.ordinal === 0 ? '' : ` call #${substitution.ordinal + 1} of`;
      throw new SubstituteError(
        `this run has no${which} "${substitution.nodeId}". It recorded: ${replayableTargets(tape)}`,
      );
    }
    if (entry.kind === 'llm') {
      throw new SubstituteError(
        `"${substitution.nodeId}" is a model step, not a call you can answer. Substitute a TOOL's ` +
          'result and let the model react to it — that is the counterfactual worth running.',
      );
    }
    entry.output = substitution.value;
    entry.status = 'ok';
    delete entry.error;
    delete entry.lossy; // your value is not the recorder's truncated one
    applied.push({ nodeId: entry.nodeId, ordinal: entry.ordinal });
    if (entry.seq !== undefined && (cutSeq === undefined || entry.seq < cutSeq)) cutSeq = entry.seq;
  }

  return {
    ...tape,
    entries,
    substituted: applied,
    ...(cutSeq !== undefined ? { cutSeq } : {}),
  };
}
