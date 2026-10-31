/**
 * Run-source badges, and whether a stranger is shown how to connect.
 *
 * Both are one-liners that the components would otherwise have to carry
 * inline; keeping them here means the rules are unit-testable without a DOM.
 */
import type { ConnectionStatus } from '../store/uiStore.js';

/** The label on a run's source chip in the runs list. */
export function runChipLabel(meta: { source: string; serverSource?: string }): string {
  if (meta.serverSource === 'demo') return 'recorded session';
  if (meta.source === 'fixture') return 'replay';
  if (meta.serverSource === 'import') return 'imported';
  return 'live';
}

const SEEN_KEY = 'graphmind.connectSeen';

/** Whether this browser has been shown the connect page before. */
export function connectSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function markConnectSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // a blocked storage just means it offers itself again next time
  }
}

/**
 * Whether to open the connect page instead of an empty runs list.
 *
 * Only on a genuinely cold start: the viewer has to have settled (an
 * attached server or a confirmed absent one — not the connecting flicker),
 * there has to be nothing to look at, and the reader must not have been
 * here before. A deep link always wins; App.tsx checks the hash first.
 */
export function shouldOpenConnect(
  connection: ConnectionStatus,
  runCount: number,
  seen: boolean,
): boolean {
  if (seen || runCount > 0) return false;
  return connection === 'live' || connection === 'detached';
}
