/**
 * Sampling — the server asking the client's LLM — is the part a protocol-level
 * proxy cannot reach cleanly: it happens INSIDE a handler, between the request
 * and its response. In-process it is just another gated node, nested under the
 * request that issued it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { makeHarness, toolText } from './helpers/mcp.js';
import { attach, makeCleanups, setup } from './helpers/setup.js';

const cleanups = makeCleanups();
afterEach(cleanups.run);

describe('sampling/createMessage', () => {
  it('via extra.sendRequest: an llm node nested under the tool, in the same run', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const h = await makeHarness(gm, { samplingAnswer: 'a short summary' });
    cleanups.push(h.close);

    const result = await h.client.callTool({
      name: 'summarize',
      arguments: { text: 'a long document' },
    });
    expect(toolText(result)).toBe('summary: a short summary');

    const sampling = await viewer.waitFor(
      (f) => f.type === 'node.started' && f.payload['nodeId'] === 'llm:sampling',
    );
    expect(sampling.payload['kind']).toBe('llm');
    expect(sampling.payload['parentId']).toBe('tool:summarize');
    expect(JSON.stringify(sampling.payload['input'])).toContain('a long document');

    // Same run as the tool call that issued it.
    const tool = viewer.received.find(
      (f) => f.type === 'node.started' && f.payload['nodeId'] === 'tool:summarize',
    )!;
    expect(sampling.runId).toBe(tool.runId);

    const finished = await viewer.waitFor(
      (f) => f.type === 'node.finished' && f.payload['nodeId'] === 'llm:sampling',
    );
    expect(finished.payload['status']).toBe('ok');
    expect(JSON.stringify(finished.payload['output'])).toContain('a short summary');
  });

  it('via server.createMessage: instrumented through the wrapped `.server` view', async () => {
    const { viewer, gm } = await setup(cleanups.push);
    await attach(gm);
    const h = await makeHarness(gm, { samplingAnswer: 'server-side summary' });
    cleanups.push(h.close);

    const result = await h.client.callTool({
      name: 'summarizeViaServer',
      arguments: { text: 'another document' },
    });
    expect(toolText(result)).toBe('summary: server-side summary');

    const sampling = await viewer.waitFor(
      (f) => f.type === 'node.started' && f.payload['nodeId'] === 'llm:sampling',
    );
    expect(sampling.payload['parentId']).toBe('tool:summarizeViaServer');
  });

  it('inject answers the model call without an LLM; the handler runs on the fake answer', async () => {
    const { viewer, gm } = await setup(cleanups.push, { breakpoints: [{ kind: 'llm' }] });
    await attach(gm);
    const h = await makeHarness(gm, { samplingAnswer: 'the real model would say this' });
    cleanups.push(h.close);

    const call = h.client.callTool({
      name: 'summarize',
      arguments: { text: 'a long document' },
    });
    const paused = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'llm:sampling',
    );
    viewer.resume(paused.payload['pauseId'] as string, 'inject', 'HALLUCINATED');

    // The tool body continued with the injected model output, and the client
    // received the tool's own result built from it.
    expect(toolText(await call)).toBe('summary: HALLUCINATED');
  });

  it('holding the sampling gate holds the whole request', async () => {
    const { viewer, gm } = await setup(cleanups.push, { breakpoints: [{ kind: 'llm' }] });
    await attach(gm);
    const h = await makeHarness(gm);
    cleanups.push(h.close);

    const call = h.client.callTool({ name: 'summarize', arguments: { text: 'doc' } });
    const paused = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'llm:sampling',
    );
    // The tool body started (it had to, to reach the sampling call) but the
    // request has not answered.
    expect(h.marks.first('tool:body-start', (m) => m.data?.['toolName'] === 'summarize')).toBeDefined();
    expect(gm.session.stats().heldGates).toBe(1);

    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    expect(toolText(await call)).toBe('summary: sampled answer');
  });
});
