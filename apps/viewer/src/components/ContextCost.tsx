/**
 * Context & cost — the inspector section on an LLM step (contract C5).
 *
 *  1. Usage header, by the same rules as every usage display (lib/usage.ts,
 *     contract C1): input (the inclusive total, or "as reported" for senders
 *     that predate 0.6), output, cache read / write and reasoning when
 *     reported, how full the model's context window was, and the step's and
 *     run's cost from the bundled genai-prices snapshot — "≈ est. (prices as
 *     of DATE)", and no dollar figure at all when the model is not in it.
 *  2. A note when more than five minutes passed since the previous step:
 *     the provider's prompt cache has likely expired, and when gate holds
 *     account for the gap, the note says the debugger did it.
 *  3. The prompt diff against the previous LLM step of the same agent — the
 *     first divergent message, what was added, removed or changed, the
 *     system prompt line diff, tool changes by schema hash (a changed tool
 *     opens as a diff of its recorded definitions), changed sampling params
 *     and model, and where a provider prompt cache stops matching — or a
 *     plain refusal when either side is not the real prompt (shrunk,
 *     redacted, a preview).
 *
 * Big prompts: the diff runs after first paint (a "Comparing…" line in the
 * meantime) and is memoized per pair of inputs; unchanged runs are folded;
 * message bodies and line diffs render only when opened, capped with a
 * "show all" control. The price table is a lazy chunk, requested only once a
 * step with usage is shown; where it cannot load (a single-file export
 * opened from disk) the view says so and shows no dollar figure — the diff
 * is in the main bundle, so it works there too.
 */
import { useEffect, useMemo, useReducer, useState } from 'react';
import { fmtCost, fmtTokens } from '../lib/format.js';
import { priceExecution, sumCosts, type CostTotal, type StepCost } from '../context/cost.js';
import { computeDiffOutcome, peekDiffOutcome, type DiffOutcome } from '../context/diffOutcome.js';
import { readableMessage, type NormMessage } from '../context/normalizePrompt.js';
import { diffLines, type Hunk, type LineOp, type MessageRow, type PromptDiff } from '../context/promptDiff.js';
import { cacheGapNote, previousLlmStep, stepsSoFar, toolSchemaOf, type StepRef } from '../context/steps.js';
import { usePriceTable } from '../prices/loader.js';
import { EST_LABEL, PRICE_SNAPSHOT } from '../prices/snapshot.js';
import { detailCells, inputLabel, inputTitle, usageView, type UsageView } from '../lib/usage.js';
import { costTotalTitle } from './costHooks.js';
import { useRunStore } from '../store/runStore.js';
import type { NodeExecution, NodeState } from '../store/types.js';
import { useUiStore } from '../store/uiStore.js';
import './ContextCost.css';

const ROWS_INITIAL = 60;
const LABELS_INITIAL = 100;
const TEXT_CAP = 4_000;
const LINES_CAP = 300;

