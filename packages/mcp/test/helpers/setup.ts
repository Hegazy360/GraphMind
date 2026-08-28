/**
 * Shared wiring for the suites: a fake viewer + a `graphmind()` pointed at it,
 * torn down after every test.
 */
import { graphmind, type Graphmind, type GraphmindOptions } from '../../src/index.js';
import { FakeViewer, waitUntil, type FakeViewerOptions } from './fake-viewer.js';

export interface Setup {
  viewer: FakeViewer;
  gm: Graphmind;
  warnings: string[];
}

export function makeCleanups(): {
  push: (fn: () => Promise<void> | void) => void;
  run: () => Promise<void>;
} {
  const cleanups: (() => Promise<void> | void)[] = [];
  return {
    push: (fn) => cleanups.push(fn),
    run: async () => {
      while (cleanups.length > 0) await cleanups.pop()?.();
    },
  };
}

export async function setup(
  push: (fn: () => Promise<void> | void) => void,
  viewerOptions: FakeViewerOptions = {},
  gmOptions: Partial<GraphmindOptions> = {},
): Promise<Setup> {
  const viewer = await FakeViewer.start(viewerOptions);
  const warnings: string[] = [];
  const gm = graphmind({
    url: viewer.url,
    enabled: true,
    retryIntervalMs: 60_000,
    logger: (message) => warnings.push(message),
    ...gmOptions,
  });
  push(async () => {
    await gm.dispose();
    await viewer.close();
  });
  return { viewer, gm, warnings };
}

/** Force the session to start its transport and wait until it is attached. */
export async function attach(gm: Graphmind): Promise<void> {
  void gm.session.gate('after', { nodeId: '__warmup', kind: 'custom', name: '__warmup' });
  await waitUntil(() => gm.session.attached, 8000, 'session attach');
}
