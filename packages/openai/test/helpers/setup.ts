/**
 * Shared wiring for the suites: a fake debugger WebSocket server, a fake
 * OpenAI HTTP endpoint, and a real `OpenAI` client wired to both through the
 * public adapter API.
 */
import OpenAI from 'openai';
import { graphmind, type Graphmind, type GraphmindOptions } from '../../src/index.js';
import { FakeOpenAI } from './fake-openai.js';
import { FakeViewer, type FakeViewerOptions } from './fake-viewer.js';

export interface Harness {
  viewer: FakeViewer;
  server: FakeOpenAI;
  gm: Graphmind;
  client: OpenAI;
  /** The un-wrapped client, for no-mutation assertions. */
  raw: OpenAI;
  warnings: string[];
}

export async function setup(
  server: FakeOpenAI,
  viewerOptions: FakeViewerOptions = {},
  gmOptions: Partial<GraphmindOptions> = {},
  cleanups: (() => Promise<void> | void)[] = [],
): Promise<Harness> {
  const viewer = await FakeViewer.start(viewerOptions);
  const warnings: string[] = [];
  const gm = graphmind({
    url: viewer.url,
    enabled: true,
    retryIntervalMs: 60_000,
    logger: (message) => warnings.push(message),
    ...gmOptions,
  });
  const raw = new OpenAI({ apiKey: 'test-key', fetch: server.fetch, maxRetries: 0 });
  const client = gm.wrapClient(raw);
  cleanups.push(async () => {
    await gm.dispose();
    await viewer.close();
  });
  return { viewer, server, gm, client, raw, warnings };
}

/** Deltas of one channel observed for a node, concatenated in arrival order. */
export function observedText(
  viewer: FakeViewer,
  nodeId: string,
  channel: 'text' | 'reasoning' | 'tool-args',
): string {
  return viewer
    .ofType('node.token')
    .filter((frame) => frame.payload['nodeId'] === nodeId)
    .flatMap((frame) => frame.payload['deltas'] as { t: string; v: string }[])
    .filter((delta) => delta.t === channel)
    .map((delta) => delta.v)
    .join('');
}

/** Same, but only the batches belonging to one execution of that node. */
export function observedTextForInstance(
  viewer: FakeViewer,
  nodeId: string,
  instanceId: string,
  channel: 'text' | 'reasoning' | 'tool-args',
): string {
  return viewer
    .ofType('node.token')
    .filter(
      (frame) => frame.payload['nodeId'] === nodeId && frame.payload['instanceId'] === instanceId,
    )
    .flatMap((frame) => frame.payload['deltas'] as { t: string; v: string }[])
    .filter((delta) => delta.t === channel)
    .map((delta) => delta.v)
    .join('');
}

export function framesFor(viewer: FakeViewer, type: string, nodeId: string) {
  return viewer.ofType(type).filter((frame) => frame.payload['nodeId'] === nodeId);
}