function fmtSize(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(chars < 10 * 1024 ? 1 : 0)} KB`;
  return `${(chars / (1024 * 1024)).toFixed(1)} MB`;
}

function Cell({ label, value, tone, title }: { label: string; value: string; tone?: 'dim' | 'money'; title?: string }) {
  return (
    <div className={`gm-inspect-stat${tone === 'dim' ? ' gm-inspect-stat--dim' : ''}${tone === 'money' ? ' gm-ctx-money' : ''}`} title={title}>
      <span className="gm-inspect-stat-value">{value}</span>
      <span className="gm-inspect-stat-label">{label}</span>
    </div>
  );
}

// ── usage + cost ──────────────────────────────────────────────────────────

/**
 * The step's usage, labelled by the same rules as every usage display
 * (lib/usage.ts, contract C1), then its cost, the run's cost so far and — for
 * a known model with a context window — how full the window was.
 */
function UsageCells({
  usage,
  step,
  run,
}: {
  usage: UsageView;
  step: StepCost | undefined;
  run: CostTotal | undefined;
}) {
  const uncached =
    usage.basis !== 'reported' && (usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined)
      ? Math.max(0, usage.inputTokens - (usage.cacheReadTokens ?? 0) - (usage.cacheWriteTokens ?? 0))
      : undefined;
  const ctxWindow = step?.status === 'priced' ? step.resolved.model.context_window : undefined;
  const filled =
    ctxWindow !== undefined && ctxWindow > 0 && usage.basis !== 'reported' ? usage.inputTokens / ctxWindow : undefined;
  return (
    <div className="gm-inspect-stats">
      <Cell
        label={inputLabel(usage.basis)}
        value={fmtTokens(usage.inputTokens)}
        title={[
          usage.inputTokens.toLocaleString(),
          inputTitle(usage.basis),
          ...(uncached !== undefined ? [`${uncached.toLocaleString()} uncached.`] : []),
        ].join(' — ')}
      />
      <Cell label="tokens out" value={fmtTokens(usage.outputTokens)} title={usage.outputTokens.toLocaleString()} />
      {detailCells(usage).map((cell) => (
        <Cell key={cell.label} label={cell.label} value={cell.value} tone="dim" {...(cell.title !== undefined ? { title: cell.title } : {})} />
      ))}
      {filled !== undefined && ctxWindow !== undefined && (
        <Cell
          label="of context"
          value={`${Math.min(100, Math.round(filled * 100))}%`}
          tone="dim"
          title={`${usage.inputTokens.toLocaleString()} of the model's ${ctxWindow.toLocaleString()}-token context window (from the price snapshot).`}
        />
      )}
      {step?.status === 'priced' && (
        <Cell label="this step" value={fmtCost(step.cost.total)} tone="money" title={costTitle(step)} />
      )}
      {step?.status === 'priced' && run !== undefined && run.priced > 0 && (
        <Cell
          label="run so far"
          value={fmtCost(run.total)}
          tone="money"
          title={`Up to this step: ${costTotalTitle(run, 'LLM step')}`}
        />
      )}
    </div>
  );
}

function costTitle(step: Extract<StepCost, { status: 'priced' }>): string {
  const c = step.cost;
  const parts = [
    `input ${fmtCost(c.input)}`,
    ...(c.cacheRead > 0 ? [`cache read ${fmtCost(c.cacheRead)}`] : []),
    ...(c.cacheWrite > 0 ? [`cache write ${fmtCost(c.cacheWrite)}`] : []),
    `output ${fmtCost(c.output)}`,
    ...(c.requests > 0 ? [`request ${fmtCost(c.requests)}`] : []),
  ];
  return `${parts.join(' + ')} — ${step.resolved.provider.name} ${step.resolved.model.id}, ${EST_LABEL}`;
}

function PriceNote({ step, loading, failed }: { step: StepCost | undefined; loading: boolean; failed: boolean }) {
  if (failed) {
    return <div className="gm-ctx-note" data-testid="price-note">Prices unavailable here (the price table did not load) — no cost shown.</div>;
  }
  if (loading || step === undefined) {
    return <div className="gm-ctx-note gm-ctx-note--faint" data-testid="price-note">Loading prices…</div>;
  }
  if (step.status === 'priced') {
    return (
      <div className="gm-ctx-note gm-ctx-note--faint" data-testid="price-note">
        Priced as {step.resolved.provider.name} <code>{step.resolved.model.id}</code>
        {step.usage.basis === 'reported'
          ? ' · recorded before GraphMind 0.6, so the input count may leave out cached tokens and this estimate can be low'
          : ''}
        {step.cost.clamped ? ' · the reported cache counts exceed the input total; clamped' : ''}
      </div>
    );
  }
  if (step.status === 'unknown-model') {
    return (
      <div className="gm-ctx-note" data-testid="price-note">
        {step.hints.model !== undefined ? (
          <>
            No price for <code>{step.hints.model}</code> in the price snapshot ({PRICE_SNAPSHOT.date}) — cost not shown.
          </>
        ) : (
          <>No model recorded for this step — cost not shown.</>
        )}
      </div>
    );
  }
  return null;
}

// ── diff rendering ────────────────────────────────────────────────────────

