/**
 * The 2026-07-28 era in-process: the v2 server served through `serveStdio`
 * (the only v2 entry that speaks the modern era) over the in-memory pair, with
 * the v2 client pinned to 2026-07-28. No `initialize`, a per-request `_meta`
 * envelope, `resultType` on every result — and, because this adapter sits at
 * the HANDLER, the SDK's own encode seam stamps all of that onto whatever a
 * gate returns. That is the one place the in-process adapter is strictly
 * ahead of the proxy on the modern era: a bare injected value is accepted by
 * the 2026 client here, and rejected through the proxy (see the KNOWN GAP
 * test in packages/cli/test/mcp-proxy-v2.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ReceivedFrame } from './helpers/fake-viewer.js';
import { makeHarnessV2, resourceText, toolText } from './helpers/mcp-v2.js';
import { attach, makeCleanups, setup } from './helpers/setup.js';

const cleanups = makeCleanups();
afterEach(cleanups.run);

const pausedOn =
  (nodeId: string, point = 'before') =>
  (f: ReceivedFrame): boolean =>
    f.type === 'exec.paused' && f.payload['nodeId'] === nodeId && f.payload['point'] === point;
const start = (frames: ReceivedFrame[], nodeId: string): ReceivedFrame | undefined =>
  frames.find((f) => f.type === 'node.started' && f.payload['nodeId'] === nodeId);

describe('v2 on the 2026-07-28 era (serveStdio + pinned client)', () => {
  it('negotiates the modern era and instruments tools, resources and prompts the same way', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const h = await makeHarnessV2(gm, { modern: true });
    cleanups.push(h.close);

    expect(h.client.getProtocolEra()).toBe('modern');
    expect(h.client.getNegotiatedProtocolVersion()).toBe('2026-07-28');

    expect(toolText(await h.client.callTool({ name: 'searchFlights', arguments: { from: 'VIE', to: 'LIS' } }))).toContain(
      'TP1234',
    );
    expect(resourceText(await h.client.readResource({ uri: 'users://9/profile' }))).toBe(JSON.stringify({ id: '9' }));
    expect(JSON.stringify((await h.client.getPrompt({ name: 'greet', arguments: { name: 'Bo' } })).messages)).toContain(
      'Say hello to Bo',
    );

    await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'prompt:greet');
    expect(start(viewer.received, 'tool:searchFlights')?.payload).toMatchObject({
      kind: 'tool',
      parentId: 'server:trip-server-v2',
      input: { from: 'VIE', to: 'LIS' },
    });
    // The handler-level input is the VALIDATED arguments: no `_meta` envelope
    // leaks into it, unlike the raw frame the proxy sees.
    expect(start(viewer.received, 'tool:searchFlights')?.payload['input']).not.toHaveProperty('_meta');
    expect(start(viewer.received, 'resource:userProfile')?.payload['input']).toEqual({
      uri: 'users://9/profile',
      variables: { id: '9' },
    });
    expect(start(viewer.received, 'prompt:greet')?.payload['input']).toEqual({ name: 'Bo' });
    // instanceId still comes from the JSON-RPC id on this era.
    expect(start(viewer.received, 'tool:searchFlights')?.payload['instanceId']).toMatch(/:\d+$/);
  });

  it('a bare injected value is accepted by the 2026 client: the SDK stamps resultType after our gate', async () => {
    const { viewer, gm } = await setup(cleanups.push, {
      breakpoints: [{ kind: 'tool', name: 'searchFlights' }, { kind: 'resource', point: 'after' }],
    });
    await attach(gm);
    const h = await makeHarnessV2(gm, { modern: true });
    cleanups.push(h.close);

    const call = h.client.callTool({ name: 'searchFlights', arguments: { from: 'A', to: 'B' } });
    const p1 = await viewer.waitFor(pausedOn('tool:searchFlights'));
    viewer.resume(p1.payload['pauseId'] as string, 'inject', 'grounded');
    const result = (await call) as { isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(toolText(result)).toBe('grounded');
    expect(h.attempts.get('searchFlights')).toBeUndefined();

    // resources/read is a CACHEABLE result on 2026-07-28 (ttlMs/cacheScope
    // required on the wire); the SDK fills those in below our gate too.
    const read = h.client.readResource({ uri: 'config://app' });
    const p2 = await viewer.waitFor(pausedOn('resource:appConfig', 'after'));
    viewer.resume(p2.payload['pauseId'] as string, 'inject', 'from the debugger');
    const contents = await read;
    expect(resourceText(contents)).toBe('from the debugger');
    expect((contents as { cacheScope?: string }).cacheScope).toBe('private');
  });

  it('input_required (the 2026 way to ask the client LLM): two executions of the tool, the answer in the retry', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const h = await makeHarnessV2(gm, { modern: true, samplingAnswer: 'forty-two' });
    cleanups.push(h.close);

    const result = await h.client.callTool({ name: 'askModel', arguments: { text: 'meaning?' } });
    expect(toolText(result)).toBe('model said: forty-two');
    expect(h.attempts.get('askModel')).toBe(2);

    await viewer.waitFor(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:askModel' &&
        JSON.stringify(f.payload['output']).includes('model said'),
    );
    const starts = viewer.received.filter((f) => f.type === 'node.started' && f.payload['nodeId'] === 'tool:askModel');
    const finishes = viewer.received.filter((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:askModel');
    expect(starts).toHaveLength(2);
    expect(finishes).toHaveLength(2);
    // Round one answered input_required (recorded as that execution's output);
    // round two is a fresh request id, so a fresh execution.
    expect((finishes[0]?.payload['output'] as { resultType?: string }).resultType).toBe('input_required');
    expect(starts[0]?.payload['instanceId']).not.toBe(starts[1]?.payload['instanceId']);
    expect(finishes[0]?.payload['status']).toBe('ok');
    expect(finishes[1]?.payload['status']).toBe('ok');
    // No server->client sampling request exists on this era: no llm node.
    expect(viewer.received.some((f) => f.type === 'node.started' && f.payload['nodeId'] === 'llm:sampling')).toBe(false);
  });

  it('requestSampling on the modern era fails inside the SDK (no server->client channel) and is recorded as the llm node error', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const h = await makeHarnessV2(gm, { modern: true });
    cleanups.push(h.close);

    const result = (await h.client.callTool({ name: 'summarize', arguments: { text: 'doc' } })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    const errored = await viewer.waitFor((f) => f.type === 'node.error' && f.payload['nodeId'] === 'llm:sampling');
    expect(typeof (errored.payload['error'] as { message: string }).message).toBe('string');
    const finished = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:sampling');
    expect(finished.payload['status']).toBe('error');
  });

  it('error gate + abort behave the same on the modern era', async () => {
    const { viewer, gm } = await setup(cleanups.push, {
      breakpoints: [{ point: 'error' }, { kind: 'tool', name: 'slow' }],
    });
    await attach(gm);
    const h = await makeHarnessV2(gm, { modern: true, flakyFailures: 1 });
    cleanups.push(h.close);

    const call = h.client.callTool({ name: 'flaky', arguments: { n: 3 } });
    const p1 = await viewer.waitFor(pausedOn('tool:flaky', 'error'));
    viewer.resume(p1.payload['pauseId'] as string, 'retry');
    expect(toolText(await call)).toBe('ok after 2 attempts: 3');

    const aborted = h.client.callTool({ name: 'slow', arguments: { ms: 5 } });
    const p2 = await viewer.waitFor(pausedOn('tool:slow'));
    viewer.resume(p2.payload['pauseId'] as string, 'abort');
    const result = (await aborted) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(h.attempts.get('slow')).toBeUndefined();
  });
});
