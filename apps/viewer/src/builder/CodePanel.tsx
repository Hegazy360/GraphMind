/**
 * The generated project, file by file, exactly as Create will write it.
 *
 * Generated in the browser by the same code the server runs (BuilderPage),
 * so this panel needs no server and never waits for one.
 * Copy any file, or the whole thing as a shell-ready bundle; the install
 * and start commands sit under the code so the page is usable without
 * ever pressing Create (an engineer may prefer to paste into their own
 * repository).
 */
import { useEffect, useState } from 'react';
import { copyText } from '../lib/commands.js';
import { useBuilderStore } from './builderStore.js';
import type { PreviewResponse } from './types.js';

function bundle(preview: PreviewResponse): string {
  const parts = preview.files.map((file) => `# ---- ${file.path} ----\n${file.content}`);
  return `${parts.join('\n')}\n# ---- run ----\n${[...preview.install, preview.start].join('\n')}\n`;
}

export function CodePanel({ preview }: { preview: PreviewResponse | undefined }) {
  const selected = useBuilderStore((s) => s.selectedFile);
  const selectFile = useBuilderStore((s) => s.selectFile);
  const [copied, setCopied] = useState<string | undefined>(undefined);

  // Default to the entry file; stay on a file while it exists.
  useEffect(() => {
    if (preview === undefined) return;
    if (selected !== undefined && preview.files.some((f) => f.path === selected)) return;
    selectFile(preview.target.entry);
  }, [preview, selected, selectFile]);

  useEffect(() => {
    if (copied === undefined) return;
    const timer = setTimeout(() => setCopied(undefined), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  const file = preview?.files.find((f) => f.path === selected) ?? preview?.files[0];

  const copy = async (what: string, text: string) => {
    if (await copyText(text)) setCopied(what);
  };

  return (
    <section className="gm-bcode" aria-label="Generated code">
      {/* Files on one row, actions on the next: a 460px rail cannot hold
          three file names and two buttons side by side without cutting a
          name to "src/main." */}
      <div className="gm-bcode-head">
        <div className="gm-bcode-tabs" role="tablist" aria-label="Files">
          {preview?.files.map((f) => (
            <button
              key={f.path}
              role="tab"
              aria-selected={file?.path === f.path}
              className={`gm-bcode-tab${file?.path === f.path ? ' gm-bcode-tab--on' : ''}`}
              onClick={() => selectFile(f.path)}
            >
              {f.path}
            </button>
          ))}
        </div>
      </div>
      {preview !== undefined && (
        <div className="gm-bcode-actions">
          <span className="gm-bcode-count">
            {preview.files.length} {preview.files.length === 1 ? 'file' : 'files'} · generated here, byte for byte what Create writes
          </span>
          {file !== undefined && (
            <button className="gm-copy" onClick={() => void copy(file.path, file.content)} title={`Copy ${file.path}`}>
              {copied === file.path ? 'copied ✓' : 'copy file'}
            </button>
          )}
          <button className="gm-copy" onClick={() => void copy('all', bundle(preview))} title="Copy every file, with separators, and the commands">
            {copied === 'all' ? 'copied ✓' : 'copy all'}
          </button>
        </div>
      )}
      {file === undefined ? (
        <div className="gm-bcode-empty">
          The generated code appears here. Fix what the cards are flagging and it comes straight back.
        </div>
      ) : (
        <pre className="gm-bcode-pre" tabIndex={0}>
          <code>{file.content}</code>
        </pre>
      )}
      {preview !== undefined && (
        <div className="gm-bcode-foot">
          <span className="gm-section-label">Run it yourself</span>
          <code className="gm-bcode-cmd">{[...preview.install, preview.start].join(' && ')}</code>
          <span className="gm-bcode-note">
            with <code>npx graphmind-ai</code> running in another terminal. Needs{' '}
            <code>{preview.envKeys.filter((k) => k.required).map((k) => k.name).join(', ')}</code> in <code>.env</code>.
            {' '}
            The adapter is pinned at the published version; a server running from a GraphMind checkout rewrites that
            to a local tarball when it writes the project, because a checkout's version is not published yet.
          </span>
        </div>
      )}
    </section>
  );
}
