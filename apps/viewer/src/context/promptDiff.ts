/**
 * What changed between two LLM steps' prompts, message by message.
 *
 * Messages are compared by identity (hash of their canonical JSON — see
 * canonical.ts), with a Myers shortest edit script over the two lists after
 * trimming the common prefix and suffix. Agent loops mostly append, so the
 * middle that Myers actually walks is tiny; a hard budget turns a
 * pathological pair (two unrelated 2,000-message histories) into an honest
 * "everything in between changed" instead of a frozen inspector.
 *
 * A run of deletions and insertions of EQUAL length, role by role, reads as
 * "changed" (the retry that swapped one tool result); anything else stays
 * "removed" + "added" (a compaction that folded six messages into one).
 */
import { canonicalJson } from './canonical.js';
import type { NormMessage, NormPrompt, NormTools } from './normalizePrompt.js';

export interface EditOp {
  type: 'same' | 'del' | 'ins';
  /** Index in `a` (same / del). */
  a: number;
  /** Index in `b` (same / ins). */
  b: number;
}

/** Most (2d+3)-sized snapshots Myers may keep before giving up (~16 MB of Int32). */
const DEFAULT_BUDGET = 4_000_000;

/**
 * Shortest edit script from `a` to `b`. `approximate` is set when the budget
 * ran out and the untrimmed middle was reported as all-deleted/all-inserted.
 */
export function diffSequences<T>(
  a: readonly T[],
  b: readonly T[],
  eq: (x: T, y: T) => boolean = (x, y) => x === y,
  budget = DEFAULT_BUDGET,
): { ops: EditOp[]; approximate: boolean } {
  const n = a.length;
  const m = b.length;
  let pre = 0;
  while (pre < n && pre < m && eq(a[pre] as T, b[pre] as T)) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && eq(a[n - 1 - suf] as T, b[m - 1 - suf] as T)) suf++;

  const head: EditOp[] = [];
  for (let i = 0; i < pre; i++) head.push({ type: 'same', a: i, b: i });
  const tail: EditOp[] = [];
  for (let i = 0; i < suf; i++) tail.push({ type: 'same', a: n - suf + i, b: m - suf + i });

  const an = n - pre - suf;
  const bm = m - pre - suf;
  const middle: EditOp[] = [];
  let approximate = false;
  if (an === 0 || bm === 0) {
    for (let i = 0; i < an; i++) middle.push({ type: 'del', a: pre + i, b: pre });
    for (let j = 0; j < bm; j++) middle.push({ type: 'ins', a: pre + an, b: pre + j });
  } else {
    const result = myers(an, bm, (x, y) => eq(a[pre + x] as T, b[pre + y] as T), budget);
    if (result === undefined) {
      approximate = true;
      for (let i = 0; i < an; i++) middle.push({ type: 'del', a: pre + i, b: pre });
      for (let j = 0; j < bm; j++) middle.push({ type: 'ins', a: pre + an, b: pre + j });
    } else {
      for (const op of result) middle.push({ type: op.type, a: pre + op.a, b: pre + op.b });
    }
  }
  return { ops: [...head, ...middle, ...tail], approximate };
}

function myers(n: number, m: number, eq: (x: number, y: number) => boolean, budget: number): EditOp[] | undefined {
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let spent = 0;
  let found = -1;
  outer: for (let d = 0; d <= max; d++) {
    spent += 2 * d + 3;
    if (spent > budget) return undefined;
    // v before round d, diagonals [-d-1, d+1].
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))) {
        x = v[offset + k + 1] as number;
      } else {
        x = (v[offset + k - 1] as number) + 1;
      }
      let y = x - k;
      while (x < n && y < m && eq(x, y)) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }
  if (found < 0) return undefined;

  const ops: EditOp[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const snap = trace[d] as Int32Array;
    const at = (k: number): number => snap[k + d + 1] as number;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: 'same', a: x - 1, b: y - 1 });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ type: 'ins', a: x, b: y - 1 });
      else ops.push({ type: 'del', a: x - 1, b: y });
    }
    x = prevX;
    y = prevY;
  }
  ops.reverse();
  return ops;
}

// ── prompt diff ───────────────────────────────────────────────────────────

export type RowType = 'same' | 'removed' | 'added' | 'changed';

export interface MessageRow {
  type: RowType;
  prev?: NormMessage;
  cur?: NormMessage;
  prevIndex?: number;
  curIndex?: number;
}

