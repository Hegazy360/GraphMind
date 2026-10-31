/**
 * "How do I get my own agent in here?" — answered on one screen.
 *
 * This was a five-step wizard: choose a path, pick a stack, install,
 * instrument, then a step whose entire content was "now run your app, and
 * leave this tab open". Four of those five were ceremony. Picking a path was
 * a menu in front of a menu; splitting install from instrument put a Next
 * button between two code blocks that belong side by side; and the waiting
 * step restated what the whole viewer does — the header already says whether
 * anything is attached, and a run that arrives already opens itself.
 *
 * What was actually load-bearing is two commands and a sentence about what
 * you get at a gate, which differs per stack and is worth knowing *before*
 * you wire it up. So: pick your stack, copy two things. One screen, no Next.
 *
 * It is built from the debugger's own atoms — one surface, hairline-divided
 * sections, a `gm-section-label` on each, a `gm-copy` on the right of the
 * head row — so it reads as the same tool rather than a docs page that
 * wandered in.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { resolveServerUrl } from '../connection/ServerConnection.js';
import { indicatorStatus, useUiStore } from '../store/uiStore.js';
import { IconArrowRight, IconCopy } from '../components/Icons.js';
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
 * Whether anything is listening. Not a step — a fact, in the same dot-and-
 * label the header uses, so the two never look like different claims.
 */
function Attachment() {
  const connection = useUiStore((s) => s.connection);
  const fixtureActive = useUiStore((s) => s.fixtureActive);
  const status = indicatorStatus(connection, fixtureActive);
  const endpoint = useMemo(() => resolveServerUrl(location.search).replace(/^wss?:\/\//, ''), []);

  return (
    <span className="gm-conn-group gm-connect-conn" data-phase={status}>
      <span className={`gm-conn gm-conn--${status}`} />
      <span className="gm-conn-label">
        {status === 'live' ? (
          <>
            listening on <code className="gm-mono">{endpoint}</code>
          </>
        ) : status === 'connecting' ? (
          <>reaching {endpoint}…</>
        ) : (
          <>nothing attached</>
        )}
      </span>
    </span>
  );
}

export function ConnectPage() {
  const [stackId, setStackId] = useState<StackId>(loadStack);
  const stack: Stack = useMemo(() => stackById(stackId), [stackId]);
  const groups = useMemo(() => stacksByLanguage(), []);
  const connection = useUiStore((s) => s.connection);
  const attached = connection === 'live';

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
          <Attachment />
        </header>
        <p className="gm-connect-lede">
          GraphMind wraps the SDK you already call — no fork, no monkey-patching, and nothing to
          change about how your agent is written. Detached, the instrumentation is a no-op, so
          these lines are safe to commit.
        </p>

        <div className="gm-connect-card">
          <section className="gm-connect-section">
            <div className="gm-inspect-section-head">
              <span className="gm-section-label">Your stack</span>
            </div>
            <div className="gm-connect-stacks" role="radiogroup" aria-label="Your stack">
              {groups.map((group) => (
                <div key={group.language} className="gm-connect-group">
                  <span className="gm-section-label gm-connect-lang">{group.language}</span>
                  <div className="gm-connect-chips">
                    {group.stacks.map((entry) => (
                      <button
                        key={entry.id}
                        className={`gm-chip gm-chip--button gm-connect-chip${
                          stackId === entry.id ? ' gm-chip--on' : ''
                        }`}
                        role="radio"
                        aria-checked={stackId === entry.id}
                        onClick={() => pick(entry.id)}
                      >
                        {entry.framework}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {/* The blurb was a tooltip: surfacing it is how you tell two
                similar-sounding SDK names apart without guessing. */}
            <p className="gm-connect-blurb">{stack.blurb}</p>
          </section>

          {stack.install !== '' && <Step n={1} label="Install" code={stack.install} lang="sh" />}
          <Step
            {...(stack.install === '' ? {} : { n: 2 })}
            label={stack.install === '' ? 'Wrap the command your host already runs' : 'Instrument'}
            code={stack.instrument}
            lang={stack.lang}
          />

          <section className="gm-connect-section gm-connect-section--last">
            <div className="gm-inspect-section-head">
              <span className="gm-section-label">At a gate</span>
              {/* A fixed label: "MCP server, via the proxy docs" is not a
                  phrase, and the framework is already named above. */}
              <a
                className="gm-copy"
                href={stack.docs}
                target="_blank"
                rel="noreferrer"
                title={`${stack.framework} integration guide`}
              >
                Integration guide
                <IconArrowRight width={11} height={11} />
              </a>
            </div>
            {/* A statement about this adapter, not about the socket — so
                no status dot, which would read as "currently true". */}
            <p className="gm-connect-gate">{stack.capability}</p>
            <p className="gm-connect-next">
              {attached ? (
                'Run your agent and it opens here on its own.'
              ) : (
                <>
                  Start the debugger with <code className="gm-mono">npx graphmind-ai</code>; this
                  tab reconnects by itself.
                </>
              )}
            </p>
          </section>
        </div>

        <footer className="gm-connect-foot">
          <span>
            Not sure what to add? <code className="gm-mono">npx graphmind-ai init</code> reads your
            project and prints these lines for you.
          </span>
          <button
            className="gm-connect-build"
            onClick={() => useUiStore.getState().setPage('build')}
          >
            Or generate a starter project
            <IconArrowRight width={12} height={12} />
          </button>
        </footer>
      </div>
    </div>
  );
}
