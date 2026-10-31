/**
 * The workspace: which parts of the run page a reader has switched on.
 *
 * The rules worth pinning are about *defaults* and *forward compatibility* —
 * what someone gets on install, and what happens to their choice when the
 * next release adds a panel they have never heard of.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ESSENTIALS,
  EVERYTHING,
  PANELS,
  hiddenCount,
  loadPanels,
  presetOf,
  presetPanels,
  savePanels,
  type PanelId,
  type Panels,
} from '../src/store/workspace.js';
import { useUiStore } from '../src/store/uiStore.js';

/** A localStorage that exists only for this test file. */
function stubStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

const ALL_IDS = PANELS.map((p) => p.id);

describe('the panel catalogue', () => {
  it('every panel is described well enough to choose it', () => {
    for (const panel of PANELS) {
      expect(panel.label.length).toBeGreaterThan(0);
      // The hint is what makes a checkbox decidable before you have used it.
      expect(panel.hint.length).toBeGreaterThan(10);
    }
  });

  it('ids are unique and both presets cover every one of them', () => {
    expect(new Set(ALL_IDS).size).toBe(ALL_IDS.length);
    for (const id of ALL_IDS) {
      expect(typeof ESSENTIALS[id]).toBe('boolean');
      expect(typeof EVERYTHING[id]).toBe('boolean');
    }
  });
});

describe('the base', () => {
  it('keeps what you need to read a run and act on a hold', () => {
    expect(ESSENTIALS.failure).toBe(true);
    expect(ESSENTIALS.payloads).toBe(true);
    expect(ESSENTIALS.timing).toBe(true);
  });

  it('leaves the rest off — a base that shows everything is not a base', () => {
    expect(ESSENTIALS.context).toBe(false);
    expect(ESSENTIALS.history).toBe(false);
    expect(ESSENTIALS.stream).toBe(false);
    expect(ESSENTIALS.identity).toBe(false);
    expect(ESSENTIALS.diagnostics).toBe(false);
    expect(hiddenCount(ESSENTIALS)).toBe(5);
  });

  it('keeps the canvas overlays, which already limit themselves by graph size', () => {
    expect(ESSENTIALS.overlays).toBe(true);
  });

  it('everything is everything', () => {
    expect(hiddenCount(EVERYTHING)).toBe(0);
  });
});

describe('presetOf', () => {
  it('recognises each preset exactly', () => {
    expect(presetOf(presetPanels('essentials'))).toBe('essentials');
    expect(presetOf(presetPanels('everything'))).toBe('everything');
  });

  it('one changed toggle is custom, in either direction', () => {
    expect(presetOf({ ...ESSENTIALS, stream: true })).toBe('custom');
    expect(presetOf({ ...EVERYTHING, stream: false })).toBe('custom');
  });

  it('presetPanels hands back a copy, so a caller cannot mutate the preset', () => {
    const panels = presetPanels('essentials');
    panels.stream = true;
    expect(ESSENTIALS.stream).toBe(false);
  });
});

describe('persistence', () => {
  beforeEach(() => {
    stubStorage();
  });

  it('a browser that has never chosen gets the base', () => {
    expect(loadPanels()).toEqual(ESSENTIALS);
  });

  it('round-trips a custom choice', () => {
    const chosen: Panels = { ...ESSENTIALS, stream: true, identity: true };
    savePanels(chosen);
    expect(loadPanels()).toEqual(chosen);
    expect(presetOf(loadPanels())).toBe('custom');
  });

  it('a panel added by a later release arrives switched off for someone on the base', () => {
    // A stored object written before `stream` existed.
    const old: Record<string, boolean> = {};
    for (const id of ALL_IDS) if (id !== 'stream') old[id] = ESSENTIALS[id];
    localStorage.setItem('graphmind.workspace', JSON.stringify(old));
    expect(loadPanels().stream).toBe(false);
  });

  it('a panel added by a later release is still off for someone on everything', () => {
    // Deliberate: a reader who chose "everything" once did not consent to
    // every panel invented afterwards. They become `custom` and can opt in.
    const old: Record<string, boolean> = {};
    for (const id of ALL_IDS) if (id !== 'stream') old[id] = true;
    localStorage.setItem('graphmind.workspace', JSON.stringify(old));
    expect(loadPanels().stream).toBe(false);
    expect(presetOf(loadPanels())).toBe('custom');
  });

  it('ignores junk rather than throwing', () => {
    localStorage.setItem('graphmind.workspace', 'not json');
    expect(loadPanels()).toEqual(ESSENTIALS);
    localStorage.setItem('graphmind.workspace', '"a string"');
    expect(loadPanels()).toEqual(ESSENTIALS);
    localStorage.setItem('graphmind.workspace', JSON.stringify({ failure: 'yes', nope: 1 }));
    expect(loadPanels()).toEqual(ESSENTIALS);
  });

  it('survives storage being blocked entirely', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(loadPanels()).toEqual(ESSENTIALS);
    expect(() => savePanels(EVERYTHING)).not.toThrow();
  });
});

describe('the ui store', () => {
  beforeEach(() => {
    stubStorage();
    useUiStore.setState({ panels: { ...ESSENTIALS } });
  });

  it('toggling one panel moves to custom and persists', () => {
    useUiStore.getState().togglePanel('stream');
    expect(useUiStore.getState().panels.stream).toBe(true);
    expect(presetOf(useUiStore.getState().panels)).toBe('custom');
    expect(loadPanels().stream).toBe(true);
  });

  it('applying a preset replaces every toggle', () => {
    useUiStore.getState().togglePanel('stream');
    useUiStore.getState().applyPreset('everything');
    expect(presetOf(useUiStore.getState().panels)).toBe('everything');
    useUiStore.getState().applyPreset('essentials');
    expect(useUiStore.getState().panels).toEqual(ESSENTIALS);
    expect(loadPanels()).toEqual(ESSENTIALS);
  });

  it('toggling is reversible with no other state lost', () => {
    const before = { ...useUiStore.getState().panels };
    const id: PanelId = 'identity';
    useUiStore.getState().togglePanel(id);
    useUiStore.getState().togglePanel(id);
    expect(useUiStore.getState().panels).toEqual(before);
  });
});
