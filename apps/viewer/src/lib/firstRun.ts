/**
 * First-run + run-badge logic, kept as plain functions so the components
 * stay declarative and the behavior is unit-testable without a DOM.
 */
import type { ConnectionStatus } from '../store/uiStore.js';

/** The label on a run's source chip in the runs list. */
export function runChipLabel(meta: { source: string; serverSource?: string }): string {
  if (meta.serverSource === 'demo') return 'recorded session';
  if (meta.source === 'fixture') return 'replay';
  if (meta.serverSource === 'import') return 'imported';
  return 'live';
}

/**
 * The crafted welcome card is the first-run experience: shown only when the
 * viewer is CONNECTED to a server that has ZERO runs. While detached the
 * plain waiting state (with the offline fixture demo) is more honest.
 */
export function shouldShowWelcome(connection: ConnectionStatus, runCount: number): boolean {
  return connection === 'live' && runCount === 0;
}

/** The three-line integration snippet on the welcome card. */
export const INTEGRATION_SNIPPET = [
  "const gm = graphmind({ app: 'my-agent' });",
  'const model = gm.wrapModel(yourModel), tools = gm.wrapTools(yourTools);',
  "await gm.run('task', () => streamText({ model, tools, prompt }));",
].join('\n');
