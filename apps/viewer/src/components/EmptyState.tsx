/**
 * Nothing recorded yet — but never a blank page, and never a wall of
 * choices. The honest state of the connection, one primary way forward, and
 * nothing else; the decision about *what you are doing* belongs in the setup
 * guide, which asks one question at a time.
 */
import { resolveHttpBase, resolveServerUrl } from '../connection/ServerConnection.js';
import { useUiStore } from '../store/uiStore.js';
import { GraphMindMark } from './Mark.js';

function ServerHint() {
  const url = resolveServerUrl(location.search);
  return (
    <code className="gm-mono" title={resolveHttpBase(location.search)}>
      {url.replace(/^wss?:\/\//, '')}
    </code>
  );
}

export function EmptyState({ fixtureAvailable }: { fixtureAvailable: boolean }) {
  const connection = useUiStore((s) => s.connection);
  const connecting = connection === 'connecting';
  const detached = connection === 'detached' || connection === 'off';

  return (
    <div className="gm-empty">
      <div className="gm-empty-card">
        <GraphMindMark size={34} animated={connecting} />
        <h2>
          {connecting
            ? 'Connecting to the debugger…'
            : detached
              ? 'No debugger server'
              : 'Waiting for a run'}
        </h2>
        <p>
          {connecting && (
            <>
              Reaching <ServerHint /> — the <code className="gm-mono">graphmind serve</code> process
              your instrumented app streams into.
            </>
          )}
          {detached && (
            <>
              Nothing is listening on <ServerHint />. Start one with{' '}
              <code className="gm-mono">npx graphmind-ai serve</code> and leave this tab open — it
              reconnects on its own.
            </>
          )}
          {!connecting && !detached && (
            <>
              Attached and idle. Run your instrumented app and the graph builds itself as events
              arrive.
            </>
          )}
        </p>

        <div className="gm-empty-actions">
          <button
            className="gm-action gm-action--primary"
            onClick={() => useUiStore.getState().setPage('connect')}
          >
            Connect an agent
          </button>
          {fixtureAvailable && (
            <button className="gm-action" onClick={() => useUiStore.getState().requestDemo()}>
              Replay the bundled demo run
            </button>
          )}
          <button className="gm-action" onClick={() => useUiStore.getState().setPage('build')}>
            Build a workflow
          </button>
        </div>

        <p className="gm-empty-foot-note">
          One package and two lines, for the SDK you already use.
        </p>
      </div>
    </div>
  );
}
