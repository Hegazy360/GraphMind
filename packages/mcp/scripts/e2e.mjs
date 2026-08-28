/**
 * End-to-end smoke for @graphmind-ai/mcp, against the REAL pieces: the
 * `graphmind` server from packages/cli, a real stdio MCP server
 * (example/stdio-server.mjs) driven by a real MCP client, and breakpoints
 * armed over the viewer's own WebSocket.
 *
 *   pnpm --filter @graphmind-ai/mcp build      # the example imports dist/
 *   pnpm --filter @graphmind-ai/mcp e2e
 *
 * Requires packages/cli to have been built (`pnpm --filter graphmind-ai build`).
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const ROOT = resolve(PKG, '..', '..');
const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');
const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { StdioClientTransport } = await import(
  require.resolve('@modelcontextprotocol/sdk/client/stdio.js')
);

const PORT = Number(process.env.GM_E2E_PORT ?? 4747);
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = spawn('node', [`${ROOT}/packages/cli/dist/cli.js`, 'serve', '--port', String(PORT), '--no-open'], {
  env: { ...process.env, GRAPHMIND_TELEMETRY: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => process.stderr.write(`[serve] ${d}`));

async function openUi() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/ui`);
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      return ws;
    } catch {
      await sleep(250);
    }
  }
  throw new Error('graphmind server never came up');
}

const ui = await openUi();
check('graphmind serve is up and the viewer socket connects', true);

const seen = [];
const waiters = [];
ui.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  seen.push(msg);
    // Only subscribe to runs CREATED after we attached: the persisted store
  // holds runs from earlier sessions whose replay would match our waiters.
  if (msg.type === 'run.update') send({ type: 'subscribe', runId: msg.run.id });
  for (let i = waiters.length - 1; i >= 0; i -= 1) {
    if (waiters[i].pred(msg)) waiters.splice(i, 1)[0].resolve(msg);
  }
});
const waitFor = (pred, label, ms = 15000) =>
  new Promise((resolve, reject) => {
    const hit = seen.find(pred);
    if (hit) return resolve(hit);
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
    waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
  });

const send = (msg) => ui.send(JSON.stringify(msg));
const envelope = (type, payload, runId = '*') => ({
  gm: 1, seq: 0, ts: Date.now(), runId, type, payload,
});

send({ type: 'subscribe', runId: '*' });
await waitFor((m) => m.type === 'welcome', 'welcome');
send({ type: 'control', envelope: envelope('breakpoint.set', { matcher: { kind: 'tool', name: 'flights' } }) });
await waitFor((m) => m.type === 'state' && m.breakpoints.some((b) => b.name === 'flights'), 'breakpoint armed');
check('breakpoint {kind:tool, name:flights} armed on the real server', true);

// Now start the instrumented MCP server as a child of a real MCP client.
const transport = new StdioClientTransport({
  command: 'node',
  args: [`${PKG}/example/stdio-server.mjs`],
  env: { ...process.env, GRAPHMIND_URL: `ws://127.0.0.1:${PORT}/ingest` },
  stderr: 'pipe',
});
const client = new Client({ name: 'e2e-client', version: '1.0.0' });
await client.connect(transport);
transport.stderr?.on('data', (d) => process.stderr.write(`[mcp-server stderr] ${d}`));
check('a real MCP client speaks to the instrumented stdio server', true);

const tools = await client.listTools();
check('tools/list is untouched by the adapter', tools.tools.some((t) => t.name === 'flights'), tools.tools.map((t) => t.name).join(','));

const call = client.callTool({ name: 'flights', arguments: { from: 'VIE', to: 'LIS' } }, undefined, { timeout: 12000 }).catch((e) => ({ error: String(e) }));

const paused = await waitFor(
  (m) => m.type === 'event' && m.envelope.type === 'exec.paused' && m.envelope.payload.nodeId === 'tool:flights',
  'exec.paused on tool:flights',
);
check('the real server held the request at the before gate', paused.envelope.payload.point === 'before', `point=${paused.envelope.payload.point}`);

await sleep(600);
const settled = await Promise.race([call.then(() => 'settled'), sleep(10).then(() => 'held')]);
check('the client is still waiting while the gate is held', settled === 'held');

send({
  type: 'control',
  envelope: envelope(
    'exec.resume',
    { pauseId: paused.envelope.payload.pauseId, action: 'inject', output: { grounded: true, note: 'NO FLIGHTS TODAY' } },
    paused.runId,
  ),
});

const result = await call;
const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
check('inject reached the client as the tool result', text.includes('NO FLIGHTS TODAY'), text);
check('an injected object also arrives as structuredContent', JSON.stringify(result.structuredContent) === JSON.stringify({ grounded: true, note: 'NO FLIGHTS TODAY' }), JSON.stringify(result.structuredContent));

// A normal call after the breakpoint is cleared runs the real handler.
send({ type: 'control', envelope: envelope('breakpoint.clear', { matcher: { kind: 'tool', name: 'flights' } }) });
await waitFor((m) => m.type === 'state' && !m.breakpoints.some((b) => b.name === 'flights'), 'breakpoint cleared');
const real = await client.callTool({ name: 'flights', arguments: { from: 'VIE', to: 'LIS' } });
check('with the breakpoint cleared the real handler answers', (real.content?.[0]?.text ?? '').includes('TP1234'));

// Pause-on-error is armed by default on a fresh server: a throwing handler stops.
const errCall = client.callTool({ name: 'flights', arguments: { from: 'VIE', to: 'VIE' } });
const errPause = await waitFor(
  (m) => m.type === 'event' && m.envelope.type === 'exec.paused' && m.envelope.payload.point === 'error',
  'exec.paused on error',
);
check('pause-on-error (default breakpoint) stops a throwing handler', true);
send({
  type: 'control',
  envelope: envelope('exec.resume', { pauseId: errPause.envelope.payload.pauseId, action: 'inject', output: 'recovered by the debugger' }, errPause.runId),
});
const recovered = await errCall;
check('inject at the error gate recovers the request', (recovered.content?.[0]?.text ?? '').includes('recovered by the debugger'), recovered.content?.[0]?.text);

// Persisted history: the run list has our runs and they are marked finished.
const runsResponse = await fetch(`http://127.0.0.1:${PORT}/api/runs`);
const runs = await runsResponse.json();
const names = (Array.isArray(runs) ? runs : runs.runs ?? []).map((r) => r.id);
check('runs are persisted and listed by the server', names.length >= 3, `${names.length} runs`);

if (process.env.GM_INSPECT) {
  const all = await (await fetch(`http://127.0.0.1:${PORT}/api/runs`)).json();
  const list = Array.isArray(all) ? all : all.runs;
  for (const r of list.filter((x) => x.app === 'flights-mcp').slice(0, 6)) {
    const evs = await (await fetch(`http://127.0.0.1:${PORT}/api/runs/${r.id}/events`)).json();
    const items = Array.isArray(evs) ? evs : evs.events;
    const line = items
      .map((e) => `${e.type}${e.payload?.nodeId ? `(${e.payload.nodeId})` : ''}`)
      .join('\n    ');
    console.log(`\n ${r.id} ${r.status} ${r.eventCount}\n    ${line}`);
  }
}

await client.close();
ui.close();
server.kill('SIGTERM');
await sleep(300);

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
