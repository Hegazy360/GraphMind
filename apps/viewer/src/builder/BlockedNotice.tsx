/**
 * Why the Build page cannot act, and what to do about it — in the page
 * rather than in a tooltip on a greyed-out button.
 *
 * There are only two reasons left, and neither stops the useful part: the
 * canvas and the generated code are computed in the browser, so they work
 * with nothing running at all. What needs a server is writing files to
 * disk, running them, and opening an MCP connection — none of which a
 * browser can do. No credential is involved either way.
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
