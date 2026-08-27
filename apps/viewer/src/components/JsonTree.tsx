/**
 * Payload viewer. A debugger lives in other people's JSON, so this one does
 * the four things that actually matter: collapse/expand any branch, search
 * inside the payload (auto-expanding to the hits), copy the *path* to a
 * value (`input.messages[2].content`) so you can paste it into your own
 * code, and copy any subtree as JSON.
 *
 * Big arrays are windowed — a 5,000-element tool result renders 100 rows and
 * an expander, not 5,000 DOM nodes.
 */
import { useMemo, useState } from 'react';
import { copyText } from '../lib/commands.js';

const MAX_STRING = 240;
const WINDOW = 100;

function isComposite(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

function entriesOf(value: Record<string, unknown> | unknown[]): (readonly [string, unknown])[] {
  return Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value);
}

function joinPath(parent: string, key: string, isArrayIndex: boolean): string {
  if (isArrayIndex) return `${parent}[${key}]`;
  if (parent === '') return key;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Paths whose subtree contains a match, plus the count of direct hits. */
function indexMatches(
  root: unknown,
  query: string,
  rootPath: string,
): { paths: Set<string>; hits: number } {
  const paths = new Set<string>();
  if (query === '') return { paths, hits: 0 };
  const needle = query.toLowerCase();
  let hits = 0;

  const walk = (value: unknown, path: string, key: string | undefined): boolean => {
    let matched = key !== undefined && key.toLowerCase().includes(needle);
    if (isComposite(value)) {
      const isArray = Array.isArray(value);
      for (const [childKey, child] of entriesOf(value)) {
        if (walk(child, joinPath(path, childKey, isArray), childKey)) matched = true;
      }
    } else if (String(value).toLowerCase().includes(needle)) {
      matched = true;
    }
    if (matched) {
      hits += 1;
      paths.add(path);
    }
    return matched;
  };

  walk(root, rootPath, undefined);
  return { paths, hits };
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (query === '') return <>{text}</>;
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark className="gm-json-hit">{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  );
}

function Primitive({ value, query }: { value: unknown; query: string }) {
  if (value === null) return <span className="gm-json-null">null</span>;
  if (value === undefined) return <span className="gm-json-null">undefined</span>;
  switch (typeof value) {
    case 'string': {
      const shown = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
      return (
        <span
          className="gm-json-string"
          title={value.length > MAX_STRING ? `${value.length} chars` : undefined}
        >
          "<Highlight text={shown} query={query} />"
        </span>
      );
    }
    case 'number':
    case 'bigint':
      return (
        <span className="gm-json-num">
          <Highlight text={String(value)} query={query} />
        </span>
      );
    case 'boolean':
      return <span className="gm-json-bool">{String(value)}</span>;
    default:
      return <span className="gm-json-null">{String(value)}</span>;
  }
}

interface EntryProps {
  label: string | undefined;
  value: unknown;
  depth: number;
  initialDepth: number;
  path: string;
  query: string;
  matches: Set<string>;
  forceOpen: number;
  forceClose: number;
}

function Entry(props: EntryProps) {
  const { label, value, depth, initialDepth, path, query, matches, forceOpen, forceClose } = props;
  const searching = query !== '';
  const onMatchPath = searching && matches.has(path);
  // `generation` invalidates a manual toggle when expand/collapse-all fires,
  // so those buttons win without every row needing an effect.
  const generation = forceOpen + forceClose;
  const [manual, setManual] = useState<{ gen: number; open: boolean } | undefined>(undefined);
  const [expandedWindow, setExpandedWindow] = useState(false);
  const [copied, setCopied] = useState(false);

  const open =
    manual !== undefined && manual.gen === generation
      ? manual.open
      : forceOpen > forceClose
        ? true
        : forceClose > forceOpen
          ? false
          : searching
            ? onMatchPath
            : depth < initialDepth;

  const labelEl =
    label !== undefined ? (
      <>
        <span className="gm-json-key">
          <Highlight text={label} query={query} />
        </span>
        <span style={{ opacity: 0.55 }}>: </span>
      </>
    ) : null;

  const copyPath = async () => {
    const ok = await copyText(path === '' ? '(root)' : path);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1100);
  };

  const pathButton =
    path === '' ? null : (
      <button className="gm-json-path" onClick={() => void copyPath()} title={`Copy path: ${path}`}>
        {copied ? '✓' : '⧉'}
      </button>
    );

  if (!isComposite(value)) {
    return (
      <div className="gm-json-row" style={{ paddingLeft: depth === 0 ? 0 : 14 }}>
        {labelEl}
        <Primitive value={value} query={query} />
        {pathButton}
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries = entriesOf(value);
  const preview = isArray ? `[${entries.length}]` : `{${entries.length}}`;
  const windowed = !expandedWindow && entries.length > WINDOW ? entries.slice(0, WINDOW) : entries;

  return (
    <div style={{ paddingLeft: depth === 0 ? 0 : 14 }}>
      <div className="gm-json-row">
        <button
          className="gm-json-toggle"
          onClick={() => setManual({ gen: generation, open: !open })}
          aria-expanded={open}
          aria-label={open ? `Collapse ${path || 'root'}` : `Expand ${path || 'root'}`}
        >
          {open ? '▾' : '▸'}
        </button>
        {labelEl}
        <span style={{ opacity: 0.6 }}>{open ? (isArray ? '[' : '{') : preview}</span>
        {pathButton}
        <button
          className="gm-json-path"
          onClick={() => void copyText(stringify(value))}
          title="Copy this subtree as JSON"
        >
          {'{ }'}
        </button>
      </div>
      {open &&
        (entries.length === 0 ? (
          <div className="gm-json-row" style={{ paddingLeft: 14, opacity: 0.6 }}>
            {isArray ? 'empty' : 'no keys'}
          </div>
        ) : (
          <>
            {windowed.map(([key, child]) => (
              <Entry
                key={key}
                label={key}
                value={child}
                depth={depth + 1}
                initialDepth={initialDepth}
                path={joinPath(path, key, isArray)}
                query={query}
                matches={matches}
                forceOpen={forceOpen}
                forceClose={forceClose}
              />
            ))}
            {windowed.length < entries.length && (
              <button
                className="gm-json-more"
                onClick={() => setExpandedWindow(true)}
                style={{ marginLeft: 14 }}
              >
                … {entries.length - windowed.length} more
              </button>
            )}
          </>
        ))}
      {open && <div style={{ opacity: 0.6, paddingLeft: 14 }}>{isArray ? ']' : '}'}</div>}
    </div>
  );
}

export function JsonTree({
  value,
  initialDepth = 2,
  rootPath = '',
  searchable = true,
}: {
  value: unknown;
  initialDepth?: number;
  /** Prefix for copied paths, e.g. `input` or `output`. */
  rootPath?: string;
  searchable?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [forceOpen, setForceOpen] = useState(0);
  const [forceClose, setForceClose] = useState(0);
  const { paths, hits } = useMemo(
    () => indexMatches(value, query, rootPath),
    [value, query, rootPath],
  );
  const composite = isComposite(value);
  const size = composite ? entriesOf(value).length : 0;

  return (
    <div className="gm-json">
      {searchable && composite && size > 0 && (
        <div className="gm-json-tools">
          <input
            className="gm-json-search"
            value={query}
            placeholder="Search payload…"
            spellCheck={false}
            aria-label="Search inside this payload"
            onChange={(e) => {
              setQuery(e.target.value);
              setForceOpen(0);
              setForceClose(0);
            }}
          />
          {query !== '' && (
            <span className="gm-json-hits">
              {hits} match{hits === 1 ? '' : 'es'}
            </span>
          )}
          <button
            className="gm-json-path"
            title="Expand everything"
            onClick={() => setForceOpen((n) => Math.max(n, forceClose) + 1)}
          >
            ⤢
          </button>
          <button
            className="gm-json-path"
            title="Collapse everything"
            onClick={() => setForceClose((n) => Math.max(n, forceOpen) + 1)}
          >
            ⤡
          </button>
        </div>
      )}
      <Entry
        label={undefined}
        value={value}
        depth={0}
        initialDepth={initialDepth}
        path={rootPath}
        query={query}
        matches={paths}
        forceOpen={forceOpen}
        forceClose={forceClose}
      />
    </div>
  );
}
