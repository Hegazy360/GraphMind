/**
 * "How do I get my own agent in here?" — answered on one screen.
 *
 * This was a five-step wizard: choose a path, pick a stack, install,
 * instrument, then a step whose entire content was "now run your app, and
 * leave this tab open". Four of those five were ceremony. Picking a path was
 * a menu in front of a menu; splitting install from instrument put a Next
 * button between two code blocks that belong side by side; and the waiting
 * step restated what the whole viewer does.
 *
 * What was actually load-bearing is two commands and a sentence about what
 * you get at a gate, which differs per stack and is worth knowing *before*
 * you wire it up. So: pick your stack, copy two things. One screen, no Next.
 *
 * Two columns, because the page has two jobs and they are not the same job:
 *
 *   - the left column is **what to do** — recognise your stack, copy the
 *     install line, copy the wrapping call. It reads top to bottom once.
 *   - the right rail is **whether it worked** — a live account of what this
 *     tab can see, which changes under you while you work in your editor and
 *     is the only thing on the page worth looking back at. A dot in the
 *     corner of the header was not enough: the whole point of the page is
 *     getting from "nothing attached" to "a run arrived", and that journey
 *     deserves to be the thing you can watch.
 *
 * The stack chooser shows every blurb rather than only the chosen one. The
 * blurb exists so you can recognise your own project ("you call streamText",
 * "someone else wrote the server") and a recognition cue you have to click
 * to read is not one — it was also the only thing telling two
 * similar-sounding MCP entries apart.
 *
 * It is built from the debugger's own atoms — one surface, hairline-divided
 * sections, a `gm-section-label` on each, a `gm-copy` on the right of the
 * head row — so it reads as the same tool rather than a docs page that
 * wandered in.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { resolveServerUrl } from '../connection/ServerConnection.js';
import { useRunStore } from '../store/runStore.js';
import { indicatorStatus, useUiStore } from '../store/uiStore.js';
import { IconArrowRight, IconCheck, IconCopy } from '../components/Icons.js';
import {
  DEFAULT_STACK,
  stackById,
  stacksByLanguage,
  type Stack,
  type StackId,
} from '../connect/catalog.js';

const STACK_KEY = 'graphmind.stack';

function loadStack(): StackId {
  try {
    const stored = localStorage.getItem(STACK_KEY);
    return stored === null ? DEFAULT_STACK : (stored as StackId);
  } catch {
    return DEFAULT_STACK;
  }
}

/**
 * A section of the card: a label, an optional copy on the right, content
 * below. The same shape as the inspector's sections, deliberately.
 */
function Step({
  n,
  label,
  code,
  lang,
}: {
  /** Omitted when there is only one — "1 of 1" is not an ordering. */
  n?: number;
  label: string;
  code: string;
  lang: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <section className="gm-connect-section">
      <div className="gm-inspect-section-head">
        <span className="gm-section-label gm-connect-steplabel">
          {n !== undefined && (
            <span className="gm-connect-n" aria-hidden="true">
              {n}
            </span>
          )}
          {label}
        </span>
        <button
          className="gm-copy"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(code)
              .then(() => {
                setCopied(true);
                clearTimeout(timer.current);
                timer.current = setTimeout(() => setCopied(false), 1600);
              })
              .catch(() => {
                // clipboard blocked — the text is still selectable
              });
          }}
        >
          <IconCopy width={11} height={11} />
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <div className="gm-code" data-lang={lang}>
        <pre className="nowheel">{code}</pre>
      </div>
    </section>
  );
}

/**
 * What this tab can see, right now.
 *
 * Three facts in the order they become true — a server to talk to, a socket
 * to it, a run on it — each either done or pending, so the rail is a
 * progress report rather than a status word. The last one lands by itself:
 * the reader is in their editor when it does, and comes back to a page that
 * has already changed.
 *
 * The header carries the same socket state in its own dot, so this does not
 * repeat the word: the header says *whether*, this says *what it means and
 * what is still missing*.
 */
