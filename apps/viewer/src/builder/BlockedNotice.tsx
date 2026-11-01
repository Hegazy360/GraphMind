/**
 * Why the Build page cannot act, and what to do about it — in the page
 * rather than in a tooltip on a greyed-out button.
 *
 * There are only two reasons left: the page is an exported run with no
 * server behind it, or no server is attached. The builder itself needs no
 * credential; it is a canvas for trying a workflow out, and asking for a
 * token first was friction with nothing behind it.
 */

export type BlockedKind = 'recorded' | 'offline';

export interface Blocked {
  kind: BlockedKind;
  /** One line, suitable on its own. */
  text: string;
}

export function BlockedNotice({ blocked }: { blocked: Blocked }) {
  return (
    <div className="gm-btoken" role="status">
      <div className="gm-btoken-text">{blocked.text}</div>
      {blocked.kind === 'offline' && (
        <div className="gm-btoken-how">
          Start it in a terminal — <code>npx graphmind-ai</code> — and this page connects on its own.
        </div>
      )}
    </div>
  );
}