export interface Hunk {
  type: RowType;
  rows: MessageRow[];
}

export interface LineOp {
  type: 'same' | 'del' | 'ins';
  text: string;
}

export type SystemDiff =
  | { status: 'none' | 'same' | 'added' | 'removed' }
  | { status: 'changed'; lines: LineOp[]; approximate: boolean };

export type ToolsDiff =
  | { status: 'one-side'; side: 'prev' | 'cur' }
  | {
      status: 'compared';
      basis: 'hash' | 'names';
      added: string[];
      removed: string[];
      changed: string[];
      /** Per changed tool: its schema hash before and after (look them up in `toolSchemas`). */
      changedHashes: { name: string; before: string; after: string }[];
      same: number;
    };

/** One request parameter (or the model) that differs; `undefined` = not sent on that side. */
export interface ParamChange {
  key: string;
  before?: unknown;
  after?: unknown;
}

/**
 * Where a provider's prompt cache stops matching: caches are prefix-based
 * over tools → system → messages (and never carry across models), so the
 * first changed part is where this step starts paying full input price.
 */
export type PrefixBreak =
  | { at: 'model' }
  | { at: 'tools' }
  | { at: 'system' }
  | { at: 'message'; index: number };

export interface PromptDiff {
  identical: boolean;
  /** The previous step's messages are an unchanged prefix of this step's. */
  appendOnly: boolean;
  /** 0-based position of the first difference, in each list. */
  firstDivergence?: { cur: number; prev: number };
  counts: Record<RowType, number>;
  hunks: Hunk[];
  approximate: boolean;
  system: SystemDiff;
  tools?: ToolsDiff;
  /** Sampling parameters and model that changed, by key. */
  params: ParamChange[];
  /** Absent when the previous prompt is an unchanged prefix of this one. */
  prefixBreak?: PrefixBreak;
  prevLength: number;
  curLength: number;
}

export function diffLines(prev: string, cur: string): { lines: LineOp[]; approximate: boolean } {
  const a = prev.split('\n');
  const b = cur.split('\n');
  const { ops, approximate } = diffSequences(a, b, undefined, 1_000_000);
  return {
    lines: ops.map((op) => ({
      type: op.type,
      text: (op.type === 'ins' ? b[op.b] : a[op.a]) ?? '',
    })),
    approximate,
  };
}

function diffSystem(prev: string | undefined, cur: string | undefined): SystemDiff {
  if (prev === undefined && cur === undefined) return { status: 'none' };
  if (prev === undefined) return { status: 'added' };
  if (cur === undefined) return { status: 'removed' };
  if (prev === cur) return { status: 'same' };
  const { lines, approximate } = diffLines(prev, cur);
  return { status: 'changed', lines, approximate };
}

