/**
 * The generated project, file by file, exactly as Create will write it.
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

export function CodePanel({
  preview,
  pending,
  error,
}: {
  preview: PreviewResponse | undefined;
  pending: boolean;
  error: string | undefined;
}) {
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
        <div className="gm-bcode-actions">
          {pending && <span className="gm-bcode-pending">updating…</span>}
          {file !== undefined && (
            <button className="gm-copy" onClick={() => void copy(file.path, file.content)} title={`Copy ${file.path}`}>
              {copied === file.path ? 'copied ✓' : 'copy file'}
            </button>
          )}
          {preview !== undefined && (
            <button className="gm-copy" onClick={() => void copy('all', bundle(preview))} title="Copy every file, with separators, and the commands">
              {copied === 'all' ? 'copied ✓' : 'copy all'}
            </button>
          )}
        </div>
      </div>
      {error !== undefined ? (
        <div className="gm-bcode-error">{error}</div>
      ) : file === undefined ? (
        <div className="gm-bcode-empty">{pending ? 'Generating…' : 'The generated code appears here.'}</div>
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
            {preview.source === 'checkout' && (
              <>
                {' '}
                This server runs from a GraphMind checkout, so the adapter is a local tarball (its version is not
                published yet); a published <code>graphmind-ai</code> would pin the registry instead.
              </>
            )}
          </span>
        </div>
      )}
    </section>
  );
}
