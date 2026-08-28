/**
 * Gate semantics, proved end to end: a real MCP client calls a real MCP
 * server, and every assertion is about what that client received.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { tick, waitUntil, type ReceivedFrame } from './helpers/fake-viewer.js';
import { makeHarness, resourceText, resourceUri, toolText } from './helpers/mcp.js';
import { attach, makeCleanups, setup } from './helpers/setup.js';

const cleanups = makeCleanups();
afterEach(cleanups.run);

const pausedOn = (nodeId: string, point = 'before') =>
  (f: ReceivedFrame): boolean =>
    f.type === 'exec.paused' && f.payload['nodeId'] === nodeId && f.payload['point'] === point;

describe('before gate', () => {
  it('holds the request: the handler body has not started while the gate is held', async () => {
    const { viewer, gm } = await setup(cleanups.push, {
      breakpoints: [{ kind: 'tool', name: 'searchFlights' }],
    });
    await attach(gm);
    const h = await makeHarness(gm);
    cleanups.push(h.close);

    const call = h.client.callTool({
      name: 'searchFlights',
      arguments: { from: 'VIE', to: 'LIS' },
    });
    const paused = await viewer.waitFor(pausedOn('tool:searchFlights'));
    const pausedAt = Date.now();

    await tick(1200);
    // Nothing is in flight: the handler has not run a single line.
    expect(h.marks.first('tool:body-start')).toBeUndefined();

    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    const result = await call;

    expect(toolText(result)).toContain('TP1234');
    const started = h.marks.first('tool:body-start')!;
    expect(started.at - pausedAt).toBeGreaterThanOrEqual(1150);
    expect(viewer.ofType('exec.resumed')).toHaveLength(1);
  });

  it('inject substitutes the RESULT the client receives; the handler never runs', async () => {
    const { viewer, gm } = await setup(cleanups.push, {
      breakpoints: [{ kind: 'tool', name: 'searchFlights' }],
    });
    await attach(gm);
    const h = await makeHarness(gm);
    cleanups.push(h.close);

    const call = h.client.callTool({
      name: 'searchFlights',
      arguments: { from: 'VIE', to: 'LIS' },
    });
    const paused = await viewer.waitFor(pausedOn('tool:searchFlights'));
    viewer.resume(paused.payload['pauseId'] as string, 'inject', {
      content: [{ type: 'text', text: 'NO FLIGHTS AVAILABLE' }],
    });

    const result = await call;
    expect(toolText(result)).toBe('NO FLIGHTS AVAILABLE');
    expect(h.attempts.get('searchFlights')).toBeUndefined(); // never executed

    const finished = await viewer.waitFor(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:searchFlights',
    );
    expect(finished.payload['injected']).toBe(true);
    expect(finished.payload['injectedAt']).toBe('before');
  });

  it('a raw value is lifted into a valid CallToolResult (string and object)', async () => {
    const { viewer, gm } = await setup(cleanups.push, { breakpoints: [{ kind: 'tool' }] });
    await attach(gm);
    const h = await makeHarness(gm);
    cleanups.push(h.close);

    const first = h.client.callTool({ name: 'ping' });
    const p1 = await viewer.waitFor(pausedOn('tool:ping'));
    viewer.resume(p1.payload['pauseId'] as string, 'inject', 'just a string');
    expect(toolText(await first)).toBe('just a string');

    // An object also lands in structuredContent, so a tool that declares an
    // outputSchema still validates.
    const second = h.client.callTool({ name: 'quote', arguments: { symbol: 'ACME' } });
    const p2 = await viewer.waitFor(pausedOn('tool:quote'));
    viewer.resume(p2.payload['pauseId'] as string, 'inject', { symbol: 'ACME', price: 999 });
    const result = (await second) as { structuredContent?: unknown; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ symbol: 'ACME', price: 999 });
  });

  it('abort makes the request terminal without running the handler', async () => {
    const { viewer, gm } = await setup(cleanups.push, {
      breakpoints: [{ kind: 'tool', name: 'searchFlights' }],
    });
    await attach(gm);
    const h = await makeHarness(gm);
    cleanups.push(h.close);

    const call = h.client.callTool({
      name: 'searchFlights',
      arguments: { from: 'VIE', to: 'LIS' },
    });
    const paused = await viewer.waitFor(pausedOn('tool:searchFlights'));
    viewer.resume(paused.payload['pauseId'] as string, 'abort');

    const result = (await call) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain('GraphMind');
    expect(h.attempts.get('searchFlights')).toBeUndefined();

    const finished = await viewer.waitFor(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:searchFlights',
    );
    expect(finished.payload['status']).toBe('aborted');
  });
});

describe('after gate', () => {
  it('fires post-handler, pre-return: inject rewrites a result the handler produced', async () => {
    const { viewer, gm } = await setup(cleanups.push, {
      breakpoints: [{ kind: 'tool', name: 'searchFlights', point: 'after' }],
    });
    await attach(gm);
    const h = await makeHarness(gm);
    cleanups.push(h.close);

    const call = h.client.callTool({
      name: 'searchFlights',
      arguments: { from: 'VIE', to: 'LIS' },
    });
    const paused = await viewer.waitFor(pausedOn('tool:searchFlights', 'after'));
    // The handler DID run this time — the gate is on the way out.
    expect(h.attempts.get('searchFlights')).toBe(1);
    expect(h.marks.first('tool:body-end')).toBeDefined();

    viewer.resume(paused.payload['pauseId'] as string, 'inject', 'rewritten on the way out');
    expect(toolText(await call)).toBe('rewritten on the way out');

    const finished = await viewer.waitFor(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:searchFlights',
    );
    expect(finished.payload['injectedAt']).toBe('after');
  });
});

describe('error gate', () => {
  it('retry re-invokes the handler and the client gets the successful result', async () => {
    const { viewer, gm } = await setup(cleanups.push, {
      breakpoints: [{ kind: 'tool', name: 'flaky', point: 'error' }],
    });
    await attach(gm);
    const h = await makeHarness(gm, { flakyFailures: 1 });
    cleanups.push(h.close);

    const call = h.client.callTool({ name: 'flaky', arguments: { n: 5 } });
    const paused = await viewer.waitFor(pausedOn('tool:flaky', 'error'));
    viewer.resume(paused.payload['pauseId'] as string, 'retry');

    const result = (await call) as { isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(toolText(result)).toBe('ok after 2 attempts: 5');
    expect(h.attempts.get('flaky')).toBe(2);
  });

  it('inject recovers a failing handler: the error never reaches the client', async () => {
    const { viewer, gm } = await setup(cleanups.push, {
      breakpoints: [{ kind: 'tool', name: 'flaky', point: 'error' }],
    });
    await attach(gm);
    const h = await makeHarness(gm, { flakyFailures: 99 });
    cleanups.push(h.close);

    const call = h.client.callTool({ name: 'flaky', arguments: { n: 5 } });
    const paused = await viewer.waitFor(pausedOn('tool:flaky', 'error'));
    viewer.resume(paused.payload['pauseId'] as string, 'inject', { rescued: true });

    const result = (await call) as { isError?: boolean; structuredContent?: unknown };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ rescued: true });
  });

  it('continue rethrows: the SDK turns it into the isError tool result', async () => {
    const { viewer, gm } = await setup(cleanups.push, {
      breakpoints: [{ kind: 'tool', name: 'flaky', point: 'error' }],
    });
    await attach(gm);
    const h = await makeHarness(gm, { flakyFailures: 99 });
    cleanups.push(h.close);

    const call = h.client.callTool({ name: 'flaky', arguments: { n: 5 } });
    const paused = await viewer.waitFor(pausedOn('tool:flaky', 'error'));
    viewer.resume(paused.payload['pauseId'] as string, 'continue');

    const result = (await call) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain('HTTP 500');
    expect(h.attempts.get('flaky')).toBe(1);
  });
});

describe('resources and prompts gate the same way', () => {
  it('inject replaces a resource read with a valid ReadResourceResult', async () => {
    const { viewer, gm } = await setup(cleanups.push, { breakpoints: [{ kind: 'resource' }] });
    await attach(gm);
    const h = await makeHarness(gm);
    cleanups.push(h.close);

    const read = h.client.readResource({ uri: 'config://app' });
    const paused = await viewer.waitFor(pausedOn('resource:appConfig'));
    viewer.resume(paused.payload['pauseId'] as string, 'inject', { theme: 'INJECTED' });

    const result = await read;
    expect(resourceUri(result)).toBe('config://app');
    expect(resourceText(result)).toContain('INJECTED');
    expect(h.attempts.get('appConfig')).toBeUndefined();
  });

  it('inject replaces a prompt with a valid GetPromptResult', async () => {
    const { viewer, gm } = await setup(cleanups.push, { breakpoints: [{ kind: 'prompt' }] });
    await attach(gm);
    const h = await makeHarness(gm);
    cleanups.push(h.close);

    const fetch = h.client.getPrompt({ name: 'greet', arguments: { name: 'Ada' } });
    const paused = await viewer.waitFor(pausedOn('prompt:greet'));
    viewer.resume(paused.payload['pauseId'] as string, 'inject', 'a totally different prompt');

    const result = await fetch;
    expect(JSON.stringify(result.messages)).toContain('a totally different prompt');
  });
});

describe('concurrency', () => {
  it('two in-flight requests hold independent gates', async () => {
    const { viewer, gm } = await setup(cleanups.push, { breakpoints: [{ kind: 'tool' }] });
    await attach(gm);
    const h = await makeHarness(gm);
    cleanups.push(h.close);

    const flights = h.client.callTool({
      name: 'searchFlights',
      arguments: { from: 'VIE', to: 'LIS' },
    });
    const ping = h.client.callTool({ name: 'ping' });

    await waitUntil(() => viewer.ofType('exec.paused').length >= 2, 8000, 'two pauses');
    const pauses = viewer.ofType('exec.paused');
    const flightPause = pauses.find((f) => f.payload['nodeId'] === 'tool:searchFlights')!;
    const pingPause = pauses.find((f) => f.payload['nodeId'] === 'tool:ping')!;
    expect(flightPause.payload['pauseId']).not.toBe(pingPause.payload['pauseId']);
    // Each request is its own run.
    expect(flightPause.runId).not.toBe(pingPause.runId);

    // Release only one: the other stays held.
    viewer.resume(pingPause.payload['pauseId'] as string, 'inject', 'pong-injected');
    expect(toolText(await ping)).toBe('pong-injected');
    await tick(150);
    expect(gm.session.stats().heldGates).toBe(1);
    expect(h.marks.first('tool:body-start')).toBeUndefined();

    viewer.resume(flightPause.payload['pauseId'] as string, 'continue');
    expect(toolText(await flights)).toContain('TP1234');
    expect(gm.session.stats().heldGates).toBe(0);
  });
});

describe('fail-open', () => {
  it('a viewer that dies mid-hold auto-continues the request', async () => {
    const { viewer, gm } = await setup(cleanups.push, { breakpoints: [{ kind: 'tool' }] });
    await attach(gm);
    const h = await makeHarness(gm);
    cleanups.push(h.close);

    const call = h.client.callTool({
      name: 'searchFlights',
      arguments: { from: 'VIE', to: 'LIS' },
    });
    await viewer.waitFor(pausedOn('tool:searchFlights'));
    expect(gm.session.stats().heldGates).toBe(1);

    viewer.killAbruptly();

    // No resume ever arrives; the request must still complete.
    const result = await call;
    expect(toolText(result)).toContain('TP1234');
    expect(gm.session.stats().heldGates).toBe(0);
    expect(gm.session.attached).toBe(false);
  });
});

describe('step mode', () => {
  it('pauses before every request without any breakpoint set', async () => {
    const { viewer, gm } = await setup(cleanups.push, { mode: 'step' });
    await attach(gm);
    const h = await makeHarness(gm);
    cleanups.push(h.close);

    const call = h.client.callTool({ name: 'ping' });
    const paused = await viewer.waitFor(pausedOn('tool:ping'));
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    expect(toolText(await call)).toBe('pong');

    // Step mode also stops on the way out (decisions.md #2 puts `after` behind
    // an explicit breakpoint, so this run stops once, before the handler).
    expect(viewer.ofType('exec.paused').filter((f) => f.payload['point'] === 'after')).toHaveLength(
      0,
    );
  });
});
