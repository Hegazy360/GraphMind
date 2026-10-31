/**
 * "Which parts of the run page do I want?"
 *
 * A dialog rather than another popover, for two reasons: it is reachable
 * from three places that are nowhere near each other (the View menu, the
 * bottom of the inspector, the palette), and nesting a nine-item checklist
 * inside the menu that already holds panes, folding and theme would be
 * solving crowding with more crowding.
 *
 * The two presets are shortcuts, not modes. Picking one sets every toggle;
 * changing any toggle afterwards just means the answer to "which preset is
 * this" becomes `custom`. There is no apply, no cancel and no unsaved state:
 * the page updates underneath as you click, which is the only honest way to
 * choose what a page should look like.
 */
import { useEffect, useRef } from 'react';
import { useUiStore } from '../store/uiStore.js';
import { PANELS, hiddenCount, presetOf, type PanelMeta } from '../store/workspace.js';
import { IconCheck, IconClose } from './Icons.js';

function PanelRow({ meta, on }: { meta: PanelMeta; on: boolean }) {
  return (
    <button
      className={`gm-cz-row${on ? ' gm-cz-row--on' : ''}`}
      role="switch"
      aria-checked={on}
      onClick={() => useUiStore.getState().togglePanel(meta.id)}
    >
      <span className="gm-cz-box" aria-hidden="true">
        {on && <IconCheck width={10} height={10} />}
      </span>
      <span className="gm-cz-text">
        <span className="gm-cz-label">{meta.label}</span>
        <span className="gm-cz-hint">{meta.hint}</span>
      </span>
    </button>
  );
}

export function CustomizePanel() {
  const open = useUiStore((s) => s.customizeOpen);
  const panels = useUiStore((s) => s.panels);
  const close = useUiStore((s) => s.setCustomizeOpen);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    dialog.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // The canvas clears its selection on Escape too; closing this is the
      // more local intent, so it eats the key.
      event.stopPropagation();
      close(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, close]);

  if (!open) return null;

  const preset = presetOf(panels);
  const hidden = hiddenCount(panels);
  const groups: PanelMeta['group'][] = ['Inspector', 'Canvas'];

  return (
    <div className="gm-cz-scrim" onMouseDown={() => close(false)}>
      <div
        className="gm-cz"
        role="dialog"
        aria-modal="true"
        aria-label="Customize the workspace"
        tabIndex={-1}
        ref={dialog}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="gm-cz-head">
          <div>
            <h2>Customize the run page</h2>
            <p>
              Start with the essentials and switch things on as you want them. Your choice is
              remembered in this browser and applies to every run.
            </p>
          </div>
          <button
            className="gm-iconbtn"
            onClick={() => close(false)}
            title="Close (esc)"
            aria-label="Close"
          >
            <IconClose />
          </button>
        </header>

        <div className="gm-section-label">Start from</div>
        <div className="gm-seg gm-seg--wide" role="radiogroup" aria-label="Preset">
          <button
            className={preset === 'essentials' ? 'gm-seg--on' : ''}
            role="radio"
            aria-checked={preset === 'essentials'}
            onClick={() => useUiStore.getState().applyPreset('essentials')}
          >
            Essentials
          </button>
          <button
            className={preset === 'everything' ? 'gm-seg--on' : ''}
            role="radio"
            aria-checked={preset === 'everything'}
            onClick={() => useUiStore.getState().applyPreset('everything')}
          >
            Everything
          </button>
          {preset === 'custom' && (
            <button className="gm-seg--on" role="radio" aria-checked disabled>
              Custom
            </button>
          )}
        </div>

        {groups.map((group) => (
          <section key={group}>
            <div className="gm-section-label" style={{ marginTop: 14 }}>
              {group}
            </div>
            <div className="gm-cz-list">
              {PANELS.filter((meta) => meta.group === group).map((meta) => (
                <PanelRow key={meta.id} meta={meta} on={panels[meta.id]} />
              ))}
            </div>
          </section>
        ))}

        <footer className="gm-cz-foot">
          {hidden === 0
            ? 'Everything this run reported is on screen.'
            : `${hidden} panel${hidden === 1 ? '' : 's'} switched off.`}{' '}
          A held run always shows why it is held and how to release it, whatever is set here.
        </footer>
      </div>
    </div>
  );
}
