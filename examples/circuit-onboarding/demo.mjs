/**
 * Guided Circuit demo — no curl, no second terminal.
 *
 * Starts the real Circuit HTTP API in this process (in-memory SQLite, a free
 * port) and drives it exactly like a customer application would: over HTTP.
 *
 *   pnpm circuit:demo          (from the repo root; builds first)
 *   node demo.mjs              (from this folder, once built)
 */
import { serve } from '@hono/node-server';
import { Executor, SqliteJournalStore } from '@graphmind-ai/circuit-engine';
import { createApi, startEngineLoop } from 'circuit-api';
import { triageInvoice } from './workflows.mjs';

const store = new SqliteJournalStore(':memory:');
const executor = new Executor({ store, workflows: [triageInvoice] });
const loop = startEngineLoop(executor, 25);
const app = createApi({ executor, store, workflows: [triageInvoice], onWork: loop.kick });

const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise((resolve) => server.once('listening', resolve));
const API = `http://127.0.0.1:${server.address().port}/v1`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (n, text) => console.log(`\n\x1b[1m${n}. ${text}\x1b[0m`);
const show = (label, value) => console.log(`   ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);

async function call(method, path, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  console.log(`   \x1b[2m${method} ${path} → ${res.status}\x1b[0m`);
  return json;
}

async function settle(runId) {
  await sleep(150); // let the engine loop pick up the work
  return call('GET', `/runs/${runId}`);
}

console.log(`Circuit API running at ${API} (in-memory, this process only)`);

step(1, 'Your app starts a workflow run with one HTTP call');
const { runId } = await call('POST', '/workflows/triage-invoice/runs', {
  input: { invoiceId: 'flaky-big-001' },
  idempotencyKey: 'flaky-big-001',
});
show('runId', runId);

step(2, 'The (simulated) ERP is down: the run PAUSES at an error gate instead of failing');
let d = await settle(runId);
show('run status', d.run.status);
show('held at', `entry #${d.run.pausedSeq} "${d.journal[0].name}"`);
show('error', d.journal[0].error.message);

step(3, 'An engineer fixes it live: retry the step, with an audited reason');
await call('POST', `/runs/${runId}/entries/0/resume`, { action: 'retry', reason: 'ERP back up' }, { 'x-circuit-actor': 'you@team' });
d = await settle(runId);
show('run status', d.run.status);
show('now held at', `entry #${d.run.pausedSeq} "${d.journal[1].name}" (invoice > 10k needs sign-off)`);

step(4, 'Finance approves');
await call('POST', `/runs/${runId}/approvals/1`, { approved: true, by: 'cfo@team' });
d = await settle(runId);
show('run status', d.run.status);
show('waiting for event', d.journal[2].waitEvent);

step(5, 'Your payment system sends an event; it matches the waiting run');
const evt = await call('POST', '/events', { name: 'payment.settled', data: { invoiceId: 'flaky-big-001' } });
show('matched runs', evt.matchedRuns);
d = await settle(runId);

step(6, 'Done. The journal records what happened, including the human fix');
show('run status', d.run.status);
show('output', d.run.output);
for (const e of d.journal) {
  const fix = e.interventions.map((i) => `${i.action} by ${i.actor}${i.reason ? ` ("${i.reason}")` : ''}`).join(', ');
  show(`  #${e.seq} ${e.name}`, `${e.status}, ${e.attempts.length} attempt(s)${fix ? `, intervention: ${fix}` : ''}`);
}

step(7, 'What if? Fork the run with a different invoice amount and run the rest for real');
const fork = await call('POST', `/runs/${runId}/fork`, { substitute: { seq: 0, output: { invoiceId: 'flaky-big-001', amount: 50, customer: 'acme' } } });
const f = await settle(fork.runId);
show('fork status', `${f.run.status}: small invoice skips the approval and waits for payment directly`);
show('fork journal', f.journal.map((e) => e.name));

step(8, 'Deploy check: would the current code break any run that is still in flight?');
const res = await fetch(`${API}/deploy-check`, { method: 'POST' });
const report = await res.json();
show('result', `${report.checked} in-flight run(s) checked, ${report.broken.length} would break (HTTP ${res.status})`);

console.log('\nDemo finished. Next: `pnpm circuit:dev` for a server you can drive yourself (see docs/circuit/USAGE.md).');
loop.stop();
server.close();
store.close();