function LineDiff({ lines, approximate }: { lines: LineOp[]; approximate: boolean }) {
  const [all, setAll] = useState(false);
  // Fold long unchanged runs to 2 lines of context either side.
  const view = useMemo(() => {
    const out: (LineOp | { type: 'fold'; count: number })[] = [];
    let i = 0;
    while (i < lines.length) {
      if (lines[i]?.type !== 'same') {
        out.push(lines[i] as LineOp);
        i++;
        continue;
      }
      let j = i;
      while (j < lines.length && lines[j]?.type === 'same') j++;
      const run = j - i;
      const lead = i === 0 ? 0 : 2;
      const trail = j === lines.length ? 0 : 2;
      if (run > lead + trail + 1) {
        for (let k = i; k < i + lead; k++) out.push(lines[k] as LineOp);
        out.push({ type: 'fold', count: run - lead - trail });
        for (let k = j - trail; k < j; k++) out.push(lines[k] as LineOp);
      } else {
        for (let k = i; k < j; k++) out.push(lines[k] as LineOp);
      }
      i = j;
    }
    return out;
  }, [lines]);
  const shown = all ? view : view.slice(0, LINES_CAP);
  return (
    <div className="gm-ctx-linediff nowheel" data-testid="line-diff">
      {approximate && <div className="gm-ctx-line gm-ctx-line--fold">(too many differences to align — shown as removed then added)</div>}
      {shown.map((line, i) =>
        line.type === 'fold' ? (
          <div key={i} className="gm-ctx-line gm-ctx-line--fold">
            … {line.count} unchanged line{line.count === 1 ? '' : 's'}
          </div>
        ) : (
          <div key={i} className={`gm-ctx-line gm-ctx-line--${line.type}`}>
            <span className="gm-ctx-line-mark">{line.type === 'del' ? '−' : line.type === 'ins' ? '+' : ' '}</span>
            {line.text === '' ? ' ' : line.text}
          </div>
        ),
      )}
      {!all && view.length > LINES_CAP && (
        <button className="gm-ctx-more" onClick={() => setAll(true)}>
          show all {view.length} lines
        </button>
      )}
    </div>
  );
}

function MessageBody({ message }: { message: NormMessage }) {
  const text = useMemo(() => readableMessage(message.raw), [message]);
  const [all, setAll] = useState(false);
  const capped = !all && text.length > TEXT_CAP;
  return (
    <>
      <pre className="gm-stream gm-ctx-body nowheel">{capped ? `${text.slice(0, TEXT_CAP)}…` : text}</pre>
      {capped && (
        <button className="gm-ctx-more" onClick={() => setAll(true)}>
          show all ({fmtSize(text.length)})
        </button>
      )}
    </>
  );
}

function ChangedBody({ row }: { row: MessageRow }) {
  const diff = useMemo(
    () => diffLines(row.prev === undefined ? '' : readableMessage(row.prev.raw), row.cur === undefined ? '' : readableMessage(row.cur.raw)),
    [row],
  );
  return <LineDiff lines={diff.lines} approximate={diff.approximate} />;
}

const MARK: Record<MessageRow['type'], string> = { same: '=', added: '+', removed: '−', changed: '~' };

function RowItem({ row }: { row: MessageRow }) {
  const [open, setOpen] = useState(false);
  const message = row.cur ?? row.prev;
  if (message === undefined) return null;
  const index = row.type === 'removed' ? row.prevIndex : row.curIndex;
  return (
    <li className={`gm-ctx-row gm-ctx-row--${row.type}`} data-testid={`diff-row-${row.type}`}>
      <button className="gm-ctx-row-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="gm-ctx-row-mark">{MARK[row.type]}</span>
        <span className="gm-ctx-row-index">#{(index ?? 0) + 1}</span>
        <span className="gm-ctx-row-label">{message.label}</span>
        <span className="gm-ctx-row-size">{fmtSize(message.size)}</span>
      </button>
      {open && (row.type === 'changed' ? <ChangedBody row={row} /> : <MessageBody message={message} />)}
    </li>
  );
}

function SameHunk({ hunk }: { hunk: Hunk }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const count = hunk.rows.length;
  const rows = all ? hunk.rows : hunk.rows.slice(0, LABELS_INITIAL);
  return (
    <li className="gm-ctx-row gm-ctx-row--same" data-testid="diff-same">
      <button className="gm-ctx-row-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="gm-ctx-row-mark">=</span>
        <span className="gm-ctx-row-label">
          {count} unchanged message{count === 1 ? '' : 's'}
        </span>
      </button>
      {open && (
        <ol className="gm-ctx-rows gm-ctx-rows--nested">
          {rows.map((row) => (
            <RowItem key={`s${row.curIndex}`} row={row} />
          ))}
          {!all && count > LABELS_INITIAL && (
            <li>
              <button className="gm-ctx-more" onClick={() => setAll(true)}>
                show all {count}
              </button>
            </li>
          )}
        </ol>
      )}
    </li>
  );
}

