/**
 * What this tab may do on the server it is attached to (0.6, contract C3),
 * read off `welcome.control` — so the UI offers only what the server will
 * accept, instead of a button whose click comes back refused.
 *
 *  - the viewer token: everything (edits unless the server runs with
 *    `--no-edit-input`);
 *  - the agent token (a script presenting it): what `--allow-control` allows;
 *  - no token: continue, retry and abort only — never inject, edit, step or
 *    breakpoints.
 *
 * No `control` (a replay, an exported run, a 0.5 server, the socket not yet
 * welcomed): nothing is withheld here; the server still has the last word.
 */
import type { ControlInfo } from '../store/uiStore.js';

export type ControlRight = 'inject' | 'edit' | 'debug';

const LEVELS: readonly ControlInfo['agentLevel'][] = ['off', 'resume', 'inject', 'edit'];

const NEEDS: Record<ControlRight, ControlInfo['agentLevel']> = { debug: 'resume', inject: 'inject', edit: 'edit' };

export function controlAllows(control: ControlInfo | undefined, right: ControlRight): boolean {
  if (control === undefined) return true;
  if (right === 'edit' && !control.editInput) return false;
  if (control.principal === 'viewer') return true;
  if (control.principal === 'agent') return LEVELS.indexOf(control.agentLevel) >= LEVELS.indexOf(NEEDS[right]);
  return false;
}

/** Said where a tokenless tab's missing controls would be. */
export const TOKENLESS_NOTE =
  'No token: this tab can continue, retry and abort. Open the viewer from the link `graphmind serve` ' +
  'printed (or its redirect file) to inject, step, edit arguments or change breakpoints.';
