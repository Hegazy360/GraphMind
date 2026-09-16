/**
 * The run list must agree with the session node. A session whose server never
 * got going (spawn failed, or it exited before its first response) used to end
 * with `run.finished { status: 'ok' }` — run status is "did the callback
 * throw", and nothing threw — while the session node was red. The proxy now
 * throws McpSessionFailedError out of the run callback for exactly those two
 * conditions, and nothing else.
 */
import type { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeViewer, ProxyRig, tick, waitUntil, type ReceivedFrame } from './mcp-proxy-harness.js';

let viewer: FakeViewer | undefined;
let rig: ProxyRig | undefined;

afterEach(async () => {
  if (rig !== undefined) {
    rig.endClient();
    await Promise.race([rig.handle.done, tick(3000)]);
    rig.handle.stop('SIGKILL');
    rig = undefined;
  }
  if (viewer !== undefined) {
    await viewer.close();
    viewer = undefined;
  }
});

const runFinished = (v: FakeViewer): ReceivedFrame | undefined => v.ofType('run.finished')[0];
const errorOf = (f: ReceivedFrame | undefined): { name?: string; message?: string } =>
  (f?.payload['error'] as { name?: string; message?: string } | undefined) ?? {};

describe('mcp-proxy: run status agrees with the session node', () => {
  it('a spawn that fails ends the RUN with status error, naming the reason', async () => {
    const einval = (): never => {
      throw Object.assign(new Error('spawn npx.cmd EINVAL'), { code: 'EINVAL', syscall: 'spawn' });
    };
    const v = await FakeViewer.start({ breakpoints: [] });
    viewer = v;
    const r = new ProxyRig({
      command: 'npx.cmd',
      args: ['-y', 'some-server'],
      spawnFn: einval as unknown as typeof spawn,
      viewerUrl: v.url,
      waitForAttach: true,
    });
    rig = r;
    const code = await r.finish();
    rig = undefined;
    expect(code).toBe(127);

    await waitUntil(() => v.ofType('run.finished').length === 1, 'run.finished');
    const finished = runFinished(v);
    expect(finished?.payload['status']).toBe('error');
    expect(errorOf(finished).name).toBe('McpSessionFailed');
    expect(errorOf(finished).message).toContain('cannot run "npx.cmd"');
    // The expected failure path is not an "internal failure".
    expect(r.logs.join('\n')).not.toContain('unexpected internal failure');
    // Exactly one run, and the node error precedes the run's end.
    expect(v.ofType('run.started')).toHaveLength(1);
    const nodeError = v.ofType('node.error').find((f) => f.payload['nodeId'] === 'mcp:session');
    expect(nodeError?.seq).toBeLessThan(finished?.seq ?? -1);
  });

  it('a server that exits before answering anything ends the RUN with status error', async () => {
    const v = await FakeViewer.start({ breakpoints: [] });
    viewer = v;
    const r = new ProxyRig({ server: 'crash-server.mjs', viewerUrl: v.url, waitForAttach: true });
    rig = r;
    // The host writes initialize the instant it spawns the server; the server
    // dies on boot without answering it.
    r.clientIn.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
    );
    await r.finish();
    rig = undefined;

    await waitUntil(() => v.ofType('run.finished').length === 1, 'run.finished');
    const finished = runFinished(v);
    expect(finished?.payload['status']).toBe('error');
    expect(errorOf(finished).name).toBe('McpSessionFailed');
    expect(errorOf(finished).message).toContain('before answering anything');
    expect(r.logs.join('\n')).not.toContain('unexpected internal failure');
  });

  it('a session that answered stays status ok, even when the server exits non-zero later', async () => {
    const v = await FakeViewer.start({ breakpoints: [] });
    viewer = v;
    const r = new ProxyRig({ server: 'raw-server.mjs', viewerUrl: v.url, waitForAttach: true });
    rig = r;
    await waitUntil(() => r.handle.session.attached, 'the proxy to attach');
    r.clientIn.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
    await waitUntil(
      () => v.ofType('node.finished').some((f) => f.payload['nodeId'] === 'mcp:ping'),
      'the ping to be answered',
    );
    r.endClient();
    await r.handle.done;
    rig = undefined;

    await waitUntil(() => v.ofType('run.finished').length === 1, 'run.finished');
    expect(runFinished(v)?.payload['status']).toBe('ok');
  });
});
