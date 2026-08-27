/**
 * Scoping the default pause-on-error breakpoint.
 *
 * Pause-on-error is default-on by design (internal/decisions.md #8) and stays
 * that way. But `{point:'error'}` matches every node, so an incidental tool
 * failure holds the run before the interesting one does — one sample app hit
 * three spurious holds before the failure it was actually debugging. These
 * tests pin both halves: the default is unchanged, and there is a documented
 * way to narrow or remove it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { OPTION_HELP, defaultFlags, parseCliArgs } from '../src/args.js';
import {
  DEFAULT_BREAKPOINTS,
  DebugState,
  PAUSE_ON_ERROR_VALUES,
  parsePauseOnError,
} from '../src/debug-state.js';
import { FakeApp, FakeUI, startTestServer, type TestServer } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function boot(options: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const ts = await startTestServer(options);
  cleanups.push(() => ts.cleanup());
  return ts;
}

describe('parsePauseOnError', () => {
  it('keeps the unscoped error breakpoint when unset or explicitly on', () => {
    for (const value of [undefined, '', 'on', 'ON', 'all', 'true', '1']) {
      const parsed = parsePauseOnError(value);
      expect(parsed.ok, `value ${String(value)}`).toBe(true);
      expect(parsed.ok && parsed.breakpoints).toEqual([{ point: 'error' }]);
    }
    expect(DEFAULT_BREAKPOINTS).toEqual([{ point: 'error' }]);
  });

  it('turns the default off', () => {
    for (const value of ['off', 'none', 'false', '0', ' OFF ']) {
      const parsed = parsePauseOnError(value);
      expect(parsed.ok, `value ${value}`).toBe(true);
      expect(parsed.ok && parsed.breakpoints).toEqual([]);
    }
  });

  it('scopes the default to one node kind', () => {
    const parsed = parsePauseOnError('llm');
    expect(parsed.ok && parsed.breakpoints).toEqual([{ point: 'error', kind: 'llm' }]);
    expect(parsePauseOnError('tool').ok && parsePauseOnError('tool')).toMatchObject({
      breakpoints: [{ point: 'error', kind: 'tool' }],
    });
  });

  it('rejects anything else instead of silently re-arming the default', () => {
    const parsed = parsePauseOnError('sometimes');
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain('sometimes');
    for (const value of PAUSE_ON_ERROR_VALUES) {
      expect(!parsed.ok && parsed.error).toContain(value);
    }
  });
});

describe('--pause-on-error', () => {
  it('parses both flag forms', () => {
    expect(parseCliArgs(['--pause-on-error', 'off']).flags.pauseOnError).toBe('off');
    expect(parseCliArgs(['--pause-on-error=tool']).flags.pauseOnError).toBe('tool');
    expect(parseCliArgs([]).flags.pauseOnError).toBe(defaultFlags().pauseOnError);
  });

  it('reports an invalid value with the accepted ones', () => {
    const parsed = parseCliArgs(['--pause-on-error', 'maybe']);
    expect(parsed.errors[0]).toContain('--pause-on-error');
    expect(parsed.errors[0]).toContain('maybe');
    expect(parsed.flags.pauseOnError).toBeUndefined();
  });

  it('is documented in `graphmind --help`', () => {
    const help = OPTION_HELP.join('\n');
    expect(help).toContain('--pause-on-error');
    expect(help).toContain('GRAPHMIND_PAUSE_ON_ERROR');
    for (const value of ['off', 'tool', 'llm']) expect(help).toContain(value);
  });
});

describe('DebugState', () => {
  it('arms the unscoped error breakpoint by default', () => {
    expect(new DebugState().breakpoints).toEqual([{ point: 'error' }]);
  });

  it('can be constructed with no breakpoints at all', () => {
    expect(new DebugState([]).breakpoints).toEqual([]);
  });
});

describe('the server arms what the user asked for', () => {
  it('still defaults to pausing on every error', async () => {
    const { port } = await boot();
    const app = await FakeApp.connect(port);
    expect(app.ack?.breakpoints).toEqual([{ point: 'error' }]);
    await app.close();
  });

  it('starts with no breakpoints when --pause-on-error=off', async () => {
    const { port } = await boot({ pauseOnError: 'off' });
    const app = await FakeApp.connect(port);
    expect(app.ack?.breakpoints).toEqual([]);
    const ui = await FakeUI.connect(port);
    expect(ui.welcome?.breakpoints).toEqual([]);
    await app.close();
    await ui.close();
  });

  it('scopes the default via GRAPHMIND_PAUSE_ON_ERROR', async () => {
    const { port } = await boot({ env: { GRAPHMIND_PAUSE_ON_ERROR: 'tool' } });
    const app = await FakeApp.connect(port);
    expect(app.ack?.breakpoints).toEqual([{ point: 'error', kind: 'tool' }]);
    await app.close();
  });

  it('lets the option beat the environment', async () => {
    const { port } = await boot({
      pauseOnError: 'off',
      env: { GRAPHMIND_PAUSE_ON_ERROR: 'tool' },
    });
    const app = await FakeApp.connect(port);
    expect(app.ack?.breakpoints).toEqual([]);
    await app.close();
  });

  it('warns and keeps the default when the environment value is nonsense', async () => {
    const logs: string[] = [];
    const { port } = await boot({
      log: (message) => logs.push(message),
      env: { GRAPHMIND_PAUSE_ON_ERROR: 'yes-please' },
    });
    expect(logs.join('\n')).toContain('yes-please');
    const app = await FakeApp.connect(port);
    // A typo must never silently disarm the product's headline mechanic.
    expect(app.ack?.breakpoints).toEqual([{ point: 'error' }]);
    await app.close();
  });

  it('does not disturb breakpoints the viewer sets afterwards', async () => {
    const { port } = await boot({ pauseOnError: 'off' });
    const ui = await FakeUI.connect(port);
    ui.control('breakpoint.set', '*', { matcher: { kind: 'tool', name: 'charge' } });
    await ui.next((m) => m.type === 'state', 'state after breakpoint.set');
    const app = await FakeApp.connect(port);
    expect(app.ack?.breakpoints).toEqual([{ kind: 'tool', name: 'charge' }]);
    await app.close();
    await ui.close();
  });
});
