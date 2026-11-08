/**
 * M7: importers. The generated skeleton must (1) be a loadable workflow
 * module, (2) keep the original order, (3) pause at the first unported step
 * when run — porting IS fix-and-resume.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Generated modules import the SDK, so they must live where Node can resolve
// the workspace packages — under this package, not the OS temp dir. The same
// is true for users: generated files belong next to their other workflows.
const genDir = () => {
  const dir = mkdtempSync(join(import.meta.dirname, '.generated-'));
  CREATED.push(dir);
  return dir;
};
import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { Executor, ManualClock, SqliteJournalStore } from '@graphmind-ai/circuit-engine';
import { importN8n, importPipedream } from '../src/import.js';
import { loadWorkflows } from '../src/load.js';

const CREATED: string[] = [];
afterAll(() => {
  for (const dir of CREATED) rmSync(dir, { recursive: true, force: true });
});

const N8N_SAMPLE = {
  name: 'Lead Capture',
  nodes: [
    { name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: { path: 'lead' } },
    { name: 'Clean Up', type: 'n8n-nodes-base.set', parameters: { values: { string: [{ name: 'email' }] } } },
    { name: 'Wait a bit', type: 'n8n-nodes-base.wait', parameters: { amount: 2, unit: 'hours' } },
    { name: 'Notify CRM', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://crm.example.com/leads', method: 'POST' } },
    { name: 'Old Node', type: 'n8n-nodes-base.noOp', disabled: true },
  ],
  connections: {
    Webhook: { main: [[{ node: 'Clean Up' }]] },
    'Clean Up': { main: [[{ node: 'Wait a bit' }]] },
    'Wait a bit': { main: [[{ node: 'Notify CRM' }]] },
  },
};

const PIPEDREAM_SAMPLE = {
  name: 'Daily Digest',
  triggers: [{ type: 'cron', cron: { cron: '0 8 * * *' } }],
  steps: [
    { namespace: 'fetch_items', code: "export default defineComponent({\n  async run({ steps }) {\n    return await fetch('https://api.example.com/items');\n  }\n});" },
    { namespace: 'send_email', component: { key: 'gmail-send-email' }, props: { to: 'team@example.com' } },
  ],
};

describe('importN8n', () => {
  it('maps triggers, order, waits and http; marks the rest TODO', () => {
    const generated = importN8n(N8N_SAMPLE);
    expect(generated.name).toBe('lead-capture');
    expect(generated.source).toContain("triggers: [{ type: 'api' }]");
    expect(generated.source).toContain("ctx.sleep(\"wait-a-bit\", '2h')");
    expect(generated.source).toContain('https://crm.example.com/leads');
    expect(generated.source).toContain("skipped: n8n node 'Old Node' was disabled");
    // order preserved: clean-up before wait before notify
    const i = (t: string) => generated.source.indexOf(t);
    expect(i('clean-up')).toBeGreaterThan(-1);
    expect(i('clean-up')).toBeLessThan(i('wait-a-bit'));
    expect(i('wait-a-bit')).toBeLessThan(i('notify-crm'));
    expect(generated.todos).toContain('clean-up');
  });

  it('the generated module loads, and a run pauses at the first TODO step', async () => {
    const dir = genDir();
    const generated = importN8n(N8N_SAMPLE);
    const file = join(dir, generated.fileName);
    writeFileSync(file, generated.source);
    const defs = await loadWorkflows(file);
    expect(defs.map((d) => d.config.name)).toEqual(['lead-capture']);

    const store = new SqliteJournalStore(':memory:');
    const executor = new Executor({ store, clock: new ManualClock(), workflows: defs });
    const run = executor.enqueue('lead-capture', {});
    await executor.drain();
    const paused = executor.getRun(run.id);
    expect(paused?.status).toBe('paused');
    const held = executor.getJournal(run.id)[0];
    expect(held?.name).toBe('clean-up');
    expect(held?.error?.message).toContain('TODO(circuit-import)');
    // Porting workflow: inject a value for the unported step; the run moves on.
    executor.resume(run.id, 0, 'inject', { actor: 'porter', output: { email: 'a@b.c' } });
    await executor.drain();
    expect(executor.getRun(run.id)?.status).toBe('suspended'); // now at the 2h sleep
  });

  it('rejects something that is not an n8n export', () => {
    expect(() => importN8n({ foo: 1 })).toThrow(/not an n8n workflow export/);
  });
});

describe('importPipedream', () => {
  it('keeps cron triggers, embeds code steps, marks actions TODO', () => {
    const generated = importPipedream(PIPEDREAM_SAMPLE);
    expect(generated.name).toBe('daily-digest');
    expect(generated.source).toContain("{ type: 'cron', schedule: \"0 8 * * *\" }");
    expect(generated.source).toContain('original Pipedream code step');
    expect(generated.source).toContain('defineComponent');
    expect(generated.source).toContain('gmail-send-email');
    expect(generated.todos).toEqual(['fetch-items', 'send-email']);
  });

  it('the generated module loads as a workflow', async () => {
    const dir = genDir();
    const generated = importPipedream(PIPEDREAM_SAMPLE);
    const file = join(dir, generated.fileName);
    writeFileSync(file, generated.source);
    const defs = await loadWorkflows(file);
    expect(defs.map((d) => d.config.name)).toEqual(['daily-digest']);
  });

  it('rejects something that is not a Pipedream export', () => {
    expect(() => importPipedream({ nodes: [] })).toThrow(/not a Pipedream workflow export/);
  });
});