export function diffTools(prev: NormTools | undefined, cur: NormTools | undefined): ToolsDiff | undefined {
  if (prev === undefined && cur === undefined) return undefined;
  if (prev === undefined) return { status: 'one-side', side: 'cur' };
  if (cur === undefined) return { status: 'one-side', side: 'prev' };
  const basis = prev.basis === 'hash' && cur.basis === 'hash' ? 'hash' : 'names';
  const before = new Map(prev.list.map((t) => [t.name, t.hash]));
  const after = new Map(cur.list.map((t) => [t.name, t.hash]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const changedHashes: { name: string; before: string; after: string }[] = [];
  let same = 0;
  for (const [name, hash] of after) {
    const old = before.get(name);
    if (!before.has(name)) added.push(name);
    else if (basis === 'hash' && old !== hash) {
      changed.push(name);
      if (old !== undefined && hash !== undefined) changedHashes.push({ name, before: old, after: hash });
    } else same++;
  }
  for (const name of before.keys()) if (!after.has(name)) removed.push(name);
  return { status: 'compared', basis, added, removed, changed, changedHashes, same };
}

/** Parameters (and the model) that differ between two requests, in a stable order. */
export function diffParams(prev: NormPrompt, cur: NormPrompt): ParamChange[] {
  const out: ParamChange[] = [];
  if (prev.model !== cur.model && (prev.model !== undefined || cur.model !== undefined)) {
    out.push({
      key: 'model',
      ...(prev.model !== undefined ? { before: prev.model } : {}),
      ...(cur.model !== undefined ? { after: cur.model } : {}),
    });
  }
  const keys = [...new Set([...Object.keys(prev.params), ...Object.keys(cur.params)])].sort();
  for (const key of keys) {
    const before = prev.params[key];
    const after = cur.params[key];
    if (before !== undefined && after !== undefined && canonicalJson(before) === canonicalJson(after)) continue;
    out.push({ key, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) });
  }
  return out;
}

export function diffPrompts(prev: NormPrompt, cur: NormPrompt): PromptDiff {
  const a = prev.messages;
  const b = cur.messages;
  const { ops, approximate } = diffSequences(a, b, (x, y) => x.key === y.key);

  const rows: MessageRow[] = [];
  let pendingDel: EditOp[] = [];
  let pendingIns: EditOp[] = [];
  const flush = (): void => {
    const pair =
      pendingDel.length > 0 &&
      pendingDel.length === pendingIns.length &&
      pendingDel.every((d, i) => a[d.a]?.role === b[pendingIns[i]?.b ?? -1]?.role);
    if (pair) {
      pendingDel.forEach((d, i) => {
        const ins = pendingIns[i] as EditOp;
        rows.push({ type: 'changed', prev: a[d.a] as NormMessage, cur: b[ins.b] as NormMessage, prevIndex: d.a, curIndex: ins.b });
      });
    } else {
      for (const d of pendingDel) rows.push({ type: 'removed', prev: a[d.a] as NormMessage, prevIndex: d.a });
      for (const ins of pendingIns) rows.push({ type: 'added', cur: b[ins.b] as NormMessage, curIndex: ins.b });
    }
    pendingDel = [];
    pendingIns = [];
  };
  let firstDivergence: PromptDiff['firstDivergence'];
  for (const op of ops) {
    if (op.type === 'same') {
      flush();
      rows.push({ type: 'same', prev: a[op.a] as NormMessage, cur: b[op.b] as NormMessage, prevIndex: op.a, curIndex: op.b });
      continue;
    }
    firstDivergence ??= { cur: op.b, prev: op.a };
    if (op.type === 'del') pendingDel.push(op);
    else pendingIns.push(op);
  }
  flush();

  const hunks: Hunk[] = [];
  const counts: Record<RowType, number> = { same: 0, removed: 0, added: 0, changed: 0 };
  for (const row of rows) {
    counts[row.type]++;
    const last = hunks[hunks.length - 1];
    if (last !== undefined && last.type === row.type) last.rows.push(row);
    else hunks.push({ type: row.type, rows: [row] });
  }

  const system = diffSystem(prev.system, cur.system);
  const tools = diffTools(prev.tools, cur.tools);
  const toolsSame =
    tools === undefined ||
    (tools.status === 'compared' && tools.added.length + tools.removed.length + tools.changed.length === 0);
  const messagesSame = counts.added + counts.removed + counts.changed === 0;
  const systemSame = system.status === 'same' || system.status === 'none';
  const lastHunk = hunks[hunks.length - 1];
  const appendOnly =
    systemSame &&
    counts.removed === 0 &&
    counts.changed === 0 &&
    counts.added > 0 &&
    lastHunk?.type === 'added' &&
    hunks.filter((h) => h.type === 'added').length === 1;

  const params = diffParams(prev, cur);
  const modelChanged = params.some((p) => p.key === 'model' && p.before !== undefined && p.after !== undefined);
  const toolsChanged =
    tools?.status === 'compared' && tools.added.length + tools.removed.length + tools.changed.length > 0;
  let prefixBreak: PrefixBreak | undefined;
  if (modelChanged) prefixBreak = { at: 'model' };
  else if (toolsChanged) prefixBreak = { at: 'tools' };
  else if (!systemSame) prefixBreak = { at: 'system' };
  else if (!appendOnly && firstDivergence !== undefined && firstDivergence.prev < a.length) {
    prefixBreak = { at: 'message', index: firstDivergence.cur };
  }

  return {
    identical: messagesSame && systemSame && toolsSame && params.length === 0,
    appendOnly,
    ...(firstDivergence !== undefined ? { firstDivergence } : {}),
    counts,
    hunks,
    approximate,
    system,
    ...(tools !== undefined ? { tools } : {}),
    params,
    ...(prefixBreak !== undefined ? { prefixBreak } : {}),
    prevLength: a.length,
    curLength: b.length,
  };
}
