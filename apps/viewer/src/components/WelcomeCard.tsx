/**
 * The first-run welcome card: shown when the viewer is connected to a server
 * with zero runs. One primary action — watch the bundled demo debug session
 * (POST /api/demo/start, keyless) — plus the three-line integration snippet.
 */
import { useMemo, useRef, useState } from 'react';
import { resolveHttpBase } from '../connection/ServerConnection.js';
import { INTEGRATION_SNIPPET } from '../lib/firstRun.js';
import { GraphMindMark } from './Mark.js';

type DemoState = 'idle' | 'starting' | 'error';

export function WelcomeCard() {
  const httpBase = useMemo(() => resolveHttpBase(location.search), []);
  const [demoState, setDemoState] = useState<DemoState>('idle');
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const startDemo = async () => {
    if (demoState === 'starting') return;
    setDemoState('starting');
    try {
      const response = await fetch(`${httpBase}/api/demo/start`, { method: 'POST' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // The run arrives over the live socket and replaces this card.
    } catch {
      setDemoState('error');
    }
  };

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(INTEGRATION_SNIPPET);
      setCopied(true);
      if (copyTimer.current !== undefined) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable (permissions) — leave the snippet selectable
    }
  };

  return (
    <div
      style={{
        width: 'min(460px, calc(100% - 48px))',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 14,
        boxShadow: 'var(--shadow-pop)',
        padding: '30px 30px 24px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 0,
      }}
    >
      <GraphMindMark size={38} />
      <div
        style={{
          marginTop: 14,
          fontSize: 19,
          fontWeight: 650,
          letterSpacing: '-0.02em',
          textAlign: 'center',
        }}
      >
        Watch your agent think
      </div>
      <div
        style={{
          marginTop: 8,
          fontSize: 12.5,
          lineHeight: 1.65,
          color: 'var(--text-dim)',
          textAlign: 'center',
          maxWidth: 380,
        }}
      >
        Every run becomes a live graph: streamed tokens, tool calls, and errors that{' '}
        <em>pause</em> so you can inspect, inject a fix, retry, or abort. You&rsquo;re connected —
        no runs yet.
      </div>

      <button
        className="gm-action gm-action--primary"
        style={{ flex: 'none', marginTop: 18, padding: '9px 20px', fontSize: 12.5, width: '100%' }}
        onClick={() => void startDemo()}
        disabled={demoState === 'starting'}
      >
        {demoState === 'starting'
          ? 'Starting the demo…'
          : '▶ Watch a demo debug session — no API key needed'}
      </button>
      {demoState === 'error' && (
        <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--err)' }}>
          Couldn&rsquo;t start the demo — is this server the graphmind CLI? Try{' '}
          <code style={{ fontFamily: 'var(--font-mono)' }}>graphmind demo</code> in a terminal.
        </div>
      )}

      <div
        className="gm-section-label"
        style={{ marginTop: 22, alignSelf: 'flex-start' }}
      >
        Or instrument your app
      </div>
      <div
        style={{
          position: 'relative',
          marginTop: 8,
          width: '100%',
          background: 'var(--bg-canvas)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '12px 14px',
        }}
      >
        <pre
          style={{
            margin: 0,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            lineHeight: 1.7,
            color: 'var(--text)',
            overflowX: 'auto',
          }}
        >
          {INTEGRATION_SNIPPET}
        </pre>
        <button
          className="gm-action"
          style={{
            position: 'absolute',
            top: 7,
            right: 7,
            flex: 'none',
            padding: '2px 9px',
            fontSize: 10,
          }}
          onClick={() => void copySnippet()}
        >
          {copied ? 'copied ✓' : 'copy'}
        </button>
      </div>
      <div
        style={{
          marginTop: 10,
          alignSelf: 'flex-start',
          fontSize: 11,
          color: 'var(--text-faint)',
          lineHeight: 1.6,
        }}
      >
        <code style={{ fontFamily: 'var(--font-mono)' }}>@graphmind-ai/sdk</code> wraps your
        Vercel AI SDK model + tools; runs stream here automatically.
      </div>
    </div>
  );
}
