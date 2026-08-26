/**
 * Collapsible JSON tree for payload inspection. No Monaco — just a compact,
 * theme-aware tree with expand toggles.
 */
import { useState } from 'react';

const MAX_STRING = 240;

function Primitive({ value }: { value: unknown }) {
  if (value === null) return <span className="gm-json-null">null</span>;
  if (value === undefined) return <span className="gm-json-null">undefined</span>;
  switch (typeof value) {
    case 'string': {
      const shown = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
      return (
        <span className="gm-json-string" title={value.length > MAX_STRING ? `${value.length} chars` : undefined}>
          "{shown}"
        </span>
      );
    }
    case 'number':
    case 'bigint':
      return <span className="gm-json-num">{String(value)}</span>;
    case 'boolean':
      return <span className="gm-json-bool">{String(value)}</span>;
    default:
      return <span className="gm-json-null">{String(value)}</span>;
  }
}

function isComposite(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

interface EntryProps {
  label: string | undefined;
  value: unknown;
  depth: number;
  initialDepth: number;
}

function Entry({ label, value, depth, initialDepth }: EntryProps) {
  const [open, setOpen] = useState(depth < initialDepth);

  const labelEl =
    label !== undefined ? (
      <>
        <span className="gm-json-key">{label}</span>
        <span style={{ opacity: 0.55 }}>: </span>
      </>
    ) : null;

  if (!isComposite(value)) {
    return (
      <div style={{ paddingLeft: depth === 0 ? 0 : 14 }}>
        {labelEl}
        <Primitive value={value} />
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  const preview = isArray ? `[${entries.length}]` : `{${entries.length}}`;

  return (
    <div style={{ paddingLeft: depth === 0 ? 0 : 14 }}>
      <button className="gm-json-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? '▾' : '▸'}
      </button>
      {labelEl}
      {!open && (
        <span style={{ opacity: 0.6 }}>
          {preview}
        </span>
      )}
      {open &&
        (entries.length === 0 ? (
          <span style={{ opacity: 0.6 }}>{isArray ? '[]' : '{}'}</span>
        ) : (
          entries.map(([key, child]) => (
            <Entry key={key} label={key} value={child} depth={depth + 1} initialDepth={initialDepth} />
          ))
        ))}
    </div>
  );
}

export function JsonTree({ value, initialDepth = 2 }: { value: unknown; initialDepth?: number }) {
  return (
    <div className="gm-json">
      <Entry label={undefined} value={value} depth={0} initialDepth={initialDepth} />
    </div>
  );
}
