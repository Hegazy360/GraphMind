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
const RUN_OPENED_KEY = 'graphmind.firstRunOpened';

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

/** Whether this browser has already been dropped into a run on arrival. */
export function firstRunOpened(): boolean {
  try {
    return localStorage.getItem(RUN_OPENED_KEY) === '1';
  } catch {
    return false;
  }
}

export function markFirstRunOpened(): void {
  try {
    localStorage.setItem(RUN_OPENED_KEY, '1');
  } catch {
    // a blocked storage just means the convenience repeats
  }
}

/**
 * Whether arriving should open a run rather than the list.
 *
 * With one run on the machine and nothing else to look at, making someone
 * click it is ceremony — but only the first time. It used to fire on every
 * mount, so each reload against a server with a replay on it teleported the
 * reader into `#/run/demo-…` when they had asked for the home page, with no
 * way to simply be on it.
 *
 * Two limits, therefore: once per browser, and never for a demo replay —
 * which is what `pnpm dev` serves, is nobody's own work, and is the case
 * where the teleport is pure noise.
 */
export function shouldOpenFirstRun(
  run: { meta: { serverSource?: string } } | undefined,
  seen: boolean,
): boolean {
  if (seen || run === undefined) return false;
  return run.meta.serverSource !== 'demo';
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
