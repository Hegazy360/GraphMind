/**
 * Lazy loader for the bundled price table.
 *
 * The table is ~330 KB of JSON (~35 KB gzipped). It is a separate chunk
 * behind a dynamic `import()` so the viewer's main bundle does not carry it:
 * nothing requests it until a run with LLM token usage is shown (the top
 * bar's est. cost, the inspector, Context & cost ask through
 * `usePriceTable(true)`); a run without usage never fetches it.
 *
 * An exported single-file run (`graphmind record --html`) has no sibling
 * chunks, and must not look for one: a relative `import()` from an inlined
 * module resolves against the document, so it would fetch — and run —
 * whatever file sits beside the export. The export carries the table as a
 * JSON block instead (`<script type="application/json" id="graphmind-prices">`,
 * packages/cli/src/export-html.ts), read here before any import; its CSP
 * refuses the import anyway.
 *
 * Fail-open: a table that cannot load leaves the state at `error` and every
 * dollar figure simply does not render. Nothing throws into React.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { PriceTable } from './engine.js';

export type PriceTableState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; table: PriceTable }
  | { status: 'error' };

let state: PriceTableState = { status: 'idle' };
let pending: Promise<PriceTable | undefined> | undefined;
const listeners = new Set<() => void>();

function setState(next: PriceTableState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function getPriceTableState(): PriceTableState {
  return state;
}

export function subscribePriceTable(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Must match packages/cli/src/export-html.ts PRICES_ELEMENT_ID. */
export const PRICES_ELEMENT_ID = 'graphmind-prices';

/**
 * The table an exported run carries inline. `null`: no such block (a served
 * viewer). Malformed: an error, never a fallback to the import.
 */
function embeddedTable(): Promise<unknown> | null {
  const doc = (globalThis as { document?: Document }).document;
  const block = doc?.getElementById(PRICES_ELEMENT_ID);
  if (block === null || block === undefined) return null;
  return Promise.resolve().then(() => JSON.parse(block.textContent ?? '') as unknown);
}

/** Start (or join) the one download. Resolves `undefined` on failure. */
export function loadPriceTable(): Promise<PriceTable | undefined> {
  if (pending !== undefined) return pending;
  setState({ status: 'loading' });
  const source: Promise<unknown> =
    embeddedTable() ?? import('./data_slim.json').then((mod) => (mod as unknown as { default: unknown }).default);
  pending = source
    .then((table) => {
      if (!Array.isArray(table)) throw new Error('price table is not an array');
      setState({ status: 'ready', table: table as PriceTable });
      return table as PriceTable;
    })
    .catch(() => {
      setState({ status: 'error' });
      return undefined;
    });
  return pending;
}

/** Test seam: install a table (or reset to idle) without the dynamic import. */
export function setPriceTableForTests(table: PriceTable | undefined): void {
  pending = table === undefined ? undefined : Promise.resolve(table);
  setState(table === undefined ? { status: 'idle' } : { status: 'ready', table });
}

/**
 * Subscribe to the table. `load: true` starts the download — every caller
 * passes whether it has usage to price (the top bar's run cost, the
 * inspector's node cost, Context & cost); `load: false` only reads what is
 * already there.
 */
export function usePriceTable(load: boolean): PriceTableState {
  const current = useSyncExternalStore(subscribePriceTable, getPriceTableState, getPriceTableState);
  useEffect(() => {
    if (load && state.status === 'idle') void loadPriceTable();
  }, [load]);
  return current;
}
