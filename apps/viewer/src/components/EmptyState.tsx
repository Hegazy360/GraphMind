/**
 * Nothing to show — but never a blank canvas. Each state says what the
 * viewer is doing, why nothing is here, and the one command that fixes it.
 */
import { resolveHttpBase, resolveServerUrl } from '../connection/ServerConnection.js';
import { shouldShowWelcome } from '../lib/firstRun.js';
import { useRunStore } from '../store/runStore.js';
import { useUiStore } from '../store/uiStore.js';
import { GraphMindMark } from './Mark.js';
import { WelcomeCard } from './WelcomeCard.js';

function ServerHint() {
  const url = resolveServerUrl(location.search);
  return (
    <code className="gm-mono" title={resolveHttpBase(location.search)}>
      {url.replace(/^wss?:\/\//, '')}
    </code>
  );
}

export function EmptyState({
  fixtureAvailable,
  runCount,
  railOpen,
  onOpenRail,
}: {
  fixtureAvailable: boolean;
  runCount: number;
  railOpen: boolean;
  onOpenRail: () => void;
}) {
  const connection = useUiStore((s) => s.connection);

  // First run: connected, zero runs → the crafted welcome card.
  if (fixtureAvailable && shouldShowWelcome(connection, runCount)) {
    return (
      <div className="gm-empty">
        <WelcomeCard />
      </div>
    );
  }

  if (runCount > 0) {
    return (
      <div className="gm-empty">
        <div className="gm-empty-card">
          <GraphMindMark size={34} />
          <h2>Pick a run</h2>
          <p>
            {runCount} run{runCount === 1 ? '' : 's'} loaded.{' '}
            {railOpen ? 'Choose one on the left' : 'Open the run list'} — or press{' '}
            <span className="gm-kbd">⌘K</span> and search.
          </p>
          <div className="gm-empty-actions">
            {!railOpen && (
              <button className="gm-action" onClick={onOpenRail}>
                Show runs
              </button>
            )}
            <button
              className="gm-action gm-action--primary"
              onClick={() => {
                const first = Object.keys(useRunStore.getState().runs)[0];
                if (first !== undefined) useUiStore.getState().selectRun(first);
              }}
            >
              Open the latest run
            </button>
          </div>
        </div>
      </div>
    );
  }

  const connecting = connection === 'connecting';
  const detached = connection === 'detached' || connection === 'off';

  return (
    <div className="gm-empty">
      <div className="gm-empty-card">
        <GraphMindMark size={34} animated={connecting} />
        <h2>
          {connecting ? 'Connecting to the debugger…' : detached ? 'No debugger server' : 'Waiting for a run'}
        </h2>
        <p>
          {connecting && (
            <>
              Reaching <ServerHint /> — this is the <code className="gm-mono">graphmind serve</code>{' '}
              process your instrumented app streams into.
            </>
          )}
          {detached && (
            <>
              Nothing is listening on <ServerHint />. Start one in a terminal, then leave this tab
              open — it reconnects on its own.
            </>
          )}
          {!connecting && !detached && (
            <>
              Connected on <code className="gm-mono">/ws/ui</code>. Run your instrumented app and
              the graph builds itself as events arrive.
            </>
          )}
        </p>

        {detached && (
          <pre className="gm-empty-code">
            <span className="gm-mono">npx graphmind-ai serve</span>
          </pre>
        )}

        <div className="gm-empty-actions">
          {fixtureAvailable && (
            <button
              className="gm-action gm-action--primary"
              onClick={() => useUiStore.getState().requestDemo()}
            >
              Replay the bundled demo run
            </button>
          )}
          <a className="gm-action" href="?stress=300" title="Generate a 300-node synthetic run">
            Load a 300-node stress run
          </a>
        </div>

        <div className="gm-empty-foot">
          <span>
            <span className="gm-kbd">⌘K</span> command palette
          </span>
          <span>
            <span className="gm-kbd">⇧T</span> timeline
          </span>
          <span>
            <span className="gm-kbd">f</span> follow
          </span>
        </div>
      </div>
    </div>
  );
}
