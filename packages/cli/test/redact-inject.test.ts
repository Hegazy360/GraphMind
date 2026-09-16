/**
 * Inject guard, server side. The viewer refuses to send an inject whose JSON
 * still contains "__REDACTED__" (apps/viewer/src/lib/gate.ts); the hub
 * refuses the same `exec.resume` when it arrives anyway — from an older
 * viewer, a script on /ws/ui, anything. The app must never receive it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { REDACTED } from '../src/redact-secrets.js';
import { FakeApp, FakeUI, startTestServer, type TestServer } from './helpers.js';

let ts: TestServer | undefined;
afterEach(async () => {
  await ts?.cleanup();
  ts = undefined;
});

const RUN = 'run-inject-guard';

async function ownedRun(): Promise<{ app: FakeApp; ui: FakeUI }> {
  ts = await startTestServer();
  const app = await FakeApp.connect(ts.port, { app: 'guarded' });
  app.send('run.started', RUN, { app: 'guarded', sdk: { name: 'ai', version: '7' } });
  app.send('node.started', RUN, { nodeId: 'tool:x', kind: 'tool', name: 'x', instanceId: '1', input: REDACTED });
  app.send('exec.paused', RUN, { pauseId: 'p1', nodeId: 'tool:x', point: 'before' });
  const ui = await FakeUI.connect(ts.port);
  ui.subscribe(RUN);
  await ui.next((m) => m.type === 'replay.end', 'replay.end');
  return { app, ui };
}

async function appGotNothing(app: FakeApp): Promise<boolean> {
  return app
    .received
    .next((e) => e.type === 'exec.resume', 300, 'exec.resume')
    .then(() => false, () => true);
}

describe('hub: exec.resume inject guard', () => {
  it('refuses an inject whose output IS the placeholder, with the structured UI error, and relays nothing', async () => {
    const { app, ui } = await ownedRun();
    ui.control('exec.resume', RUN, { pauseId: 'p1', action: 'inject', output: REDACTED });
    const err = await ui.next((m) => m.type === 'error', 'ui error');
    expect(err).toEqual({
      type: 'error',
      runId: RUN,
      message: 'inject refused: this value contains redacted content ("__REDACTED__"); edit it before injecting',
    });
    expect(await appGotNothing(app)).toBe(true);
    await app.close();
  });

  it('refuses the placeholder nested in an object, inside a string, and as a key', async () => {
    const { app, ui } = await ownedRun();
    const outputs: unknown[] = [
      { result: { rows: [{ id: 1, secret: REDACTED }] } },
      `partially ${REDACTED} edited`,
      { [REDACTED]: 1 },
      [REDACTED],
    ];
    for (const output of outputs) {
      ui.control('exec.resume', RUN, { pauseId: 'p1', action: 'inject', output });
      const err = await ui.next((m) => m.type === 'error', 'ui error');
      expect(err.type === 'error' && err.message).toContain('redacted content');
    }
    expect(await appGotNothing(app)).toBe(true);
    await app.close();
  });

  it('lets a clean inject through untouched, and only inspects action inject', async () => {
    const { app, ui } = await ownedRun();
    ui.control('exec.resume', RUN, {
      pauseId: 'p1',
      action: 'inject',
      output: { result: 'REDACTED is not the placeholder', note: '__redacted__' },
    });
    const relayed = await app.nextControl((e) => e.type === 'exec.resume');
    expect(relayed.payload).toEqual({
      pauseId: 'p1',
      action: 'inject',
      output: { result: 'REDACTED is not the placeholder', note: '__redacted__' },
    });
    // `continue` ignores `output` entirely, so a stray placeholder there is not an inject.
    ui.control('exec.resume', RUN, { pauseId: 'p1', action: 'continue', output: REDACTED });
    const cont = await app.nextControl((e) => e.type === 'exec.resume');
    expect(cont.payload).toMatchObject({ pauseId: 'p1', action: 'continue' });
    expect(ui.received.peekAll().filter((m) => m.type === 'error')).toEqual([]);
    await app.close();
  });

  it('the guard runs before ownership: an unowned run gets the redaction error, not a routing one', async () => {
    ts = await startTestServer();
    const ui = await FakeUI.connect(ts.port);
    ui.control('exec.resume', 'run-nobody', { pauseId: 'p', action: 'inject', output: REDACTED });
    const err = await ui.next((m) => m.type === 'error', 'ui error');
    expect(err.type === 'error' && err.message).toContain('redacted content');
    ui.control('exec.resume', 'run-nobody', { pauseId: 'p', action: 'inject', output: { ok: true } });
    const routing = await ui.next((m) => m.type === 'error', 'ui error');
    expect(routing.type === 'error' && routing.message).toContain('no connected app owns run');
    await ui.close();
  });
});