function StatusRail() {
  const connection = useUiStore((s) => s.connection);
  const fixtureActive = useUiStore((s) => s.fixtureActive);
  const runCount = useRunStore((s) => Object.keys(s.runs).length);
  const status = indicatorStatus(connection, fixtureActive);
  // Host and port only: `/ws/ui` is the socket's path, not an address
  // anyone types, and it is what makes the line wrap in a 320px rail.
  const endpoint = useMemo(
    () => resolveServerUrl(location.search).replace(/^wss?:\/\//, '').replace(/\/.*$/, ''),
    [],
  );

  const attached = status === 'live';
  const connecting = status === 'connecting';
  const replaying = status === 'replaying';
  const hasRun = runCount > 0;

  /**
   * A replay is not a connection, and the runs it put on the list are not
   * yours. Saying "1 run recorded" beside "not connected" is two true
   * sentences that together tell a lie, so a replay gets its own panel:
   * what this tab is showing, and the one thing still missing.
   */
  if (replaying) {
    return (
      <div className="gm-attach gm-attach--replaying">
        <div className="gm-attach-head">
          <span className={`gm-conn gm-conn--${status}`} />
          <span className="gm-attach-title">Replaying a recording</span>
        </div>
        <p className="gm-attach-lede">
          This tab is showing a recorded run, not a live server — everything works except the
          controls that change execution, because nothing is executing.
        </p>
        <p className="gm-attach-hint">
          To debug your own agent, start the debugger with{' '}
          <code className="gm-mono">npx graphmind-ai serve</code> and follow the steps here.
        </p>
        {hasRun && (
          <button className="gm-attach-go" onClick={() => useUiStore.getState().setPage('runs')}>
            See the recording
            <IconArrowRight width={12} height={12} />
          </button>
        )}
      </div>
    );
  }

  const steps: { done: boolean; pending: boolean; label: React.ReactNode }[] = [
    {
      done: attached,
      pending: connecting,
      label: attached ? (
        <>
          Debugger running on <code className="gm-mono">{endpoint}</code>
        </>
      ) : connecting ? (
        <>
          Reaching <code className="gm-mono">{endpoint}</code>…
        </>
      ) : (
        <>
          No debugger on <code className="gm-mono">{endpoint}</code>
        </>
      ),
    },
    {
      done: attached,
      pending: connecting,
      label: attached ? 'This tab is attached to it' : 'This tab will attach by itself',
    },
    {
      // Only a live socket can say a run arrived: runs on the list while
      // nothing is attached came from somewhere else.
      done: attached && hasRun,
      pending: attached && !hasRun,
      label:
        attached && hasRun
          ? `${runCount} run${runCount === 1 ? '' : 's'} recorded`
          : 'Waiting for your first run',
    },
  ];

  const ready = attached && hasRun;

  return (
    <div className={`gm-attach gm-attach--${attached ? (hasRun ? 'ready' : 'waiting') : status}`}>
      <div className="gm-attach-head">
        <span className={`gm-conn gm-conn--${status}`} />
        <span className="gm-attach-title">
          {ready ? 'Connected' : attached ? 'Listening' : connecting ? 'Connecting' : 'Not connected'}
        </span>
      </div>

      <ol className="gm-attach-steps">
        {steps.map((step, index) => (
          <li
            key={index}
            className={`gm-attach-step${step.done ? ' gm-attach-step--done' : ''}${
              step.pending ? ' gm-attach-step--pending' : ''
            }`}
          >
            <span className="gm-attach-mark" aria-hidden="true">
              {step.done ? <IconCheck width={11} height={11} /> : <span className="gm-attach-ring" />}
            </span>
            <span className="gm-attach-text">{step.label}</span>
          </li>
        ))}
      </ol>

      {!attached && !connecting && (
        <p className="gm-attach-hint">
          Start it with <code className="gm-mono">npx graphmind-ai serve</code> — this tab keeps
          retrying on its own.
        </p>
      )}
      {attached && !hasRun && (
        <p className="gm-attach-hint">
          Run your agent. The graph builds itself as events arrive, and the run opens here without
          you reloading.
        </p>
      )}
      {ready && (
        <button className="gm-attach-go" onClick={() => useUiStore.getState().setPage('runs')}>
          See the runs
          <IconArrowRight width={12} height={12} />
        </button>
      )}
    </div>
  );
}

export function ConnectPage() {
  const [stackId, setStackId] = useState<StackId>(loadStack);
  const stack: Stack = useMemo(() => stackById(stackId), [stackId]);
  const groups = useMemo(() => stacksByLanguage(), []);

  const pick = (id: StackId) => {
    setStackId(id);
    try {
      localStorage.setItem(STACK_KEY, id);
    } catch {
      // per-session only when storage is blocked
    }
  };

  return (
    <div className="gm-connect">
      <div className="gm-connect-inner">
        <header className="gm-connect-head">
          <h1>Connect an agent</h1>
          <p className="gm-connect-lede">
            GraphMind wraps the SDK you already call — no fork, no monkey-patching, and nothing to
            change about how your agent is written. Detached, the instrumentation is a no-op, so
            these lines are safe to commit.
          </p>
        </header>

        <div className="gm-connect-body">
          <div className="gm-connect-main">
            <div className="gm-connect-card">
              <section className="gm-connect-section">
                <div className="gm-inspect-section-head">
                  <span className="gm-section-label gm-connect-steplabel">
                    <span className="gm-connect-n" aria-hidden="true">
                      1
                    </span>
                    Your stack
                  </span>
                </div>
                {/* Every blurb, not only the chosen one: the blurb is how you
                    recognise your own project, and the only thing that tells
                    the two MCP entries apart. */}
                <div className="gm-connect-stacks" role="radiogroup" aria-label="Your stack">
                  {groups.map((group) => (
                    <div key={group.language} className="gm-connect-group">
                      <span className="gm-section-label gm-connect-lang">{group.language}</span>
                      <div className="gm-connect-chips">
                        {group.stacks.map((entry) => (
                          <button
                            key={entry.id}
                            className={`gm-connect-chip${
                              stackId === entry.id ? ' gm-connect-chip--on' : ''
                            }`}
                            role="radio"
                            aria-checked={stackId === entry.id}
                            aria-label={entry.framework}
                            onClick={() => pick(entry.id)}
                          >
                            <span className="gm-connect-chip-name">
                              {entry.framework}
                              {stackId === entry.id && (
                                <IconCheck
                                  className="gm-connect-chip-tick"
                                  width={12}
                                  height={12}
                                />
                              )}
                            </span>
                            <span className="gm-connect-chip-blurb">{entry.blurb}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {stack.install !== '' && <Step n={2} label="Install" code={stack.install} lang="sh" />}
              <Step
                n={stack.install === '' ? 2 : 3}
                label={
                  stack.install === '' ? 'Wrap the command your host already runs' : 'Instrument'
                }
                code={stack.instrument}
                lang={stack.lang}
              />
            </div>

            <p className="gm-connect-foot">
              Not sure what to add? <code className="gm-mono">npx graphmind-ai init</code> reads
              your project and prints these lines for you — or{' '}
              <button
                className="gm-connect-build"
                onClick={() => useUiStore.getState().setPage('build')}
              >
                generate a starter project
              </button>
              .
            </p>
          </div>

          <aside className="gm-connect-rail" aria-label="Connection status">
            <StatusRail />

            {/* A statement about this adapter, not about the socket — so no
                status dot, which would read as "currently true". */}
            <div className="gm-connect-gatebox">
              <span className="gm-section-label">At a gate</span>
              <p className="gm-note gm-connect-gate">{stack.capability}</p>
              <a
                className="gm-connect-doclink"
                href={stack.docs}
                target="_blank"
                rel="noreferrer"
                title={`${stack.framework} integration guide`}
              >
                {stack.framework} integration guide
                <IconArrowRight width={12} height={12} />
              </a>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
