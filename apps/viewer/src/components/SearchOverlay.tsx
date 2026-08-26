/**
 * Fuzzy node search (`/`) — match-sorter over the run's nodes, ported from
 * the legacy autocomplete overlay. Enter selects + centers.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { matchSorter } from 'match-sorter';
import { useRunStore } from '../store/runStore.js';
import { useUiStore } from '../store/uiStore.js';
import { nodeStatus, type NodeLifeStatus } from '../store/types.js';
import { StatusDot } from './nodes/nodeParts.js';

interface SearchItem {
  id: string;
  name: string;
  kind: string;
  status: NodeLifeStatus;
}

export function SearchOverlay({ runId }: { runId: string }) {
  const statusVersion = useRunStore((s) => s.runs[runId]?.statusVersion ?? -1);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo<SearchItem[]>(() => {
    void statusVersion;
    const run = useRunStore.getState().runs[runId];
    if (run === undefined) return [];
    return run.order.flatMap((id) => {
      const node = run.nodes[id];
      if (node === undefined) return [];
      return [{ id, name: node.name, kind: node.kind, status: nodeStatus(node) }];
    });
  }, [runId, statusVersion]);

  const results = useMemo(
    () =>
      query === ''
        ? items
        : matchSorter(items, query, { keys: ['name', 'id', 'kind'] }),
    [items, query],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setActive(0);
  }, [query]);

  const close = () => useUiStore.getState().setSearchOpen(false);

  const choose = (item: SearchItem | undefined) => {
    if (item === undefined) return;
    const ui = useUiStore.getState();
    ui.selectNode(runId, item.id);
    ui.requestFocus(item.id);
    ui.setSearchOpen(false);
  };

  return (
    <div className="gm-search-scrim" onMouseDown={close}>
      <div className="gm-search" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder="Search nodes…"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, results.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') {
              choose(results[active]);
            } else if (e.key === 'Escape') {
              close();
            }
          }}
        />
        {results.length > 0 && (
          <div className="gm-search-results">
            {results.map((item, i) => (
              <button
                key={item.id}
                className={`gm-search-item${i === active ? ' gm-search-item--active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(item)}
              >
                <StatusDot status={item.status} />
                <span style={{ fontWeight: 550 }}>{item.name}</span>
                <span className="gm-node-kind" style={{ marginLeft: 'auto' }}>
                  {item.kind}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