function Hunks({ diff }: { diff: PromptDiff }) {
  const [limit, setLimit] = useState(ROWS_INITIAL);
  let budget = limit;
  let hidden = 0;
  const items: React.ReactNode[] = [];
  diff.hunks.forEach((hunk, h) => {
    if (hunk.type === 'same') {
      items.push(<SameHunk key={`h${h}`} hunk={hunk} />);
      return;
    }
    for (const [r, row] of hunk.rows.entries()) {
      if (budget <= 0) {
        hidden++;
        continue;
      }
      budget--;
      items.push(<RowItem key={`h${h}r${r}`} row={row} />);
    }
  });
  return (
    <ol className="gm-ctx-rows">
      {items}
      {hidden > 0 && (
        <li>
          <button className="gm-ctx-more" onClick={() => setLimit((l) => l + 200)}>
            show {Math.min(hidden, 200)} more of {hidden}
          </button>
        </li>
      )}
    </ol>
  );
}

function SystemChange({ diff }: { diff: PromptDiff }) {
  const [open, setOpen] = useState(false);
  const sys = diff.system;
  if (sys.status === 'none' || sys.status === 'same') return null;
  const text =
    sys.status === 'added'
      ? 'system prompt added'
      : sys.status === 'removed'
        ? 'system prompt removed'
        : 'system prompt changed';
  return (
    <div className="gm-ctx-row gm-ctx-row--changed" data-testid="system-change">
      <button
        className="gm-ctx-row-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        disabled={sys.status !== 'changed'}
      >
        <span className="gm-ctx-row-mark">~</span>
        <span className="gm-ctx-row-label">{text}</span>
        {sys.status === 'changed' && (
          <span className="gm-ctx-row-size">
            −{sys.lines.filter((l) => l.type === 'del').length} +{sys.lines.filter((l) => l.type === 'ins').length} lines
          </span>
        )}
      </button>
      {open && sys.status === 'changed' && <LineDiff lines={sys.lines} approximate={sys.approximate} />}
    </div>
  );
}

/** A changed tool's two recorded definitions, as a line diff (looked up on open). */
function SchemaDiff({ runId, before, after }: { runId: string; before: string; after: string }) {
  const diff = useMemo(() => {
    const run = useRunStore.getState().runs[runId];
    if (run === undefined) return undefined;
    const a = toolSchemaOf(run, before);
    const b = toolSchemaOf(run, after);
    if (a === undefined || b === undefined) return undefined;
    return diffLines(JSON.stringify(a, null, 2) ?? '', JSON.stringify(b, null, 2) ?? '');
  }, [runId, before, after]);
  if (diff === undefined) {
    return (
      <div className="gm-ctx-note gm-ctx-note--faint">
        Only the schema hashes are in this recording ({before} → {after}); the definitions travel once per run, on the
        first step that used them.
      </div>
    );
  }
  return <LineDiff lines={diff.lines} approximate={diff.approximate} />;
}

function ToolsChange({ runId, diff }: { runId: string; diff: PromptDiff }) {
  const [open, setOpen] = useState<string | undefined>(undefined);
  const tools = diff.tools;
  if (tools === undefined) return null;
  if (tools.status === 'one-side') {
    return (
      <div className="gm-ctx-note gm-ctx-note--faint" data-testid="tools-change">
        Tool list recorded on {tools.side === 'cur' ? 'this step' : 'the previous step'} only — not compared.
      </div>
    );
  }
  const { added, removed, changedHashes } = tools;
  if (added.length + removed.length + tools.changed.length === 0) {
    return (
      <div className="gm-ctx-note gm-ctx-note--faint" data-testid="tools-change">
        Tools unchanged ({tools.same}){tools.basis === 'names' ? ' — names only, schemas not recorded' : ''}.
      </div>
    );
  }
  const opened = changedHashes.find((c) => c.name === open);
  return (
    <>
      <div className="gm-ctx-tools" data-testid="tools-change">
        <span className="gm-ctx-tools-label">tools</span>
        {added.map((name) => (
          <span key={`+${name}`} className="gm-chip gm-chip--tiny gm-ctx-chip--added">+ {name}</span>
        ))}
        {removed.map((name) => (
          <span key={`-${name}`} className="gm-chip gm-chip--tiny gm-ctx-chip--removed">− {name}</span>
        ))}
        {changedHashes.map((c) => (
          <button
            key={`~${c.name}`}
            className="gm-chip gm-chip--tiny gm-chip--button gm-ctx-chip--changed"
            title="Same name, different schema — show the definition diff"
            aria-expanded={open === c.name}
            onClick={() => setOpen((o) => (o === c.name ? undefined : c.name))}
          >
            ~ {c.name} schema
          </button>
        ))}
        {tools.basis === 'names' && <span className="gm-ctx-note--faint"> (names only — schemas not recorded)</span>}
      </div>
      {opened !== undefined && <SchemaDiff runId={runId} before={opened.before} after={opened.after} />}
    </>
  );
}

