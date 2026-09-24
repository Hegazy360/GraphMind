/**
 * Lazy loader for the bundled price table.
 *
 * The table is ~330 KB of JSON (~35 KB gzipped). It is a separate chunk
 * behind a dynamic `import()` so the viewer's main bundle does not carry it:
 * nothing requests it until an LLM node's Context & cost view asks for a
 * price. Once loaded, anything else that can use it (the run's cost in the
 * top bar) picks it up through `usePriceTable()` — without ever triggering
 * the download itself.
 *
 * Fail-open: a chunk that cannot load (an exported single-file run opened
 * from disk has no sibling chunks) leaves the state at `error` and every
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

/** Start (or join) the one download. Resolves `undefined` on failure. */
export function loadPriceTable(): Promise<PriceTable | undefined> {
  if (pending !== undefined) return pending;
  setState({ status: 'loading' });
  pending = import('./data_slim.json')
    .then((mod) => {
      const table = (mod as unknown as { default: unknown }).default;
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
 * Subscribe to the table. `load: true` starts the download (the Context &
 * cost view); `load: false` only reads what is already there (the top bar).
 */
export function usePriceTable(load: boolean): PriceTableState {
  const current = useSyncExternalStore(subscribePriceTable, getPriceTableState, getPriceTableState);
  useEffect(() => {
    if (load && state.status === 'idle') void loadPriceTable();
  }, [load]);
  return current;
}
