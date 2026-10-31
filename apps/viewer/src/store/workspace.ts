/**
 * What the run page is made of, and which parts of it you want.
 *
 * The debugger shows a lot because there is a lot to show: a failed call has
 * an error, a stack, the input that caused it, the siblings that did not
 * fail, timings, token counts, a cost, the other executions of the same node,
 * the streamed text, and who released the last hold. All of it is useful to
 * *someone*. Printing all of it to everyone, on the first run they ever open,
 * is how a debugger reads as a wall.
 *
 * So the page has a base — `essentials`, what you need to read a run and act
 * on a hold — and every other panel is a thing you switch on once you know
 * you want it. The preset is a shortcut for a set of panel toggles, not a
 * mode: flip any single toggle and you are simply in `custom`, with no state
 * lost and nothing to undo.
 *
 * Nothing here can hide *why a run is held*. The pause banner, the hold
 * evidence and the decision row are not panels; they are the product.
 */

export type PanelId =
  // ── inspector ──
  | 'failure'
  | 'timing'
  | 'payloads'
  | 'context'
  | 'history'
  | 'stream'
  | 'identity'
  // ── chrome ──
  | 'overlays'
  | 'diagnostics';

export type Panels = Record<PanelId, boolean>;

export type PresetId = 'essentials' | 'everything' | 'custom';

export interface PanelMeta {
  id: PanelId;
  group: 'Inspector' | 'Canvas';
  label: string;
  /** What switching it on actually adds — shown beside the checkbox. */
  hint: string;
}

/**
 * Declaration order is the order of the checklist, and (for the inspector
 * ones) roughly the order they appear down the panel.
 */
export const PANELS: PanelMeta[] = [
  {
    id: 'failure',
    group: 'Inspector',
    label: 'Why it failed',
    hint: 'The error, its stack, the input that caused it, and what ran around it',
  },
  {
    id: 'payloads',
    group: 'Inspector',
    label: 'Input and output',
    hint: 'The values this call received and returned',
  },
  {
    id: 'timing',
    group: 'Inspector',
    label: 'Timing and tokens',
    hint: 'Duration, held time, token counts for this one execution',
  },
  {
    id: 'context',
    group: 'Inspector',
    label: 'Context and cost',
    hint: 'What the model saw, how it changed since the last step, and the estimate',
  },
  {
    id: 'history',
    group: 'Inspector',
    label: 'History',
    hint: 'Totals across every execution of this node, and who released its holds',
  },
  {
    id: 'stream',
    group: 'Inspector',
    label: 'Streamed text',
    hint: 'The tokens as they arrived, and any reasoning the model emitted',
  },
  {
    id: 'identity',
    group: 'Inspector',
    label: 'Node id',
    hint: 'The logical id and a deep link to this exact node',
  },
  {
    id: 'overlays',
    group: 'Canvas',
    label: 'Minimap and size readout',
    hint: 'Only ever shown on a graph large enough to need them',
  },
  {
    id: 'diagnostics',
    group: 'Canvas',
    label: 'Connection detail',
    hint: 'Who this tab is to the server, what a coding agent may do, and the endpoint',
  },
];

const ALL_ON: Panels = {
  failure: true,
  timing: true,
  payloads: true,
  context: true,
  history: true,
  stream: true,
  identity: true,
  overlays: true,
  diagnostics: true,
};

/**
 * The base. Enough to answer "what happened, what went in, what came out,
 * how long did it take" and to decide what to do about a hold — and nothing
 * whose value you cannot guess from its name before you have needed it.
 *
 * `overlays` is on because it is already self-limiting: the minimap and the
 * size readout appear only above the graph sizes that need them, so on a
 * small run they cost nothing and on a big one they are navigation.
 */
export const ESSENTIALS: Panels = {
  failure: true,
  timing: true,
  payloads: true,
  overlays: true,
  context: false,
  history: false,
  stream: false,
  identity: false,
  diagnostics: false,
};

export const EVERYTHING: Panels = ALL_ON;

export function presetPanels(preset: Exclude<PresetId, 'custom'>): Panels {
  return preset === 'essentials' ? { ...ESSENTIALS } : { ...EVERYTHING };
}

function samePanels(a: Panels, b: Panels): boolean {
  return (Object.keys(ALL_ON) as PanelId[]).every((id) => a[id] === b[id]);
}

/** Which preset a set of toggles *is*, so the segmented control can say so. */
export function presetOf(panels: Panels): PresetId {
  if (samePanels(panels, ESSENTIALS)) return 'essentials';
  if (samePanels(panels, EVERYTHING)) return 'everything';
  return 'custom';
}

/** How many switched-off panels are waiting to be discovered. */
export function hiddenCount(panels: Panels): number {
  return (Object.keys(ALL_ON) as PanelId[]).filter((id) => !panels[id]).length;
}

const STORAGE_KEY = 'graphmind.workspace';

/**
 * Read the stored choice, defaulting to the base.
 *
 * Unknown keys are dropped and missing ones take the essentials value, so a
 * build that adds a panel does not resurrect a stale object — and a new panel
 * arrives switched off for someone on the base, which is the point of having
 * one.
 */
export function loadPanels(): Panels {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { ...ESSENTIALS };
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return { ...ESSENTIALS };
    const stored = parsed as Record<string, unknown>;
    const panels = { ...ESSENTIALS };
    for (const id of Object.keys(ALL_ON) as PanelId[]) {
      if (typeof stored[id] === 'boolean') panels[id] = stored[id];
    }
    return panels;
  } catch {
    return { ...ESSENTIALS };
  }
}

export function savePanels(panels: Panels): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(panels));
  } catch {
    // a blocked storage just means the choice is per-session
  }
}