function paramValue(value: unknown): string {
  if (value === undefined) return '(not sent)';
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** Sampling parameters (and the model) that changed since the previous step. */
function ParamsChange({ diff }: { diff: PromptDiff }) {
  if (diff.params.length === 0) return null;
  return (
    <div className="gm-ctx-tools" data-testid="params-change">
      <span className="gm-ctx-tools-label">params</span>
      {diff.params.map((p) => (
        <span
          key={p.key}
          className="gm-chip gm-chip--tiny gm-ctx-chip--changed"
          title={`${p.key}: ${paramValue(p.before)} → ${paramValue(p.after)}`}
        >
          {p.key} {paramValue(p.before)} → {paramValue(p.after)}
        </span>
      ))}
    </div>
  );
}

function prefixText(diff: PromptDiff): string | undefined {
  const at = diff.prefixBreak;
  if (at === undefined) return undefined;
  switch (at.at) {
    case 'model':
      return 'Different model — nothing of the previous prompt is cached for it.';
    case 'tools':
      return 'The tool list changed — a provider prompt cache (tools → system → messages) misses from the start.';
    case 'system':
      return 'The system prompt changed — a provider prompt cache misses from the system prompt on.';
    case 'message':
      return `The history changed at message #${at.index + 1} — a provider prompt cache misses from there on.`;
    default:
      return undefined;
  }
}

function DiffSummary({ diff }: { diff: PromptDiff }) {
  const { counts } = diff;
  if (diff.identical) {
    return (
      <div className="gm-ctx-note" data-testid="diff-identical">
        Same prompt as the previous step ({diff.curLength} message{diff.curLength === 1 ? '' : 's'}).
      </div>
    );
  }
  const first = diff.firstDivergence;
  const prefix = prefixText(diff);
  return (
    <>
      <div className="gm-ctx-summary" data-testid="diff-summary">
        {first !== undefined && (
          <span className="gm-ctx-summary-lead" title="Messages are numbered from 1; the system prompt is compared separately">
            {first.cur >= diff.curLength
              ? `messages end after #${diff.curLength}`
              : `first difference at message #${first.cur + 1} of ${diff.curLength}`}
          </span>
        )}
        {first === undefined && <span className="gm-ctx-summary-lead">messages unchanged ({diff.curLength})</span>}
        {counts.added > 0 && <span className="gm-chip gm-chip--tiny gm-ctx-chip--added">+{counts.added} added</span>}
        {counts.removed > 0 && <span className="gm-chip gm-chip--tiny gm-ctx-chip--removed">−{counts.removed} removed</span>}
        {counts.changed > 0 && <span className="gm-chip gm-chip--tiny gm-ctx-chip--changed">~{counts.changed} changed</span>}
      </div>
      {prefix !== undefined && (
        <div className="gm-ctx-note gm-ctx-note--faint" data-testid="prefix-break">
          {prefix}
        </div>
      )}
      {counts.removed > 0 && (
        <div className="gm-ctx-note gm-ctx-note--warn" data-testid="diff-trimmed">
          {counts.removed} message{counts.removed === 1 ? '' : 's'} removed since the previous step — trimmed?
        </div>
      )}
      {diff.approximate && (
        <div className="gm-ctx-note gm-ctx-note--faint">Too many differences to align exactly — the middle is shown as removed, then added.</div>
      )}
    </>
  );
}

/** Runs the diff after first paint unless it is already memoized. */
function useDiffOutcome(prevInput: unknown, curInput: unknown, hasPrev: boolean): DiffOutcome | 'pending' {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const ready = hasPrev ? peekDiffOutcome(prevInput, curInput) : { status: 'first' as const };
  const cheap = hasPrev && ready === undefined && (typeof prevInput !== 'object' || typeof curInput !== 'object' || prevInput === null || curInput === null);
  useEffect(() => {
    if (ready !== undefined || cheap || !hasPrev) return;
    const id = setTimeout(() => {
      computeDiffOutcome(prevInput, curInput);
      bump();
    }, 0);
    return () => clearTimeout(id);
  }, [prevInput, curInput, hasPrev, ready, cheap]);
  if (ready !== undefined) return ready;
  if (cheap) return computeDiffOutcome(prevInput, curInput);
  return 'pending';
}

function PromptDiffView({ runId, prev, exec }: { runId: string; prev: StepRef | undefined; exec: NodeExecution }) {
  const outcome = useDiffOutcome(prev?.exec.input, exec.input, prev !== undefined);
  const jump = (): void => {
    if (prev === undefined) return;
    const ui = useUiStore.getState();
    ui.selectNode(runId, prev.nodeId);
    ui.setInstanceIdx(prev.index);
  };
  return (
    <div className="gm-ctx-diff" data-testid="prompt-diff">
      <div className="gm-why-label gm-ctx-diff-label">
        Prompt vs previous step
        {prev !== undefined && (
          <button className="gm-copy" onClick={jump} title="Open the previous step">
            {prev.node.name} #{prev.index + 1}
          </button>
        )}
      </div>
      {outcome === 'pending' ? (
        <div className="gm-ctx-note gm-ctx-note--faint">Comparing…</div>
      ) : outcome.status === 'first' ? (
        <div className="gm-ctx-note gm-ctx-note--faint" data-testid="diff-first">
          First LLM step of this agent in the run — nothing to compare yet.
        </div>
      ) : outcome.status === 'refused' ? (
        <div className="gm-ctx-note gm-ctx-refusal" data-testid="diff-refused">
          Can't compare: {outcome.text}
        </div>
      ) : (
        <>
          <DiffSummary diff={outcome.diff} />
          <SystemChange diff={outcome.diff} />
          <ToolsChange runId={runId} diff={outcome.diff} />
          <ParamsChange diff={outcome.diff} />
          {!outcome.diff.identical && <Hunks diff={outcome.diff} />}
        </>
      )}
    </div>
  );
}

// ── the section ───────────────────────────────────────────────────────────

export function ContextCost({
  runId,
  node,
  exec,
  execIndex,
}: {
  runId: string;
  node: NodeState;
  exec: NodeExecution;
  execIndex: number;
}) {
  const statusVersion = useRunStore((s) => s.runs[runId]?.statusVersion ?? 0);
  const usage = useMemo(() => usageView(exec.usage), [exec.usage]);
  // The price table is a lazy chunk: only a step with usage has anything to price.
  const prices = usePriceTable(usage !== undefined);

  const derived = useMemo(() => {
    const run = useRunStore.getState().runs[runId];
    if (run === undefined) return { prev: undefined, gap: undefined, runCost: undefined };
    const prev = previousLlmStep(run, node.nodeId, execIndex);
    const gap = prev === undefined ? undefined : cacheGapNote(run, prev, { nodeId: node.nodeId, exec }, Date.now());
    const runCost =
      prices.status === 'ready' ? sumCosts(prices.table, stepsSoFar(run, exec).map((s) => s.exec)) : undefined;
    return { prev, gap, runCost };
    // statusVersion: pauses, finishes and new steps all bump it.
  }, [runId, node.nodeId, execIndex, exec, prices, statusVersion]);

  const step = prices.status === 'ready' ? priceExecution(prices.table, exec) : undefined;

  return (
    <section className="gm-inspect-section gm-ctx" aria-label="Context and cost" data-testid="context-cost">
      <div className="gm-inspect-section-head">
        <span className="gm-section-label">Context &amp; cost</span>
        {step?.status === 'priced' && (
          <span className="gm-ctx-est" title={`genai-prices snapshot ${PRICE_SNAPSHOT.upstreamCommit} (MIT). Token counts come from the run; prices do not.`}>
            {EST_LABEL}
          </span>
        )}
      </div>

      {usage !== undefined ? (
        <>
          <UsageCells usage={usage} step={step} run={derived.runCost} />
          <PriceNote step={step} loading={prices.status === 'idle' || prices.status === 'loading'} failed={prices.status === 'error'} />
        </>
      ) : (
        <div className="gm-ctx-note gm-ctx-note--faint">
          {exec.status === 'running' ? 'No usage yet — the step is still running.' : 'This step reported no token usage.'}
        </div>
      )}

      {derived.gap !== undefined && (
        <div className={`gm-ctx-note gm-ctx-note--${derived.gap.kind === 'held' ? 'held' : 'warn'}`} data-testid="cache-gap">
          {derived.gap.text}
        </div>
      )}

      <PromptDiffView runId={runId} prev={derived.prev} exec={exec} />
    </section>
  );
}
